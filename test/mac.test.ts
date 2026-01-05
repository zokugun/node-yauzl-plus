import { join as pathJoin } from 'node:path';
import { isString } from '@zokugun/is-it-type';
import { afterEach, expect, it } from 'vitest';
import * as yauzl from '../src/index.js';
import { expectResultValue } from './utils/expect-result-value.js';
import { getFiles } from './utils/get-files.js';

const FIXTURES_DIR = pathJoin(__dirname, 'fixtures/mac');

type FileMap = Record<string, Buffer | null>;

let zip: yauzl.Zip | undefined;

afterEach(async () => {
	if(zip) {
		await zip.close();

		zip = undefined;
	}
});

it('handles empty files', async () => {
	const zipPath = pathJoin(FIXTURES_DIR, 'empty-files.zip');
	const expectedFiles = getFiles(zipPath.slice(0, -4));
	const zip = expectResultValue(await yauzl.open(zipPath));

	await expectZipContentsToMatch(zip, expectedFiles);

	expect(zip.isMaybeMacArchive).to.be.true;
});

it('handles folders', async () => {
	const zipPath = pathJoin(FIXTURES_DIR, 'folders.zip');
	const expectedFiles = getFiles(zipPath.slice(0, -4));
	const zip = expectResultValue(await yauzl.open(zipPath));

	await expectZipContentsToMatch(zip, expectedFiles);

	expect(zip.isMaybeMacArchive).to.be.true;
});

async function expectZipContentsToMatch(currentZip: yauzl.Zip, expectedFiles: FileMap): Promise<void> {
	let entryCount = 0;
	for await (const entry of currentZip) {
		expect(entry.error).to.be.undefined;

		entryCount++;

		expect(entry.value!.comment).to.equals('');

		const filename = isString(entry.value!.filename) ? entry.value!.filename : entry.value!.filename.toString('utf8');

		if(filename.endsWith('/')) {
			expect(expectedFiles[filename]).to.be.null;
		}
		else {
			const stream = expectResultValue(await entry.value!.openReadStream());
			const content = expectResultValue(await yauzl.streamToBuffer(stream));
			expect(content).to.eql(expectedFiles[filename]);
		}
	}

	expect(entryCount).to.equals(Object.keys(expectedFiles).length);
}
