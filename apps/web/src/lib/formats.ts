// SPDX-License-Identifier: Apache-2.0

export type PhotoFormat = 'jpeg' | 'png' | 'webp';

/** Identify a file by its first bytes, never by its name or MIME type. */
export function sniffFormat(bytes: Uint8Array): PhotoFormat | null {
	const b = (i: number) => bytes[i] ?? -1;
	if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpeg';
	if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'png';
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
	if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
	return null;
}

/** Sniff a file from its first 16 bytes, without reading the rest. */
export async function sniffFile(file: Blob): Promise<PhotoFormat | null> {
	return sniffFormat(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
}
