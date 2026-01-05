import { type Result } from '@zokugun/xtry';
import { expect } from 'vitest';

export function expectResultValue<T>(result: Result<T, string>): T {
	expect(result.error).toBeNullable();

	return result.value as T;
}
