import { readdirSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { describe, it, expect, type SuiteAPI, type TestAPI } from 'vitest';
import * as yauzl from '../src/index.js';
import { expectEntryValue } from './utils/expect-entry-value.js';
import { expectResultValue } from './utils/expect-result-value.js';
import { getFiles } from './utils/get-files.js';

const SUCCESS_DIR = pathJoin(__dirname, 'fixtures/success');
const FAILURE_DIR = pathJoin(__dirname, 'fixtures/failure');

// This is the date example ZIP files and their content files were made,
// so this timestamp will be earlier than all the ones stored in these test ZIP files
// (and probably all future ZIP files).
// No timezone awareness, because that's how MS-DOS rolls.
const EARLIEST_TIMESTAMP = new Date(2014, 7, 18, 0, 0, 0, 0);

type FixtureOptions = {
	zip?: Record<string, unknown>;
	stream?: Record<string, unknown>;
	rename?: Array<[string, string]>;
	isEncrypted?: boolean;
	isCompressed?: boolean;
};

type FixtureTestFn = (zipFilename: string, zipPath: string, options: FixtureOptions) => Promise<void> | void;

type Eachable = SuiteAPI | TestAPI;

testEachFile('Successfully unzips', SUCCESS_DIR, describe, (_zipFilename, zipPath, options) => {
	const expectedFiles = getFiles(zipPath.slice(0, -4));

	it.each([
		['options.decodeStrings = true', true],
		['options.decodeStrings = false', false],
	])('%s', async (_testName, decodeStrings) => {
		const zip = expectResultValue(await yauzl.open(zipPath, { ...options.zip, decodeStrings }));

		try {
			let entryCount = 0;
			for await (const entryResult of zip) {
				const entry = expectEntryValue(entryResult);

				entryCount++;

				let filenameValue: string;
				let commentValue: string;
				const { filename, comment } = entry;
				if(decodeStrings && typeof filename === 'string' && typeof comment === 'string') {
					filenameValue = filename;
					commentValue = comment;
				}
				else {
					expect(filename).toBeInstanceOf(Buffer);
					expect(comment).toBeInstanceOf(Buffer);
					filenameValue = manuallyDecodeString(filename as Buffer);
					commentValue = manuallyDecodeString(comment as Buffer);
				}

				expect(commentValue).to.equals('');

				const timestamp = entry.getLastModified();
				expect(timestamp.getTime()).toBeGreaterThan(EARLIEST_TIMESTAMP.getTime());
				expect(timestamp.getTime()).toBeLessThan(Date.now());

				for(const [from, to] of options.rename ?? []) {
					filenameValue = filenameValue.replace(from, to);
				}

				if(options.isEncrypted !== undefined) {
					expect(entry.isEncrypted()).to.equals(options.isEncrypted);
				}

				if(options.isCompressed !== undefined) {
					expect(entry.isCompressed()).to.equals(options.isCompressed);
				}

				const expectedContent = expectedFiles[filenameValue];
				if(filenameValue.endsWith('/')) {
					expect(expectedContent).to.be.null;
				}
				else {
					expect(expectedContent).to.exist;
					const stream = expectResultValue(await entry.openReadStream(options.stream));
					const content = expectResultValue(await yauzl.streamToBuffer(stream));
					expect(content).toEqual(expectedContent);
				}
			}

			expect(entryCount).to.equals(Object.keys(expectedFiles).length);
		}
		finally {
			expectResultValue(await zip.close());
		}
	});
});

testEachFile('Errors unzipping', FAILURE_DIR, it, async (zipFilename, zipPath, options) => {
	const expectedErrorMessage = zipFilename.replace(/(_\d+)?\.zip$/, '');

	let message = '';

	const zipResult = await yauzl.open(zipPath, options.zip);

	if(zipResult.fails) {
		message = zipResult.error;
	}
	else {
		const zip = zipResult.value;

		try {
			for await (const entryResult of zip) {
				if(entryResult.fails) {
					message = entryResult.error;
					break;
				}

				const entry = entryResult.value;
				if(!entry) {
					continue;
				}

				const streamResult = await entry.openReadStream(options.stream);
				if(streamResult.fails) {
					message = streamResult.error;
					break;
				}

				const bufferResult = await yauzl.streamToBuffer(streamResult.value);
				if(bufferResult.fails) {
					message = bufferResult.error;
					break;
				}
			}
		}
		finally {
			expectResultValue(await zip.close());
		}
	}

	expect(message.replaceAll(/[^a-zA-Z\d., ]/g, '-')).to.equals(expectedErrorMessage);
});

function testEachFile(name: string, dirPath: string, describeOrIt: Eachable, testFn: FixtureTestFn): void {
	const filenames = readdirSync(dirPath)
		.filter((filename) => filename.endsWith('.zip'))
		.sort();

	const testCases: Array<[string, string, FixtureOptions]> = filenames.map((filename) => {
		const zipPath = pathJoin(dirPath, filename);
		const options = readFixtureOptions(zipPath);

		return [filename, zipPath, options];
	});

	describe(name, () => {
		describeOrIt.each(testCases)('%s', async (zipFilename, zipPath, options) =>
			testFn(zipFilename, zipPath, options),
		);
	});
}

function readFixtureOptions(zipPath: string): FixtureOptions {
	try {
		const jsonContent = readFileSync(`${zipPath.slice(0, -4)}.json`, 'utf8');
		const parsed: unknown = JSON.parse(jsonContent);
		if(parsed && typeof parsed === 'object') {
			return parsed as FixtureOptions;
		}
	}
	catch (error) {
		if((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			throw error;
		}
	}

	return {};
}

function manuallyDecodeString(filename: Buffer): string {
	let decoded = filename.toString('utf8').replace('\\', '/');
	if(decoded === '\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000A\u000B\u000C\u000D\u000E\u000F') {
		decoded = '七个房间.txt';
	}

	return decoded;
}
