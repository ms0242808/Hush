// SPDX-License-Identifier: Apache-2.0
import exifr from 'exifr';
import { describe, expect, it } from 'vitest';
import { createExif, editExif, hasGps, JPEG_EXIF_MAX_BYTES, readAscii, readOrientation } from '../src/index.ts';
import { ASCII, buildTiff, cameraExif, SHORT } from './helpers/tiff.ts';

/** Parse with exifr, an independent reader, as every tag group. */
const parse = (tiff: Uint8Array) =>
	exifr.parse(tiff, {
		translateValues: false,
		reviveValues: false,
		mergeOutput: false,
		tiff: true,
		ifd1: true,
		gps: true,
		makerNote: false,
	});

const MAKER_NOTE_TAG = 0x927c;

/** The maker note's bytes, found by tag in the EXIF directory, wherever it lives. */
function makerNote(tiff: Uint8Array): Uint8Array {
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
	const little = tiff[0] === 0x49;
	const ifd0 = view.getUint32(4, little);
	const findEntry = (at: number, tag: number) => {
		const count = view.getUint16(at, little);
		for (let i = 0; i < count; i++) if (view.getUint16(at + 2 + i * 12, little) === tag) return at + 2 + i * 12;
		return -1;
	};
	const exifEntry = findEntry(ifd0, 0x8769);
	const exifAt = view.getUint32(exifEntry + 8, little);
	const entry = findEntry(exifAt, MAKER_NOTE_TAG);
	return tiff.subarray(
		view.getUint32(entry + 8, little),
		view.getUint32(entry + 8, little) + view.getUint32(entry + 4, little),
	);
}

describe('readOrientation', () => {
	it('reads the tag in both byte orders', () => {
		expect(readOrientation(cameraExif({ orientation: 6 }))).toBe(6);
		expect(readOrientation(cameraExif({ orientation: 8, little: false }))).toBe(8);
	});

	it('is null when absent or out of range, and never throws on garbage', () => {
		expect(readOrientation(buildTiff({ ifd0: [{ tag: 0x010f, type: ASCII, values: 'X' }] }))).toBeNull();
		expect(readOrientation(buildTiff({ ifd0: [{ tag: 0x0112, type: SHORT, values: [9] }] }))).toBeNull();
		expect(readOrientation(Uint8Array.of(1, 2, 3))).toBeNull();
	});
});

