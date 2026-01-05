import { type Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { err, ok, type Result, stringifyError, xtry } from '@zokugun/xtry/async';

/**
 * Drain contents of a readable stream into a Buffer.
 */
export async function streamToBuffer(stream: Readable): Promise<Result<Buffer, string>> {
	const chunks: Buffer[] = [];

	const collectStream = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			chunks.push(chunk);

			callback();
		},
	});

	const result = await xtry(pipeline(stream, collectStream));
	if(result.fails) {
		return err(stringifyError(result.error));
	}

	return ok(Buffer.concat(chunks));
}
