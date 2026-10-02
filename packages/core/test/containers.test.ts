// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	parseHeif,
	parseJpeg,
	parsePng,
	parseWebp,
	readJpegMetadata,
	readWebpMetadata,
	writeJpegMetadata,
	writePngMetadata,
	writeWebpMetadata,
} from '../src/index.ts';
import {
	encodedJpeg,
	exifSegment,
	heifFile,
	iccSegments,
	jfifSegment,
	jpegFile,
	pngChunk,
	pngFile,
	segment,
	vp8,
	vp8l,
	vp8x,
	webpChunk,
	webpFile,
	xmpSegment,
} from './helpers/containers.ts';
import { cameraExif } from './helpers/tiff.ts';

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** A 150 KB "profile": more than two APP2 segments' worth. */
const bigIcc = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 31 + 7) & 0xff);

describe('JPEG', () => {
	it('reads the frame and every kind of metadata segment', () => {
		const exif = cameraExif();
		const file = jpegFile({
			width: 6000,
			height: 4000,
			segments: [
				jfifSegment(300),
				exifSegment(exif),
				xmpSegment('<x:xmpmeta/>'),
				...iccSegments(bigIcc),
				segment(0xed, ascii('Photoshop 3.0\0' + '8BIM\x04\x04\0\0\0\0\0\x05caption')),
				segment(0xfe, ascii('a comment')),
			],
		});
		const structure = parseJpeg(file);
		expect(structure.frame).toEqual({ width: 6000, height: 4000, components: 3, precision: 8 });
		const meta = readJpegMetadata(structure);
		expect(meta.exif).toEqual(exif);
		expect(new TextDecoder().decode(meta.xmp!)).toBe('<x:xmpmeta/>');
		expect(sha(meta.icc!)).toBe(sha(bigIcc));
		expect(meta.photoshop).toHaveLength(1);
		expect(meta.comments.map((c) => new TextDecoder().decode(c))).toEqual(['a comment']);
		expect(meta.jfif).not.toBeNull();
	});

	it('reassembles a profile whose chunks are out of order, and notices a missing one', () => {
		const chunks = iccSegments(bigIcc);
		const shuffled = jpegFile({ width: 1, height: 1, segments: [chunks[2]!, chunks[0]!, chunks[1]!] });
		expect(sha(readJpegMetadata(parseJpeg(shuffled)).icc!)).toBe(sha(bigIcc));
		const missing = readJpegMetadata(parseJpeg(jpegFile({ width: 1, height: 1, segments: [chunks[0]!, chunks[2]!] })));
		expect(missing.icc).toBeNull();
		expect(missing.iccIncomplete).toBe(true);
	});

	it('writes metadata in front of the encoder’s tables, dropping its own APP segments', () => {
		const encoded = encodedJpeg(40, 30);
		const exif = cameraExif();
		const out = writeJpegMetadata(encoded, {
			jfif: null,
			exif,
			xmp: ascii('<x/>'),
			icc: bigIcc,
			photoshop: [ascii('Photoshop 3.0\0iptc')],
			comments: [ascii('hi')],
		});
		const structure = parseJpeg(out);
		const markers = structure.segments.map((s) => s.marker);
		// SOI, encoder's JFIF, EXIF, XMP, 3 × ICC, APP13, COM, then the encoder's DQT, SOF0, DHT.
		expect(markers).toEqual([0xe0, 0xe1, 0xe1, 0xe2, 0xe2, 0xe2, 0xed, 0xfe, 0xdb, 0xc0, 0xc4]);
		const meta = readJpegMetadata(structure);
		expect(meta.exif).toEqual(exif);
		expect(sha(meta.icc!)).toBe(sha(bigIcc));
		// The compressed scan is byte-for-byte the encoder's.
		const tail = (bytes: Uint8Array) => bytes.subarray(parseJpeg(bytes).scanStart);
		expect(tail(out)).toEqual(tail(encoded));
	});

	it('prefers the source’s JFIF (it carries the print resolution)', () => {
		const source = jfifSegment(300).subarray(4);
		const out = writeJpegMetadata(encodedJpeg(), { jfif: source });
		expect(readJpegMetadata(parseJpeg(out)).jfif).toEqual(source);
	});

	it('refuses files that are not JPEG or are cut short', () => {
		expect(() => parseJpeg(ascii('not a jpeg'))).toThrow('start-of-image');
		const file = jpegFile({ width: 2, height: 2, segments: [exifSegment(cameraExif())] });
		expect(() => parseJpeg(file.subarray(0, 40))).toThrow();
	});
});

