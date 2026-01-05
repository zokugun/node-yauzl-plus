import { type Readable } from 'node:stream';
import { crc32 as calculateCrc32 } from 'node:zlib';
import { isPositiveIntegerOrZero, isString } from '@zokugun/is-it-type';
import { err, OK, ok, OK_FALSE, OK_NULL, OK_TRUE, type Result } from '@zokugun/xtry';
import { Entry } from './entry.js';
import { type Reader } from './reader.js';
import { uncertainUncompressedSizeEntriesRegistry } from './shared.js';
import { type ZipOptions, type EntryFilename, type EntryProperties, type ExtraField, type OpenReadStreamOptions } from './types.js';
import { decodeBuffer } from './utils/decode-buffer.js';
import { readUInt64LE } from './utils/read-uint64-le.js';
import { validateFilename } from './utils/validate-filename.js';

export type EntryInstance = InstanceType<typeof Entry>;
type EntryConstructorProperties = ConstructorParameters<typeof Entry>[0];

// Spec of ZIP format is here: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// Also: https://libzip.org/specifications/appnote_iz.txt

const EOCDR_WITHOUT_COMMENT_SIZE = 22;
const MAX_EOCDR_COMMENT_SIZE = 0xFF_FF;
const MAC_CDH_EXTRA_FIELD_ID = 22_613;
const MAC_CDH_EXTRA_FIELD_LENGTH = 8;
const MAC_CDH_EXTRA_FIELDS_LENGTH = MAC_CDH_EXTRA_FIELD_LENGTH + 4; // Field data + ID + len (2 bytes each)
const MAC_LFH_EXTRA_FIELDS_LENGTH = 16;
const CDH_MIN_LENGTH = 46;
const CDH_MAX_LENGTH = CDH_MIN_LENGTH + (0xFF_FF * 3); // 3 = Filename, extra fields, comment
const CDH_MAX_LENGTH_MAC = CDH_MIN_LENGTH + (0xFF_FF + MAC_CDH_EXTRA_FIELDS_LENGTH); // No comment
const FOUR_GIB = 0x1_00_00_00_00; // Math.pow(2, 32)

export class Zip {
	public reader: Reader;
	private readonly size: number;
	private readonly decodeStrings: boolean;
	public validateEntrySizes: boolean;
	private readonly validateFilenames: boolean;
	private readonly strictFilenames: boolean;
	private readonly supportMacArchive: boolean;
	private isZip64: boolean | null;
	private entryCount: number | null;
	private entryCountIsCertain: boolean;
	public footerOffset: number | null;
	private centralDirectoryOffset: number | null;
	private centralDirectorySize: number | null;
	private centralDirectorySizeIsCertain: boolean;
	public comment: string | Buffer | null;
	public numEntriesRead: number;
	public isMacArchive: boolean;
	public isMaybeMacArchive: boolean;
	private compressedSizesAreCertain: boolean;
	private uncompressedSizesAreCertain: boolean;
	private _isReading: boolean;
	public _entryCursor: number | null;
	private _fileCursor: number | null;
	public _uncertainUncompressedSizeEntryRefs: Set<WeakRef<EntryInstance>> | null;
	private _firstEntryProps: EntryProperties | null;

	/**
	 * Class representing ZIP file.
	 * Class is exported in public interface, for purpose of `instanceof` checks, but constructor cannot
	 * be called by user. This is enforced by use of private symbol `INTERNAL_SYMBOL`.
	 */
	public constructor(reader: Reader, size: number, options: ZipOptions) { // {{{
		this.reader = reader;
		this.size = size;
		this.decodeStrings = options.decodeStrings!;
		this.validateEntrySizes = options.validateEntrySizes!;
		this.validateFilenames = options.validateFilenames!;
		this.strictFilenames = options.strictFilenames!;
		this.supportMacArchive = options.supportMacArchive!;
		this.isZip64 = null;
		this.entryCount = null;
		this.entryCountIsCertain = true;
		this.footerOffset = null;
		this.centralDirectoryOffset = null;
		this.centralDirectorySize = null;
		this.centralDirectorySizeIsCertain = true;
		this.comment = null;
		this.numEntriesRead = 0;
		this.isMacArchive = false;
		this.isMaybeMacArchive = false;
		this.compressedSizesAreCertain = true;
		this.uncompressedSizesAreCertain = true;
		this._isReading = false;
		this._entryCursor = null;
		this._fileCursor = null;
		this._uncertainUncompressedSizeEntryRefs = null;
		this._firstEntryProps = null;
	} // }}}

	/**
	 * Getter for whether `Zip` is open for reading.
	 */
	public get isOpen(): boolean { // {{{
		return this.reader.isOpen;
	} // }}}

	/**
	 * Close ZIP file. Underlying reader will be closed.
	 */
	public async close(): Promise<Result<void, string>> { // {{{
		return this.reader.close();
	} // }}}

	/**
	 * Locate Central Directory.
	 */
	public async init(): Promise<Result<void, string>> { // {{{
		// Parse End of Central Directory Record + ZIP64 extension
		// to get location of the Central Directory
		const bufferResult = await this._locateEocdr();
		if(bufferResult.fails) {
			return bufferResult;
		}

		const eocdrBuffer = bufferResult.value;

		let result = this._parseEocdr(eocdrBuffer);
		if(result.fails) {
			return result;
		}

		if(this.isZip64) {
			result = await this._parseZip64Eocdr();
			if(result.fails) {
				return result;
			}
		}

		result = await this._locateCentralDirectory();
		if(result.fails) {
			return result;
		}

		this._entryCursor = this.centralDirectoryOffset;

		return OK;
	} // }}}

	/**
	 * Locate End of Central Directory Record.
	 */
	async _locateEocdr(): Promise<Result<Buffer, string>> { // {{{
		// Last field of the End of Central Directory Record is a variable-length comment.
		// The comment size is encoded in a 2-byte field in the EOCDR, which we can't find without trudging
		// backwards through the comment to find it.
		// As a consequence of this design decision, it's possible to have ambiguous ZIP file metadata
		// if a coherent EOCDR was in the comment.
		// Search backwards for a EOCDR signature.
		let bufferSize = EOCDR_WITHOUT_COMMENT_SIZE + MAX_EOCDR_COMMENT_SIZE;

		if(this.size < bufferSize) {
			if(this.size < EOCDR_WITHOUT_COMMENT_SIZE) {
				return err('End of Central Directory Record not found');
			}

			bufferSize = this.size;
		}

		const bufferOffset = this.size - bufferSize;
		const result = await this.reader.read(bufferOffset, bufferSize);
		if(result.fails) {
			return result;
		}

		const buffer = result.value;

		let position: number;

		for(position = bufferSize - EOCDR_WITHOUT_COMMENT_SIZE; position >= 0; position--) {
			if(buffer[position] !== 0x50) {
				continue;
			}

			if(buffer.readUInt32LE(position) !== 0x06_05_4B_50) {
				continue;
			}

			const commentLength = buffer.readUInt16LE(position + 20);

			if(commentLength === bufferSize - position - EOCDR_WITHOUT_COMMENT_SIZE) {
				this.footerOffset = bufferOffset + position;

				return ok(buffer.subarray(position));
			}
		}

		return err('End of Central Directory Record not found');
	} // }}}

