import path from 'path';
import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/async.ts',
		'src/sync.ts',
	],
	format: ['esm', 'cjs'],
	outDir: 'lib',
	dts: true,
	unbundle: true,
	skipNodeModulesBundle: true,
	// @ts-ignore
	outputOptions: (options, format, _context) => {
		let subdir: string | undefined;

		if(format === 'es') {
			subdir = 'esm';
		}
		else if(format === 'cjs') {
			subdir = 'cjs';
		}

		if(subdir) {
			options.dir = path.join(options.dir, subdir);
		}

		return options;
	},
});