describe('PNG', () => {
	it('writes eXIf, iCCP, XMP and carried chunks before the image data, with valid CRCs', () => {
		const encoded = pngFile({ width: 5, height: 4 });
		const exif = cameraExif();
		const out = writePngMetadata(encoded, {
			exif,
			iccp: { name: 'Display P3', compressed: Uint8Array.of(0x78, 0x9c, 3, 0, 0, 0, 0, 1) },
			xmp: ascii('<x:xmpmeta/>'),
			chunks: [
				{ type: 'pHYs', data: Uint8Array.of(0, 0, 0x2e, 0x23, 0, 0, 0x2e, 0x23, 1) },
				{ type: 'tEXt', data: ascii('Author\0Jo') },
			],
		});
		const { chunks } = parsePng(out);
		expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'iCCP', 'pHYs', 'eXIf', 'iTXt', 'tEXt', 'IDAT', 'IEND']);
		expect(chunks.find((c) => c.type === 'eXIf')!.data).toEqual(exif);
		// Re-serialising with independent CRCs reproduces the file exactly.
		const rebuilt = new Uint8Array([...out.subarray(0, 8), ...chunks.flatMap((c) => [...pngChunk(c.type, c.data)])]);
		expect(rebuilt).toEqual(out);
		// IDAT is the encoder's, untouched.
		const idat = (bytes: Uint8Array) => parsePng(bytes).chunks.find((c) => c.type === 'IDAT')!.data;
		expect(inflateSync(idat(out))).toEqual(inflateSync(idat(encoded)));
	});

	it('drops sRGB when an embedded profile is written (the two must not both appear)', () => {
		const out = writePngMetadata(pngFile({ width: 1, height: 1 }), {
			iccp: { name: 'p', compressed: Uint8Array.of(1) },
			chunks: [{ type: 'sRGB', data: Uint8Array.of(0) }],
		});
		expect(parsePng(out).chunks.map((c) => c.type)).not.toContain('sRGB');
	});
});

describe('WebP', () => {
	it('reads sizes from VP8, VP8L and VP8X', () => {
		expect(parseWebp(webpFile([webpChunk('VP8 ', vp8(640, 480))]))).toMatchObject({
			width: 640,
			height: 480,
			lossless: false,
		});
		expect(parseWebp(webpFile([webpChunk('VP8L', vp8l(321, 123, true))]))).toMatchObject({
			width: 321,
			height: 123,
			lossless: true,
			alpha: true,
		});
		expect(parseWebp(webpFile([vp8x(9000, 6000, 0), webpChunk('VP8 ', vp8(1, 1))]))).toMatchObject({
			width: 9000,
			height: 6000,
		});
	});

	it('spots animation', () => {
		const animated = webpFile([
			vp8x(10, 10, 0x02),
			webpChunk('ANIM', new Uint8Array(6)),
			webpChunk('ANMF', new Uint8Array(24)),
		]);
		expect(parseWebp(animated).animated).toBe(true);
	});

	it('rewrites a simple file into the extended layout with ICC, EXIF and XMP', () => {
		const encoded = webpFile([webpChunk('VP8 ', vp8(300, 200))]);
		const exif = cameraExif();
		const out = writeWebpMetadata(encoded, { icc: bigIcc, exif, xmp: ascii('<x/>') });
		const info = parseWebp(out);
		expect(info.chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'ICCP', 'VP8 ', 'EXIF', 'XMP ']);
		expect(info.chunks[0]!.data[0]).toBe(0x20 | 0x08 | 0x04);
		expect(info).toMatchObject({ width: 300, height: 200 });
		const meta = readWebpMetadata(info);
		expect(meta.exif).toEqual(exif);
		expect(sha(meta.icc!)).toBe(sha(bigIcc));
		// RIFF size is the file length minus the 8-byte RIFF header.
		expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
	});

	it('keeps the alpha flag and the ALPH chunk', () => {
		const encoded = webpFile([
			vp8x(4, 4, 0x10),
			webpChunk('ALPH', Uint8Array.of(0, 1, 2)),
			webpChunk('VP8 ', vp8(4, 4)),
		]);
		const out = writeWebpMetadata(encoded, { exif: cameraExif() });
		const info = parseWebp(out);
		expect(info.chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'ALPH', 'VP8 ', 'EXIF']);
		expect(info.chunks[0]!.data[0]! & 0x10).toBe(0x10);
	});

	it('accepts EXIF chunks written with a JPEG-style prefix', () => {
		const exif = cameraExif();
		const file = webpFile([
			vp8x(2, 2, 0x08),
			webpChunk('VP8 ', vp8(2, 2)),
			webpChunk('EXIF', new Uint8Array([...ascii('Exif\0\0'), ...exif])),
		]);
		expect(readWebpMetadata(parseWebp(file)).exif).toEqual(exif);
	});
});

describe('HEIF (HEIC and AVIF)', () => {
	it('reads the primary item: size, rotation, mirror, profile, depth, EXIF and XMP', () => {
		const exif = cameraExif({ orientation: 6 });
		const info = parseHeif(
			heifFile({
				width: 4032,
				height: 3024,
				rotation: 3,
				mirror: 1,
				icc: bigIcc.subarray(0, 600),
				bitDepth: 10,
				exif,
				xmp: '<x:xmpmeta/>',
			}),
		);
		expect(info).toMatchObject({ width: 4032, height: 3024, rotation: 3, mirror: 1, bitDepth: 10 });
		expect(info.icc).toEqual(bigIcc.subarray(0, 600));
		expect(info.exif).toEqual(exif);
		expect(new TextDecoder().decode(info.xmp!)).toBe('<x:xmpmeta/>');
	});

	it('reads CICP colour from an nclx box', () => {
		const info = parseHeif(
			heifFile({
				brand: 'avif',
				width: 8,
				height: 8,
				nclx: { primaries: 12, transfer: 13, matrix: 6, fullRange: true },
			}),
		);
		expect(info.nclx).toEqual({ primaries: 12, transfer: 13, matrix: 6, fullRange: true });
		expect(info.brands).toContain('avif');
	});

	it('refuses files without a primary image', () => {
		expect(() => parseHeif(ascii('\0\0\0\x10ftypheic\0\0\0\0'))).toThrow('meta');
	});
});
