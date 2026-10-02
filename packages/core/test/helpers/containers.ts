// SPDX-License-Identifier: Apache-2.0
/**
 * Tiny container writers for tests: structurally valid JPEG, PNG, WebP and
 * HEIF files with chosen metadata. Their pixel data is fake (the codecs are
 * tested in the browser); everything around it follows the specs, and uses
 * Node's own zlib and CRC rather than the code under test.
 */
import { crc32, deflateSync } from 'node:zlib';

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
export const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const part of parts) {
		out.set(part, o);
		o += part.length;
	}
	return out;
};
const u16be = (v: number) => Uint8Array.of(v >>> 8, v & 0xff);
const u32be = (v: number) => Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const u32le = (v: number) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);

// --- JPEG ---------------------------------------------------------------

export const segment = (marker: number, payload: Uint8Array) =>
	concat(Uint8Array.of(0xff, marker), u16be(payload.length + 2), payload);

export const exifSegment = (tiff: Uint8Array) => segment(0xe1, concat(ascii('Exif\0\0'), tiff));
export const xmpSegment = (xmp: string) => segment(0xe1, concat(ascii('http://ns.adobe.com/xap/1.0/\0'), ascii(xmp)));
export const jfifSegment = (dpi = 300) =>
	segment(0xe0, concat(ascii('JFIF\0'), Uint8Array.of(1, 2, 1), u16be(dpi), u16be(dpi), Uint8Array.of(0, 0)));

export function iccSegments(icc: Uint8Array, chunk = 65519): Uint8Array[] {
	const count = Math.ceil(icc.length / chunk);
	return Array.from({ length: count }, (_, i) =>
		segment(
			0xe2,
			concat(ascii('ICC_PROFILE\0'), Uint8Array.of(i + 1, count), icc.subarray(i * chunk, (i + 1) * chunk)),
		),
	);
}

/** SOI, the given segments, then tables, a frame header, a scan and EOI. */
export function jpegFile(options: { width: number; height: number; components?: number; segments?: Uint8Array[] }) {
	const components = options.components ?? 3;
	const sof = concat(
		Uint8Array.of(8),
		u16be(options.height),
		u16be(options.width),
		Uint8Array.of(components),
		...Array.from({ length: components }, (_, i) => Uint8Array.of(i + 1, 0x11, 0)),
	);
	const sos = concat(
		Uint8Array.of(components),
		...Array.from({ length: components }, (_, i) => Uint8Array.of(i + 1, 0)),
		Uint8Array.of(0, 63, 0),
	);
	return concat(
		Uint8Array.of(0xff, 0xd8),
		...(options.segments ?? []),
		segment(0xdb, new Uint8Array(65)),
		segment(0xc0, sof),
		segment(0xc4, new Uint8Array(20)),
		segment(0xda, sos),
		Uint8Array.of(0x12, 0x34, 0x56, 0xff, 0x00, 0x78),
		Uint8Array.of(0xff, 0xd9),
	);
}

/** What an encoder hands back: SOI, its own JFIF, tables, frame, scan. */
export const encodedJpeg = (width = 4, height = 3) => jpegFile({ width, height, segments: [jfifSegment(72)] });

// --- PNG ----------------------------------------------------------------

export function pngChunk(type: string, data: Uint8Array) {
	const typeBytes = ascii(type);
	return concat(u32be(data.length), typeBytes, data, u32be(crc32(concat(typeBytes, data))));
}

export const iccpChunk = (icc: Uint8Array, name = 'Display P3') =>
	pngChunk('iCCP', concat(ascii(`${name}\0`), Uint8Array.of(0), deflateSync(icc)));

export const xmpItxt = (xmp: string, compressed = false) =>
	pngChunk(
		'iTXt',
		concat(
			ascii('XML:com.adobe.xmp\0'),
			Uint8Array.of(compressed ? 1 : 0, 0),
			ascii('\0\0'),
			compressed ? deflateSync(ascii(xmp)) : ascii(xmp),
		),
	);

export function pngFile(options: { width: number; height: number; bitDepth?: number; chunks?: Uint8Array[] }) {
	const { width, height } = options;
	const ihdr = concat(u32be(width), u32be(height), Uint8Array.of(options.bitDepth ?? 8, 6, 0, 0, 0));
	const raw = new Uint8Array(height * (1 + width * 4));
	return concat(
		ascii('\x89PNG\r\n\x1a\n'),
		pngChunk('IHDR', ihdr),
		...(options.chunks ?? []),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', new Uint8Array(0)),
	);
}

// --- WebP ---------------------------------------------------------------

export function webpChunk(fourcc: string, data: Uint8Array) {
	return concat(ascii(fourcc), u32le(data.length), data, data.length % 2 ? new Uint8Array(1) : new Uint8Array(0));
}

/** A lossy (VP8) frame header for the given size; the rest of the bitstream is filler. */
export function vp8(width: number, height: number) {
	return concat(
		Uint8Array.of(0x50, 0x01, 0x00, 0x9d, 0x01, 0x2a),
		Uint8Array.of(width & 0xff, width >>> 8, height & 0xff, height >>> 8),
		new Uint8Array(12),
	);
}

