// SPDX-License-Identifier: Apache-2.0
/**
 * Read metadata back out of exported files, for the end-to-end tests. These
 * small readers are written from the format specs and share no code with
 * Hush's own; EXIF values themselves are read with exifr.
 */
import exifr from 'exifr';
import { inflateSync } from 'node:zlib';

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
const startsWith = (bytes: Uint8Array, text: string, at = 0) => ascii(bytes, at, at + text.length) === text;

export interface Extracted {
	format: 'jpeg' | 'png' | 'webp';
	exif: Uint8Array | null;
	icc: Uint8Array | null;
	xmp: string | null;
	/** JPEG only. */
	iptc: boolean;
	comments: string[];
	jfifDpi: number | null;
	/** WebP only. */
	webpLossless: boolean | null;
	/** JPEG only: each component's sampling factors, h × v ("1x1" everywhere is 4:4:4). */
	sampling: string[];
	/** JPEG only: progressive (SOF2) rather than baseline. */
	progressive: boolean | null;
}

export function extract(file: Uint8Array): Extracted {
	const out: Extracted = {
		format: 'jpeg',
		exif: null,
		icc: null,
		xmp: null,
		iptc: false,
		comments: [],
		jfifDpi: null,
		webpLossless: null,
		sampling: [],
		progressive: null,
	};
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	if (file[0] === 0xff && file[1] === 0xd8) {
		const icc: Uint8Array[] = [];
		for (let at = 2; at + 4 <= file.length && file[at] === 0xff;) {
			const marker = file[at + 1]!;
			if (marker === 0xda) break;
			const length = view.getUint16(at + 2);
			const payload = file.subarray(at + 4, at + 2 + length);
			if (marker === 0xe1 && startsWith(payload, 'Exif\0\0')) out.exif = payload.slice(6);
			if (marker === 0xe1 && startsWith(payload, 'http://ns.adobe.com/xap/1.0/\0'))
				out.xmp = Buffer.from(payload.subarray(29)).toString('utf8');
			if (marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) icc[payload[12]! - 1] = payload.slice(14);
			if (marker === 0xed && startsWith(payload, 'Photoshop 3.0\0')) out.iptc = true;
			if (marker === 0xfe) out.comments.push(Buffer.from(payload).toString('utf8'));
			if (marker === 0xe0 && startsWith(payload, 'JFIF\0') && payload[7] === 1)
				out.jfifDpi = (payload[8]! << 8) | payload[9]!;
			if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
				out.progressive = marker === 0xc2;
				for (let c = 0; c < payload[5]!; c++) {
					const factors = payload[6 + c * 3 + 1]!;
					out.sampling.push(`${factors >> 4}x${factors & 15}`);
				}
			}
			at += 2 + length;
		}
		if (icc.length) out.icc = Buffer.concat(icc);
		return out;
	}
	if (startsWith(file, '\x89PNG')) {
		out.format = 'png';
		for (let at = 8; at + 12 <= file.length;) {
			const length = view.getUint32(at);
			const type = ascii(file, at + 4, at + 8);
			const data = file.subarray(at + 8, at + 8 + length);
			if (type === 'eXIf') out.exif = data.slice();
			if (type === 'iCCP') out.icc = new Uint8Array(inflateSync(data.subarray(data.indexOf(0) + 2)));
			if (type === 'iTXt' && startsWith(data, 'XML:com.adobe.xmp\0')) {
				const compressed = data[18] === 1;
				let text = data.indexOf(0, 20); // language tag end
				text = data.indexOf(0, text + 1) + 1; // translated keyword end
				const body = data.subarray(text);
				out.xmp = Buffer.from(compressed ? inflateSync(body) : body).toString('utf8');
			}
			at += 12 + length;
		}
		return out;
	}
	if (startsWith(file, 'RIFF') && startsWith(file, 'WEBP', 8)) {
		out.format = 'webp';
		for (let at = 12; at + 8 <= file.length;) {
			const fourcc = ascii(file, at, at + 4);
			const size = view.getUint32(at + 4, true);
			const data = file.subarray(at + 8, at + 8 + size);
			if (fourcc === 'EXIF') out.exif = startsWith(data, 'Exif\0\0') ? data.slice(6) : data.slice();
			if (fourcc === 'ICCP') out.icc = data.slice();
			if (fourcc === 'XMP ') out.xmp = Buffer.from(data).toString('utf8');
			if (fourcc === 'VP8L') out.webpLossless = true;
			if (fourcc === 'VP8 ') out.webpLossless = false;
			at += 8 + size + (size % 2);
		}
		return out;
	}
	throw new Error('Not a JPEG, PNG or WebP file');
}

/** EXIF values from a TIFF block, by exifr, grouped by directory. */
export async function readExif(tiff: Uint8Array) {
	return (await exifr.parse(tiff, {
		translateValues: false,
		reviveValues: false,
		mergeOutput: false,
		tiff: true,
		ifd1: false,
		gps: true,
		makerNote: false,
	})) as { ifd0: Record<string, unknown>; exif?: Record<string, unknown>; gps?: Record<string, unknown> };
}

/** An ICC profile's description ('desc' tag, v2 or v4), read from the spec. */
export function profileName(icc: Uint8Array | null): string | null {
	if (!icc) return null;
	const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
	for (let i = 0; i < view.getUint32(128); i++) {
		const at = 132 + i * 12;
		if (ascii(icc, at, at + 4) !== 'desc') continue;
		const offset = view.getUint32(at + 4);
		const type = ascii(icc, offset, offset + 4);
		if (type === 'desc') return ascii(icc, offset + 12, offset + 12 + view.getUint32(offset + 8) - 1);
		if (type === 'mluc') {
			const length = view.getUint32(offset + 20);
			const start = offset + view.getUint32(offset + 24);
			return Buffer.from(icc.subarray(start, start + length))
				.swap16()
				.toString('utf16le');
		}
	}
	return null;
}

/** The maker note's bytes (tag 0x927C in the EXIF directory), found by walking the TIFF structure. */
export function makerNote(tiff: Uint8Array): Uint8Array | null {
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
	const little = tiff[0] === 0x49;
	const entry = (ifd: number, tag: number) => {
		const count = view.getUint16(ifd, little);
		for (let i = 0; i < count; i++) {
			const at = ifd + 2 + i * 12;
			if (view.getUint16(at, little) === tag) return at;
		}
		return -1;
	};
	const exifPointer = entry(view.getUint32(4, little), 0x8769);
	if (exifPointer < 0) return null;
	const note = entry(view.getUint32(exifPointer + 8, little), 0x927c);
	if (note < 0) return null;
	const length = view.getUint32(note + 4, little);
	const offset = view.getUint32(note + 8, little);
	return tiff.slice(offset, offset + length);
}

/** PSNR in dB between two equally sized RGBA buffers, over RGB. */
export function psnr(a: Uint8Array, b: Uint8Array): number {
	let sum = 0;
	let count = 0;
	for (let i = 0; i < a.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			const d = a[i + c]! - b[i + c]!;
			sum += d * d;
			count++;
		}
	}
	return sum === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sum / count));
}

/** The test model's output for an RGBA image: every colour channel inverted, alpha kept. */
export function inverted(rgba: Uint8Array): Uint8Array {
	return rgba.map((v, i) => (i % 4 === 3 ? v : 255 - v));
}
