import * as fs from 'node:fs';

type FsShim = Pick<typeof fs, 'open' | 'read' | 'close'>;

const shimmedClosePromisify: FsShim['close']['__promisify__'] = async (_fd) => new Promise<void>((resolve) => {
	setImmediate(resolve);
});

const shimmedClose: FsShim['close'] = Object.assign(
	(_fd: number, callback?: fs.NoParamCallback) => {
		setImmediate(() => {
			callback?.(null);
		});
	},
	{ __promisify__: shimmedClosePromisify },
);

export const SHIMMED_FS: FsShim = {
	open: fs.open,
	read: fs.read,
	close: shimmedClose,
};
