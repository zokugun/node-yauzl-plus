import { pipeline, type Readable, Transform, type TransformCallback } from 'node:stream';
import { createInflateRaw, crc32 as calculateCrc32 } from 'node:zlib';
import { isBoolean, isNumber, isPositiveInteger, isPositiveIntegerOrZero, isRecord } from '@zokugun/is-it-type';
import { err, ok, type Result } from '@zokugun/xtry';
import { uncertainUncompressedSizeEntriesRegistry } from './shared.js';
import { type EntryFilename, type EntryProperties, type ExtraField, type OpenReadStreamOptions } from './types.js';
import { dosDateTimeToDate } from './utils/dos-date-time-to-date.js';
import { type Zip } from './zip.js';

const MAC_LFH_EXTRA_FIELDS_LENGTH = 16;
const FOUR_GIB = 0x1_00_00_00_00; // Math.pow(2, 32)

export class Entry {
	declare filename: EntryFilename;
	declare compressedSize: number;
	declare uncompressedSize: number;
	declare uncompressedSizeIsCertain: boolean;
	declare compressionMethod: number;
	declare fileHeaderOffset: number;
	declare fileDataOffset: number | null;
	declare isZip64: boolean;
	declare crc32: number;
	declare lastModTime: number;
	declare lastModDate: number;
	declare comment: string | Buffer;
	declare extraFields: ExtraField[];
	declare versionMadeBy: number;
	declare versionNeededToExtract: number;
	declare generalPurposeBitFlag: number;
	declare internalFileAttributes: number;
	declare externalFileAttributes: number;
	declare filenameLength: number;
	declare zip: Zip;
	declare _ref: WeakRef<Entry> | null;

	/**
	 * Class representing ZIP file entry.
	 * Class is exported in public interface, for purpose of `instanceof` checks, but constructor cannot
	 * be called by user. This is enforced by use of private symbol `INTERNAL_SYMBOL`.
	 * @class
	 */
	constructor(properties: EntryProperties) {
		Object.assign(this, properties);
	}

	/**
	 * Get last modified date as JS `Date` object.
	 */
	getLastModified(): Date {
		return dosDateTimeToDate(this.lastModDate, this.lastModTime);
	}

	/**
	 * Get if entry is encrypted.
	 */
	isEncrypted(): boolean {
		return (this.generalPurposeBitFlag & 0x1) !== 0;
	}

	/**
	 * Get if file data is compressed.
	 * Differs slightly from Yauzl's implementation, which only returns `true` if compression method
	 * is deflate. This returns `true` if it's compressed with *any* compression method.
	 */
	isCompressed(): boolean {
		return this.compressionMethod !== 0;
	}