	/**
	 * Parse End of Central Directory Record.
	 * Get Central Directory location, size and entry count.
	 */
	private _parseEocdr(eocdrBuffer: Buffer): Result<void, string> { // {{{
		// Bytes 0-3: End of Central Directory Record signature = 0x06054b50
		// Bytes 4-5: Number of this disk
		const diskNumber = eocdrBuffer.readUInt16LE(4);
		if(diskNumber !== 0) {
			return err('Multi-disk ZIP files are not supported');
		}

		// Bytes 6-7: Disk where Central Directory starts
		// Bytes 8-9: Number of Central Directory records on this disk
		// Bytes 10-11: Total number of Central Directory records
		this.entryCount = eocdrBuffer.readUInt16LE(10);

		// Bytes 12-15: Size of Central Directory (bytes)
		this.centralDirectorySize = eocdrBuffer.readUInt32LE(12);

		// Bytes 16-19: Offset of Central Directory
		this.centralDirectoryOffset = eocdrBuffer.readUInt32LE(16);

		// Bytes 22-...: Comment. Encoding is always CP437.
		// Copy buffer instead of slicing, so rest of buffer can be garbage collected.
		this.comment = this.decodeStrings ? decodeBuffer(eocdrBuffer, 22, false) : Buffer.from(eocdrBuffer.subarray(22));

		// Original Yauzl does not check `centralDirectorySize` here, only offset, though ZIP spec suggests
		// both should be checked. I suspect this is a bug in Yauzl, and it has remained undiscovered
		// because ZIP files with a Central Directory > 4 GiB are vanishingly rare
		// (would require millions of files, or thousands of files with very long filenames/comments).
		this.isZip64 = this.entryCount === 0xFF_FF || this.centralDirectoryOffset === 0xFF_FF_FF_FF	|| this.centralDirectorySize === 0xFF_FF_FF_FF;

		return OK;
	} // }}}

	/**
	 * Parse ZIP64 End of Central Directory Locator + Record.
	 * Get Central Directory location, size and entry count, where ZIP64 extension used.
	 */
	async _parseZip64Eocdr(): Promise<Result<void, string>> { // {{{
		// Parse ZIP64 End of Central Directory Locator
		const zip64EocdlOffset = this.footerOffset! - 20;
		if(zip64EocdlOffset < 0) {
			return err('Cannot locate ZIP64 End of Central Directory Locator');
		}

		let bufferResult = await this.reader.read(zip64EocdlOffset, 20);
		if(bufferResult.fails) {
			return bufferResult;
		}

		const zip64EocdlBuffer = bufferResult.value;

		// Bytes 0-3: ZIP64 End of Central Directory Locator signature = 0x07064b50
		if(zip64EocdlBuffer.readUInt32LE(0) !== 0x07_06_4B_50) {
			if(this.supportMacArchive) {
				// Assume this is a faulty Mac OS archive which happens to have entry count of 65535 (possible)
				// or Central Directory size/offset of 4 GiB - 1 (much less likely, but possible).
				// If it's not, we'll get another error when trying to read the Central Directory.
				this.isMacArchive = true;

				return OK;
			}

			return err('Invalid ZIP64 End of Central Directory Locator signature');
		}

		// Bytes 4-7 - Number of the disk with the start of the ZIP64 End of Central Directory Record
		// Bytes 8-15: Position of ZIP64 End of Central Directory Record
		const zip64EocdrOffset = readUInt64LE(zip64EocdlBuffer, 8);
		// Bytes 16-19: Total number of disks

		// Parse ZIP64 End of Central Directory Record
		if(zip64EocdrOffset + 56 > zip64EocdlOffset) {
			return err('Cannot locate ZIP64 End of Central Directory Record');
		}

		bufferResult = await this.reader.read(zip64EocdrOffset, 56);
		if(bufferResult.fails) {
			return bufferResult;
		}

		const zip64EocdrBuffer = bufferResult.value;

		// Bytes 0-3: ZIP64 End of Central Directory Record signature = 0x06064b50
		if(zip64EocdrBuffer.readUInt32LE(0) !== 0x06_06_4B_50) {
			return err('Invalid ZIP64 End of Central Directory Record signature');
		}

		// Bytes 4-11: Size of ZIP64 End of Central Directory Record (not inc first 12 bytes)
		const zip64EocdrSize = readUInt64LE(zip64EocdrBuffer, 4);

		if(zip64EocdrOffset + zip64EocdrSize + 12 > zip64EocdlOffset) {
			return err('Invalid ZIP64 End of Central Directory Record');
		}

		// Bytes 12-13: Version made by
		// Bytes 14-15: Version needed to extract
		// Bytes 16-19: Number of this disk
		// Bytes 20-23: Number of the disk with the start of the Central Directory
		// Bytes 24-31: Total number of entries in the Central Directory on this disk
		// Bytes 32-39: Total number of entries in the Central Directory
		// Spec: "If an archive is in ZIP64 format and the value in this field is 0xFFFF, the size
		// will be in the corresponding 8 byte zip64 end of central directory field."
		// Original Yauzl expects correct entry count to always be recorded in ZIP64 EOCDR,
		// but have altered that here to be more spec-compliant. Ditto Central Directory size + offset.
		if(this.entryCount === 0xFF_FF) {
			this.entryCount = readUInt64LE(zip64EocdrBuffer, 32);
		}

		// Bytes 40-47: Size of the Central Directory
		if(this.centralDirectorySize === 0xFF_FF_FF_FF) {
			this.centralDirectorySize = readUInt64LE(zip64EocdrBuffer, 40);
		}

		// Bytes 48-55: Offset of start of Central Directory with respect to the starting disk number
		if(this.centralDirectoryOffset === 0xFF_FF_FF_FF) {
			this.centralDirectoryOffset = readUInt64LE(zip64EocdrBuffer, 48);
		}
		// Bytes 56-...: ZIP64 extensible data sector

		// Record offset of start of footers.
		// Either start of ZIP64 EOCDR (if it butts up to ZIP64 EOCDL), or ZIP64 EOCDL.
		this.footerOffset = zip64EocdrOffset + zip64EocdrSize === zip64EocdlOffset ? zip64EocdrOffset : zip64EocdlOffset;

		return OK;
	} // }}}

