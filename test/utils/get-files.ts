import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join as pathJoin } from 'node:path';

export type FileContents = Record<string, Buffer | null>;

type DirTraversalContext = {
	files: FileContents;
	fullPath: string;
	dirPath: string;
};

export function getFiles(dirPath: string): FileContents {
	const files = Object.create(null) as FileContents;
	const context: DirTraversalContext = {
		files,
		fullPath: dirPath,
		dirPath: '',
	};
	traverseDir(context);
	return files;
}

function traverseDir({ files, fullPath, dirPath }: DirTraversalContext): void {
	const dirents = readdirSync(fullPath, { withFileTypes: true });
	for(const dirent of dirents) {
		const filename = dirPath ? `${dirPath}/${dirent.name}` : dirent.name;
		if(dirent.isDirectory()) {
			files[`${filename}/`] = null;
			traverseDir({
				files,
				fullPath: pathJoin(fullPath, dirent.name),
				dirPath: filename,
			});
		}
		else if(dirent.name === '.dont_expect_an_empty_dir_entry_for_this_dir') {
			const parentKey = filename.slice(0, -'.dont_expect_an_empty_dir_entry_for_this_dir'.length);
			delete files[parentKey];
		}
		else if(!shouldSkipFile(dirent)) {
			files[filename] = readFileSync(pathJoin(fullPath, dirent.name));
		}
	}
}

function shouldSkipFile(dirent: Dirent): boolean {
	return dirent.name === '.DS_Store' || dirent.name === '.git_please_make_this_directory';
}
