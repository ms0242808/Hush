// SPDX-License-Identifier: Apache-2.0
import type { Bytes } from './types.ts';

/** Join byte arrays into one. */
export function concatBytes(parts: readonly Bytes[]): Bytes {
	let length = 0;
	for (const part of parts) length += part.byteLength;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/** The bytes of an ASCII (or Latin-1) string. */
export function latin1(text: string): Bytes {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

/** Bytes [start, end) read as a Latin-1 string: every byte maps to one character and back. */
export function latin1String(bytes: Bytes, start = 0, end = bytes.byteLength): string {
	let text = '';
	const stop = Math.min(end, bytes.byteLength);
	for (let i = Math.max(0, start); i < stop; i += 4096) {
		text += String.fromCharCode(...bytes.subarray(i, Math.min(stop, i + 4096)));
	}
	return text;
}

/** Whether `bytes` holds `prefix` at `offset`. */
export function hasPrefix(bytes: Bytes, prefix: string | Bytes, offset = 0): boolean {
	const expected = typeof prefix === 'string' ? latin1(prefix) : prefix;
	if (offset < 0 || offset + expected.byteLength > bytes.byteLength) return false;
	for (let i = 0; i < expected.byteLength; i++) if (bytes[offset + i] !== expected[i]) return false;
	return true;
}

export function bytesEqual(a: Bytes, b: Bytes): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

export const u16be = (b: Bytes, o: number): number => ((b[o]! << 8) | b[o + 1]!) >>> 0;
export const u32be = (b: Bytes, o: number): number =>
	((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
export const u16le = (b: Bytes, o: number): number => (b[o]! | (b[o + 1]! << 8)) >>> 0;
export const u24le = (b: Bytes, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) >>> 0;
export const u32le = (b: Bytes, o: number): number =>
	(b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export function setU16be(b: Bytes, o: number, v: number): void {
	b[o] = (v >>> 8) & 0xff;
	b[o + 1] = v & 0xff;
}

export function setU32be(b: Bytes, o: number, v: number): void {
	b[o] = (v >>> 24) & 0xff;
	b[o + 1] = (v >>> 16) & 0xff;
	b[o + 2] = (v >>> 8) & 0xff;
	b[o + 3] = v & 0xff;
}

export function setU16le(b: Bytes, o: number, v: number): void {
	b[o] = v & 0xff;
	b[o + 1] = (v >>> 8) & 0xff;
}

export function setU24le(b: Bytes, o: number, v: number): void {
	b[o] = v & 0xff;
	b[o + 1] = (v >>> 8) & 0xff;
	b[o + 2] = (v >>> 16) & 0xff;
}

export function setU32le(b: Bytes, o: number, v: number): void {
	b[o] = v & 0xff;
	b[o + 1] = (v >>> 8) & 0xff;
	b[o + 2] = (v >>> 16) & 0xff;
	b[o + 3] = (v >>> 24) & 0xff;
}

/** Big-endian bytes of a 16- or 32-bit unsigned integer. */
export function be16(v: number): Bytes {
	const out = new Uint8Array(2);
	setU16be(out, 0, v);
	return out;
}

export function be32(v: number): Bytes {
	const out = new Uint8Array(4);
	setU32be(out, 0, v);
	return out;
}

export function le32(v: number): Bytes {
	const out = new Uint8Array(4);
	setU32le(out, 0, v);
	return out;
}

/** CRC-32 (ISO 3309, as PNG and zlib use it). */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(...parts: Bytes[]): number {
	let crc = 0xffffffff;
	for (const bytes of parts) {
		for (let i = 0; i < bytes.byteLength; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
