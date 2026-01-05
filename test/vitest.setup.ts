import process from 'node:process';
import { isPromise } from 'node:util/types';
import { expect } from 'vitest';

process.on('unhandledRejection', (err) => {
	throw err;
});

type MatchResult = {
	pass: boolean;
	message(): string;
};

type AsyncMatchResult = Promise<MatchResult>;

const formatValue = (value: unknown): string => {
	if(typeof value === 'string') {
		return `'${value}'`;
	}

	if(value === null) {
		return 'null';
	}

	if(value === undefined) {
		return 'undefined';
	}

	if(typeof value === 'object') {
		try {
			return JSON.stringify(value);
		}
		catch {
			return value?.constructor?.name ?? '[object Object]';
		}
	}

	return String(value);
};

const customMatchers = {
	toBeString(received: unknown): MatchResult {
		const pass = typeof received === 'string';
		return {
			pass,
			message: () => `${pass ? 'Expected' : 'Did not expect'} ${formatValue(received)} to be a string`,
		};
	},
	// toBeTrue(received: unknown): MatchResult {
	// 	const pass = received === true;
	// 	return {
	// 		pass,
	// 		message: () => `${pass ? 'Expected' : 'Did not expect'} ${formatValue(received)} to be true`,
	// 	};
	// },
	// toBeFalse(received: unknown): MatchResult {
	// 	const pass = received === false;
	// 	return {
	// 		pass,
	// 		message: () => `${pass ? 'Expected' : 'Did not expect'} ${formatValue(received)} to be false`,
	// 	};
	// },
	toBeObject(received: unknown): MatchResult {
		const pass = typeof received === 'object' && received !== null;
		return {
			pass,
			message: () => `${pass ? 'Expected' : 'Did not expect'} ${formatValue(received)} to be an object`,
		};
	},
	toBeArrayOfSize(received: unknown, expectedSize: number): MatchResult {
		if(!Array.isArray(received)) {
			return {
				pass: false,
				message: () => `Expected value to be an array but received ${formatValue(received)}`,
			};
		}

		const pass = received.length === expectedSize;
		return {
			pass,
			message: () => `${pass ? 'Expected' : 'Did not expect'} array length ${received.length} to be ${expectedSize}`,
		};
	},
	toBeAfter(received: unknown, expected: Date): MatchResult {
		if(!(received instanceof Date) || !(expected instanceof Date)) {
			return {
				pass: false,
				message: () => 'Expected both values to be Date instances',
			};
		}

		const pass = received.getTime() > expected.getTime();
		return {
			pass,
			message: () => `${pass ? 'Expected' : 'Did not expect'} ${received.toISOString()} to be after ${expected.toISOString()}`,
		};
	},
	toBeBefore(received: unknown, expected: Date): MatchResult {
		if(!(received instanceof Date) || !(expected instanceof Date)) {
			return {
				pass: false,
				message: () => 'Expected both values to be Date instances',
			};
		}

		const pass = received.getTime() < expected.getTime();
		return {
			pass,
			message: () => `${pass ? 'Expected' : 'Did not expect'} ${received.toISOString()} to be before ${expected.toISOString()}`,
		};
	},
	async toReject(received: unknown): AsyncMatchResult {
		if(!isPromise(received)) {
			return {
				pass: false,
				message: () => `Expected value to be a Promise but received ${formatValue(received)}`,
			};
		}

		try {
			await received;
			return {
				pass: false,
				message: () => 'Expected promise to reject, but it resolved',
			};
		}
		catch (error) {
			return {
				pass: true,
				message: () => `Expected promise not to reject, but it rejected with ${formatValue(error)}`,
			};
		}
	},
};

expect.extend(customMatchers);

declare module 'vitest' {
	type Assertion<T = any> = {
		toBeString(): T;
		// toBeTrue(): T;
		// toBeFalse(): T;
		toBeObject(): T;
		toBeArrayOfSize(expectedSize: number): T;
		toBeAfter(expected: Date): T;
		toBeBefore(expected: Date): T;
		toReject(): Promise<T>;
	};
	type AsymmetricMatchersContaining = {
		toBeString(): void;
		// toBeTrue(): void;
		// toBeFalse(): void;
		toBeObject(): void;
		toBeArrayOfSize(expectedSize: number): void;
		toBeAfter(expected: Date): void;
		toBeBefore(expected: Date): void;
		toReject(): Promise<void>;
	};
}