	/**
	 * Locate Central Directory.
	 *
	 * In a well-formed ZIP file, the EOCDR accurately gives us the offset and size of Central
	 * Directory, and the entry count.
	 *
	 * However Mac OS Archive Utility, instead of using ZIP64 extension to record Central Directory
	 * offset or size >= 4 GiB, or entry count >= 65536, truncates size and offset to lower 32 bits,
	 * and entry count to lower 16 bits.
	 * i.e.:
	 * Actual offset = reported offset + n * (1 << 32)
	 * Actual size = reported size + m * (1 << 32)
	 * Actual entry count = reported entry count + o * (1 << 16)
	 * (where `n`, `m` and `o` are unknown)
	 *
	 * Identify if this may be a faulty Mac OS Archive Utility ZIP. If so, find the actual location of
	 * the Central Directory. Deduce which of above properties cannot be known with certainty.
	 *
	 * In some cases, it's not possible to immediately determine if a ZIP is definitely a Mac OS ZIP.
	 * If it may be, but not sure yet, record which properties are unknown at present.
	 * Later calls to `readEntry()` or `openReadStream()` will reveal more about the ZIP, and the
	 * determinaton of whether ZIP is a faulty Mac OS ZIP or not will be made then.
	 *
	 * Try to do this while ensuring a spec-compliant ZIP will never be misinterpretted.
	 */
	async _locateCentralDirectory(): Promise<Result<void, string>> { // {{{
		// Skip this if Mac OS Archive Utility support disabled
		if(!this.supportMacArchive) {
			return OK;
		}

		// Mac OS archives don't use ZIP64 extension
		if(this.isZip64) {
			return OK;
		}

		// Mac Archives do not contain comment after End of Central Directory Record
		if(this.size - this.footerOffset! !== EOCDR_WITHOUT_COMMENT_SIZE) {
			return OK;
		}

		// Mac Archives do not have gap between end of last Central Directory Header and start of EOCDR
		let centralDirectoryEnd = this.centralDirectoryOffset! + this.centralDirectorySize!;
		if(centralDirectoryEnd % FOUR_GIB !== this.footerOffset! % FOUR_GIB) {
			return OK;
		}

		// If claims to have no entries, and there's no room for any, this must be accurate.
		// Handle this here to avoid trying to read beyond end of file.
		if(this.entryCount === 0 && this.centralDirectoryOffset! + CDH_MIN_LENGTH > this.footerOffset!) {
			if(this.centralDirectorySize !== 0) {
				return err('Inconsistent Central Directory size and entry count');
			}

			return OK;
		}

		// Ensure size and entry count comply with each other and adjust if they don't
		if(this.centralDirectorySize! < this.entryCount! * CDH_MIN_LENGTH) {
			// Central Directory size is too small to contain `entryCount` entries. Must be Mac OS ZIP.
			// Check is room to grow Central Directory, and grow it up to EOCDR.
			if(centralDirectoryEnd >= this.footerOffset!) {
				return err('Inconsistent Central Directory size and entry count');
			}

			this.isMacArchive = true;
			centralDirectoryEnd = this.footerOffset!;
			this.centralDirectorySize = centralDirectoryEnd - this.centralDirectoryOffset!;
		}

		if(this._recalculateEntryCount(0, this.centralDirectoryOffset!)) {
			// Entry count was too small. Must be Mac OS ZIP.
			this.isMacArchive = true;
		}

		// Unless we already know this is a Mac ZIP, check if Central Directory is where EOCDR says it is
		// (if we know it's a Mac ZIP, better to look in last possible position first)
		let entry: EntryProperties | null = null;
		let alreadyCheckedOffset = -1;

		if(!this.isMacArchive) {
			const result = await this._readEntryAt(this.centralDirectoryOffset!);
			if(result.fails) {
				return result;
			}

			entry = result.value;

			// If found a non-Mac Central Directory Header, exit - it's not a Mac archive
			if(entry && !firstEntryMaybeMac(entry)) {
				if(this.entryCount! <= 0) {
					return err('Inconsistent Central Directory size and entry count');
				}

				// Store entry, to be used in first call to `readEntry()`, to avoid reading from file again
				this._firstEntryProps = entry;
				return OK;
			}

			alreadyCheckedOffset = this.centralDirectoryOffset!;
		}

		// If no Central Directory found where it should be, this ZIP is either:
		// 1. Valid ZIP with no entries
		// 2. Faulty Mac OS Archive Utility ZIP
		// 3. Invalid ZIP
		// If it's an invalid ZIP, all bets are off, so ignore that possibility.
		// Try to locate Central Directory in possible locations it could be if this is
		// a Mac OS Archive Utility ZIP (`centralDirectoryOffset + n * FOUR_GIB` where `n` is unknown).
		// It's more common to have a ZIP containing large files, than a ZIP with
		// so many files that the Central Directory is 4 GiB+ in size (likely requiring millions of files).
		// So start with last possible position and work backwards towards start of file.
		if(!entry) {
			// Find last possible offset for Central Directory
			let offset = this.footerOffset! - Math.max(this.centralDirectorySize!, this.entryCount! * CDH_MIN_LENGTH);

			if(offset % FOUR_GIB < this.centralDirectoryOffset!) {
				if(offset < FOUR_GIB) {
					return err('Inconsistent Central Directory size and entry count');
				}

				offset -= FOUR_GIB;
			}

			offset = (Math.floor(offset / FOUR_GIB) * FOUR_GIB) + this.centralDirectoryOffset!;

			// Search for Central Directory
			while(offset > alreadyCheckedOffset) {
				const result = await this._readEntryAt(offset);
				if(result.fails) {
					return result;
				}

				entry = result.value;

				if(entry) {
					if(!firstEntryMaybeMac(entry)) {
						return err('Cannot locate Central Directory');
					}

					this.isMacArchive = true;
					this.centralDirectoryOffset = offset;
					break;
				}

				offset -= FOUR_GIB;
			}
		}

		// If couldn't find Central Directory, it's a faulty ZIP, unless it has 0 entries
		if(!entry) {
			if(this.entryCount !== 0 || this.centralDirectorySize !== 0) {
				return err('Cannot locate Central Directory');
			}

			return OK;
		}

		// We've found Central Directory, and it is likely to be Mac OS ZIP, but we may not know for sure.
		// If reported entry count was 0, but Central Directory found, must be a Mac OS ZIP.
		if(this.entryCount === 0) {
			this.isMacArchive = true;
		}

		if(this.isMacArchive) {
			// We know for sure this is a Mac OS Archive Utility ZIP,
			// because some of the size/offset/entry count data has proved faulty.
			// Mac OS ZIPs always have Central Directory going all the way up to the EOCDR.
			centralDirectoryEnd = this.footerOffset!;
			this.centralDirectorySize = centralDirectoryEnd - this.centralDirectoryOffset!;

			if(this.centralDirectorySize <= 0) {
				return err('Inconsistent Central Directory size and entry count');
			}

			// Recalculate minimum entry count
			this._recalculateEntryCount(1, entry.entryEnd);

			// Calculate if possible for one or more files to be 4 GiB larger than reported.
			// Each entry takes at minimum 30 bytes for Local File Header + 16 bytes for Data Descriptor.
			// Mac Archives repeat same filename in Local File Header as in Central Directory.
			// Mac Archives contain 16 bytes Extra Fields in Local File Header if CDH contains an Extra Field.
			// So minimum size occupied by first file can be included in this calculation.
			const minTotalDataSize = (this.entryCount! * 46)
				+ entry.compressedSize
				+ entry.filename.length
				+ (entry.extraFields.length * MAC_LFH_EXTRA_FIELDS_LENGTH);

			if(minTotalDataSize + FOUR_GIB <= this.centralDirectoryOffset!) {
				this.compressedSizesAreCertain = false;
			}
		}
		else {
			// ZIP has Central Directory where it should be, and format of first entry is consistent
			// with this being a Mac OS ZIP, but we don't know for sure that it is
			this.isMaybeMacArchive = true;

			if(centralDirectoryEnd < this.footerOffset!) {
				// There's room for Central Directory to be 4 GiB or more bigger than reported.
				// This implies entry count is uncertain too. An extra 4 GiB could fit up to ~9 million entries.
				this.centralDirectorySizeIsCertain = false;
				this.entryCountIsCertain = false;
			}
			else {
				// Recalculate minimum entry count
				this._recalculateEntryCount(1, entry.entryEnd);
			}

			// Init set of uncertain uncompressed size entries
			this._uncertainUncompressedSizeEntryRefs = new Set();
		}

		// Check if entry count could be higher than EOCDR says it is
		if(this.entryCountIsCertain && !entryCountIsCertain(this.entryCount! - 1, centralDirectoryEnd - entry.entryEnd)) {
			this.entryCountIsCertain = false;
		}

		// Even if compressed file sizes are certain, uncompressed file sizes remain uncertain
		// because a file could be < 4 GiB compressed, but >= 4 GiB uncompressed
		this.uncompressedSizesAreCertain = false;

		// Init local file header cursor
		this._fileCursor = 0;

		// Store entry, to be used in first call to `readEntry()`, to avoid reading from file again
		this._firstEntryProps = entry;

		return OK;
	} // }}}

