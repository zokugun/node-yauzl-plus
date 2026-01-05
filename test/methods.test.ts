import { join as pathJoin } from 'node:path';
import { Readable } from 'node:stream';
import { ok, type Result } from '@zokugun/xtry';
import * as fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as yauzl from '../src/index.js';
import { expectEntryValue } from './utils/expect-entry-value.js';
import { expectResultValue } from './utils/expect-result-value.js';
import { normalizeFilename } from './utils/normalize-filename.js';

const PATH = pathJoin(__dirname, 'fixtures/basic/test.zip');
const BAD_PATH = pathJoin(__dirname, 'fixtures/basic/does-not-exist.zip');
const FILES = ['test_files/', 'test_files/1.txt', 'test_files/2.txt', 'test_files/3.txt'];

const FILE_CONTENTS: Record<string, string> = {};
for(const filename of FILES) {
	if(filename.endsWith('/')) {
		continue;
	}

	FILE_CONTENTS[filename] = fse.readFileSync(pathJoin(__dirname, 'fixtures/basic', filename), 'utf8');
}

const ZIP_BUFFER = fse.readFileSync(PATH);

describe('.open()', () => {
	defineTests('open', async () => yauzl.open(PATH));

	it('returns rejected promise if IO error', async () => {
		const promise = yauzl.open(BAD_PATH);
		expect(promise).toBeInstanceOf(Promise);
		const result = await promise;
		expect(result.error).to.be.not.undefined;
	});
});

describe('.fromFd()', () => {
	let fd: number;

	beforeEach(async () => {
		fd = await fse.open(PATH, 'r');
	});

	defineTests('fromFd', async () => yauzl.fromFd(fd));
});

describe('.fromBuffer()', () => {
	defineTests('fromBuffer', async () => yauzl.fromBuffer(Buffer.from(ZIP_BUFFER)));
});

describe('.fromReader()', () => {
	class MyReader extends yauzl.Reader {
		async _read(start: number, length: number): Promise<Result<Buffer, string>> {
			return ok(ZIP_BUFFER.subarray(start, start + length));
		}

		_createReadStream(start: number, length: number): Result<Readable, string> {
			return ok(Readable.from(ZIP_BUFFER.subarray(start, start + length)));
		}
	}

	defineTests('fromReader', async () => yauzl.fromReader(new MyReader(), ZIP_BUFFER.length));
});