describe('editExif', () => {
	for (const little of [true, false]) {
		const order = little ? 'little-endian' : 'big-endian';

		it(`sets Software and keeps every other tag (${order})`, async () => {
			const source = cameraExif({ little, orientation: 6 });
			const before = await parse(source);
			const { exif, warnings } = editExif(source, { software: 'Hush' });
			expect(warnings).toEqual([]);
			const after = await parse(exif!);
			expect(after.ifd0.Software).toBe('Hush');
			expect({ ...after.ifd0, Software: undefined }).toEqual({ ...before.ifd0, Software: undefined });
			expect(after.exif).toEqual(before.exif);
			expect(after.gps).toEqual(before.gps);
		});

		it(`never moves the maker note (${order})`, () => {
			const source = cameraExif({ little });
			const note = makerNote(source).slice();
			const noteAt = makerNote(source).byteOffset - source.byteOffset;
			const { exif } = editExif(source, { software: 'Hush', removeLocation: true, orientation: 3 });
			// Same bytes at the same offset: offsets inside it stay valid.
			expect(exif!.subarray(noteAt, noteAt + note.length)).toEqual(note);
			expect(makerNote(exif!)).toEqual(note);
		});
	}

	it('adds Software when the camera wrote none, moving only IFD0', async () => {
		const source = buildTiff({
			ifd0: [
				{ tag: 0x010f, type: ASCII, values: 'FUJIFILM' },
				{ tag: 0x0112, type: SHORT, values: [1] },
			],
			exif: [{ tag: 0x8827, type: SHORT, values: [3200] }],
		});
		const { exif } = editExif(source, { software: 'Hush' });
		const parsed = await parse(exif!);
		expect(parsed.ifd0.Software).toBe('Hush');
		expect(parsed.ifd0.Make).toBe('FUJIFILM');
		expect(parsed.exif.ISO).toBe(3200);
		// The original bytes after the header are untouched apart from the old IFD0, which is cleared.
		const ifd0Size = 2 + 3 * 12 + 4; // 2 entries + the EXIF pointer
		expect(exif!.subarray(8 + ifd0Size, source.length)).toEqual(source.subarray(8 + ifd0Size));
	});

	it('removes location: the GPS directory is unlinked and its bytes wiped', async () => {
		const source = cameraExif();
		expect(hasGps(source)).toBe(true);
		const { exif } = editExif(source, { software: 'Hush', removeLocation: true });
		expect(hasGps(exif!)).toBe(false);
		const parsed = await parse(exif!);
		expect(parsed.gps).toBeUndefined();
		expect(parsed.exif.ISO).toBe(6400);
		// No trace of the coordinates anywhere in the block: 121° 33′ 45.67″ was stored as rationals.
		const view = new DataView(exif!.buffer, exif!.byteOffset, exif!.byteLength);
		for (let i = 0; i + 4 <= exif!.length; i += 2) expect(view.getUint32(i, true)).not.toBe(4567);
	});

	it('sets or adds Orientation, and corrects pixel dimensions in place', async () => {
		const withTag = editExif(cameraExif({ orientation: 6 }), {
			orientation: 1,
			dimensions: { width: 5464, height: 8192 },
		});
		const parsed = await parse(withTag.exif!);
		expect(parsed.ifd0.Orientation).toBe(1);
		expect(parsed.exif.ExifImageWidth).toBe(5464);
		expect(parsed.exif.ExifImageHeight).toBe(8192);

		const without = buildTiff({ ifd0: [{ tag: 0x010f, type: ASCII, values: 'Apple' }] });
		expect(readOrientation(editExif(without, { orientation: 8 }).exif!)).toBe(8);
	});

	it('drops the thumbnail when a JPEG segment would overflow, keeping the rest', async () => {
		const thumbnail = new Uint8Array(JPEG_EXIF_MAX_BYTES - 980).fill(0x55);
		thumbnail.set([0xff, 0xd8], 0);
		const source = cameraExif({ thumbnail });
		expect(source.length).toBeLessThan(JPEG_EXIF_MAX_BYTES);
		expect(source.length + 400).toBeGreaterThan(JPEG_EXIF_MAX_BYTES);

		// Software alone fits in place (the tag exists), so the thumbnail stays.
		const fits = editExif(source, { software: 'Hush', maxBytes: JPEG_EXIF_MAX_BYTES });
		expect(fits.warnings).toEqual([]);

		// Adding enough to overflow forces the thumbnail out, and the result fits.
		const long = editExif(source, { software: 'H'.repeat(1500), maxBytes: JPEG_EXIF_MAX_BYTES });
		expect(long.warnings).toContain('exif-thumbnail-dropped');
		expect(long.exif!.length).toBeLessThanOrEqual(JPEG_EXIF_MAX_BYTES);
		const parsed = await parse(long.exif!);
		expect(parsed.ifd1).toBeUndefined();
		expect(parsed.exif.LensModel).toBe('RF24-70mm F2.8 L IS USM');
	});

	it('gives up cleanly when even without the thumbnail it cannot fit', () => {
		const result = editExif(cameraExif(), { software: 'x'.repeat(70_000), maxBytes: JPEG_EXIF_MAX_BYTES });
		expect(result.exif).toBeNull();
		expect(result.warnings).toContain('exif-too-large');
	});

	it('carries unreadable EXIF untouched, but drops it when location must go', () => {
		const garbage = Uint8Array.from({ length: 40 }, (_, i) => i);
		expect(editExif(garbage, { software: 'Hush' })).toEqual({ exif: garbage, warnings: ['exif-unreadable'] });
		expect(editExif(garbage, { software: 'Hush', removeLocation: true })).toEqual({
			exif: null,
			warnings: ['exif-unreadable'],
		});
	});

	it('never modifies its input', () => {
		const source = cameraExif();
		const copy = source.slice();
		editExif(source, { software: 'Hush', removeLocation: true, orientation: 5 });
		expect(source).toEqual(copy);
	});
});

describe('createExif', () => {
	it('builds a minimal block any reader understands', async () => {
		const exif = createExif({ orientation: 6, software: 'Hush' });
		const parsed = await parse(exif);
		expect(parsed.ifd0.Orientation).toBe(6);
		expect(parsed.ifd0.Software).toBe('Hush');
		expect(readAscii(exif, 0x0131)).toBe('Hush');
	});
});
