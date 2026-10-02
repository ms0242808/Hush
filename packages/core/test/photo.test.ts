// SPDX-License-Identifier: Apache-2.0
import exifr from 'exifr';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	DecodeError,
	displayP3Profile,
	hasGps,
	parseJpeg,
	parsePng,
	parseWebp,
	readJpegMetadata,
	readOrientation,
	readPhoto,
	readWebpMetadata,
	UnsupportedPhotoError,
	writePhotoMetadata,
	xmpHasLocation,
	type PhotoInfo,
	type WriteOptions,
	type Zlib,
} from '../src/index.ts';
import {
	encodedJpeg,
	exifSegment,
	heifFile,
	iccpChunk,
	iccSegments,
	jfifSegment,
	jpegFile,
	pngChunk,
	pngFile,
	segment,
	vp8,
	vp8x,
	webpChunk,
	webpFile,
	xmpItxt,
	xmpSegment,
} from './helpers/containers.ts';
import { cameraExif } from './helpers/tiff.ts';

const zlib: Zlib = {
	inflate: (bytes) => Promise.resolve(new Uint8Array(inflateSync(bytes))),
	deflate: (bytes) => Promise.resolve(new Uint8Array(deflateSync(bytes))),
};
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const icc = displayP3Profile();
const XMP =
	'<x:xmpmeta><rdf:Description exif:GPSLatitude="25,2.0N" dc:format="image/jpeg" tiff:Orientation="6"/></x:xmpmeta>';
const parseExif = (tiff: Uint8Array) =>
	exifr.parse(tiff, {
		translateValues: false,
		reviveValues: false,
		mergeOutput: false,
		tiff: true,
		gps: true,
		ifd1: true,
	});

const options = (overrides: Partial<WriteOptions> = {}): WriteOptions => ({
	format: 'jpeg',
	software: 'Hush',
	removeLocation: false,
	orientation: 1,
	width: 4,
	height: 3,
	...overrides,
});

/** The output's EXIF, ICC and XMP, read back with the container parsers. */
function readBack(bytes: Uint8Array, format: 'jpeg' | 'png' | 'webp') {
	if (format === 'jpeg') {
		const meta = readJpegMetadata(parseJpeg(bytes));
		return { exif: meta.exif, icc: meta.icc, xmp: meta.xmp, photoshop: meta.photoshop, jfif: meta.jfif };
	}
	if (format === 'webp') return { ...readWebpMetadata(parseWebp(bytes)), photoshop: [], jfif: null };
	const { chunks } = parsePng(bytes);
	const xmp = chunks.find((c) => c.type === 'iTXt' && ascii('XML:com.adobe.xmp').every((b, i) => c.data[i] === b));
	const iccp = chunks.find((c) => c.type === 'iCCP');
	return {
		exif: chunks.find((c) => c.type === 'eXIf')?.data ?? null,
		icc: iccp ? new Uint8Array(inflateSync(iccp.data.subarray(iccp.data.indexOf(0) + 2))) : null,
		xmp: xmp ? xmp.data.subarray(22) : null,
		photoshop: [],
		jfif: null,
	};
}

