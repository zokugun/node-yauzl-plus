[@zokugun/yauzl](https://github.com/zokugun/node-yauzl)
=======================================================

[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![NPM Version](https://img.shields.io/npm/v/@zokugun/yauzl.svg?colorB=green)](https://www.npmjs.com/package/@zokugun/yauzl)
[![Donation](https://img.shields.io/badge/donate-ko--fi-green)](https://ko-fi.com/daiyam)
[![Donation](https://img.shields.io/badge/donate-liberapay-green)](https://liberapay.com/daiyam/donate)
[![Donation](https://img.shields.io/badge/donate-paypal-green)](https://paypal.me/daiyam99)

> Promise-friendly, Result-first, fully typed ZIP reader that keeps large archives off disk and outside memory.

About this project
------------------

`@zokugun/yauzl` is a TypeScript-first port and fork of [`overlookmotel/yauzl-promise`](https://github.com/overlookmotel/yauzl-promise). The upstream project provides a Promise wrapper over the battle-tested [`thejoshwolfe/yauzl`](https://github.com/thejoshwolfe/yauzl) ZIP reader. This repository rebuilds that API:

- written entirely in TypeScript with strict types;
- shipped as native ES modules.

Features
--------

- **Promise + Result-based API** – Every helper (`open`, `fromFd`, `fromBuffer`, `fromReader`) returns a [`Result`](https://www.npmjs.com/package/@zokugun/xtry) so you handle errors explicitly without exceptions.
- **Streaming friendly** – Iterate entries one at a time via `zip.readEntry()` and stream their contents with back-pressure-aware `entry.openReadStream()`.
- **Multi-source readers** – Open ZIPs from file paths, existing file descriptors, in-memory buffers, or custom `Reader` subclasses.
- **Spec coverage** – Supports ZIP64 archives, Mac Archive Utility quirks, Central Directory validation, CRC32 checking, CP437/UTF-8 filename decoding, and DOS timestamp conversion.
- **TypeScript ready** – Rich `.d.ts` declarations shipped in the package; strict options help you catch mistakes at compile time.

Install
-------

```bash
npm add @zokugun/yauzl
```

Example
-------

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, type Result, stringifyError, xtry, xdefer } from '@zokugun/xtry/async';
import { open } from '@zokugun/yauzl';

async function run(): Promise<Result<void, string>> {
    const zipResult = await open('fixtures/archive.zip', {
        decodeStrings: true,
        strictFilenames: false,
    });

    if(zipResult.fails) {
        return zipResult;
    }

    const zip = zipResult.value;
    const defer = xdefer(zip.close)

    for await (const entryResult of zip) {
        if(entryResult.fails) {
            return defer(entryResult);
        }

        const entry = entryResult.value;
        if(!entry) {
            break; // No more files
        }

        const name = entry.filename;

        if(name.endsWith('/')) {
            continue; // Skip directories
        }

        const readStreamResult = await entry.openReadStream({ decompress: true });
        if(streamResult.fails) {
            return defer(streamResult);
        }

        const readStream = await entry.openReadStream();
        const writeStream = fs.createWriteStream(path.join('output', name));

        const result = await xtry(pipeline(readStream, writeStream));
        if(result.fails) {
            return defer(err(stringifyError(result.error)));
        }
    }

    return defer();
}
```

API overview
------------

- `open(path, options?)` – open a ZIP from disk.
- `fromFd(fd, options?)` – reuse an already opened file descriptor.
- `fromBuffer(buffer, options?)` – treat any `Buffer` as a ZIP binary.
- `fromReader(reader, size, options?)` – plug in your own `Reader` subclass (e.g., S3, HTTP).
- `Zip` – exposes `readEntry()`, `close()`, and metadata about the archive.
- `Entry` – read metadata (`filename`, `lastModDate`, `comment`), check `isEncrypted()` / `isCompressed()`, and stream data with `openReadStream()`.
- Utilities – `dosDateTimeToDate`, `streamToBuffer`, `streamToString`, `validateFilename` for standalone usage.

Refer to the TypeScript definitions in `lib/*.d.ts` or the source in `src/` for the complete surface area.

### Options

`open`, `fromFd`, `fromBuffer`, and `fromReader` accept a `ZipOptions` object:

- `decodeStrings` – decode CP437 / UTF-8 filenames to strings (default `true`).
- `validateEntrySizes` – ensure streamed bytes match the header metadata.
- `validateFilenames` & `strictFilenames` – reject unsafe paths or disallow relative components.
- `supportMacArchive` – enable heuristics for ZIPs produced by Apple Archive Utility.

All options default to the most defensive settings; pass `false` when you need raw access.

### `Entry.openReadStream(options?)`

- `decompress` (`boolean | 'auto'`)  If `true`, only the Deflate method (`8`) is supported and `start`/`end` cannot be set.
- `decrypt` (`boolean | 'auto'`) Decryption is not implemented yet, so enabling it returns an error.
- `validateCrc32` (`boolean | 'auto'`) Cannot be combined with partial (`start`/`end`) reads.
- `start` / `end` – byte offsets (`integers`) into the compressed stream.

Development & testing
---------------------

```bash
npm run compile   # Build TypeScript -> lib/
npm test          # Run Vitest suite
npm run lint      # XO linting
```

Contributing
------------

Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for code style, branching, and release guidance. Bug reports, feature proposals, docs tweaks, and test fixtures are all welcome.

Donations
---------

Support this project by becoming a financial contributor.

<table>
    <tr>
        <td><img src="https://raw.githubusercontent.com/daiyam/assets/master/icons/256/funding_kofi.png" alt="Ko-fi" width="80px" height="80px"></td>
        <td><a href="https://ko-fi.com/daiyam" target="_blank">ko-fi.com/daiyam</a></td>
    </tr>
    <tr>
        <td><img src="https://raw.githubusercontent.com/daiyam/assets/master/icons/256/funding_liberapay.png" alt="Liberapay" width="80px" height="80px"></td>
        <td><a href="https://liberapay.com/daiyam/donate" target="_blank">liberapay.com/daiyam/donate</a></td>
    </tr>
    <tr>
        <td><img src="https://raw.githubusercontent.com/daiyam/assets/master/icons/256/funding_paypal.png" alt="PayPal" width="80px" height="80px"></td>
        <td><a href="https://paypal.me/daiyam99" target="_blank">paypal.me/daiyam99</a></td>
    </tr>
</table>

License
-------

Copyright &copy; 2025-present Baptiste Augrain

Licensed under the [MIT license](https://opensource.org/licenses/MIT).