	/**
	 * Get next entry.
	 */
	async readEntry(): Promise<Result<Entry | null, string>> { // {{{
		if(this._isReading) {
			return err('Cannot call `readEntry()` before previous call\'s promise has settled');
		}

		this._isReading = true;

		const result = await this._readEntry();

		this._isReading = false;

		return result;
	} // }}}

	/**
	 * Get next entry.
	 * Implementation for `readEntry()`. Should not be called directly.
	 */
	async _readEntry(): Promise<Result<Entry | null, string>> { // {{{
		if(this.numEntriesRead === this.entryCount && this.entryCountIsCertain) {
			return OK_NULL;
		}

		// Read Central Directory entry properties (or use the one already read)
		let entryProperties = this._firstEntryProps;
		let entryEnd: number;
		if(entryProperties) {
			this._firstEntryProps = null;
			entryEnd = entryProperties.entryEnd;
		}
		else {
			const entryPropertiesResult = await this._readEntryAt(this._entryCursor!);
			if(entryPropertiesResult.fails) {
				return entryPropertiesResult;
			}

			const centralDirectoryEnd = this.centralDirectoryOffset! + this.centralDirectorySize!;

			entryProperties = entryPropertiesResult.value;

			if(entryProperties === null) {
				// Only way to get here if the ZIP file isn't corrupt is if Central Directory size wasn't
				// certain, and therefore entry count wasn't certain either, so we weren't sure if this was
				// the end or not. If we've reached end of reported entries, and are at end of reported
				// Central Directory, then there being no entry means the Central Directory entry size
				// and entry count are accurate, and this is indeed the end.
				// That implies this can't be a Mac ZIP, because Central Directory doesn't go up to EOCDR.
				// NB: No need to check for `this.centralDirectorySizeIsCertain === false` because if that
				// was the case, `this.entryCountIsCertain` would be `false` too, and we wouldn't be here.
				if(this.isMacArchive || this.numEntriesRead !== this.entryCount || this._entryCursor !== centralDirectoryEnd) {
					return err('Invalid Central Directory File Header signature');
				}

				// `isMaybeMacArchive` must have been `true` at start of this function, but check it here
				// just in case it was already changed in a call to `openReadStream()` made by user while async
				// `_readEntryAt()` call above was executing.
				if(this.isMaybeMacArchive) {
					this._setAsNotMacArchive();
				}

				return OK_NULL;
			}

			entryEnd = entryProperties.entryEnd;

			if(this.isMacArchive) {
				// Properties have been found to be inconsistent already, signalling a Mac OS ZIP.
				// So all entries must be Mac-type, or it isn't a Mac ZIP after all, and is corrupt.
				// File data is tightly packed in Mac OS ZIPs with no gaps in between.
				if(!entryMaybeMac(entryProperties) || entryProperties.fileHeaderOffset !== this._fileCursor! % FOUR_GIB
				) {
					return err('Inconsistent Central Directory structure');
				}

				entryProperties.fileHeaderOffset = this._fileCursor!;

				if(!this.entryCountIsCertain) {
					this._recalculateEntryCount(this.numEntriesRead + 1, entryEnd);
					this._recalculateEntryCountIsCertain(this.numEntriesRead + 1, entryEnd);
				}
			}
			else if(this.isMaybeMacArchive) {
				if(this._fileCursor! >= FOUR_GIB) {
					// This ZIP is flagged as maybe Mac which means all data up to `_fileCursor`
					// has been consumed by previous files.
					// `fileHeaderOffset` is 32 bit (so < 4 GiB), and `_fileCursor` > 4 GiB, so either
					// 1. file data for this entry covers data already consumed (invalid, possible ZIP bomb)
					// or 2. this must be a Mac ZIP and `fileHeaderOffset` is more than stated.
					if(!entryMaybeMac(entryProperties) || entryProperties.fileHeaderOffset !== this._fileCursor! % FOUR_GIB) {
						return err('Inconsistent Central Directory structure');
					}

					this._setAsMacArchive(this.numEntriesRead + 1, entryEnd);
				}
				else if(!entryMaybeMac(entryProperties) || entryProperties.fileHeaderOffset !== this._fileCursor!) {
					// Entry doesn't match signature of Mac entries, or file header is not where it would be
					// in a Mac ZIP, so it can't be one
					this._setAsNotMacArchive();

					// If entries were meant to be exhausted, there's an error somewhere
					if(this.numEntriesRead === this.entryCount) {
						return err('Central Directory contains too many entries');
					}
				}
				else if(!this.centralDirectorySizeIsCertain && (
					entryEnd + ((this.entryCount! - this.numEntriesRead - 1) * CDH_MIN_LENGTH) > centralDirectoryEnd
				)) {
					// Not enough space in Central Directory for number of entries remaining,
					// so this must be a Mac ZIP. Grow Central Directory.
					this._setAsMacArchive(this.numEntriesRead + 1, entryEnd);
				}
				else if(!this.entryCountIsCertain) {
					// Recalculate if entry count is now impossibly low
					if(this._recalculateEntryCount(this.numEntriesRead + 1, entryEnd)) {
						// Entry count was impossibly low for size of Central Directory so this must be Mac ZIP
						this._setAsMacArchive(this.numEntriesRead + 1, entryEnd);
					}
					else if(this.centralDirectorySizeIsCertain) {
						// Check if entry count is now high enough vs remaining Central Directory space
						// that it can't be any larger
						this._recalculateEntryCountIsCertain(this.numEntriesRead + 1, entryEnd);
					}
				}
			}
		}

		// Calculate what location of file data will be if this is a Mac OS ZIP.
		// Mac OS ZIPs always contain Local File Header of 30 bytes
		// + same filename as in Central Directory entry
		// + 16 bytes Extra Fields if Central Directory entry has extra fields.
		const fileDataOffsetIfMac = entryProperties.fileHeaderOffset
			+ 30
			+ entryProperties.filename.length
			+ (entryProperties.extraFields.length * MAC_LFH_EXTRA_FIELDS_LENGTH);

		// Determine if possible for compressed data to be larger than reported,
		// and, if so, the actual compressed size
		if(!this.compressedSizesAreCertain) {
			const isNowCertain = await this._determineCompressedSize(entryProperties, fileDataOffsetIfMac);
			if(isNowCertain.fails) {
				return isNowCertain;
			}

			if(isNowCertain.value) {
				this.compressedSizesAreCertain = true;
			}
		}

		// Determine if possible for this entry's uncompressed size to be larger than reported
		if(!this.uncompressedSizesAreCertain) {
			if(entryProperties.compressionMethod === 0) {
				// No compression - uncompressed size always equal to compressed.
				// NB: We know encryption is not enabled as entry would have been flagged as non-Mac if it was.
				entryProperties.uncompressedSize = entryProperties.compressedSize;
			}
			else if(entryProperties.compressionMethod === 8) {
				// Deflate compression. Maximum compression ratio is 1032.
				// https://stackoverflow.com/questions/16792189/gzip-compression-ratio-for-zeros/16794960#16794960
				const maxUncompressedSize = entryProperties.compressedSize * 1032;

				if(
					maxUncompressedSize > FOUR_GIB * 2
					|| (
						maxUncompressedSize > FOUR_GIB
						&& maxUncompressedSize % FOUR_GIB > entryProperties.uncompressedSize
					)
				) {
					entryProperties.uncompressedSizeIsCertain = false;
				}
			}
			else {
				// Not Deflate compression - no idea what uncompressed size could be
				entryProperties.uncompressedSizeIsCertain = false;
			}
		}

		const entryResult = this._validateAndDecodeEntry(entryProperties);
		if(entryResult.fails) {
			return entryResult;
		}

		const entry = entryResult.value;

		this._entryCursor = entryEnd;
		this.numEntriesRead++;

		if(this.isMacArchive || this.isMaybeMacArchive) {
			// Record offset of where next Local File Header will be if this is a Mac OS ZIP.
			// 16 bytes for Data Descriptor after file data, unless it's a folder, empty file, or symlink.
			const dataDescriptorLength = entryProperties.compressionMethod === 8 ? 16 : 0;
			this._fileCursor = fileDataOffsetIfMac + entry.compressedSize + dataDescriptorLength;

			if(this.isMacArchive) {
				// We know offset of file data for sure, so record it
				entry.fileDataOffset = fileDataOffsetIfMac;
			}
			else if(!entry.uncompressedSizeIsCertain) {
				// This is a suspected Mac OS ZIP (but not for sure), and uncompressed size is uncertain.
				// Record entry, so that if ZIP turns out not to be a Mac OS ZIP later,
				// `uncompressedSizeIsCertain` can be changed to `true`.
				// Entries are recorded as `WeakRef`s, to allow them to be garbage collected.
				// The entry is also added to a `FinalizationRegistry`, which removes the ref from the set
				// when entry object is garbage collected. This should prevent escalating memory usage
				// if lots of entries.
				const references = this._uncertainUncompressedSizeEntryRefs;
				if(!references) {
					return err('Logic failure. Please raise an issue.');
				}

				const reference = new WeakRef(entry);
				entry._ref = reference;
				references.add(reference);
				uncertainUncompressedSizeEntriesRegistry.register(entry, { zip: this, ref: reference }, reference);
			}
		}

		return ok(entry);
	} // }}}

