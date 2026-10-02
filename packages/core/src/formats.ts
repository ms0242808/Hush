// SPDX-License-Identifier: Apache-2.0
import { hasPrefix, latin1String, u32be } from './bytes.ts';
import type { Bytes, Format } from './types.ts';

/** Formats Hush writes. HEIC and AVIF are read, then saved as JPEG (§2.6). */
export type OutputFormat = 'jpeg' | 'png' | 'webp';

export const FORMATS: readonly Format[] = ['jpeg', 'png', 'webp', 'heic', 'avif'];

export const MIME_TYPES: Record<Format, string> = {
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	heic: 'image/heic',
	avif: 'image/avif',
};

/** Canonical extension, and the spellings a file of that format may already have. */
const EXTENSIONS: Record<OutputFormat, { canonical: string; aliases: readonly string[] }> = {
	jpeg: { canonical: 'jpg', aliases: ['jpg', 'jpeg', 'jpe', 'jfif'] },
	png: { canonical: 'png', aliases: ['png'] },
	webp: { canonical: 'webp', aliases: ['webp'] },
};

/** How many leading bytes `sniffFormat` needs to see. */
export const SNIFF_BYTES = 64;

const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2']);

/**
 * Identify a photo by its first bytes, never by its name or MIME type: files
 * get renamed, and browsers report an empty type for HEIC on most systems.
 */
export function sniffFormat(head: Bytes): Format | null {
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
	if (hasPrefix(head, '\x89PNG\r\n\x1a\n')) return 'png';
	if (hasPrefix(head, 'RIFF') && hasPrefix(head, 'WEBP', 8)) return 'webp';
	if (hasPrefix(head, 'ftyp', 4)) {
		const boxSize = u32be(head, 0);
		const end = Math.min(head.byteLength, boxSize >= 16 ? boxSize : 16);
		const brands = [latin1String(head, 8, 12)];
		for (let o = 16; o + 4 <= end; o += 4) brands.push(latin1String(head, o, o + 4));
		if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
		if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
	}
	return null;
}

/** HEIC and AVIF photos are delivered as JPEG; everything else keeps its format (§2.6). */
export function defaultOutputFormat(input: Format): OutputFormat {
	return input === 'heic' || input === 'avif' ? 'jpeg' : input;
}

/** Characters that can't appear in a file name on Windows, macOS or Linux (control characters too). */
const UNSAFE_NAME_CHARACTERS = '\\/:*?"<>|';

/** A suffix stripped of anything that would turn it into a path or an invalid file name. */
export function cleanSuffix(suffix: string): string {
	let clean = '';
	for (const character of suffix) {
		if (character.charCodeAt(0) >= 0x20 && !UNSAFE_NAME_CHARACTERS.includes(character)) clean += character;
	}
	return clean.trim();
}

/**
 * `IMG_2041.JPG` → `IMG_2041-denoised.JPG`. The original spelling of the
 * extension is kept when the format doesn't change, so a folder of camera
 * files stays consistent; a new format gets its canonical lowercase extension.
 */
export function outputName(input: string, format: OutputFormat, suffix = '-denoised'): string {
	const base = input.split(/[\\/]/).pop() || 'photo';
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const extension = dot > 0 ? base.slice(dot + 1) : '';
	const { canonical, aliases } = EXTENSIONS[format];
	const keep = aliases.includes(extension.toLowerCase());
	return `${stem}${cleanSuffix(suffix)}.${keep ? extension : canonical}`;
}

export function outputMimeType(format: OutputFormat): string {
	return MIME_TYPES[format];
}
