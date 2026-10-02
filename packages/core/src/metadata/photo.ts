// SPDX-License-Identifier: Apache-2.0
import { latin1, latin1String } from '../bytes.ts';
import { DecodeError, UnsupportedPhotoError } from '../errors.ts';
import { SNIFF_BYTES, sniffFormat, type OutputFormat } from '../formats.ts';
import type { Bytes, Format } from '../types.ts';
import { createExif, editExif, JPEG_EXIF_MAX_BYTES, readOrientation, type ExifEdit, type Orientation } from './exif.ts';
import { parseHeif } from './heif.ts';
import { iccDescription, interpretNclx } from './icc.ts';
import { JPEG_XMP_MAX_BYTES, parseJpeg, readJpegMetadata, writeJpegMetadata } from './jpeg.ts';
import { orientationFromHeif } from './orientation.ts';
import {
	isXmpChunk,
	parseIccp,
	parseItxt,
	parsePng,
	PNG_CARRIED_CHUNKS,
	writePngMetadata,
	type PngChunk,
	type PngIcc,
} from './png.ts';
import type { MetadataWarning } from './warnings.ts';
import { parseWebp, readWebpMetadata, writeWebpMetadata } from './webp.ts';
import { stripXmpLocation, xmpHasLocation } from './xmp.ts';

/** zlib (RFC 1950) streams, for PNG's compressed profile and text. Supplied by the platform. */
export interface Zlib {
	inflate(bytes: Bytes): Promise<Bytes>;
	deflate(bytes: Bytes): Promise<Bytes>;
}

/** Where a photo's colour description came from. */
export type ColourSource = 'icc' | 'nclx-srgb' | 'nclx-p3' | 'none' | 'unknown';

/**
 * Everything Hush learns from a photo's container before decoding its pixels:
 * enough to refuse it early (format, size, CMYK, HDR, animation), and every
 * piece of metadata the export will carry (§2.6).
 */
export interface PhotoInfo {
	format: Format;
	/** Stored pixel size, before any rotation. */
	width: number;
	height: number;
	/** Bits per channel in the file. Hush works in 8 this phase. */
	bitDepth: number;
	/** How the stored pixels are turned upright: EXIF Orientation, or HEIF irot/imir. */
	orientation: Orientation;
	/** TIFF block. */
	exif: Bytes | null;
	/** Raw ICC profile (PNG's is decompressed). */
	icc: Bytes | null;
	colour: ColourSource;
	xmp: Bytes | null;
	/** Pieces only a JPEG can hold. */
	jpeg: { jfif: Bytes | null; xmpExtended: Bytes[]; photoshop: Bytes[]; comments: Bytes[] } | null;
	/** Pieces only a PNG can hold: the iCCP chunk as stored, plus colour, density and text chunks. */
	png: { iccp: PngIcc | null; chunks: PngChunk[] } | null;
	webp: { lossless: boolean } | null;
	warnings: MetadataWarning[];
}

/** Bytes → format, or a clear refusal. */
export function photoFormat(bytes: Bytes): Format {
	const format = sniffFormat(bytes.subarray(0, SNIFF_BYTES));
	if (!format) throw new UnsupportedPhotoError('unknown-format');
	return format;
}

/**
 * Read a photo's container: dimensions, orientation, colour and metadata.
 * Throws UnsupportedPhotoError for what Hush can't process (CMYK JPEG, HDR,
 * animation) and DecodeError for a damaged container — both before any
 * pixels are decoded.
 */
export async function readPhoto(bytes: Bytes, zlib: Zlib): Promise<PhotoInfo> {
	const format = photoFormat(bytes);
	try {
		switch (format) {
			case 'jpeg':
				return readJpeg(bytes);
			case 'png':
				return await readPng(bytes, zlib);
			case 'webp':
				return readWebp(bytes);
			case 'heic':
			case 'avif':
				return readHeif(bytes, format);
		}
	} catch (error) {
		if (error instanceof UnsupportedPhotoError) throw error;
		throw new DecodeError(format, error);
	}
}

/** A photo with no metadata at all: synthetic test photos, pixels from elsewhere. */
export function blankPhotoInfo(format: Format, width: number, height: number): PhotoInfo {
	return { ...base(format), width, height };
}

const base = (format: Format): Omit<PhotoInfo, 'width' | 'height'> => ({
	format,
	bitDepth: 8,
	orientation: 1,
	exif: null,
	icc: null,
	colour: 'none',
	xmp: null,
	jpeg: null,
	png: null,
	webp: null,
	warnings: [],
});

