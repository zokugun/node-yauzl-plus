import { PassThrough as PassThroughStream, type Readable } from 'node:stream';
import { isNumber } from '@zokugun/is-it-type';
import { err, ok, type Result } from '@zokugun/xtry';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as yauzl from '../src/index.js';
import { type OpenReadStreamOptions } from '../src/types.js';
import { expectResultValue } from './utils/expect-result-value.js';

const ZIP_BUFFER = hexToBuffer(
	'504b03040a00000000006a54954ab413389510000000100000000a001c007374'
	+ '6f7265642e7478745554090003d842fa5842c5f75875780b000104e803000004'
	+ 'e803000061616162616161626161616261616162504b03041400000008007554'
	+ '954ab413389508000000100000000e001c00636f6d707265737365642e747874'
	+ '5554090003ed42fa58ed42fa5875780b000104e803000004e80300004b4c4c4c'
	+ '4a44c200504b03040a00090000008454954ab41338951c000000100000000d00'
	+ '1c00656e637279707465642e74787455540900030743fa580743fa5875780b00'
	+ '0104e803000004e8030000f72e7bb915142131c934f01b163fcadb2a8db7cdaf'
	+ 'd0a6f4dd1694c0504b0708b41338951c00000010000000504b03041400090008'
	+ '008a54954ab413389514000000100000001c001c00656e637279707465642d61'
	+ '6e642d636f6d707265737365642e74787455540900031343fa581343fa587578'
	+ '0b000104e803000004e80300007c4d3ea0d9754b470d3eb32ada5741bfc848f4'
	+ '19504b0708b41338951400000010000000504b01021e030a00000000006a5495'
	+ '4ab413389510000000100000000a0018000000000000000000b4810000000073'
	+ '746f7265642e7478745554050003d842fa5875780b000104e803000004e80300'
	+ '00504b01021e031400000008007554954ab413389508000000100000000e0018'
	+ '000000000001000000b48154000000636f6d707265737365642e747874555405'
	+ '0003ed42fa5875780b000104e803000004e8030000504b01021e030a00090000'
	+ '008454954ab41338951c000000100000000d0018000000000000000000b481a4'
	+ '000000656e637279707465642e74787455540500030743fa5875780b000104e8'
	+ '03000004e8030000504b01021e031400090008008a54954ab413389514000000'
	+ '100000001c0018000000000001000000b48117010000656e637279707465642d'
	+ '616e642d636f6d707265737365642e74787455540500031343fa5875780b0001'
	+ '04e803000004e8030000504b0506000000000400040059010000910100000000',
);

const EXPECTED_FILE_DATAS = [
	hexToBuffer('61616162616161626161616261616162'),
	hexToBuffer('4b4c4c4c4a44c200'),
	hexToBuffer('f72e7bb915142131c934f01b163fcadb2a8db7cdafd0a6f4dd1694c0'),
	hexToBuffer('7c4d3ea0d9754b470d3eb32ada5741bfc848f419'),
];

describe('Reads ranges correctly', () => {
	let reader: StingyRandomAccessReader;
	let zip: yauzl.Zip | undefined;
	let entries: yauzl.Entry[] | undefined;
	beforeEach(async () => {
		zip = undefined;
		entries = undefined;

		reader = new StingyRandomAccessReader(ZIP_BUFFER);

		const zipResult = await yauzl.fromReader(reader, ZIP_BUFFER.length);
		if(zipResult.fails) {
			return;
		}

		zip = zipResult.value;

		const entriesResult = await zip.readEntries();
		if(entriesResult.fails) {
			return;
		}

		entries = entriesResult.value;
	});

	afterEach(async () => {
		if(zip) {
			await zip.close();
		}
	});

	describe.each([
		['uncompressed + unencrypted', false, false],
		['compressed + unencrypted', true, false],
		['uncompressed + encrypted', false, true],
		['compressed + encrypted', true, true],
	])('%s', (_testName, isCompressed, isEncrypted) => {
		const entryIndex = Number(isCompressed) + (Number(isEncrypted) * 2);

		describe.each([[null], [0], [2]])('start: %s', (start) => {
			it.each([[null], [3], [5]])('end: %s', async (end) => {
				if(!zip || !entries) {
					return;
				}

				const entry = entries[entryIndex];
				expect(entry.isCompressed()).to.equals(isCompressed);
				expect(entry.isEncrypted()).to.equals(isEncrypted);

				const expectedFileData = EXPECTED_FILE_DATAS[entryIndex];
				const effectiveStart = start ?? 0;
				const effectiveEnd = end ?? expectedFileData.length;
				const expectedSlice = expectedFileData.slice(effectiveStart, effectiveEnd);

				reader.upcomingByteCounts = [null, expectedSlice.length];

				const options: OpenReadStreamOptions = {
					decompress: false,
					decrypt: false,
					validateCrc32: false,
				};

				if(start !== null) {
					options.start = start;
				}

				if(end !== null) {
					options.end = end;
				}

				const stream = expectResultValue(await zip.openReadStream(entry, options));

				const buffer = expectResultValue(await yauzl.streamToBuffer(stream));
				expect(buffer).to.eql(expectedSlice);
			});
		});
	});
});

class StingyRandomAccessReader extends yauzl.Reader {
	buffer: Buffer;
	upcomingByteCounts: Array<number | null>;

	constructor(buffer: Buffer) {
		super();
		this.buffer = buffer;
		this.upcomingByteCounts = [];
	}

	_createReadStream(start: number, length: number): Result<Readable, string> {
		if(this.upcomingByteCounts.length > 0) {
			const expectedByteCount = this.upcomingByteCounts.shift();

			if(isNumber(expectedByteCount) && expectedByteCount !== length) {
				return err(`expected ${expectedByteCount} got ${length} bytes`);
			}
		}

		const result = new PassThroughStream();

		result.write(this.buffer.slice(start, start + length));
		result.end();

		return ok(result);
	}
}

function hexToBuffer(hexString: string): Buffer {
	const buffer = Buffer.alloc(hexString.length / 2);
	for(let i = 0; i < buffer.length; i++) {
		const offset = i * 2;

		buffer[i] = Number.parseInt(hexString.slice(offset, offset + 2), 16);
	}

	return buffer;
}
