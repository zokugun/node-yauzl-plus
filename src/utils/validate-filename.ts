import { err, OK, type Result } from '@zokugun/xtry';

const ABSOLUTE_FILENAME_REGEX1 = /^[a-zA-Z]:/;

/**
 * Validate filename.
 */
export function validateFilename(filename: string): Result<void, string> {
	if(filename.includes('\\')) {
		return err(`Invalid characters in filename: ${filename}`);
	}

	if(ABSOLUTE_FILENAME_REGEX1.test(filename) || filename.startsWith('/')) {
		return err(`Absolute path: ${filename}`);
	}

	if(filename.split('/').includes('..')) {
		return err(`Relative path: ${filename}`);
	}

	return OK;
}
