export function normalizeFilename(filename: string | Buffer): string {
	return typeof filename === 'string' ? filename : filename.toString('utf8');
}
