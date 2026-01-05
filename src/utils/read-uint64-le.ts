/**
 * Read Uint64 from buffer.
 * There is no native JS function for this, because we can't actually store 64-bit integers precisely.
 * After 53 bits, JavaScript's Number type (IEEE 754 double) can't store individual integers anymore.
 * But 53 bits is enough for our purposes in this context.
 */
export function readUInt64LE(buffer: Buffer, offset: number): number {
	// Can't use bitshifting here, because only supports 32-bit integers in JS
	return (buffer.readUInt32LE(offset + 4) * 0x1_00_00_00_00) + buffer.readUInt32LE(offset);
}
