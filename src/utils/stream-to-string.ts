import { type Readable } from 'node:stream';
import { ok, type Result } from '@zokugun/xtry';
import { streamToBuffer } from './stream-to-buffer.js';

export async function streamToString(stream: Readable): Promise<Result<string, string>> {
	const result = await streamToBuffer(stream);
	if(result.fails) {
		return result;
	}

	return ok(result.value.toString());
}
