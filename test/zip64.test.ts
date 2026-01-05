import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { isFunction } from '@zokugun/is-it-type';
import { err, ok, type Result } from '@zokugun/xtry';
import { expect, it } from 'vitest';
import * as yauzl from '../src/index.js';
import { expectResultValue } from './utils/expect-result-value.js';
import { normalizeFilename } from './utils/normalize-filename.js';

const FRAGMENT_PATH = pathJoin(__dirname, 'fixtures/zip64/zip64.zip_fragment');
const LARGE_BIN_LENGTH = 8_000_000_000;
const PREFIX_LENGTH = 0x1_00;
const UINT32_RANGE = 0x1_00_00_00_00;

it('handles large ZIP64 file', async () => {
	const { reader, size } = expectResultValue(makeRandomAccessReader());
	const zip = expectResultValue(await yauzl.fromReader(reader, size));

	try {
		const entries = expectResultValue(await zip.readEntries());
		expect(entries.map((entry) => normalizeFilename(entry.filename))).toEqual(['a.txt', 'large.bin', 'b.txt']);

		const textStream1 = expectResultValue(await entries[0].openReadStream());
		const content1 = expectResultValue(await yauzl.streamToString(textStream1));
		expect(content1).to.equals('hello a\n');

		const expectedBinStart = await getPrefixOfStream(newLargeBinContentsProducer());
		const bigBinaryStream = expectResultValue(await entries[1].openReadStream());
		const actualBinStart = await getPrefixOfStream(bigBinaryStream);
		expect(actualBinStart).toEqual(expectedBinStart);

		const textStream2 = expectResultValue(await entries[2].openReadStream());
		const content2 = expectResultValue(await yauzl.streamToString(textStream2));
		expect(content2).to.equals('hello b\n');
	}
	finally {
		expectResultValue(await zip.close());
	}
});

async function getPrefixOfStream(stream: Readable): Promise<Buffer> {
	return new Promise((resolve) => {
		const prefixBuffer = Buffer.alloc(PREFIX_LENGTH);
		const writer = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				chunk.copy(prefixBuffer, 0, 0, PREFIX_LENGTH);
				stream.unpipe(writer);

				if('destroy' in stream && isFunction(stream.destroy)) {
					stream.destroy();
				}

				resolve(prefixBuffer);
				callback();
			},
		});

		stream.pipe(writer);
	});
}

function makeRandomAccessReader(): Result<{ reader: yauzl.Reader; size: number }, string> {
	const backendContents = readFileSync(FRAGMENT_PATH);

	if(backendContents.length <= 4) {
		return err('Unexpected EOF');
	}

	const largeBinContentsOffset = backendContents.readUInt32BE(0) - 4;
	if(largeBinContentsOffset > backendContents.length) {
		return err('.zip_fragment header is malformed');
	}

	const largeBinContentsEnd = largeBinContentsOffset + LARGE_BIN_LENGTH;

	let firstRead = true;
	const pretendSize = backendContents.length + LARGE_BIN_LENGTH - 4;

	class InflatingReader extends yauzl.Reader {
		_createReadStream(start: number, length: number): Result<Readable, string> {
			const thisIsTheFirstRead = firstRead;
			const end = start + length;
			firstRead = false;
			const chunks: Buffer[] = [];
			if(end <= largeBinContentsOffset) {
				chunks.push(backendContents.subarray(start + 4, end + 4));
			}
			else if(start >= largeBinContentsOffset + LARGE_BIN_LENGTH) {
				chunks.push(backendContents.subarray(start - LARGE_BIN_LENGTH + 4, end - LARGE_BIN_LENGTH + 4));
			}
			else if(start === largeBinContentsOffset && end === largeBinContentsEnd) {
				return ok(newLargeBinContentsProducer());
			}
			else if(thisIsTheFirstRead && start > largeBinContentsOffset && end === pretendSize) {
				const dummyTrash = Buffer.alloc(largeBinContentsEnd - start);
				chunks.push(dummyTrash, backendContents.subarray(largeBinContentsOffset + 4));
			}
			else {
				return err(`_createReadStream(${start}, ${length}) misaligned to range [${largeBinContentsOffset}, ${largeBinContentsEnd - largeBinContentsOffset}]`);
			}

			return ok(Readable.from(chunks));
		}
	}

	const reader = new InflatingReader() as yauzl.Reader;

	return ok({ reader, size: pretendSize });
}

function newLargeBinContentsProducer(): Readable {
	let previous0 = -1;
	let previous1 = 1;
	let byteCount = 0;

	return new Readable({
		read() {
			while(byteCount < LARGE_BIN_LENGTH) {
				const bufferSize = Math.min(0x1_00_00, LARGE_BIN_LENGTH - byteCount);
				const buffer = Buffer.alloc(bufferSize);

				for(let i = 0; i < bufferSize; i += 4) {
					const sum = previous0 + previous1;
					const nextValue = normalizeToUint32(sum);
					previous0 = previous1;
					previous1 = nextValue;
					byteCount += 4;
					buffer.writeUInt32BE(nextValue, i);
				}

				if(!this.push(buffer)) {
					return;
				}
			}

			this.push(null);
		},
	});
}

function normalizeToUint32(value: number): number {
	const normalized = value % UINT32_RANGE;
	return normalized >= 0 ? normalized : normalized + UINT32_RANGE;
}