/** A lossless (VP8L) header for the given size. */
export function vp8l(width: number, height: number, alpha = false) {
	const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
	return concat(Uint8Array.of(0x2f), u32le(bits >>> 0), new Uint8Array(8));
}

export function webpFile(chunks: Uint8Array[]) {
	const body = concat(ascii('WEBP'), ...chunks);
	return concat(ascii('RIFF'), u32le(body.length), body);
}

export function vp8x(width: number, height: number, flags: number) {
	const data = new Uint8Array(10);
	data[0] = flags;
	data.set([(width - 1) & 0xff, ((width - 1) >>> 8) & 0xff, (width - 1) >>> 16], 4);
	data.set([(height - 1) & 0xff, ((height - 1) >>> 8) & 0xff, (height - 1) >>> 16], 7);
	return webpChunk('VP8X', data);
}

// --- HEIF ---------------------------------------------------------------

const box = (type: string, ...payload: Uint8Array[]) => {
	const body = concat(...payload);
	return concat(u32be(8 + body.length), ascii(type), body);
};
const fullBox = (type: string, version: number, flags: number, ...payload: Uint8Array[]) =>
	box(type, Uint8Array.of(version, flags >>> 16, (flags >>> 8) & 0xff, flags & 0xff), ...payload);

export interface HeifSpec {
	brand?: 'heic' | 'avif';
	width: number;
	height: number;
	rotation?: number;
	mirror?: 0 | 1;
	icc?: Uint8Array;
	nclx?: { primaries: number; transfer: number; matrix: number; fullRange: boolean };
	bitDepth?: number;
	/** TIFF block; stored with the usual "Exif\0\0" prefix and offset 6. */
	exif?: Uint8Array;
	xmp?: string;
}

export function heifFile(spec: HeifSpec) {
	const brand = spec.brand ?? 'heic';
	const ftyp = box('ftyp', ascii(brand), u32be(0), ascii('mif1'), ascii(brand), ascii('miaf'));
	const codec = brand === 'avif' ? 'av01' : 'hvc1';
	const exifPayload = spec.exif ? concat(u32be(6), ascii('Exif\0\0'), spec.exif) : null;
	const xmpPayload = spec.xmp ? ascii(spec.xmp) : null;
	const imageData = new Uint8Array(32).fill(0xaa);

	const properties: Uint8Array[] = [fullBox('ispe', 0, 0, u32be(spec.width), u32be(spec.height))];
	if (spec.rotation !== undefined) properties.push(box('irot', Uint8Array.of(spec.rotation & 3)));
	if (spec.mirror !== undefined) properties.push(box('imir', Uint8Array.of(spec.mirror)));
	if (spec.icc) properties.push(box('colr', ascii('prof'), spec.icc));
	if (spec.nclx) {
		const { primaries, transfer, matrix, fullRange } = spec.nclx;
		properties.push(
			box('colr', ascii('nclx'), u16be(primaries), u16be(transfer), u16be(matrix), Uint8Array.of(fullRange ? 0x80 : 0)),
		);
	}
	if (spec.bitDepth)
		properties.push(fullBox('pixi', 0, 0, Uint8Array.of(3, spec.bitDepth, spec.bitDepth, spec.bitDepth)));

	const items: Array<{ id: number; type: string; contentType?: string; data: Uint8Array }> = [
		{ id: 1, type: codec, data: imageData },
	];
	if (exifPayload) items.push({ id: 2, type: 'Exif', data: exifPayload });
	if (xmpPayload) items.push({ id: 3, type: 'mime', contentType: 'application/rdf+xml', data: xmpPayload });

	const build = (mdatStart: number) => {
		let offset = mdatStart + 8;
		const iloc = fullBox(
			'iloc',
			0,
			0,
			Uint8Array.of(0x44, 0x00),
			u16be(items.length),
			...items.map((item) => {
				const entry = concat(u16be(item.id), u16be(0), u16be(1), u32be(offset), u32be(item.data.length));
				offset += item.data.length;
				return entry;
			}),
		);
		const infe = items.map((item) =>
			fullBox(
				'infe',
				2,
				0,
				u16be(item.id),
				u16be(0),
				ascii(item.type),
				ascii('\0'),
				...(item.contentType ? [ascii(`${item.contentType}\0`)] : []),
			),
		);
		const refs = items.filter((item) => item.id !== 1).map((item) => box('cdsc', u16be(item.id), u16be(1), u16be(1)));
		const ipma = fullBox(
			'ipma',
			0,
			0,
			u32be(1),
			u16be(1),
			Uint8Array.of(properties.length),
			...properties.map((_, i) => Uint8Array.of(0x80 | (i + 1))),
		);
		const meta = fullBox(
			'meta',
			0,
			0,
			fullBox('hdlr', 0, 0, u32be(0), ascii('pict'), new Uint8Array(12), ascii('\0')),
			fullBox('pitm', 0, 0, u16be(1)),
			fullBox('iinf', 0, 0, u16be(items.length), ...infe),
			...(refs.length ? [fullBox('iref', 0, 0, ...refs)] : []),
			box('iprp', box('ipco', ...properties), ipma),
			iloc,
		);
		return meta;
	};
	const metaLength = build(0).length;
	const meta = build(ftyp.length + metaLength);
	const mdat = box('mdat', ...items.map((item) => item.data));
	return concat(ftyp, meta, mdat);
}