describe('readPhoto', () => {
	it('reads a camera JPEG: size, orientation, EXIF, profile, XMP, IPTC and density', async () => {
		const exif = cameraExif({ orientation: 6 });
		const file = jpegFile({
			width: 8192,
			height: 5464,
			segments: [
				jfifSegment(300),
				exifSegment(exif),
				xmpSegment(XMP),
				...iccSegments(icc),
				segment(0xed, ascii('Photoshop 3.0\0' + '8BIM')),
			],
		});
		const info = await readPhoto(file, zlib);
		expect(info).toMatchObject({
			format: 'jpeg',
			width: 8192,
			height: 5464,
			orientation: 6,
			bitDepth: 8,
			colour: 'icc',
		});
		expect(info.exif).toEqual(exif);
		expect(info.icc).toEqual(icc);
		expect(info.jpeg?.photoshop).toHaveLength(1);
		expect(info.jpeg?.jfif).not.toBeNull();
	});

	it('refuses CMYK JPEGs, animated WebP and PNG, and HDR HEIF before decoding anything', async () => {
		await expect(readPhoto(jpegFile({ width: 10, height: 10, components: 4 }), zlib)).rejects.toMatchObject({
			name: 'UnsupportedPhotoError',
			code: 'cmyk',
		});
		const animatedWebp = webpFile([
			vp8x(4, 4, 0x02),
			webpChunk('ANIM', new Uint8Array(6)),
			webpChunk('ANMF', new Uint8Array(30)),
		]);
		await expect(readPhoto(animatedWebp, zlib)).rejects.toMatchObject({ code: 'animated' });
		const apng = pngFile({ width: 4, height: 4, chunks: [pngChunk('acTL', new Uint8Array(8))] });
		await expect(readPhoto(apng, zlib)).rejects.toMatchObject({ code: 'animated' });
		const pq = heifFile({
			width: 6000,
			height: 4000,
			nclx: { primaries: 9, transfer: 16, matrix: 9, fullRange: false },
		});
		await expect(readPhoto(pq, zlib)).rejects.toMatchObject({ code: 'hdr' });
		await expect(readPhoto(ascii('hello there, not a photo'), zlib)).rejects.toBeInstanceOf(UnsupportedPhotoError);
	});

	it('calls a damaged container a decode error, not a crash', async () => {
		const file = jpegFile({ width: 2, height: 2, segments: [exifSegment(cameraExif())] });
		await expect(readPhoto(file.subarray(0, 60), zlib)).rejects.toBeInstanceOf(DecodeError);
	});

	it('reads PNG: decompresses the profile and XMP, keeps text and density chunks to carry', async () => {
		const file = pngFile({
			width: 30,
			height: 20,
			bitDepth: 16,
			chunks: [
				iccpChunk(icc),
				pngChunk('pHYs', Uint8Array.of(0, 0, 0x2e, 0x23, 0, 0, 0x2e, 0x23, 1)),
				pngChunk('eXIf', cameraExif({ orientation: 3 })),
				xmpItxt(XMP, true),
				pngChunk('tEXt', ascii('Comment\0hello')),
			],
		});
		const info = await readPhoto(file, zlib);
		expect(info).toMatchObject({ format: 'png', width: 30, height: 20, bitDepth: 16, orientation: 3, colour: 'icc' });
		expect(info.icc).toEqual(icc);
		expect(new TextDecoder().decode(info.xmp!)).toBe(XMP);
		expect(info.png?.chunks.map((c) => c.type)).toEqual(['pHYs', 'tEXt']);
		expect(info.warnings).toContain('bit-depth-reduced');
	});

	it('reads HEIC orientation from irot/imir and a P3 nclx as a Display P3 profile', async () => {
		const file = heifFile({
			width: 4032,
			height: 3024,
			rotation: 3,
			nclx: { primaries: 12, transfer: 13, matrix: 6, fullRange: true },
			exif: cameraExif({ orientation: 6 }),
		});
		const info = await readPhoto(file, zlib);
		expect(info).toMatchObject({ format: 'heic', width: 4032, height: 3024, orientation: 6, colour: 'nclx-p3' });
		expect(info.icc).toEqual(displayP3Profile());
	});
});