	/**
	 * Get readable stream for file data.
	 */
	async openReadStream(options?: OpenReadStreamOptions): Promise<Result<Readable, string>> {
		let decompress: boolean;
		let decrypt: boolean;
		let validateCrc32: boolean;
		let start: number;
		let end: number;

		const isEncrypted = this.isEncrypted();
		const isCompressed = this.isCompressed();

		if(options) {
			if(!isRecord(options)) {
				return err('`options` must be an object if provided');
			}

			if(isBoolean(options.decompress)) {
				decompress = options.decompress && isCompressed;
			}
			else {
				decompress = isCompressed;
			}

			if(isBoolean(options.decrypt)) {
				decrypt = options.decrypt && isEncrypted;
			}
			else {
				decrypt = isEncrypted;
			}

			if(isBoolean(options.validateCrc32)) {
				if(options.validateCrc32 && decompress) {
					return err('Cannot validate CRC32 for uncompressed data');
				}

				({ validateCrc32 } = options);
			}
			else {
				validateCrc32 = !decompress;
			}

			if(isNumber(options.start)) {
				({ start } = options);

				if(start !== 0) {
					if(!isPositiveInteger(start)) {
						return err('`options.start` must be a positive integer if provided');
					}

					if(decompress) {
						return err('Cannot stream a section of file if decompressing');
					}

					if(validateCrc32) {
						return err('Cannot validate CRC32 for a section of file');
					}

					if(start > this.compressedSize) {
						return err('`start` is after end of file data');
					}
				}
			}
			else {
				start = 0;
			}

			if(isNumber(options.end)) {
				({ end } = options);

				if(!isPositiveIntegerOrZero(end)) {
					return err('`options.end` must be a positive integer if provided');
				}

				if(decompress) {
					return err('Cannot stream a section of file if decompressing');
				}

				if(validateCrc32) {
					return err('Cannot validate CRC32 for a section of file');
				}

				if(end > this.compressedSize) {
					return err('`end` is after end of file data');
				}

				if(end < start) {
					return err('`end` is before `start`');
				}
			}
			else {
				end = this.compressedSize;
			}
		}
		else {
			decrypt = isEncrypted;
			decompress = isCompressed;
			validateCrc32 = true;
			start = 0;
			end = this.compressedSize;
		}

		if(decrypt) {
			return err('Decryption is not supported');
		}

		if(decompress && this.compressionMethod !== 8) {
			return err(`Unsupported compression method ${this.compressionMethod}`);
		}

		if(decompress && isEncrypted) {
			return err('Cannot decompress encrypted data');
		}

		if(validateCrc32 && isEncrypted) {
			return err('Cannot validate CRC32 of encrypted data');
		}

		// Read Local File Header.
		// Have already checked this read is in bounds in `readEntry()`.
		const bufferResult = await this.zip.reader.read(this.fileHeaderOffset, 30);
		if(bufferResult.fails) {
			return bufferResult;
		}

		const buffer = bufferResult.value;

		// Bytes 0-3: Local File Header signature = 0x04034b50
		if(buffer.readUInt32LE(0) !== 0x04_03_4B_50) {
			return err('Invalid Local File Header signature');
		}

		// All this should be redundant
		// Bytes 4-5: Version needed to extract (minimum)
		// Bytes 6-7: General Purpose Bit Flag
		// Bytes 8-9: Compression method
		// Bytes 10-11: File last modification time
		// Bytes 12-13: File last modification date
		// Bytes 14-17: CRC32
		const localCrc32 = buffer.readUInt32LE(14);
		// Bytes 18-21: Compressed size
		const localCompressedSize = buffer.readUInt32LE(18);
		// Bytes 22-23: Uncompressed size
		const localUncompressedSize = buffer.readUInt32LE(22);
		// Bytes 26-27: Filename length
		const filenameLength = buffer.readUInt16LE(26);
		// Bytes 28-29: Extra Fields length
		const extraFieldsLength = buffer.readUInt16LE(28);
		// Bytes 30-... - Filename + Extra Fields

		const fileDataOffset = this.fileHeaderOffset + 30 + filenameLength + extraFieldsLength;
		this.fileDataOffset = fileDataOffset;

		if(this.zip.isMacArchive || this.zip.isMaybeMacArchive) {
			// Check properties match Mac ZIP signature
			const matchesMacSignature = localCrc32 === 0
				&& localCompressedSize === 0
				&& localUncompressedSize === 0
				&& filenameLength === this.filenameLength
				&& extraFieldsLength === this.extraFields.length * MAC_LFH_EXTRA_FIELDS_LENGTH;
			if(this.zip.isMacArchive) {
				if(!matchesMacSignature) {
					return err('Misidentified Mac OS Archive Utility ZIP');
				}
			}
			else if(!matchesMacSignature) {
				// Doesn't fit signature of Mac OS Archive Utility ZIP, so can't be one
				this.zip._setAsNotMacArchive();
			}
		}

		if(this.compressedSize !== 0 && fileDataOffset + this.compressedSize > this.zip.footerOffset!) {
			return err(`File data overflows file bounds: ${fileDataOffset} + ${this.compressedSize} > ${this.zip.footerOffset}`);
		}

		// Get stream
		const streamResult = this.zip.reader.createReadStream(fileDataOffset + start, end - start);
		if(streamResult.fails) {
			return streamResult;
		}

		let stream = streamResult.value;

		// Pipe stream through decompress, CRC32 validation, and/or uncompressed size check transform streams
		const streams: Readable[] = [stream];

		if(decompress) {
			streams.push(createInflateRaw());

			if(this.zip.validateEntrySizes) {
				streams.push(new ValidateUncompressedSizeStream(this));
			}
		}

		if(validateCrc32) {
			streams.push(new ValidateCrc32Stream(this.crc32));
		}

		if(streams.length > 1) {
			// eslint-disable-next-line @typescript-eslint/no-empty-function
			pipeline(streams, () => {});

			stream = streams.at(-1) ?? stream;
		}

		return ok(stream);
	}
}