	/**
	 * Determine actual compressed size of entry.
	 * Update `compressedSize` if it's not what was reported.
	 * Return whether *all future* entries have certain compressed size.
	 *
	 * This method should only be called if this is a Mac ZIP, or possibly a Mac ZIP.
	 * i.e. Compressed sizes are not certain to be as reported in the ZIP.
	 *
	 * First attempt to prove that size can be known with certainty without reading from ZIP file.
	 * If that's not possible, search ZIP file for the Data Descriptor which follows file data.
	 *
	 * Care has to be taken to avoid data races, because this function contains async IO calls,
	 * and possible for user to call `openReadStream()` on another Entry, or an event on a stream
	 * already in process to cause the ZIP to be identified as definitely Mac or definitely not Mac
	 * during this function's async calls.
	 */
	async _determineCompressedSize(entryProperties: EntryProperties, fileDataOffsetIfMac: number): Promise<Result<boolean, string>> { // {{{
		// ZIP may only be a suspected Mac OS ZIP, rather than definitely one.
		// However, we can assume it is a Mac ZIP for purposes of calculations here,
		// as if actually it's not, compressed size of all entries is certain anyway.
		//
		// In a Mac ZIP:
		// - Files (unless empty) are compressed and have Data Descriptor and Extra Fields.
		//   Size may be incorrect - truncated to lower 32 bits.
		// - Folders and empty files are not compressed and have no Data Descriptor,
		//   but do have Extra Fields.
		//   Size = 0.
		// - Symlinks are not compressed and have no Data Descriptor or Extra Fields.
		//   Size assumed under 4GiB as file content is just path to linked file.
		//
		// So we can know exact end point of this entry's data section (unless it's 4 GiB larger),
		// and all other entries yet to come must use 30 bytes each at minimum.
		let numEntriesRemaining = this.entryCount! - this.numEntriesRead - 1;
		let dataSpaceRemaining = this.centralDirectoryOffset! - fileDataOffsetIfMac
			- entryProperties.compressedSize - (entryProperties.compressionMethod === 8 ? 16 : 0);

		// Check if not enough data space left for this entry or any later entry
		// to be 4 GiB larger than reported
		if(dataSpaceRemaining - (numEntriesRemaining * 30) < FOUR_GIB) {
			return OK_TRUE;
		}

		if(this.isMacArchive && numEntriesRemaining === 0) {
			// Last entry in Mac ZIP - must use all remaining space.
			// We can trust `entryCount` at this point, as it would have been increased
			// if there was excess space in the Central Directory.
			// We cannot assume file takes up all remaining space if we don't know for sure that
			// this is a Mac ZIP, because if it's not, it would be legitimate as per the ZIP spec
			// to have unused space between end of file data and the Central Directory.
			if(dataSpaceRemaining % FOUR_GIB !== 0) {
				return err('Invalid ZIP structure for Mac OS Archive Utility ZIP');
			}

			entryProperties.compressedSize += dataSpaceRemaining;

			return OK_TRUE;
		}

		if(entryProperties.compressionMethod === 0) {
			// If this is a Mac ZIP, entry is a folder, empty file, or symlink (see `entryMaybeMac()` below).
			// Folders and empty files definitely have 0 size.
			// We have to assume symlinks are under 4 GiB because they have no data descriptor after to
			// search for (and what kind of maniac uses a symlink bigger than 4 GiB anyway?).
			// If it's not a Mac ZIP, reported compressed size will be accurate.
			// So either way, we know size is correct.
			// Return `false`, because compressed size of later files may still be larger than reported.
			return OK_FALSE;
		}

		// Compressed size is not certain.
		// Search for Data Descriptor after file data.
		// It could be where it's reported to be, or anywhere after that in 4 GiB jumps.
		let fileDataEnd: number | null = fileDataOffsetIfMac + entryProperties.compressedSize;

		// eslint-disable-next-line no-constant-condition
		while(true) {
			const bufferResult = await this.reader.read(fileDataEnd, 20);
			if(bufferResult.fails) {
				return bufferResult;
			}

			const buffer = bufferResult.value;

			if(
				buffer.readUInt32LE(0) === 0x08_07_4B_50 // Data Descriptor signature
				&& buffer.readUInt32LE(4) === entryProperties.crc32
				&& buffer.readUInt32LE(8) === entryProperties.compressedSize
				&& buffer.readUInt32LE(12) === entryProperties.uncompressedSize
				&& (
					buffer.readUInt32LE(16) === 0x04_03_4B_50 // Local File Header signature
					|| fileDataEnd + 16 === this.centralDirectoryOffset // Last entry
				)
			) {
				break;
			}

			// During async `read()` call above, if user called `openReadStream()` on another entry,
			// it could have discovered this isn't a Mac ZIP after all.
			// If so, stop searching for data descriptor.
			if(this.compressedSizesAreCertain) {
				fileDataEnd = null;
				break;
			}

			fileDataEnd += FOUR_GIB;
			if(fileDataEnd + 16 > this.centralDirectoryOffset!) {
				// Data Descriptor not found
				fileDataEnd = null;
				break;
			}
		}

		if(fileDataEnd === null) {
			// Could not find Data Descriptor, so this can't be a Mac ZIP
			if(this.isMacArchive) {
				return err('Cannot locate file Data Descriptor');
			}

			// Have to check `isMaybeMacArchive` again, as could have changed during async calls
			// to `read()` above, if `openReadStream()` was called and found this isn't a Mac ZIP after all
			if(this.isMaybeMacArchive) {
				this._setAsNotMacArchive();
			}

			return OK_TRUE;
		}

		if(fileDataEnd === fileDataOffsetIfMac + entryProperties.compressedSize) {
			// Compressed size is what was stated. So size of later entries is still uncertain.
			return OK_FALSE;
		}

		// Size is larger than stated, so this must be Mac ZIP
		if(!this.isMacArchive) {
			// Have to check `isMaybeMacArchive` again, as could have changed during async calls
			// to `read()` above, if `openReadStream()` was called and found this isn't a Mac ZIP after all
			if(!this.isMaybeMacArchive) {
				return err('Cannot locate file Data Descriptor');
			}

			this._setAsMacArchive(this.numEntriesRead + 1, entryProperties.entryEnd);
		}

		entryProperties.compressedSize = fileDataEnd - fileDataOffsetIfMac;

		// Check if there's now not enough data space left after this entry for any later entry
		// to be 4 GiB larger than reported.
		// Need to recalculate `numEntriesRemaining` as `entryCount` could have changed.
		// That could happen in `_setAsMacArchive()` call above. Or there's also a possible race
		// if another entry is being streamed at the moment, and that stream happened to exceed
		// its reported uncompressed size. That could happen during async `read()` calls above,
		// and would also cause a call to `_setAsMacArchive()`.
		// More obviously, `dataSpaceRemaining` has to be recalculated too,
		// as initial `fileDataEnd` may have been found to be inaccurate.
		numEntriesRemaining = this.entryCount! - this.numEntriesRead - 1;
		dataSpaceRemaining = this.centralDirectoryOffset! - fileDataEnd - 16;

		return ok(dataSpaceRemaining - (numEntriesRemaining * 30) < FOUR_GIB);
	} // }}}