function readJpeg(bytes: Bytes): PhotoInfo {
	const structure = parseJpeg(bytes);
	if (!structure.frame) throw new Error('No frame header before the image data');
	if (structure.frame.components === 4) throw new UnsupportedPhotoError('cmyk');
	const meta = readJpegMetadata(structure);
	return {
		...base('jpeg'),
		width: structure.frame.width,
		height: structure.frame.height,
		bitDepth: structure.frame.precision,
		orientation: (meta.exif && readOrientation(meta.exif)) ?? 1,
		exif: meta.exif,
		icc: meta.icc,
		colour: meta.icc ? 'icc' : 'none',
		xmp: meta.xmp,
		jpeg: { jfif: meta.jfif, xmpExtended: meta.xmpExtended, photoshop: meta.photoshop, comments: meta.comments },
		warnings: meta.iccIncomplete ? ['icc-incomplete'] : [],
	};
}

async function readPng(bytes: Bytes, zlib: Zlib): Promise<PhotoInfo> {
	const { header, chunks } = parsePng(bytes);
	if (chunks.some((c) => c.type === 'acTL')) throw new UnsupportedPhotoError('animated');
	const cicp = chunks.find((c) => c.type === 'cICP');
	if (cicp && cicp.data.byteLength >= 2 && (cicp.data[1] === 16 || cicp.data[1] === 18)) {
		throw new UnsupportedPhotoError('hdr');
	}
	const warnings: MetadataWarning[] = [];
	const info: PhotoInfo = {
		...base('png'),
		width: header.width,
		height: header.height,
		bitDepth: header.bitDepth,
		png: { iccp: null, chunks: [] },
		warnings,
	};
	for (const chunk of chunks) {
		if (chunk.type === 'eXIf' && info.exif === null) {
			info.exif = chunk.data.slice();
		} else if (chunk.type === 'iCCP' && info.png!.iccp === null) {
			const iccp = parseIccp(chunk.data);
			if (iccp) {
				info.png!.iccp = { name: iccp.name, compressed: iccp.compressed.slice() };
				try {
					info.icc = await zlib.inflate(iccp.compressed);
					info.colour = 'icc';
				} catch {
					warnings.push('colour-unknown');
				}
			}
		} else if (isXmpChunk(chunk) && info.xmp === null) {
			const text = parseItxt(chunk.data);
			if (text) info.xmp = text.compressed ? await zlib.inflate(text.text) : text.text.slice();
		} else if (PNG_CARRIED_CHUNKS.has(chunk.type)) {
			info.png!.chunks.push({ type: chunk.type, data: chunk.data.slice() });
		}
	}
	info.orientation = (info.exif && readOrientation(info.exif)) ?? 1;
	if (header.bitDepth > 8) warnings.push('bit-depth-reduced');
	return info;
}

function readWebp(bytes: Bytes): PhotoInfo {
	const parsed = parseWebp(bytes);
	if (parsed.animated) throw new UnsupportedPhotoError('animated');
	const meta = readWebpMetadata(parsed);
	return {
		...base('webp'),
		width: parsed.width,
		height: parsed.height,
		orientation: (meta.exif && readOrientation(meta.exif)) ?? 1,
		exif: meta.exif,
		icc: meta.icc,
		colour: meta.icc ? 'icc' : 'none',
		xmp: meta.xmp,
		webp: { lossless: parsed.lossless },
	};
}

function readHeif(bytes: Bytes, format: 'heic' | 'avif'): PhotoInfo {
	const heif = parseHeif(bytes);
	const warnings: MetadataWarning[] = [];
	let icc = heif.icc;
	let colour: ColourSource = icc ? 'icc' : 'none';
	if (heif.nclx) {
		const meaning = interpretNclx(heif.nclx);
		if (meaning.kind === 'hdr') throw new UnsupportedPhotoError('hdr');
		if (!icc) {
			if (meaning.kind === 'profile') {
				icc = meaning.icc;
				colour = 'nclx-p3';
			} else if (meaning.kind === 'srgb') {
				colour = 'nclx-srgb';
			} else {
				colour = 'unknown';
				warnings.push('colour-unknown');
			}
		}
	}
	const bitDepth = heif.bitDepth ?? 8;
	if (bitDepth > 8) warnings.push('bit-depth-reduced');
	return {
		...base(format),
		width: heif.width,
		height: heif.height,
		bitDepth,
		orientation: orientationFromHeif(heif.rotation, heif.mirror),
		exif: heif.exif,
		icc,
		colour,
		xmp: heif.xmp,
		warnings,
	};
}

