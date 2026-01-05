/**
 * Convert date + time timestamps to `Date` object.
 * DOS date format does not contain any notion of timezone, so interpret as UTC.
 */
export function dosDateTimeToDate(date: number, time: number): Date {
	const day = date & 0x1F; // 1-31
	const month = ((date >> 5) & 0xF) - 1; // 1-12, 0-11
	const year = ((date >> 9) & 0x7F) + 1980; // 0-128, 1980-2108
	const millisecond = 0;
	const second = (time & 0x1F) * 2; // 0-29, 0-58 (even numbers)
	const minute = (time >> 5) & 0x3F; // 0-59
	const hour = (time >> 11) & 0x1F; // 0-23

	return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond));
}
