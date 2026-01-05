import {defineConfig} from 'vitest/config';
import path from 'path';

export default defineConfig(() => {
	const isMacBigTargeted = process.argv.some(arg => arg.includes('mac-big.test'));

	return {
		test: {
			include: isMacBigTargeted ? ['test/mac-big.test.ts'] : ['test/**/*.test.ts'],
			exclude: isMacBigTargeted ? [] : ['test/mac-big.test.ts'],
			environment: 'node',
			reporters: isMacBigTargeted ? 'verbose' : 'dot',
			setupFiles: ['./test/vitest.setup.ts'],
			globals: false,
			maxWorkers: isMacBigTargeted ? 1 : undefined,
		},
		coverage: {
			provider: 'v8',
			reportsDirectory: 'coverage',
			include: ['dist/index.js', 'dist/lib/**/*.js'],
		}
	};
});
