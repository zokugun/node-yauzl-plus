import { type EntryInstance, type Zip } from './zip.js';

// Finalization registry for entries with uncertain uncompressed size
export const uncertainUncompressedSizeEntriesRegistry = new FinalizationRegistry(
	({ zip, ref }: { zip: Zip; ref: WeakRef<EntryInstance> }) => zip._uncertainUncompressedSizeEntryRefs?.delete(ref),
);