class ValidateUncompressedSizeStream extends Transform {
	private byteCount: number;
	private expectedByteCount: number;
	private readonly entry: Entry;

	/**
	 * Transform stream to compare size of uncompressed stream to expected.
	 * If `entry.uncompressedSizeIsCertain === false`, only checks actual byte count is accurate
	 * in lower 32 bits. `entry.uncompressedSize` can be inaccurate in faulty Mac OS ZIPs where
	 * uncompressed size reported by ZIP is truncated to lower 32 bits.
	 * If it proves inaccurate, `entry.uncompressedSize` is updated,
	 * and ZIP is flagged as being Mac OS ZIP if it isn't already.
	 */
	constructor(entry: Entry) {
		super();
		this.byteCount = 0;
		this.expectedByteCount = entry.uncompressedSize;
		this.entry = entry;
	}

	_transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
		this.byteCount += chunk.length;
		if(this.byteCount > this.expectedByteCount) {
			if(this.entry.uncompressedSizeIsCertain) {
				callback(new Error(`Too many bytes in the stream. Expected ${this.expectedByteCount}, got at least ${this.byteCount}.`));
				return;
			}

			// Entry must be at least 4 GiB larger. ZIP must be faulty Mac OS ZIP.
			if(this.entry.uncompressedSize === this.expectedByteCount) {
				this.expectedByteCount += FOUR_GIB;
				this.entry.uncompressedSize = this.expectedByteCount;
				const { zip } = this.entry;
				if(!zip.isMacArchive) {
					if(!zip.isMaybeMacArchive) {
						// It shouldn't be possible for `isMaybeMacArchive` to be `false`.
						// But check here as failsafe, as the logic around handling maybe-Mac ZIPs is complex.
						// If there's a mistake in logic which does cause us to get here, `_setAsMacArchive()`
						// below could throw an error which would crash the whole process. Contain the damage.
						callback(new Error('Logic failure. Please raise an issue.'));
						return;
					}

					zip._setAsMacArchive(zip.numEntriesRead, zip._entryCursor!);
				}
			}
			else {
				// Same entry must be being streamed simultaneously on another "thread",
				// and other stream overtook this one, and already increased size
				this.expectedByteCount = this.entry.uncompressedSize;
			}
		}

		callback(null, chunk);
	}

	_flush(callback: TransformCallback): void {
		if(this.byteCount < this.expectedByteCount) {
			callback(new Error(
				`Not enough bytes in the stream. Expected ${this.expectedByteCount}, got only ${this.byteCount}.`,
			));
		}
		else {
			if(!this.entry.uncompressedSizeIsCertain) {
				// Uncompressed size was uncertain, but is now known.
				// Record size as certain, and remove from list of uncertain-sized entries.
				this.entry.uncompressedSizeIsCertain = true;
				const reference = this.entry._ref;
				if(reference) {
					this.entry._ref = null;
					this.entry.zip._uncertainUncompressedSizeEntryRefs?.delete(reference);
					uncertainUncompressedSizeEntriesRegistry.unregister(reference);
				}
			}

			callback();
		}
	}
}

/**
 * Transform stream to calculate CRC32 of data and compare to expected.
 * @class
 */
class ValidateCrc32Stream extends Transform {
	private crc32: number;
	private readonly expectedCrc32: number;

	constructor(crc32: number) {
		super();
		this.crc32 = 0;
		this.expectedCrc32 = crc32;
	}

	_transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
		this.crc32 = calculateCrc32(chunk, this.crc32);
		callback(null, chunk);
	}

	_flush(callback: TransformCallback): void {
		if(this.crc32 === this.expectedCrc32) {
			callback();
		}
		else {
			callback(new Error(`CRC32 validation failed. Expected ${this.expectedCrc32}, received ${this.crc32}.`));
		}
	}
}
