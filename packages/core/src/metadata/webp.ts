// SPDX-License-Identifier: Apache-2.0
import { concatBytes, hasPrefix, latin1, latin1String, le32, setU24le, u16le, u24le, u32le } from '../bytes.ts';
import type { Bytes } from '../types.ts';

/**
 * WebP is a RIFF container. Metadata (ICC, EXIF, XMP) needs the extended
 * layout: a VP8X chunk whose flags announce it, ICCP before the image, EXIF
 * and XMP after it.
 */

export interface WebpChunk {
	fourcc: string;
	data: Bytes;
}

export interface WebpInfo {
	width: number;
	height: number;
	animated: boolean;
	lossless: boolean;
	alpha: boolean;
	chunks: WebpChunk[];
}

export class WebpFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WebpFormatError';
	}
}

const FLAG_ANIMATION = 0x02;
const FLAG_XMP = 0x04;
const FLAG_EXIF = 0x08;
const FLAG_ALPHA = 0x10;
const FLAG_ICC = 0x20;

export function parseWebp(bytes: Bytes): WebpInfo {
	if (!hasPrefix(bytes, 'RIFF') || !hasPrefix(bytes, 'WEBP', 8)) throw new WebpFormatError('Not a WebP file');
	const end = Math.min(bytes.byteLength, 8 + u32le(bytes, 4));
	const chunks: WebpChunk[] = [];
	for (let at = 12; at + 8 <= end;) {
		const fourcc = latin1String(bytes, at, at + 4);
		const size = u32le(bytes, at + 4);
		if (at + 8 + size > end) throw new WebpFormatError(`Chunk ${fourcc} overruns the file`);
		chunks.push({ fourcc, data: bytes.subarray(at + 8, at + 8 + size) });
		at += 8 + size + (size % 2);
	}

	let width = 0;
	let height = 0;
	let animated = false;
	let alpha = false;
	const vp8x = chunks.find((c) => c.fourcc === 'VP8X');
	if (vp8x && vp8x.data.byteLength >= 10) {
		animated = (vp8x.data[0]! & FLAG_ANIMATION) !== 0;
		alpha = (vp8x.data[0]! & FLAG_ALPHA) !== 0;
		width = u24le(vp8x.data, 4) + 1;
		height = u24le(vp8x.data, 7) + 1;
	}
	if (chunks.some((c) => c.fourcc === 'ANIM' || c.fourcc === 'ANMF')) animated = true;
	const lossy = chunks.find((c) => c.fourcc === 'VP8 ');
	const lossless = chunks.find((c) => c.fourcc === 'VP8L');
	if (lossy && lossy.data.byteLength >= 10 && width === 0) {
		width = u16le(lossy.data, 6) & 0x3fff;
		height = u16le(lossy.data, 8) & 0x3fff;
	}
	if (lossless && lossless.data.byteLength >= 5) {
		const bits = u32le(lossless.data, 1);
		if (width === 0) {
			width = (bits & 0x3fff) + 1;
			height = ((bits >>> 14) & 0x3fff) + 1;
		}
		if ((bits >>> 28) & 1) alpha = true;
	}
	if (chunks.some((c) => c.fourcc === 'ALPH')) alpha = true;
	return { width, height, animated, lossless: lossless !== undefined && lossy === undefined, alpha, chunks };
}

export interface WebpMetadata {
	icc: Bytes | null;
	exif: Bytes | null;
	xmp: Bytes | null;
}

export function readWebpMetadata(info: WebpInfo): WebpMetadata {
	const find = (fourcc: string) => info.chunks.find((c) => c.fourcc === fourcc)?.data.slice() ?? null;
	let exif = find('EXIF');
	// The spec says raw TIFF; some writers prepend the JPEG-style "Exif\0\0" anyway.
	if (exif && hasPrefix(exif, 'Exif\0\0')) exif = exif.slice(6);
	return { icc: find('ICCP'), exif, xmp: find('XMP ') };
}

function chunk(fourcc: string, data: Bytes): Bytes {
	const parts = [latin1(fourcc), le32(data.byteLength), data];
	if (data.byteLength % 2 === 1) parts.push(new Uint8Array(1));
	return concatBytes(parts);
}

/** The encoder's WebP, rewritten in the extended layout with ICC, EXIF and XMP chunks. */
export function writeWebpMetadata(encoded: Bytes, metadata: Partial<WebpMetadata>): Bytes {
	const { icc = null, exif = null, xmp = null } = metadata;
	if (!icc && !exif && !xmp) return encoded;
	const info = parseWebp(encoded);
	const image = info.chunks.filter((c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8 ' || c.fourcc === 'VP8L');
	if (image.length === 0) throw new WebpFormatError('The encoder produced no image chunk');

	const header = new Uint8Array(10);
	header[0] = (icc ? FLAG_ICC : 0) | (info.alpha ? FLAG_ALPHA : 0) | (exif ? FLAG_EXIF : 0) | (xmp ? FLAG_XMP : 0);
	setU24le(header, 4, info.width - 1);
	setU24le(header, 7, info.height - 1);

	const body = concatBytes([
		chunk('VP8X', header),
		...(icc ? [chunk('ICCP', icc)] : []),
		...image.map((c) => chunk(c.fourcc, c.data)),
		...(exif ? [chunk('EXIF', exif)] : []),
		...(xmp ? [chunk('XMP ', xmp)] : []),
	]);
	return concatBytes([latin1('RIFF'), le32(4 + body.byteLength), latin1('WEBP'), body]);
}
