export type ExtraField = {
	id: number;
	data: Buffer;
};

export type EntryFilename = Buffer | string;

export type EntryProperties = {
	filename: EntryFilename;
	compressedSize: number;
	uncompressedSize: number;
	uncompressedSizeIsCertain: boolean;
	compressionMethod: number;
	fileHeaderOffset: number;
	fileDataOffset: number | null;
	isZip64: boolean;
	crc32: number;
	lastModTime: number;
	lastModDate: number;
	comment: string | Buffer;
	extraFields: ExtraField[];
	versionMadeBy: number;
	versionNeededToExtract: number;
	generalPurposeBitFlag: number;
	internalFileAttributes: number;
	externalFileAttributes: number;
	filenameLength: number;
	entryEnd: number;
};

export type OpenReadStreamOptions = {
	decompress?: boolean | 'auto';
	decrypt?: boolean | 'auto';
	validateCrc32?: boolean | 'auto';
	start?: number;
	end?: number;
};

export type ZipOptions = {
	decodeStrings?: boolean;
	validateEntrySizes?: boolean;
	validateFilenames?: boolean;
	strictFilenames?: boolean;
	supportMacArchive?: boolean;
};