function defineTests(methodName: string, method: () => Promise<Result<yauzl.Zip, string>>): void {
	it(`.${methodName}() returns a Promise of Zip object`, async () => {
		const promise = method();
		expect(promise).toBeInstanceOf(Promise);
		const zip = expectResultValue(await promise);
		expect(zip).toBeInstanceOf(yauzl.Zip);
	});

	it('.close() returns a Promise', async () => {
		const zipInstance = expectResultValue(await method());
		const promise = zipInstance.close();
		expect(promise).toBeInstanceOf(Promise);
		expectResultValue(await promise);
	});

	describe('entry methods', () => {
		let zip: yauzl.Zip;

		beforeEach(async () => {
			zip = expectResultValue(await method());
		});

		afterEach(async () => {
			if(zip) {
				expectResultValue(await zip.close());
			}
		});

		describe('.readEntry()', () => {
			let promise: Promise<Result<yauzl.Entry | null, string>>;
			let entry: yauzl.Entry;

			beforeEach(async () => {
				promise = zip.readEntry();
				entry = expectEntryValue(await promise);
			});

			it('returns a Promise resolving to `Entry` object', () => {
				expect(promise).toBeInstanceOf(Promise);
				expect(entry).toBeInstanceOf(yauzl.Entry);
			});

			it('returns first entry', () => {
				expect(normalizeFilename(entry.filename)).to.equals(FILES[0]);
			});

			it('when called again, returns next entry', async () => {
				const nextEntry = expectEntryValue(await zip.readEntry());
				expect(normalizeFilename(nextEntry.filename)).to.equals(FILES[1]);
			});

			it('returns `null` when all entries consumed', async () => {
				expect(normalizeFilename(entry.filename)).to.equals(FILES[0]);

				let nextEntry = expectEntryValue(await zip.readEntry());
				expect(normalizeFilename(nextEntry.filename)).to.equals(FILES[1]);

				nextEntry = expectEntryValue(await zip.readEntry());
				expect(normalizeFilename(nextEntry.filename)).to.equals(FILES[2]);

				nextEntry = expectEntryValue(await zip.readEntry());
				expect(normalizeFilename(nextEntry.filename)).to.equals(FILES[3]);

				const finalEntry = expectResultValue(await zip.readEntry());
				expect(finalEntry).to.be.null;
			});
		});

		describe('.readEntries()', () => {
			it('returns a Promise', async () => {
				const promise = zip.readEntries();
				expect(promise).toBeInstanceOf(Promise);
				await promise;
			});

			it('returns array of `numEntries` entries', async () => {
				const entries = expectResultValue(await zip.readEntries(2));
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => normalizeFilename(entry.filename))).toEqual(FILES.slice(0, 2));
			});

			it('when called again, returns next entries', async () => {
				expectResultValue(await zip.readEntries(2));

				const entries = expectResultValue(await zip.readEntries(2));
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => normalizeFilename(entry.filename))).toEqual(FILES.slice(2, 4));
			});

			it('with no `numEntries` specified, returns all entries', async () => {
				const entries = expectResultValue(await zip.readEntries());
				expect(entries).toHaveLength(FILES.length);
				expect(entries.map((entry) => normalizeFilename(entry.filename))).toEqual(FILES);
			});
		});

		describe('async iterator', () => {
			it('iterates entries', async () => {
				const filenames: string[] = [];

				for await (const entryResult of zip) {
					const entry = expectResultValue(entryResult);

					if(entry) {
						filenames.push(normalizeFilename(entry.filename));
					}
				}

				expect(filenames).toEqual(FILES);
			});
		});
	});

	describe('stream methods', () => {
		let zip: yauzl.Zip;
		let entry: yauzl.Entry;

		beforeEach(async () => {
			zip = expectResultValue(await method());

			expectResultValue(await zip.readEntry());

			entry = expectEntryValue(await zip.readEntry());
		});

		afterEach(async () => {
			if(zip) {
				expectResultValue(await zip.close());
			}
		});

		describe('zip.openReadStream()', () => {
			let promise: Promise<Result<Readable, string>>;
			let stream: Readable;

			beforeEach(async () => {
				promise = zip.openReadStream(entry);
				stream = expectResultValue(await promise);
				// eslint-disable-next-line @typescript-eslint/no-empty-function
				stream.on('error', () => {});
			});

			afterEach(async () => {
				stream.destroy();
			});

			it('returns a Promise', () => {
				expect(promise).toBeInstanceOf(Promise);
			});

			it('promise resolves to Readable Stream', () => {
				expect(stream).toBeInstanceOf(Readable);
			});

			it('streams file data', async () => {
				const restEntries = expectResultValue(await zip.readEntries());
				const entries = [entry, ...restEntries];

				for(const [index, entryItem] of entries.entries()) {
					expect(normalizeFilename(entryItem.filename)).to.equals(FILES[index + 1]);
					const entryStream = expectResultValue(await zip.openReadStream(entryItem));
					const data = expectResultValue(await yauzl.streamToString(entryStream));
					const key = normalizeFilename(entryItem.filename);
					expect(data).to.equals(FILE_CONTENTS[key]);
				}
			});
		});

		describe('entry.openReadStream()', () => {
			let promise: Promise<Result<Readable, string>>;
			let stream: Readable;

			beforeEach(async () => {
				promise = zip.openReadStream(entry);
				stream = expectResultValue(await promise);
				// eslint-disable-next-line @typescript-eslint/no-empty-function
				stream.on('error', () => {});
			});

			afterEach(async () => {
				stream?.destroy();
			});

			it('returns a Promise', () => {
				expect(promise).toBeInstanceOf(Promise);
			});

			it('resolves to Readable Stream', () => {
				expect(stream).toBeInstanceOf(Readable);
			});

			it('streams file data', async () => {
				const restEntries = expectResultValue(await zip.readEntries());
				const entries = [entry, ...restEntries];

				for(const [index, entryItem] of entries.entries()) {
					expect(normalizeFilename(entryItem.filename)).to.equals(FILES[index + 1]);
					const entryStream = expectResultValue(await zip.openReadStream(entryItem));
					const data = expectResultValue(await yauzl.streamToString(entryStream));
					const key = normalizeFilename(entryItem.filename);
					expect(data).to.equals(FILE_CONTENTS[key]);
				}
			});
		});
	});

	it('can stream multiple files simultaneously', async () => {
		const zip = expectResultValue(await method());

		try {
			const entries = expectResultValue(await zip.readEntries());
			entries.shift();

			const contents = await Promise.all(entries.map(async (entry) => {
				const stream = expectResultValue(await entry.openReadStream());
				return expectResultValue(await yauzl.streamToString(stream));
			}));

			for(const [index, entry] of entries.entries()) {
				const key = normalizeFilename(entry.filename);
				expect(contents[index]).to.equals(FILE_CONTENTS[key]);
			}
		}
		finally {
			expectResultValue(await zip.close());
		}
	});

	it('destroying stream does not close file descriptor', async () => {
		const zip = expectResultValue(await method());

		try {
			const entries = expectResultValue(await zip.readEntries());
			const stream1 = expectResultValue(await entries[1].openReadStream());

			stream1.destroy();

			const stream2 = expectResultValue(await entries[1].openReadStream());
			const content2 = expectResultValue(await yauzl.streamToString(stream2));
			const key2 = normalizeFilename(entries[1].filename);
			expect(content2).to.equals(FILE_CONTENTS[key2]);

			const stream3 = expectResultValue(await entries[2].openReadStream());
			const content3 = expectResultValue(await yauzl.streamToString(stream3));
			const key3 = normalizeFilename(entries[2].filename);
			expect(content3).to.equals(FILE_CONTENTS[key3]);
		}
		finally {
			expectResultValue(await zip.close());
		}
	});
}
