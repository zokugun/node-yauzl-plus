
import { PassThrough, Readable } from 'node:stream';
import { isPositiveIntegerOrZero } from '@zokugun/is-it-type';
import { err, ok, type Result, stringifyError, xtry } from '@zokugun/xtry/async';
import * as fse from 'fs-extra';
import { SHIMMED_FS } from './utils/shimmed-fs.js';
import { streamToBuffer } from './utils/stream-to-buffer.js';

/**
 * Users can create custom `Reader`s by subclassing and implementing the following methods:
 *   - `_createReadStream(start, length)` (required)
 *   - `_read(start, length)` (optional)
 *   - `_open()` (optional)
 *   - `_close()` (optional)
 */
export class Reader {
	protected _isOpen: boolean;
	protected _readCount: number;

	public constructor() { // {{{
		this._isOpen = false;
		this._readCount = 0;
	} // }}}

	public get isOpen(): boolean { // {{{
		return this._isOpen;
	} // }}}

	/**
	 * Open reader.
	 * Calls `._open()` method defined by subclass.
	 * If already open, does nothing.
	 */
	public async open(): Promise<Result<void, string>> { // {{{
		if(this._isOpen) {
			return ok();
		}

		this._isOpen = true;

		return this._open();
	} // }}}

	/**
	 * Close reader.
	 * Calls `._close()` method defined by subclass.
	 * If already closed, does nothing.
	 */
	public async close(): Promise<Result<void, string>> { // {{{
		if(!this._isOpen) {
			return ok();
		}

		if(this._readCount !== 0) {
			// flush I/O operations
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		}

		if(this._readCount !== 0) {
			return err('Cannot close while reading in progress');
		}

		this._isOpen = false;

		return this._close();
	} // }}}

	/**
	 * Read bytes into Buffer.
	 */
	public async read(start: number, length: number): Promise<Result<Buffer, string>> { // {{{
		// Don't validate `start` + `length` because this is called so often
		if(!this._isOpen) {
			return err('Cannot call `read()` on a reader which is not open');
		}

		if(length === 0) {
			return ok(Buffer.allocUnsafe(0));
		}

		this._readCount += 1;

		const result = await this._read(start, length);

		this._readCount -= 1;

		return result;
	} // }}}

	/**
	 * Create readable stream to read from Reader.
	 */
	public createReadStream(start: number, length: number): Result<Readable, string> { // {{{
		if(!isPositiveIntegerOrZero(start)) {
			return err('`start` must be a positive integer or zero');
		}

		if(!isPositiveIntegerOrZero(length)) {
			return err('`length` must be a positive integer or zero');
		}

		if(!this._isOpen) {
			return err('Cannot call `createReadStream()` on a reader which is not open');
		}

		// Return empty stream for zero-size request
		if(length === 0) {
			const emptyStream = new PassThrough();

			setImmediate(() => emptyStream.end());

			return ok(emptyStream);
		}

		// Get stream
		this._readCount += 1;

		const result = this._createReadStream(start, length);
		if(result.fails) {
			this._readCount -= 1;

			return result;
		}

		let isEnded = false;

		const onEnd = () => {
			if(isEnded) {
				return;
			}

			isEnded = true;

			this._readCount -= 1;
		};

		const stream = result.value;

		stream.on('end', onEnd);
		stream.on('error', onEnd);
		stream.on('close', onEnd);

		return ok(stream);
	} // }}}

	/**
	 * Open Reader.
	 * Default implementation does nothing. Subclasses can optionally implement this.
	 */
	protected async _open(): Promise<Result<void, string>> { // {{{
		return ok();
	} // }}}

	/**
	 * Close Reader.
	 * Default implementation does nothing. Subclasses can optionally implement this.
	 */
	protected async _close(): Promise<Result<void, string>> { // {{{
		return ok();
	} // }}}

