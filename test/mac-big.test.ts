import { join as pathJoin } from 'node:path';
import process from 'node:process';
import { isString } from '@zokugun/is-it-type';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yauzl from '../src/index.js';
import { expectEntryValue } from './utils/expect-entry-value.js';
import { expectResultValue } from './utils/expect-result-value.js';

vi.setConfig({ testTimeout: 5 * 60_000 });

const FIXTURES_DIR = pathJoin(__dirname, 'fixtures/mac');

// Set `MAC_BIG_SIZE` env var to only run test for a certain entry count
let sizes = [65_534, 65_535, 65_536, 65_537, 131_072, 200_000];
const environmentSize = process.env.MAC_BIG_SIZE;
if(environmentSize) {
	const size = Number(environmentSize);

	if(!sizes.includes(size)) {
		throw new Error(`Invalid MAC_BIG_SIZE size: ${environmentSize}`);
	}

	sizes = [size];
}

let zip: yauzl.Zip | undefined;

afterEach(async () => {
	if(zip) {
		expectResultValue(await zip.close());
		zip = undefined;
	}
});

describe('handles large number of files', () => {
	it.each(sizes.map((size) => [size]))('%s files', async (entryCount) => {
		const zipPath = pathJoin(FIXTURES_DIR, `${entryCount}-files.zip`);

		const received: boolean[] = [true];
		for(let i = 1; i <= entryCount; i++) {
			received[i] = false;
		}

		let fileCount = 0;
		zip = expectResultValue(await yauzl.open(zipPath));
		const activeZip = zip;

		for await (const entryResult of activeZip) {
			const entryValue = expectEntryValue(entryResult);

			fileCount++;

			const filename = isString(entryValue.filename) ? entryValue.filename : entryValue.filename.toString('utf8');
			const match = /^(\d+)\.txt$/.exec(filename);
			expect(match).toBeDefined();
			const num = Number(match![1]);
			expect(received[num]).to.equals(false);
			received[num] = true;

			const stream = expectResultValue(await entryValue.openReadStream());
			const content = expectResultValue(await yauzl.streamToString(stream));
			expect(content).to.equals(`${num}\n`);
		}

		expect(fileCount).to.equals(entryCount);

		expect(activeZip.isMacArchive).to.equals(entryCount >= 65_535);
		expect(activeZip.isMaybeMacArchive).to.equals(entryCount < 65_535);
	});
});
