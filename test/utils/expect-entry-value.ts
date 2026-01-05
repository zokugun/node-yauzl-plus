import { type Result } from '@zokugun/xtry';
import { type Entry } from '../../src/index.js';
import { expectResultValue } from './expect-result-value.js';

export function expectEntryValue(result: Result<Entry | null, string>): Entry {
	const entry = expectResultValue(result);
	if(!entry) {
		throw new Error('Expected entry to be defined');
	}

	return entry;
}