	/**
	 * Read bytes from Reader into a Buffer.
	 * Subclasses can override this.
	 */
	protected async _read(start: number, length: number): Promise<Result<Buffer, string>> { // {{{
		const stream = this._createReadStream(start, length);
		if(stream.fails) {
			return stream;
		}

		const buffer = await streamToBuffer(stream.value);
		if(buffer.fails) {
			return buffer;
		}

		if(buffer.value.length !== length) {
			return err('Unexpected end of file');
		}

		return buffer;
	} // }}}

	/**
	 * Create readable stream to read from Reader.
	 * Subclasses must implement this.
	 */
	protected _createReadStream(start: number, length: number): Result<Readable, string> { // {{{
		return err('Not Implemented');
	} // }}}
}

export class FdReader extends Reader { // {{{
	protected fd: number | null;

	/**
	 * Create `FdReader`.
	 */
	public constructor(fd: number | null) { // {{{
		super();
		this.fd = fd;
	} // }}}

	public get fileDescriptor(): number | null { // {{{
		return this.fd;
	} // }}}

	protected async _close(): Promise<Result<void, string>> { // {{{
		if(this.fd) {
			await fse.close(this.fd);
		}

		return ok();
	} // }}}

	protected async _read(start: number, length: number): Promise<Result<Buffer, string>> { // {{{
		if(!this.fd) {
			return err('File descriptor not open');
		}

		return new Promise((resolve) => {
			const buffer = Buffer.allocUnsafe(length);

			fse.read(this.fd!, buffer, 0, length, start, (error, bytesRead) => {
				if(error) {
					resolve(err(stringifyError(error)));
				}
				else if(bytesRead === length) {
					resolve(ok(buffer));
				}
				else {
					resolve(err('Unexpected end of file'));
				}
			});
		});
	} // }}}

	protected _createReadStream(start: number, length: number): Result<Readable, string> { // {{{
		if(!this.fd) {
			return err('File descriptor not open');
		}

		// Use shimmed `fs` with inactive `close()` method,
		// to prevent file descriptor getting closed when stream ends.
		// `autoClose` option works for this purpose when stream ends naturally,
		// but FD still gets closed if `.destroy()` is called.
		// Shimming FS is only way I around this that I could find.
		const readStream = fse.createReadStream(
			null as unknown as string,
			{
				start,
				end: start + length - 1,
				fd: this.fd,
				fs: SHIMMED_FS,
			},
		);

		return ok(readStream);
	} // }}}
}

export class FileReader extends FdReader {
	protected path: string;

	/**
	 * Create `FileReader`.
	 */
	public constructor(path: string) { // {{{
		super(null);
		this.path = path;
	} // }}}

	protected async _open(): Promise<Result<void, string>> { // {{{
		const result = await xtry(fse.open(this.path, 'r', 0o444));
		if(result.fails) {
			return err(stringifyError(result.error));
		}

		this.fd = result.value;

		return ok();
	} // }}}

	protected async _close(): Promise<Result<void, string>> { // {{{
		if(!this.fd) {
			return err('File descriptor not open');
		}

		await fse.close(this.fd);

		this.fd = null;

		return ok();
	} // }}}
}

export class BufferReader extends Reader {
	protected buffer: Buffer;

	/**
	 * Create `BufferReader`.
	 */
	public constructor(buffer: Buffer) { // {{{
		super();
		this.buffer = buffer;
	} // }}}

	protected async _read(start: number, length: number): Promise<Result<Buffer, string>> { // {{{
		const end = start + length;

		if(end > this.buffer.length) {
			return err('Cannot read beyond end of buffer');
		}

		return ok(this.buffer.subarray(start, end));
	} // }}}

	protected _createReadStream(start: number, length: number): Result<Readable, string> { // {{{
		const end = start + length;

		if(end > this.buffer.length) {
			return err('Cannot read beyond end of buffer');
		}

		const slice = this.buffer.subarray(start, end);

		return ok(Readable.from(slice));
	} // }}}
}
