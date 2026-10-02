// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, fixture, test } from './fixtures';
import { extract, inverted, makerNote, psnr, readExif } from './metadata';

/**
 * Phase 1: the pipeline, headless. Real photos written by independent
 * encoders (tools/fixtures) go through the real codecs, ONNX Runtime in a
 * worker and the metadata writer; the files that come out are read back by
 * exifr and by readers that share no code with Hush.
 *
 * CI runs the test model, which inverts colours exactly, so pixels can be
 * checked too: 255 − input, exactly for lossless formats, closely for lossy.
 */

declare global {
	interface Window {
		/** The bench page's headless pipeline (src/bench/BenchApp.tsx). */
		__hushPipeline?: {
			process(
				name: string,
				base64: string,
				settings?: Record<string, unknown>,
				params?: Record<string, number>,
			): Promise<unknown>;
			processSynthetic(width: number, height: number): Promise<unknown>;
			decode(base64: string): Promise<{ width: number; height: number; data: string }>;
			injectFaults(plan: { outOfMemoryAbove?: number; loseDeviceOnRun?: number }): Promise<void>;
			sessionState(): Promise<{ tileSize: number | null; recoveries: number }>;
		};
	}
}

interface Processed {
	bytes: string;
	name: string;
	mimeType: string;
	warnings: string[];
	width: number;
	height: number;
	backend: string;
	source: { format: string; width: number; height: number; bitDepth: number; colour: string; hadLocation: boolean };
	stats: { peakFloatBytes: number; tiled: { backoffs: number; recoveries: number; tileWidth: number } | null };
}

const base64Of = (name: string) => readFileSync(fixture(name)).toString('base64');
const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

async function open(page: Page) {
	await page.goto('/bench/?backend=wasm');
	await page.waitForFunction(() => window.__hushPipeline !== undefined);
}

function processFile(
	page: Page,
	name: string,
	settings: Record<string, unknown> = {},
	params?: Record<string, number>,
) {
	return page.evaluate(
		([fileName, data, options, recipe]) =>
			window.__hushPipeline!.process(fileName, data, options, recipe) as unknown as Promise<Processed>,
		[name, base64Of(name), settings, params] as const,
	);
}

async function decode(page: Page, base64: string) {
	const image = await page.evaluate((data) => window.__hushPipeline!.decode(data), base64);
	return { width: image.width, height: image.height, data: bytesOf(image.data) };
}