describe('writePhotoMetadata', () => {
	async function jpegInfo(): Promise<PhotoInfo> {
		return readPhoto(
			jpegFile({
				width: 4,
				height: 3,
				segments: [
					jfifSegment(300),
					exifSegment(cameraExif({ orientation: 6 })),
					xmpSegment(XMP),
					...iccSegments(icc),
					segment(0xed, ascii('Photoshop 3.0\0' + '8BIM')),
					segment(0xfe, ascii('shot on the night')),
				],
			}),
			zlib,
		);
	}

	it('JPEG → JPEG: EXIF matches apart from Software, the profile is byte for byte, the rest rides along', async () => {
		const info = await jpegInfo();
		const { bytes, warnings } = await writePhotoMetadata(encodedJpeg(), info, options({ orientation: 6 }), zlib);
		expect(warnings).toEqual([]);
		const out = readBack(bytes, 'jpeg');
		const [before, after] = await Promise.all([parseExif(info.exif!), parseExif(out.exif!)]);
		expect(after.ifd0.Software).toBe('Hush');
		expect({ ...after.ifd0, Software: 0 }).toEqual({ ...before.ifd0, Software: 0 });
		// Everything but the pixel dimensions, which now describe the saved pixels (this fixture's EXIF claimed 8192 × 5464).
		const sizeless = ({ ExifImageWidth: _w, ExifImageHeight: _h, ...rest }: Record<string, unknown>) => rest;
		expect(sizeless(after.exif)).toEqual(sizeless(before.exif));
		expect(after.exif).toMatchObject({ ExifImageWidth: 4, ExifImageHeight: 3 });
		expect(after.gps).toEqual(before.gps);
		expect(after.ifd0.Orientation).toBe(6); // never rotated, so the tag stays
		expect(out.icc).toEqual(icc);
		expect(new TextDecoder().decode(out.xmp!)).toBe(XMP);
		expect(out.photoshop).toHaveLength(1);
		expect(out.jfif).toEqual(info.jpeg!.jfif);
	});

	it('removes location from EXIF and XMP when asked, and only then', async () => {
		const info = await jpegInfo();
		const kept = readBack(
			(await writePhotoMetadata(encodedJpeg(), info, options({ orientation: 6 }), zlib)).bytes,
			'jpeg',
		);
		expect(hasGps(kept.exif!)).toBe(true);
		expect(xmpHasLocation(kept.xmp!)).toBe(true);
		const removed = readBack(
			(await writePhotoMetadata(encodedJpeg(), info, options({ orientation: 6, removeLocation: true }), zlib)).bytes,
			'jpeg',
		);
		expect(hasGps(removed.exif!)).toBe(false);
		expect((await parseExif(removed.exif!)).gps).toBeUndefined();
		expect(xmpHasLocation(removed.xmp!)).toBe(false);
	});

	it('pixels a decoder already turned upright get Orientation 1, in EXIF and XMP alike', async () => {
		const info = await readPhoto(
			heifFile({ width: 4, height: 3, rotation: 3, icc, exif: cameraExif({ orientation: 6 }), xmp: XMP }),
			zlib,
		);
		const { bytes } = await writePhotoMetadata(
			encodedJpeg(3, 4),
			info,
			options({ orientation: 1, width: 3, height: 4 }),
			zlib,
		);
		const out = readBack(bytes, 'jpeg');
		expect(readOrientation(out.exif!)).toBe(1);
		expect(new TextDecoder().decode(out.xmp!)).toContain('tiff:Orientation="1"');
		const parsed = await parseExif(out.exif!);
		expect(parsed.exif.ExifImageWidth).toBe(3);
		expect(parsed.exif.ExifImageHeight).toBe(4);
		expect(out.icc).toEqual(icc);
	});

	it('AVIF decoded as stored: its irot becomes an EXIF orientation, even when it had no EXIF', async () => {
		const info = await readPhoto(heifFile({ brand: 'avif', width: 4, height: 3, rotation: 1 }), zlib);
		expect(info.orientation).toBe(8);
		const { bytes } = await writePhotoMetadata(encodedJpeg(), info, options({ orientation: info.orientation }), zlib);
		const parsed = await parseExif(readBack(bytes, 'jpeg').exif!);
		expect(parsed.ifd0).toMatchObject({ Orientation: 8, Software: 'Hush' });
	});

	it('JPEG → PNG and → WebP carry EXIF, the profile and XMP; IPTC can only stay in JPEG', async () => {
		const info = await jpegInfo();
		for (const format of ['png', 'webp'] as const) {
			const encoded = format === 'png' ? pngFile({ width: 4, height: 3 }) : webpFile([webpChunk('VP8 ', vp8(4, 3))]);
			const { bytes, warnings } = await writePhotoMetadata(encoded, info, options({ format, orientation: 6 }), zlib);
			expect(warnings).toEqual(['iptc-not-carried']);
			const out = readBack(bytes, format);
			expect((await parseExif(out.exif!)).ifd0).toMatchObject({ Make: 'Canon', Software: 'Hush', Orientation: 6 });
			expect(out.icc).toEqual(icc);
			expect(new TextDecoder().decode(out.xmp!)).toBe(XMP);
		}
	});

	it('PNG → PNG reuses the stored profile chunk and carried chunks', async () => {
		const source = pngFile({
			width: 4,
			height: 3,
			chunks: [iccpChunk(icc, 'My Profile'), pngChunk('pHYs', Uint8Array.of(0, 0, 0x2e, 0x23, 0, 0, 0x2e, 0x23, 1))],
		});
		const info = await readPhoto(source, zlib);
		const { bytes } = await writePhotoMetadata(
			pngFile({ width: 4, height: 3 }),
			info,
			options({ format: 'png' }),
			zlib,
		);
		const types = parsePng(bytes).chunks.map((c) => c.type);
		expect(types).toEqual(['IHDR', 'iCCP', 'pHYs', 'eXIf', 'IDAT', 'IEND']);
		const iccp = parsePng(bytes).chunks.find((c) => c.type === 'iCCP')!;
		expect(new TextDecoder().decode(iccp.data.subarray(0, 10))).toBe('My Profile');
	});

	it('a photo without metadata still says who made the file', async () => {
		const info = await readPhoto(pngFile({ width: 4, height: 3 }), zlib);
		const { bytes } = await writePhotoMetadata(
			pngFile({ width: 4, height: 3 }),
			info,
			options({ format: 'png' }),
			zlib,
		);
		expect((await parseExif(readBack(bytes, 'png').exif!)).ifd0).toEqual({ Software: 'Hush' });
	});

	it('drops an XMP packet too large for a JPEG segment, and says so', async () => {
		const info = await readPhoto(
			pngFile({ width: 4, height: 3, chunks: [xmpItxt(`<x>${'a'.repeat(70_000)}</x>`)] }),
			zlib,
		);
		const { bytes, warnings } = await writePhotoMetadata(encodedJpeg(), info, options(), zlib);
		expect(warnings).toContain('xmp-too-large');
		expect(readBack(bytes, 'jpeg').xmp).toBeNull();
	});
});
