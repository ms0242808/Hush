// SPDX-License-Identifier: Apache-2.0
import { be16, concatBytes, hasPrefix, latin1, u16be } from '../bytes.ts';
import type { Bytes } from '../types.ts';

/**
 * JPEG files are a run of marker segments before the compressed scan. Hush
 * reads metadata from the segments and, on export, slots the source's
 * segments into the encoder's output in front of its tables and scan.
 */

export interface JpegSegment {
	marker: number;
	/** Offset of the 0xFF marker byte. */
	start: number;
	/** Payload (after the length field), as a view into the file. */
	payload: Bytes;
}

export interface JpegFrame {
	width: number;
	height: number;
	components: number;
	precision: number;
}

export interface JpegStructure {
	/** Every segment before the first scan, in file order. */
	segments: JpegSegment[];
	/** Offset of the first SOS marker. */
	scanStart: number;
	frame: JpegFrame | null;
}

export class JpegFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'JpegFormatError';
	}
}

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const COM = 0xfe;
/** Start-of-frame markers: every 0xC0–0xCF except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (marker: number) =>
	marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
/** Markers that stand alone, without a length. */
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);

export function parseJpeg(bytes: Bytes): JpegStructure {
	if (bytes[0] !== 0xff || bytes[1] !== SOI) throw new JpegFormatError('Missing start-of-image marker');
	const segments: JpegSegment[] = [];
	let frame: JpegFrame | null = null;
	let at = 2;
	while (at < bytes.byteLength) {
		if (bytes[at] !== 0xff) throw new JpegFormatError(`Expected a marker at ${at}`);
		while (bytes[at] === 0xff && at < bytes.byteLength) at++; // fill bytes
		const marker = bytes[at]!;
		const start = at - 1;
		at++;
		if (isStandalone(marker)) continue;
		if (at + 2 > bytes.byteLength) throw new JpegFormatError('Truncated segment length');
		const length = u16be(bytes, at);
		if (length < 2 || at + length > bytes.byteLength)
			throw new JpegFormatError(`Segment at ${start} overruns the file`);
		if (marker === SOS) return { segments, scanStart: start, frame };
		const payload = bytes.subarray(at + 2, at + length);
		if (isSof(marker) && payload.byteLength >= 6) {
			frame = {
				precision: payload[0]!,
				height: u16be(payload, 1),
				width: u16be(payload, 3),
				components: payload[5]!,
			};
		}
		segments.push({ marker, start, payload });
		at += length;
	}
	throw new JpegFormatError('No image data (no start-of-scan marker)');
}

export const EXIF_HEADER = 'Exif\0\0';
export const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
export const XMP_EXTENSION_HEADER = 'http://ns.adobe.com/xmp/extension/\0';
const ICC_HEADER = 'ICC_PROFILE\0';
const PHOTOSHOP_HEADER = 'Photoshop 3.0\0';
const JFIF_HEADER = 'JFIF\0';

/** Largest XMP packet a single APP1 segment holds (Adobe's figure). */
export const JPEG_XMP_MAX_BYTES = 65502;
const ICC_CHUNK_BYTES = 65519;
const SEGMENT_MAX_PAYLOAD = 65533;

export interface JpegMetadata {
	/** TIFF block from the Exif APP1 segment. */
	exif: Bytes | null;
	xmp: Bytes | null;
	/** Extended XMP segments, whole payloads (header included), in order. */
	xmpExtended: Bytes[];
	icc: Bytes | null;
	iccIncomplete: boolean;
	/** APP13 Photoshop payloads (IPTC lives here), whole, in order. */
	photoshop: Bytes[];
	comments: Bytes[];
	/** APP0 JFIF payload: carries the pixel density (DPI). */
	jfif: Bytes | null;
}