	/**
	 * Attempt to read Central Directory Header at offset.
	 * Returns properties of entry. Does not decode strings or validate file sizes.
	 */
	async _readEntryAt(offset: number): Promise<Result<EntryProperties | null, string>> { // {{{
		// Bytes 0-3: Central Directory File Header signature
		if(offset + CDH_MIN_LENGTH > this.footerOffset!) {
			return err('Invalid Central Directory File Header');
		}

		const entryBufferResult = await this.reader.read(offset, CDH_MIN_LENGTH);
		if(entryBufferResult.fails) {
			return entryBufferResult;
		}

		const entryBuffer = entryBufferResult.value;
		if(entryBuffer.readUInt32LE(0) !== 0x02_01_4B_50) {
			return OK_NULL;
		}

		// Bytes 4-5: Version made by
		const versionMadeBy = entryBuffer.readUInt16LE(4);
		// Bytes 6-7: Version needed to extract (minimum)
		const versionNeededToExtract = entryBuffer.readUInt16LE(6);
		// Bytes 8-9: General Purpose Bit Flag
		const generalPurposeBitFlag = entryBuffer.readUInt16LE(8);
		// Bytes 10-11: Compression method
		const compressionMethod = entryBuffer.readUInt16LE(10);
		// Bytes 12-13: File last modification time
		const lastModTime = entryBuffer.readUInt16LE(12);
		// Bytes 14-15: File last modification date
		const lastModDate = entryBuffer.readUInt16LE(14);
		// Bytes 16-17: CRC32
		const crc32 = entryBuffer.readUInt32LE(16);
		// Bytes 20-23: Compressed size
		let compressedSize = entryBuffer.readUInt32LE(20);
		// Bytes 24-27: Uncompressed size
		let uncompressedSize = entryBuffer.readUInt32LE(24);
		// Bytes 28-29: Filename length
		const filenameLength = entryBuffer.readUInt16LE(28);
		// Bytes 30-31: Extra field length
		const extraFieldLength = entryBuffer.readUInt16LE(30);
		// Bytes 32-33: File comment length
		const commentLength = entryBuffer.readUInt16LE(32);
		// Bytes 34-35: Disk number where file starts
		// Bytes 36-37: Internal file attributes
		const internalFileAttributes = entryBuffer.readUInt16LE(36);
		// Bytes 38-41: External file attributes
		const externalFileAttributes = entryBuffer.readUInt32LE(38);
		// Bytes 42-45: Relative offset of Local File Header
		let fileHeaderOffset = entryBuffer.readUInt32LE(42);

		if((generalPurposeBitFlag & 0x40) !== 0) {
			return err('Strong encryption is not supported');
		}

		// Get filename
		const extraDataOffset = offset + CDH_MIN_LENGTH;
		const extraDataSize = filenameLength + extraFieldLength + commentLength;
		const entryEnd = extraDataOffset + extraDataSize;

		if(entryEnd > this.footerOffset!) {
			return err('Invalid Central Directory File Header');
		}

		const extraBufferResult = await this.reader.read(extraDataOffset, extraDataSize);
		if(extraBufferResult.fails) {
			return extraBufferResult;
		}

		const extraBuffer = extraBufferResult.value;
		const filename = extraBuffer.subarray(0, filenameLength);
		const commentStart = filenameLength + extraFieldLength;
		const extraFieldBuffer = extraBuffer.subarray(filenameLength, commentStart);
		const extraFields: ExtraField[] = [];
		let i = 0;
		let zip64EiefBuffer: Buffer | undefined;

		while(i < extraFieldBuffer.length - 3) {
			const headerId = extraFieldBuffer.readUInt16LE(i);
			const dataSize = extraFieldBuffer.readUInt16LE(i + 2);
			const dataStart = i + 4;
			const dataEnd = dataStart + dataSize;

			if(dataEnd > extraFieldBuffer.length) {
				return err('Extra field length exceeds extra field buffer size');
			}

			const dataBuffer = extraFieldBuffer.subarray(dataStart, dataEnd);
			extraFields.push({ id: headerId, data: dataBuffer });
			i = dataEnd;

			if(headerId === 1) {
				zip64EiefBuffer = dataBuffer;
			}
		}

		// Get file comment
		const comment = extraBuffer.subarray(commentStart, extraDataSize);

		// Handle ZIP64
		const isZip64 = uncompressedSize === 0xFF_FF_FF_FF || compressedSize === 0xFF_FF_FF_FF || fileHeaderOffset === 0xFF_FF_FF_FF;
		if(isZip64) {
			if(!zip64EiefBuffer) {
				return err('Expected ZIP64 Extended Information Extra Field');
			}

			// @overlookmotel: According to the spec, I'd expect all 3 of these fields to be present,
			// but Yauzl's implementation makes them optional.
			// There may be a good reason for this, so leaving it as in Yauzl's implementation.
			let index = 0;

			// 8 bytes: Uncompressed size
			if(uncompressedSize === 0xFF_FF_FF_FF) {
				if(index + 8 > zip64EiefBuffer.length) {
					return err('ZIP64 Extended Information Extra Field does not include uncompressed size');
				}

				uncompressedSize = readUInt64LE(zip64EiefBuffer, index);
				index += 8;
			}

			if(compressedSize === 0xFF_FF_FF_FF) {
				if(index + 8 > zip64EiefBuffer.length) {
					return err('ZIP64 Extended Information Extra Field does not include compressed size');
				}

				compressedSize = readUInt64LE(zip64EiefBuffer, index);
				index += 8;
			}

			if(fileHeaderOffset === 0xFF_FF_FF_FF) {
				if(index + 8 > zip64EiefBuffer.length) {
					return err('ZIP64 Extended Information Extra Field does not include relative header offset');
				}

				fileHeaderOffset = readUInt64LE(zip64EiefBuffer, index);
			}
		}

		if(fileHeaderOffset + 30 > this.footerOffset!) {
			return err('Invalid location for file data');
		}

		return ok({
			filename,
			compressedSize,
			uncompressedSize,
			uncompressedSizeIsCertain: true, // May not be correct - may be set to `false` in `readEntry()`
			compressionMethod,
			fileHeaderOffset,
			fileDataOffset: null,
			isZip64,
			crc32,
			lastModTime,
			lastModDate,
			comment,
			extraFields,
			versionMadeBy,
			versionNeededToExtract,
			generalPurposeBitFlag,
			internalFileAttributes,
			externalFileAttributes,
			filenameLength,
			entryEnd,
		});
	} // }}}