/** What every export must say about who made it, and keep from the camera. */
async function expectCameraExif(exif: Uint8Array | null, orientation: number, location: boolean) {
	expect(exif, 'EXIF present').not.toBeNull();
	const parsed = await readExif(exif!);
	expect(parsed.ifd0).toMatchObject({
		Make: 'Canon',
		Model: 'Canon EOS R5',
		Software: 'Hush',
		Artist: 'Test Studio',
		ModifyDate: '2026:09:12 21:14:03',
	});
	expect(parsed.ifd0['Orientation'] ?? 1).toBe(orientation);
	expect(parsed.exif).toMatchObject({
		ISO: 6400,
		LensModel: 'RF24-70mm F2.8 L IS USM',
		DateTimeOriginal: '2026:09:12 21:14:03',
	});
	if (location) {
		expect(parsed.gps).toMatchObject({ GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' });
	} else {
		expect(parsed.gps).toBeUndefined();
	}
}

test.describe('the pipeline, headless', () => {
	test.beforeEach(async ({ page }) => open(page));

	test('JPEG → JPEG: EXIF, profile, XMP, IPTC, comment and density survive; pixels are never rotated', async ({
		page,
	}) => {
		const result = await processFile(page, 'meta-camera.jpg');
		expect(result).toMatchObject({
			name: 'meta-camera-denoised.jpg',
			mimeType: 'image/jpeg',
			width: 260,
			height: 180,
			warnings: [],
		});
		const output = bytesOf(result.bytes);
		const before = extract(readFileSync(fixture('meta-camera.jpg')));
		const after = extract(output);

		await expectCameraExif(after.exif, 6, true);
		expect(Buffer.compare(after.icc!, before.icc!), 'ICC profile byte for byte').toBe(0);
		expect(after.xmp).toBe(before.xmp);
		expect(after.xmp).toContain('婚禮 · 台北');
		expect(after.iptc).toBe(true);
		expect(after.comments).toEqual(['Shot on the night']);
		expect(after.jfifDpi).toBe(300);
		// Baseline, and no chroma subsampling at quality 95: colour-noise removal isn't blurred away.
		expect(after.progressive).toBe(false);
		expect(after.sampling).toEqual(['1x1', '1x1', '1x1']);
		// The maker note travels byte for byte (offsets inside it stay valid).
		expect(makerNote(after.exif!)).not.toBeNull();
		expect(Buffer.compare(makerNote(after.exif!)!, makerNote(before.exif!)!)).toBe(0);

		// Same stored pixels, inverted by the test model; JPEG's own loss only. The fixture is
		// deliberately very noisy (σ ≈ 15 levels), the hardest case for quality 95: about 37.5 dB.
		// The lossless PNG and WebP tests show the pipeline itself is exact.
		const input = await decode(page, base64Of('meta-camera.jpg'));
		const out = await decode(page, result.bytes);
		expect([out.width, out.height]).toEqual([260, 180]);
		expect(psnr(out.data, inverted(input.data))).toBeGreaterThan(36);
	});

	test('removing location strips GPS from EXIF and XMP, and nothing else', async ({ page }) => {
		const result = await processFile(page, 'meta-camera.jpg', { removeLocation: true });
		const after = extract(bytesOf(result.bytes));
		await expectCameraExif(after.exif, 6, false);
		expect(after.xmp).not.toContain('GPS');
		expect(after.xmp).toContain('xmp:Rating="4"');
		expect(result.source.hadLocation).toBe(true);
	});

	test('PNG → PNG is lossless: exactly the model’s output, with EXIF, profile, XMP and density', async ({ page }) => {
		const result = await processFile(page, 'meta-camera.png');
		expect(result).toMatchObject({ name: 'meta-camera-denoised.png', mimeType: 'image/png' });
		const before = extract(readFileSync(fixture('meta-camera.png')));
		const after = extract(bytesOf(result.bytes));
		await expectCameraExif(after.exif, 6, true);
		expect(Buffer.compare(after.icc!, before.icc!)).toBe(0);
		expect(after.xmp).toBe(before.xmp);
		const input = await decode(page, base64Of('meta-camera.png'));
		const out = await decode(page, result.bytes);
		expect(psnr(out.data, inverted(input.data))).toBe(Infinity);
	});

	test('WebP keeps its kind: lossy stays lossy, lossless stays lossless and exact', async ({ page }) => {
		const lossy = await processFile(page, 'meta-camera.webp');
		const lossyOut = extract(bytesOf(lossy.bytes));
		expect(lossyOut.webpLossless).toBe(false);
		await expectCameraExif(lossyOut.exif, 6, true);
		expect(Buffer.compare(lossyOut.icc!, extract(readFileSync(fixture('meta-camera.webp'))).icc!)).toBe(0);
		expect(lossyOut.xmp).toContain('婚禮');
		const lossyInput = await decode(page, base64Of('meta-camera.webp'));
		expect(psnr((await decode(page, lossy.bytes)).data, inverted(lossyInput.data))).toBeGreaterThan(32);

		const lossless = await processFile(page, 'meta-lossless.webp');
		const losslessOut = extract(bytesOf(lossless.bytes));
		expect(losslessOut.webpLossless).toBe(true);
		const input = await decode(page, base64Of('meta-lossless.webp'));
		expect(psnr((await decode(page, lossless.bytes)).data, inverted(input.data))).toBe(Infinity);
	});

	test('HEIC → JPEG: libheif turns it upright, so the saved orientation is 1, never rotated twice', async ({
		page,
	}) => {
		const result = await processFile(page, 'meta-phone.heic');
		expect(result).toMatchObject({ name: 'meta-phone-denoised.jpg', mimeType: 'image/jpeg', width: 180, height: 260 });
		expect(result.source).toMatchObject({ format: 'heic', width: 260, height: 180, colour: 'icc', hadLocation: true });
		const after = extract(bytesOf(result.bytes));
		await expectCameraExif(after.exif, 1, true);
		expect(after.xmp).toContain('tiff:Orientation="1"');
		expect(Buffer.compare(after.icc!, extract(readFileSync(fixture('meta-camera.jpg'))).icc!), 'the same profile').toBe(
			0,
		);

		// The red square sits top-left of the upright photo.
		const out = await decode(page, result.bytes);
		const pixel = (x: number, y: number) => [
			...out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 3),
		];
		const [r, g, b] = pixel(20, 20); // inverted red: dark red, bright green and blue
		expect(r).toBeLessThan(90);
		expect(g).toBeGreaterThan(160);
		expect(b).toBeGreaterThan(160);
	});

	test('AVIF → JPEG: pixels as stored, with the container’s rotation as EXIF orientation', async ({ page }) => {
		const result = await processFile(page, 'meta-camera.avif');
		expect(result).toMatchObject({ name: 'meta-camera-denoised.jpg', width: 260, height: 180 });
		const after = extract(bytesOf(result.bytes));
		await expectCameraExif(after.exif, 6, true);
		const input = await decode(page, base64Of('meta-camera.avif'));
		const out = await decode(page, result.bytes);
		expect(psnr(out.data, inverted(input.data))).toBeGreaterThan(36);
	});

	test('the recipe’s sliders apply: strength 0 gives the original back, exactly', async ({ page }) => {
		const result = await processFile(page, 'meta-camera.png', {}, { strength: 0, luma: 1, colour: 1, detail: 0 });
		const input = await decode(page, base64Of('meta-camera.png'));
		expect(psnr((await decode(page, result.bytes)).data, input.data)).toBe(Infinity);
		const half = await processFile(page, 'meta-camera.png', {}, { strength: 0.5, luma: 1, colour: 1, detail: 0 });
		const mid = (await decode(page, half.bytes)).data;
		for (let i = 0; i < 4000; i += 4) expect(Math.abs(mid[i]! - 127.5)).toBeLessThanOrEqual(1);
	});

	test('export settings: another format, a suffix', async ({ page }) => {
		const result = await processFile(page, 'meta-camera.png', { format: 'webp', quality: 90, suffix: '_clean' });
		expect(result).toMatchObject({ name: 'meta-camera_clean.webp', mimeType: 'image/webp' });
		await expectCameraExif(extract(bytesOf(result.bytes)).exif, 6, true);
	});

	test('16-bit photos are processed in 8 bits, and the export says so', async ({ page }) => {
		const result = await processFile(page, 'deep-16bit.png');
		expect(result.warnings).toContain('bit-depth-reduced');
		expect(result.source.bitDepth).toBe(16);
	});

	test('what Hush can’t process is refused before decoding, by reason', async ({ page }) => {
		const refused = (name: string) =>
			processFile(page, name).then(
				() => null,
				(error: Error) => error.message,
			);
		expect(await refused('refuse-cmyk.jpg')).toMatch(/UnsupportedPhotoError|cmyk/);
		expect(await refused('refuse-animated.webp')).toMatch(/animated/);
		expect(await refused('not-a-photo.txt')).toMatch(/unknown-format/);
		expect(await refused('corrupt.jpg')).toMatch(/DecodeError|decode|Corrupt|overruns|marker/i);
	});
});

test.describe('when the GPU fails (§2.3)', () => {
	test.beforeEach(async ({ page }) => open(page));

	test('out of memory: tiles halve, the photo finishes exactly, and the session remembers', async ({ page }) => {
		await page.evaluate(() => window.__hushPipeline!.injectFaults({ outOfMemoryAbove: 150 * 150 }));
		const result = await processFile(page, 'meta-camera.png');
		expect(result.stats.tiled?.backoffs).toBeGreaterThanOrEqual(1);
		const input = await decode(page, base64Of('meta-camera.png'));
		expect(psnr((await decode(page, result.bytes)).data, inverted(input.data))).toBe(Infinity);
		const state = await page.evaluate(() => window.__hushPipeline!.sessionState());
		expect(state.tileSize).toBeLessThanOrEqual(150);
	});

	test('device lost: the session is rebuilt and the tile retried, without restarting the photo', async ({ page }) => {
		await page.evaluate(() => window.__hushPipeline!.injectFaults({ loseDeviceOnRun: 1 }));
		const result = await processFile(page, 'meta-camera.png');
		expect(result.stats.tiled?.recoveries).toBe(1);
		const input = await decode(page, base64Of('meta-camera.png'));
		expect(psnr((await decode(page, result.bytes)).data, inverted(input.data))).toBe(Infinity);
		expect((await page.evaluate(() => window.__hushPipeline!.sessionState())).recoveries).toBe(1);
	});
});

test.describe('a 102 MP photo (Phase 1 acceptance)', () => {
	test('completes in the browser, with float memory bounded by one band', async ({ page }) => {
		test.slow();
		test.setTimeout(600_000);
		await open(page);
		// Fujifilm GFX100: 11648 × 8736.
		const result = (await page.evaluate(() => window.__hushPipeline!.processSynthetic(11648, 8736))) as {
			width: number;
			height: number;
			byteLength: number;
			decoded: { width: number; height: number };
			stats: { peakFloatBytes: number; tiled: { tileHeight: number; tileWidth: number; bandFloatBytes: number } };
		};
		expect([result.width, result.height]).toEqual([11648, 8736]);
		expect(result.byteLength).toBeGreaterThan(1_000_000);
		// The saved JPEG decodes again, full size.
		expect(result.decoded).toEqual({ width: 11648, height: 8736 });
		const { tiled } = result.stats;
		expect(tiled.bandFloatBytes).toBe(3 * tiled.tileHeight * 11648 * 4);
		// Band + three tiles + the adjust stage's rows: about a tenth of a whole-image float buffer.
		expect(result.stats.peakFloatBytes).toBeLessThan(0.11 * 3 * 11648 * 8736 * 4);
	});
});