export function readJpegMetadata(structure: JpegStructure): JpegMetadata {
	const out: JpegMetadata = {
		exif: null,
		xmp: null,
		xmpExtended: [],
		icc: null,
		iccIncomplete: false,
		photoshop: [],
		comments: [],
		jfif: null,
	};
	const iccChunks = new Map<number, Bytes>();
	let iccCount = 0;
	for (const { marker, payload } of structure.segments) {
		if (marker === APP1 && out.exif === null && hasPrefix(payload, 'Exif\0')) {
			out.exif = payload.slice(6);
		} else if (marker === APP1 && out.xmp === null && hasPrefix(payload, XMP_HEADER)) {
			out.xmp = payload.slice(XMP_HEADER.length);
		} else if (marker === APP1 && hasPrefix(payload, XMP_EXTENSION_HEADER)) {
			out.xmpExtended.push(payload.slice());
		} else if (marker === APP2 && hasPrefix(payload, ICC_HEADER) && payload.byteLength > 14) {
			const sequence = payload[12]!;
			iccCount = Math.max(iccCount, payload[13]!);
			if (!iccChunks.has(sequence)) iccChunks.set(sequence, payload.subarray(14));
		} else if (marker === APP13 && hasPrefix(payload, PHOTOSHOP_HEADER)) {
			out.photoshop.push(payload.slice());
		} else if (marker === COM) {
			out.comments.push(payload.slice());
		} else if (marker === APP0 && out.jfif === null && hasPrefix(payload, JFIF_HEADER)) {
			out.jfif = payload.slice();
		}
	}
	if (iccChunks.size > 0) {
		const ordered: Bytes[] = [];
		for (let sequence = 1; sequence <= iccCount; sequence++) {
			const chunk = iccChunks.get(sequence);
			if (!chunk) {
				out.iccIncomplete = true;
				break;
			}
			ordered.push(chunk);
		}
		if (!out.iccIncomplete) out.icc = concatBytes(ordered);
	}
	return out;
}

/** One marker segment, length included. Throws if the payload can't fit. */
export function segment(marker: number, payload: Bytes): Bytes {
	if (payload.byteLength > SEGMENT_MAX_PAYLOAD) {
		throw new JpegFormatError(`A 0x${marker.toString(16)} segment can't hold ${payload.byteLength} bytes`);
	}
	return concatBytes([new Uint8Array([0xff, marker]), be16(payload.byteLength + 2), payload]);
}

export interface JpegOutputMetadata {
	jfif?: Bytes | null;
	exif?: Bytes | null;
	xmp?: Bytes | null;
	xmpExtended?: Bytes[];
	icc?: Bytes | null;
	photoshop?: Bytes[];
	comments?: Bytes[];
}

/**
 * The encoder's JPEG with metadata segments in front of its tables and scan:
 * SOI, JFIF (the source's, for its density, else the encoder's), EXIF, XMP,
 * ICC, Photoshop/IPTC, comments. The encoder's own APPn segments are dropped.
 */
export function writeJpegMetadata(encoded: Bytes, metadata: JpegOutputMetadata): Bytes {
	const structure = parseJpeg(encoded);
	const firstTable = structure.segments.find((s) => !(s.marker >= APP0 && s.marker <= 0xef));
	const bodyStart = firstTable?.start ?? structure.scanStart;
	const encoderJfif = structure.segments.find((s) => s.marker === APP0 && hasPrefix(s.payload, JFIF_HEADER));

	const parts: Bytes[] = [new Uint8Array([0xff, SOI])];
	const jfif = metadata.jfif ?? encoderJfif?.payload.slice() ?? null;
	if (jfif) parts.push(segment(APP0, jfif));
	if (metadata.exif) parts.push(segment(APP1, concatBytes([latin1(EXIF_HEADER), metadata.exif])));
	if (metadata.xmp) parts.push(segment(APP1, concatBytes([latin1(XMP_HEADER), metadata.xmp])));
	for (const extended of metadata.xmpExtended ?? []) parts.push(segment(APP1, extended));
	if (metadata.icc) parts.push(...iccSegments(metadata.icc));
	for (const photoshop of metadata.photoshop ?? []) parts.push(segment(APP13, photoshop));
	for (const comment of metadata.comments ?? []) parts.push(segment(COM, comment));
	parts.push(encoded.subarray(bodyStart));
	return concatBytes(parts);
}

function iccSegments(icc: Bytes): Bytes[] {
	const count = Math.ceil(icc.byteLength / ICC_CHUNK_BYTES);
	if (count > 255) throw new JpegFormatError('ICC profile too large for JPEG');
	const out: Bytes[] = [];
	for (let i = 0; i < count; i++) {
		const chunk = icc.subarray(i * ICC_CHUNK_BYTES, (i + 1) * ICC_CHUNK_BYTES);
		out.push(segment(APP2, concatBytes([latin1(ICC_HEADER), new Uint8Array([i + 1, count]), chunk])));
	}
	return out;
}