// --- Writing -----------------------------------------------------------------

export interface WriteOptions {
	format: OutputFormat;
	/** The `Software` value (§2.6: APP_NAME). */
	software: string;
	/** Opt-in: strip GPS from EXIF and XMP (§2.6). */
	removeLocation: boolean;
	/** The orientation of the pixels being saved: the source's, or 1 if the decoder already turned them upright. */
	orientation: Orientation;
	/** Size of the pixels being saved. */
	width: number;
	height: number;
}

const XMP_ORIENTATION_ATTRIBUTE = /(\btiff:Orientation\s*=\s*["'])\d(["'])/g;
const XMP_ORIENTATION_ELEMENT = /(<tiff:Orientation>)\s*\d\s*(<\/tiff:Orientation>)/g;

/** Keep an XMP copy of the orientation in step with EXIF, so no reader rotates twice. */
function setXmpOrientation(xmp: Bytes, orientation: Orientation): Bytes {
	const text = latin1String(xmp);
	const next = text
		.replace(XMP_ORIENTATION_ATTRIBUTE, `$1${orientation}$2`)
		.replace(XMP_ORIENTATION_ELEMENT, `$1${orientation}$2`);
	return next === text ? xmp : latin1(next);
}

/**
 * Put the source's metadata into freshly encoded pixels: EXIF with Software
 * set (and GPS removed on request), XMP, the ICC profile byte for byte, and
 * whatever else the output container can hold.
 */
export async function writePhotoMetadata(
	encoded: Bytes,
	info: PhotoInfo,
	options: WriteOptions,
	zlib: Zlib,
): Promise<{ bytes: Bytes; warnings: MetadataWarning[] }> {
	const warnings: MetadataWarning[] = [];
	const { format } = options;

	// EXIF: always present on output, so every file says which software made it.
	let exif: Bytes | null;
	if (info.exif) {
		const edit: ExifEdit = {
			software: options.software,
			removeLocation: options.removeLocation,
			dimensions: { width: options.width, height: options.height },
			...(format === 'jpeg' && { maxBytes: JPEG_EXIF_MAX_BYTES }),
		};
		if ((readOrientation(info.exif) ?? 1) !== options.orientation) edit.orientation = options.orientation;
		const edited = editExif(info.exif, edit);
		exif = edited.exif;
		warnings.push(...edited.warnings);
	} else {
		exif = createExif({
			software: options.software,
			...(options.orientation !== 1 && { orientation: options.orientation }),
		});
	}

	let xmp = info.xmp;
	if (xmp && options.removeLocation) xmp = stripXmpLocation(xmp);
	if (xmp && options.orientation !== info.orientation) xmp = setXmpOrientation(xmp, options.orientation);

	switch (format) {
		case 'jpeg': {
			if (xmp && xmp.byteLength > JPEG_XMP_MAX_BYTES) {
				xmp = null;
				warnings.push('xmp-too-large');
			}
			const same = info.jpeg;
			let xmpExtended = same?.xmpExtended ?? [];
			if (options.removeLocation && xmpExtended.some(xmpHasLocation)) {
				xmpExtended = [];
				warnings.push('xmp-extended-dropped');
			}
			return {
				bytes: writeJpegMetadata(encoded, {
					jfif: same?.jfif ?? null,
					exif,
					xmp,
					xmpExtended: xmp ? xmpExtended : [],
					icc: info.icc,
					photoshop: same?.photoshop ?? [],
					comments: same?.comments ?? [],
				}),
				warnings,
			};
		}
		case 'png': {
			let iccp = info.png?.iccp ?? null;
			if (!iccp && info.icc) {
				iccp = { name: iccDescription(info.icc) ?? 'ICC profile', compressed: await zlib.deflate(info.icc) };
			}
			if (info.jpeg?.photoshop.length) warnings.push('iptc-not-carried');
			return {
				bytes: writePngMetadata(encoded, { exif, iccp, xmp, chunks: info.png?.chunks ?? [] }),
				warnings,
			};
		}
		case 'webp':
			if (info.jpeg?.photoshop.length) warnings.push('iptc-not-carried');
			return { bytes: writeWebpMetadata(encoded, { exif, icc: info.icc, xmp }), warnings };
	}
}