	/**
	 * Update `entryCount` if it's lower than is possible for it to be.
	 */
	_recalculateEntryCount(numEntriesRead: number, entryCursor: number): boolean { // {{{
		const numEntriesRemaining = this.entryCount! - numEntriesRead;
		const centralDirectoryRemaining = this.centralDirectoryOffset! + this.centralDirectorySize! - entryCursor;
		const entryMaxLength = this.isMacArchive ? CDH_MAX_LENGTH_MAC : CDH_MAX_LENGTH;

		if(numEntriesRemaining * entryMaxLength >= centralDirectoryRemaining) {
			return false;
		}

		// Entry count can't be right.
		// This must be a Mac Archive, so we calculate minimum entry count based on
		// max length of entries in Mac OS ZIPs (which is less than for non-Mac entries).
		const minEntriesRemaining = Math.ceil(centralDirectoryRemaining / CDH_MAX_LENGTH_MAC);
		this.entryCount! += (minEntriesRemaining - numEntriesRemaining + 0xFF_FF) & 0x1_00_00;

		return true;
	} // }}}

	/**
	 * Update `entryCountIsCertain` if it's impossible for entry count to be 65536 larger than
	 * current `entryCount` without exceeding bounds of Central Directory.
	 * This calculation is only valid if size of Central Directory is certain,
	 * so must only be called if `centralDirectorySizeIsCertain` is `true`.
	 */
	_recalculateEntryCountIsCertain(numEntriesRead: number, entryCursor: number): void { // {{{
		const numEntriesRemaining = this.entryCount! - numEntriesRead;
		const centralDirectoryRemaining = this.centralDirectoryOffset! + this.centralDirectorySize! - entryCursor;

		if(entryCountIsCertain(numEntriesRemaining, centralDirectoryRemaining)) {
			this.entryCountIsCertain = true;
		}
	} // }}}

	/**
	 * Suspected Mac OS Archive Utility ZIP has turned out to definitely be one.
	 * Flag as Mac ZIP and calculate Central Directory size if it was ambiguous previously.
	 * Recalculate minimum entry count and whether it's now certain.
	 */
	_setAsMacArchive(numEntriesRead: number, entryCursor: number): void { // {{{
		this.isMacArchive = true;
		this.isMaybeMacArchive = false;

		if(!this.centralDirectorySizeIsCertain) {
			this.centralDirectorySize = this.footerOffset! - this.centralDirectoryOffset!;
			this.centralDirectorySizeIsCertain = true;
		}

		// Recalculate minimum entry count + whether entry count is certain
		if(!this.entryCountIsCertain) {
			this._recalculateEntryCount(numEntriesRead, entryCursor);
			this._recalculateEntryCountIsCertain(numEntriesRead, entryCursor);
		}

		// Clear set of uncertain uncompressed size entries
		const references = this._uncertainUncompressedSizeEntryRefs;
		if(references) {
			for(const reference of references) {
				uncertainUncompressedSizeEntriesRegistry.unregister(reference);
				const entry = reference.deref();
				if(entry) {
					entry._ref = null;
				}
			}
		}

		this._uncertainUncompressedSizeEntryRefs = null;
	} // }}}

	/**
	 * Suspected Mac OS Archive Utility ZIP has turned out not to be one.
	 * Reset flags.
	 */
	_setAsNotMacArchive(): void { // {{{
		this.isMaybeMacArchive = false;
		this.entryCountIsCertain = true;
		this.centralDirectorySizeIsCertain = true;
		this.compressedSizesAreCertain = true;
		this.uncompressedSizesAreCertain = true;
		this._fileCursor = null;

		// Flag all entries flagged as having uncertain uncompressed size as now having certain size
		const references = this._uncertainUncompressedSizeEntryRefs;
		if(references) {
			for(const reference of references) {
				uncertainUncompressedSizeEntriesRegistry.unregister(reference);
				const entry = reference.deref();
				if(entry) {
					entry._ref = null;
					entry.uncompressedSizeIsCertain = true;
				}
			}
		}

		this._uncertainUncompressedSizeEntryRefs = null;
	} // }}}

