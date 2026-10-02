// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { cleanSuffix, defaultOutputFormat, outputName, sniffFormat } from '../src/index.ts';
import { heifFile, jpegFile, pngFile, vp8, webpChunk, webpFile } from './helpers/containers.ts';

describe('sniffFormat: by content, never by name', () => {
	it('recognises every input format', () => {
		expect(sniffFormat(jpegFile({ width: 2, height: 2 }))).toBe('jpeg');
		expect(sniffFormat(pngFile({ width: 2, height: 2 }))).toBe('png');
		expect(sniffFormat(webpFile([webpChunk('VP8 ', vp8(2, 2))]))).toBe('webp');
		expect(sniffFormat(heifFile({ width: 2, height: 2 }))).toBe('heic');
		expect(sniffFormat(heifFile({ width: 2, height: 2, brand: 'avif' }))).toBe('avif');
	});

	it('tells AVIF from HEIC by brand, whatever the major brand says', () => {
		const ftyp = (major: string, ...compatible: string[]) =>
			Uint8Array.from(
				`\0\0\0${String.fromCharCode(16 + compatible.length * 4)}ftyp${major}\0\0\0\0${compatible.join('')}`,
				(c) => c.charCodeAt(0),
			);
		expect(sniffFormat(ftyp('mif1', 'mif1', 'avif'))).toBe('avif');
		expect(sniffFormat(ftyp('mif1', 'mif1', 'heic'))).toBe('heic');
		expect(sniffFormat(ftyp('heix', 'mif1'))).toBe('heic');
		expect(sniffFormat(ftyp('isom', 'mp41'))).toBeNull(); // an MP4 video
	});

	it('rejects anything else, and short files', () => {
		const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
		expect(sniffFormat(ascii('This is text'))).toBeNull();
		expect(sniffFormat(ascii('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
		expect(sniffFormat(Uint8Array.of(0xff))).toBeNull();
	});
});

describe('output naming (§2.6)', () => {
	it('keeps the format, except HEIC and AVIF, which become JPEG', () => {
		expect(defaultOutputFormat('jpeg')).toBe('jpeg');
		expect(defaultOutputFormat('png')).toBe('png');
		expect(defaultOutputFormat('webp')).toBe('webp');
		expect(defaultOutputFormat('heic')).toBe('jpeg');
		expect(defaultOutputFormat('avif')).toBe('jpeg');
	});

	it('adds the suffix and keeps the original spelling of the extension', () => {
		expect(outputName('IMG_2041.JPG', 'jpeg')).toBe('IMG_2041-denoised.JPG');
		expect(outputName('DSC_0001.jpeg', 'jpeg')).toBe('DSC_0001-denoised.jpeg');
		expect(outputName('scan.png', 'png', '_clean')).toBe('scan_clean.png');
		expect(outputName('IMG_5501.HEIC', 'jpeg')).toBe('IMG_5501-denoised.jpg');
		expect(outputName('photo.webp', 'jpeg')).toBe('photo-denoised.jpg');
		expect(outputName('no-extension', 'png')).toBe('no-extension-denoised.png');
		expect(outputName('.hidden', 'jpeg')).toBe('.hidden-denoised.jpg');
		expect(outputName('Wedding/IMG_1.jpg', 'jpeg')).toBe('IMG_1-denoised.jpg');
	});

	it('never lets a suffix become a path or an invalid name', () => {
		expect(cleanSuffix('/../x')).toBe('..x');
		expect(cleanSuffix(' -clean: v2? ')).toBe('-clean v2');
		expect(cleanSuffix('\u0007tab\u0000')).toBe('tab');
		expect(outputName('a.jpg', 'jpeg', '\\evil/')).toBe('aevil.jpg');
	});
});
