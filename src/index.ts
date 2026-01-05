import { isBoolean, isPositiveInteger, isRecord } from '@zokugun/is-it-type';
import { err, ok, type Result } from '@zokugun/xtry';
import * as fse from 'fs-extra';
import { type Reader, FileReader, FdReader, BufferReader } from './reader.js';
import { type ZipOptions } from './types.js';
import { Zip } from './zip.js';

/**
 * Create `Zip` from file.
 */
export async function open(path: string, options?: ZipOptions): Promise<Result<Zip, string>> { // {{{
	const optionsResult = validateOptions(options);
	if(optionsResult.fails) {
		return optionsResult;
	}

	const reader = new FileReader(path);

	const openResult = await reader.open();
	if(openResult.fails) {
		return openResult;
	}

	const { size } = await fse.fstat(reader.fileDescriptor!);

	const zip = new Zip(reader, size, optionsResult.value);

	const initResult = await zip.init();
	if(initResult.fails) {
		return initResult;
	}

	return ok(zip);
} // }}}

/**
 * Create `Zip` from file descriptor.
 */
export async function fromFd(fd: number, options?: ZipOptions): Promise<Result<Zip, string>> { // {{{
	const optionsResult = validateOptions(options);
	if(optionsResult.fails) {
		return optionsResult;
	}

	const reader = new FdReader(fd);

	const openResult = await reader.open();
	if(openResult.fails) {
		return openResult;
	}

	const { size } = await fse.fstat(fd);

	const zip = new Zip(reader, size, optionsResult.value);

	const initResult = await zip.init();
	if(initResult.fails) {
		return initResult;
	}

	return ok(zip);
} // }}}

/**
 * Create `Zip` from `Buffer`.
 */
export async function fromBuffer(buffer: Buffer, options?: ZipOptions): Promise<Result<Zip, string>> { // {{{
	const optionsResult = validateOptions(options);
	if(optionsResult.fails) {
		return optionsResult;
	}

	const reader = new BufferReader(buffer);

	const openResult = await reader.open();
	if(openResult.fails) {
		return openResult;
	}

	const zip = new Zip(reader, buffer.length, optionsResult.value);

	const initResult = await zip.init();
	if(initResult.fails) {
		return initResult;
	}

	return ok(zip);
} // }}}

/**
 * Create `Zip` from `Reader`.
 */
export async function fromReader(reader: Reader, size: number, options?: ZipOptions): Promise<Result<Zip, string>> { // {{{
	if(!isPositiveInteger(size)) {
		return err('`size` must be a positive integer');
	}

	const optionsResult = validateOptions(options);
	if(optionsResult.fails) {
		return optionsResult;
	}

	const openResult = await reader.open();
	if(openResult.fails) {
		return openResult;
	}

	const zip = new Zip(reader, size, optionsResult.value);

	const initResult = await zip.init();
	if(initResult.fails) {
		return initResult;
	}

	return ok(zip);
} // }}}

/**
 * Validate and conform `Zip` creation options.
 */
function validateOptions(inputOptions: unknown): Result<ZipOptions, string> { // {{{
	const options = {
		decodeStrings: true,
		validateEntrySizes: true,
		validateFilenames: true,
		strictFilenames: false,
		supportMacArchive: true,
	};

	if(inputOptions) {
		if(!isRecord(inputOptions)) {
			return err('`options` must be an object if provided');
		}

		for(const [key, value] of Object.entries(inputOptions)) {
			if(!Object.hasOwn(options, key)) {
				return err(`Unknown option '${key}'`);
			}

			if(!isBoolean(value)) {
				return err(`\`options.${key}\` must be a boolean if provided`);
			}

			options[key] = value;
		}
	}

	return ok(options);
} // }}}

export { Entry } from './entry.js';
export { Zip } from './zip.js';
export { Reader } from './reader.js';
export { dosDateTimeToDate } from './utils/dos-date-time-to-date.js';
export { streamToBuffer } from './utils/stream-to-buffer.js';
export { streamToString } from './utils/stream-to-string.js';
export { validateFilename } from './utils/validate-filename.js';
