// SPDX-License-Identifier: Apache-2.0
import { be32, concatBytes, crc32, hasPrefix, latin1, latin1String, u32be } from '../bytes.ts';
import type { Bytes } from '../types.ts';

/** PNG is a signature and a list of chunks: length, type, data, CRC. */

export interface PngChunk {
	type: string;
	data: Bytes;
}

export interface PngHeader {
	width: number;
	height: number;
	bitDepth: number;
	colourType: number;
}

export class PngFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PngFormatError';
	}
}

const SIGNATURE = latin1('\x89PNG\r\n\x1a\n');

export function parsePng(bytes: Bytes): { header: PngHeader; chunks: PngChunk[] } {
	if (!hasPrefix(bytes, SIGNATURE)) throw new PngFormatError('Missing PNG signature');
	const chunks: PngChunk[] = [];
	let at = 8;
	while (at + 12 <= bytes.byteLength) {
		const length = u32be(bytes, at);
		const type = latin1String(bytes, at + 4, at + 8);
		if (at + 12 + length > bytes.byteLength) throw new PngFormatError(`Chunk ${type} overruns the file`);
		chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
		at += 12 + length;
		if (type === 'IEND') break;
	}
	const ihdr = chunks[0];
	if (ihdr?.type !== 'IHDR' || ihdr.data.byteLength < 13) throw new PngFormatError('Missing IHDR');
	return {
		header: {
			width: u32be(ihdr.data, 0),
			height: u32be(ihdr.data, 4),
			bitDepth: ihdr.data[8]!,
			colourType: ihdr.data[9]!,
		},
		chunks,
	};
}

export function pngChunk(type: string, data: Bytes): Bytes {
	const typeBytes = latin1(type);
	return concatBytes([be32(data.byteLength), typeBytes, data, be32(crc32(typeBytes, data))]);
}

/** Chunks that describe colour or density, or carry text: copied PNG → PNG (§2.6, "keep everything else"). */
export const PNG_CARRIED_CHUNKS = new Set(['cICP', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'tEXt', 'zTXt', 'iTXt']);

/** Chunks that must come before the image data (and PLTE). */
const BEFORE_IDAT = new Set(['cICP', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'eXIf', 'pHYs']);

const XMP_KEYWORD = 'XML:com.adobe.xmp';

export interface PngText {
	/** iTXt: keyword, then the compressed flag, method, language and translated keyword. */
	keyword: string;
	compressed: boolean;
	text: Bytes;
}

export function parseItxt(data: Bytes): PngText | null {
	const keywordEnd = data.indexOf(0);
	if (keywordEnd < 1 || keywordEnd + 3 > data.byteLength) return null;
	const compressed = data[keywordEnd + 1] === 1;
	const languageEnd = data.indexOf(0, keywordEnd + 3);
	if (languageEnd < 0) return null;
	const translatedEnd = data.indexOf(0, languageEnd + 1);
	if (translatedEnd < 0) return null;
	return { keyword: latin1String(data, 0, keywordEnd), compressed, text: data.subarray(translatedEnd + 1) };
}

export function isXmpChunk(chunk: PngChunk): boolean {
	return chunk.type === 'iTXt' && hasPrefix(chunk.data, `${XMP_KEYWORD}\0`);
}

/** An uncompressed iTXt chunk holding the XMP packet. */
export function xmpChunk(xmp: Bytes): Bytes {
	return pngChunk('iTXt', concatBytes([latin1(`${XMP_KEYWORD}\0\0\0\0\0`), xmp]));
}

export interface PngIcc {
	name: string;
	/** zlib-compressed profile, exactly as stored. */
	compressed: Bytes;
}

export function parseIccp(data: Bytes): PngIcc | null {
	const nameEnd = data.indexOf(0);
	if (nameEnd < 1 || nameEnd > 79 || data[nameEnd + 1] !== 0) return null;
	return { name: latin1String(data, 0, nameEnd), compressed: data.subarray(nameEnd + 2) };
}

export function iccpChunk(name: string, compressed: Bytes): Bytes {
	const safe = name.replace(/[^\x20-\x7e]/g, '').slice(0, 79) || 'ICC profile';
	return pngChunk('iCCP', concatBytes([latin1(`${safe}\0\0`), compressed]));
}

export interface PngOutputMetadata {
	exif?: Bytes | null;
	/** iCCP: either the source's chunk data reused as is, or a freshly compressed profile. */
	iccp?: PngIcc | null;
	xmp?: Bytes | null;
	/** Further chunks (PNG_CARRIED_CHUNKS) copied from a PNG source. */
	chunks?: PngChunk[];
}

/**
 * The encoder's PNG with metadata chunks after IHDR. Colour and density
 * chunks precede the image data, as the format requires. The encoder's own
 * copies of chunks Hush writes are dropped, so nothing appears twice.
 */
export function writePngMetadata(encoded: Bytes, metadata: PngOutputMetadata): Bytes {
	const { chunks } = parsePng(encoded);
	const carried = metadata.chunks ?? [];
	const written = new Set(carried.map((c) => c.type));
	if (metadata.iccp) written.add('iCCP');
	if (metadata.exif) written.add('eXIf');
	// iCCP and sRGB must not both appear; an embedded profile wins.
	const extra = carried.filter((c) => !(metadata.iccp && c.type === 'sRGB'));

	const head: Bytes[] = [];
	const tail: Bytes[] = [];
	for (const chunk of extra) (BEFORE_IDAT.has(chunk.type) ? head : tail).push(pngChunk(chunk.type, chunk.data));
	const parts: Bytes[] = [SIGNATURE, pngChunk('IHDR', chunks[0]!.data)];
	if (metadata.iccp) parts.push(iccpChunk(metadata.iccp.name, metadata.iccp.compressed));
	parts.push(...head);
	if (metadata.exif) parts.push(pngChunk('eXIf', metadata.exif));
	if (metadata.xmp) parts.push(xmpChunk(metadata.xmp));
	parts.push(...tail);
	for (const chunk of chunks.slice(1)) {
		if (written.has(chunk.type) || isXmpChunk(chunk)) continue;
		parts.push(pngChunk(chunk.type, chunk.data));
	}
	return concatBytes(parts);
}