	/**
	 * Convert entry properties returned from `_readEntryAt()` to a full `Entry` object.
	 * Decode strings and validate entry size according to options.
	 */
	_validateAndDecodeEntry(entry: EntryProperties): Result<Entry, string> { // {{{
		if(this.decodeStrings) {
			// Check for Info-ZIP Unicode Path Extra Field (0x7075).
			// See: https://github.com/thejoshwolfe/yauzl/issues/33
			let filename: string | undefined;
			for(const extraField of entry.extraFields) {
				if(extraField.id !== 0x70_75) {
					continue;
				}

				if(extraField.data.length < 6) {
					continue;
				} // Too short to be meaningful

				// Check version is 1. "Changes may not be backward compatible so this extra
				// field should not be used if the version is not recognized."
				if(extraField.data[0] !== 1) {
					continue;
				}

				// Check CRC32 matches original filename.
				// "The NameCRC32 is the standard zip CRC32 checksum of the File Name
				// field in the header. This is used to verify that the header
				// File Name field has not changed since the Unicode Path extra field
				// was created. This can happen if a utility renames the File Name but
				// does not update the UTF-8 path extra field. If the CRC check fails,
				// this UTF-8 Path Extra Field SHOULD be ignored and the File Name field
				// in the header SHOULD be used instead."
				const oldNameCrc32 = extraField.data.readUInt32LE(1);

				if(calculateCrc32(entry.filename) !== oldNameCrc32) {
					continue;
				}

				filename = decodeBuffer(extraField.data, 5, true);
				break;
			}

			// Decode filename
			const isUtf8 = (entry.generalPurposeBitFlag & 0x8_00) !== 0;

			if(filename === undefined) {
				if(isString(entry.filename)) {
					filename = entry.filename;
				}
				else {
					filename = decodeBuffer(entry.filename, 0, isUtf8);
				}
			}

			// Validate filename
			if(this.validateFilenames) {
				// Allow backslash if `strictFilenames` option disabled
				if(!this.strictFilenames) {
					filename = filename.replaceAll('\\', '/');
				}

				const filenameResult = validateFilename(filename);
				if(filenameResult.fails) {
					return filenameResult;
				}
			}

			entry.filename = filename;

			// Clone Extra Fields buffers, so rest of buffer that they're sliced from
			// (which also contains strings which are now decoded) can be garbage collected
			for(const extraField of entry.extraFields) {
				extraField.data = Buffer.from(extraField.data);
			}

			// Decode comment
			if(typeof entry.comment !== 'string') {
				entry.comment = decodeBuffer(entry.comment, 0, isUtf8);
			}
		}

		// Validate file size
		if(this.validateEntrySizes && entry.compressionMethod === 0) {
			// Lowest bit of General Purpose Bit Flag is for traditional encryption.
			// Traditional encryption prefixes the file data with a header.
			const expectedCompressedSize = (entry.generalPurposeBitFlag & 0x1) ? entry.uncompressedSize + 12 : entry.uncompressedSize;

			if(entry.compressedSize !== expectedCompressedSize) {
				return err(`Compressed/uncompressed size mismatch for stored file: ${entry.compressedSize} !== ${expectedCompressedSize}`);
			}
		}

		// Create `Entry` object
		const { entryEnd, ...rest } = entry;
		const normalizedEntry = {
			...rest,
			zip: this,
			_ref: null,
		} as unknown as EntryConstructorProperties;

		return ok(new Entry(normalizedEntry));
	} // }}}

	/**
	 * Read multiple entries.
	 * If `numEntries` is provided, will read at maximum that number of entries.
	 * Otherwise, reads all entries.
	 * @async
	 * @param {number} [numEntries] - Number of entries to read
	 * @returns {Array<Entry>} - Array of entries
	 */
	async readEntries(numEntries?: number): Promise<Result<Entry[], string>> { // {{{
		if(numEntries === undefined) {
			numEntries = Infinity;
		}
		else if(!isPositiveIntegerOrZero(numEntries)) {
			return err('`numEntries` must be a positive integer if provided');
		}

		const entries: Entry[] = [];
		for(let i = 0; i < numEntries; i++) {
			const entryResult = await this.readEntry();
			if(entryResult.fails) {
				return entryResult;
			}

			const entry = entryResult.value;
			if(!entry) {
				break;
			}

			entries.push(entry);
		}

		return ok(entries);
	} // }}}

	/**
	 * Get async iterator for entries.
	 * Usage: `for await (const entry of zip) { ... }`
	 */
	[Symbol.asyncIterator]() { // {{{
		let exhausted = false;

		return {
			next: async () => {
				if(exhausted) {
					return { value: OK_NULL, done: true };
				}

				const entryResult = await this.readEntry();

				if(entryResult.fails) {
					exhausted = true;
					return { value: entryResult, done: false };
				}

				if(entryResult.value === null) {
					exhausted = true;
					return { value: entryResult, done: true };
				}

				return { value: entryResult, done: false };
			},
		};
	} // }}}

	/**
	 * Get readable stream for file data.
	 */
	async openReadStream(entry: Entry, options?: OpenReadStreamOptions): Promise<Result<Readable, string>> { // {{{
		if(!(entry instanceof Entry)) {
			return err('`entry` must be an instance of `Entry`');
		}

		if(entry.zip !== this) {
			return err('`entry` must be an `Entry` from this ZIP file');
		}

		return entry.openReadStream(options);
	} // }}}
}

/**
 * Determine if entry count is certain.
 * i.e. `centralDirectorySize` bytes could not fit 65536 more entries than stated.
 */
function entryCountIsCertain(entryCount: number, centralDirectorySize: number): boolean { // {{{
	return (entryCount + 0x1_00_00) * CDH_MIN_LENGTH > centralDirectorySize;
} // }}}

/**
 * Check if first entry may be a Mac OS Archive Utility entry,
 * according to various distinguishing characteristics.
 */
function firstEntryMaybeMac(entry: EntryProperties): boolean { // {{{
	// First file always starts at byte 0
	if(entry.fileHeaderOffset !== 0) {
		return false;
	}

	return entryMaybeMac(entry);
} // }}}

/**
 * Check if entry may be a Mac OS Archive Utility entry,
 * according to various distinguishing characteristics.
 */
function entryMaybeMac(entry: EntryProperties): boolean { // {{{
	// Entries always have this `versionMadeBy` value
	if(entry.versionMadeBy !== 789) {
		return false;
	}

	// Entries never have comments
	if(entry.comment.length > 0) {
		return false;
	}

	// Entries never have ZIP64 headers
	if(entry.isZip64) {
		return false;
	}

	// Check various attributes for files, folders and symlinks
	if(entry.versionNeededToExtract === 20) {
		// File
		if(
			entry.generalPurposeBitFlag !== 8 || entry.compressionMethod !== 8 || endsWithSlash(entry.filename)
		) {
			return false;
		}
	}
	else if(entry.versionNeededToExtract === 10) {
		// Folder, empty file, or symlink
		if(
			entry.generalPurposeBitFlag !== 0 || entry.compressionMethod !== 0
			|| entry.uncompressedSize !== entry.compressedSize
		) {
			return false;
		}

		if(entry.extraFields.length === 0) {
			// Symlink
			if(entry.compressedSize === 0 || endsWithSlash(entry.filename)) {
				return false;
			}

			// Symlinks have no Extra Fields, so skip the check below.
			// It is probably a Mac Archive Utility ZIP file.
			return true;
		}

		// Folder or empty file
		if(entry.compressedSize !== 0 || entry.crc32 !== 0) {
			return false;
		}
	}
	else {
		// Unrecognised
		return false;
	}

	// Files + folders always have 1 Extra Field with certain id and length
	if(
		entry.extraFields.length !== 1
		|| entry.extraFields[0].id !== MAC_CDH_EXTRA_FIELD_ID
		|| entry.extraFields[0].data.length !== MAC_CDH_EXTRA_FIELD_LENGTH
	) {
		return false;
	}

	// It is probably a Mac Archive Utility ZIP file
	return true;
} // }}}

/**
 * Determine if filename (as undecoded buffer) ends with a slash.
 */
function endsWithSlash(filename: EntryFilename): boolean { // {{{
	// Code for '/' is 47 in both CP437 and UTF8
	return filename.at(-1) === 47;
} // }}}
