// SPDX-License-Identifier: Apache-2.0
import exifr from 'exifr';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	CancelledError,
	DEFAULT_OUTPUT,
	displayP3Profile,
	hasGps,
	loadModel,
	modelPartPath,
	ModelIntegrityError,
	parseJpeg,
	PhotoTooLargeError,
	processPhoto,
	readJpegMetadata,
	readOrientation,
	SaveError,
	UnsupportedPhotoError,
	type CodecAdapter,
	type Image8,
	type ImageOperation,
	type ModelVariant,
	type PhotoProgress,
	type PipelineContext,
	type Recipe,
	type Zlib,
} from '../src/index.ts';
import {
	encodedJpeg,
	exifSegment,
	heifFile,
	iccSegments,
	jpegFile,
	pngFile,
	vp8,
	webpChunk,
	webpFile,
} from './helpers/containers.ts';
import { cameraExif } from './helpers/tiff.ts';

const zlib: Zlib = {
	inflate: (b) => Promise.resolve(new Uint8Array(inflateSync(b))),
	deflate: (b) => Promise.resolve(new Uint8Array(deflateSync(b))),
};
const recipe: Recipe = { schema: 1, ops: [{ op: 'invert', params: {} }] };

/** Codecs that hand back a known image and encode into a valid (if pixel-free) container. */
function fakeCodecs(width: number, height: number, orientation: 'as-stored' | 'applied' = 'as-stored') {
	const calls = { decode: 0, encoded: null as Image8 | null, quality: 0 };
	const codecs: CodecAdapter = {
		decode: () => {
			calls.decode++;
			const data = new Uint8Array(width * height * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 13) & 0xff));
			return Promise.resolve({
				image: { width, height, channels: 4, bitDepth: 8, colourSpace: 'srgb', data },
				orientation,
			});
		},
		encode: (image, options) => {
			calls.encoded = image;
			calls.quality = options.quality;
			if (options.format === 'jpeg') return Promise.resolve(encodedJpeg(image.width, image.height));
			if (options.format === 'png') return Promise.resolve(pngFile({ width: image.width, height: image.height }));
			return Promise.resolve(webpFile([webpChunk('VP8 ', vp8(image.width, image.height))]));
		},
	};
	return { codecs, calls };
}

/** An operation that inverts pixels in place and reports a little float memory. */
const invert: ImageOperation = {
	id: 'invert',
	controls: [],
	run: ({ input, output }) => {
		for (let i = 0; i < input.data.length; i++) if (i % 4 !== 3) output.data[i] = 255 - input.data[i]!;
		return Promise.resolve({ stats: null, floatBytes: 1024 });
	},
	dispose: () => Promise.resolve(),
};

function context(codecs: CodecAdapter, overrides: Partial<PipelineContext> = {}) {
	const saved: Array<{ name: string; bytes: Uint8Array; mime: string }> = [];
	const ctx: PipelineContext = {
		codecs,
		output: {
			save: (name, bytes, mime) => {
				saved.push({ name, bytes, mime });
				return Promise.resolve({ name, location: 'Downloads' });
			},
		},
		zlib,
		operations: { invert },
		software: 'Hush',
		...overrides,
	};
	return { ctx, saved };
}

const parseExif = (tiff: Uint8Array) =>
	exifr.parse(tiff, { translateValues: false, reviveValues: false, mergeOutput: false, tiff: true, gps: true });

describe('processPhoto: one photo, end to end (§2.1)', () => {
	const camera = () =>
		jpegFile({
			width: 6,
			height: 4,
			segments: [exifSegment(cameraExif({ orientation: 6 })), ...iccSegments(displayP3Profile())],
		});

	it('reads, decodes, runs the recipe in place, encodes, restores metadata and saves', async () => {
		const { codecs, calls } = fakeCodecs(6, 4);
		const progress: PhotoProgress[] = [];
		const { ctx, saved } = context(codecs, { onProgress: (p) => progress.push(p) });
		const result = await processPhoto({ name: 'IMG_2041.JPG', bytes: camera(), recipe, output: DEFAULT_OUTPUT }, ctx);

		expect(result).toMatchObject({
			name: 'IMG_2041-denoised.JPG',
			mimeType: 'image/jpeg',
			format: 'jpeg',
			width: 6,
			height: 4,
		});
		expect(result.saved).toEqual({ name: 'IMG_2041-denoised.JPG', location: 'Downloads' });
		expect(saved).toHaveLength(1);
		expect(saved[0]!.bytes).toBe(result.bytes);
		expect(calls.quality).toBe(95);
		// The encoder saw the inverted pixels: the recipe ran.
		expect(calls.encoded!.data[0]).toBe(255 - 0);
		expect(calls.encoded!.data[3]).toBe(255);

		const meta = readJpegMetadata(parseJpeg(result.bytes));
		const exif = await parseExif(meta.exif!);
		expect(exif.ifd0).toMatchObject({ Make: 'Canon', Software: 'Hush', Orientation: 6 });
		expect(hasGps(meta.exif!)).toBe(true);
		expect(createHash('sha256').update(meta.icc!).digest('hex')).toBe(
			createHash('sha256').update(displayP3Profile()).digest('hex'),
		);
		expect(result.source).toMatchObject({ format: 'jpeg', width: 6, height: 4, colour: 'icc', hadLocation: true });
		expect(result.stats.peakFloatBytes).toBe(1024);

		// Progress walks the §2.7 states in order and only ever moves forward.
		expect([...new Set(progress.map((p) => p.stage))]).toEqual([
			'reading',
			'decoding',
			'processing',
			'encoding',
			'saving',
		]);
		for (let i = 1; i < progress.length; i++)
			expect(progress[i]!.fraction).toBeGreaterThanOrEqual(progress[i - 1]!.fraction);
		expect(progress.at(-1)!.fraction).toBe(1);
	});

	it('honours the export settings: format, quality, suffix, location', async () => {
		const { codecs, calls } = fakeCodecs(6, 4);
		const { ctx } = context(codecs);
		const result = await processPhoto(
			{
				name: 'night.jpg',
				bytes: camera(),
				recipe,
				output: { format: 'webp', quality: 80, suffix: '_clean', removeLocation: true },
			},
			ctx,
		);
		expect(result).toMatchObject({ name: 'night_clean.webp', mimeType: 'image/webp', format: 'webp' });
		expect(calls.quality).toBe(80);
		expect(result.warnings).toEqual([]);
	});

	it('HEIC becomes JPEG; pixels the decoder rotated are saved with Orientation 1', async () => {
		const heic = heifFile({ width: 4, height: 6, rotation: 3, exif: cameraExif({ orientation: 6 }) });
		const { codecs } = fakeCodecs(6, 4, 'applied');
		const { ctx } = context(codecs);
		const result = await processPhoto({ name: 'IMG_5501.HEIC', bytes: heic, recipe, output: DEFAULT_OUTPUT }, ctx);
		expect(result).toMatchObject({ name: 'IMG_5501-denoised.jpg', format: 'jpeg', width: 6, height: 4 });
		expect(readOrientation(readJpegMetadata(parseJpeg(result.bytes)).exif!)).toBe(1);
	});

	it('refuses an oversized photo before decoding it (§2.9)', async () => {
		const { codecs, calls } = fakeCodecs(6, 4);
		const { ctx } = context(codecs, { maxMegapixels: 24 });
		const big = jpegFile({ width: 8256, height: 5504 });
		await expect(
			processPhoto({ name: 'big.jpg', bytes: big, recipe, output: DEFAULT_OUTPUT }, ctx),
		).rejects.toBeInstanceOf(PhotoTooLargeError);
		expect(calls.decode).toBe(0);
	});

	it('refuses what it can’t process before decoding', async () => {
		const { codecs, calls } = fakeCodecs(6, 4);
		const { ctx } = context(codecs);
		const notAPhoto = new TextEncoder().encode('a shopping list');
		await expect(
			processPhoto({ name: 'list.txt', bytes: notAPhoto, recipe, output: DEFAULT_OUTPUT }, ctx),
		).rejects.toBeInstanceOf(UnsupportedPhotoError);
		expect(calls.decode).toBe(0);
	});

	it('stops when cancelled', async () => {
		const { codecs } = fakeCodecs(6, 4);
		const signal = { aborted: false };
		const { ctx, saved } = context(codecs, {
			signal,
			onProgress: (p) => {
				if (p.stage === 'decoding') signal.aborted = true;
			},
		});
		await expect(
			processPhoto({ name: 'a.jpg', bytes: camera(), recipe, output: DEFAULT_OUTPUT }, ctx),
		).rejects.toBeInstanceOf(CancelledError);
		expect(saved).toHaveLength(0);
	});

	it('a failed save keeps the finished file, so it can be retried without reprocessing (§5.13)', async () => {
		const { codecs } = fakeCodecs(6, 4);
		const { ctx } = context(codecs, {
			output: { save: () => Promise.reject(new Error('The folder is no longer writable')) },
		});
		const failure = processPhoto(
			{ name: 'a.png', bytes: pngFile({ width: 6, height: 4 }), recipe, output: DEFAULT_OUTPUT },
			ctx,
		);
		await expect(failure).rejects.toBeInstanceOf(SaveError);
		const error = (await failure.catch((e: unknown) => e)) as SaveError;
		expect(error.fileName).toBe('a-denoised.png');
		expect(error.mimeType).toBe('image/png');
		expect(error.bytes.byteLength).toBeGreaterThan(50);
		expect(error.message).toBe('The folder is no longer writable');
	});

	it('names an operation the recipe needs but the context lacks', async () => {
		const { codecs } = fakeCodecs(6, 4);
		const { ctx } = context(codecs, { operations: {} });
		await expect(processPhoto({ name: 'a.jpg', bytes: camera(), recipe, output: DEFAULT_OUTPUT }, ctx)).rejects.toThrow(
			'"invert"',
		);
	});
});

describe('loadModel: storage first, verified, else download parts', () => {
	const sha256 = (b: Uint8Array) => Promise.resolve(createHash('sha256').update(b).digest('hex'));
	const whole = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
	const variant = async (): Promise<ModelVariant> => ({
		precision: 'fp32',
		bytes: whole.length,
		sha256: await sha256(whole),
		parts: ['parts/m.000', 'parts/m.001'],
		backends: ['wasm'],
	});
	const assets = (requests: string[]) => ({
		json: () => Promise.reject(new Error('unused')),
		bytes: (path: string, onBytes?: (n: number) => void) => {
			requests.push(path);
			const part = path.endsWith('000') ? whole.subarray(0, 200) : whole.subarray(200);
			onBytes?.(part.length);
			return Promise.resolve(part);
		},
	});

	it('resolves part paths against the manifest', () => {
		expect(modelPartPath('parts/x.onnx.000')).toBe('models/parts/x.onnx.000');
		expect(modelPartPath('../elsewhere/y')).toBe('elsewhere/y');
	});

	it('downloads, verifies and stores; next time it comes from storage', async () => {
		const stored = new Map<string, Uint8Array>();
		const storage = {
			getModel: (key: string) => Promise.resolve(stored.get(key) ?? null),
			putModel: (key: string, bytes: Uint8Array) => {
				stored.set(key, bytes);
				return Promise.resolve();
			},
		};
		const requests: string[] = [];
		const first = await loadModel(await variant(), { assets: assets(requests), storage, sha256 });
		expect(first.fromCache).toBe(false);
		expect(first.bytes).toEqual(whole);
		expect(requests).toEqual(['models/parts/m.000', 'models/parts/m.001']);
		const second = await loadModel(await variant(), { assets: assets(requests), storage, sha256 });
		expect(second.fromCache).toBe(true);
		expect(requests).toHaveLength(2);
	});

	it('re-downloads when storage holds a damaged copy, and works when storage refuses', async () => {
		const requests: string[] = [];
		const damaged = whole.slice();
		damaged[10] = damaged[10]! ^ 1;
		const result = await loadModel(await variant(), {
			assets: assets(requests),
			storage: {
				getModel: () => Promise.resolve(damaged),
				putModel: () => Promise.reject(new Error('QuotaExceededError')),
			},
			sha256,
		});
		expect(result.fromCache).toBe(false);
		expect(result.bytes).toEqual(whole);
	});

	it('refuses a download that does not match the manifest', async () => {
		const bad = { ...(await variant()), sha256: '0'.repeat(64) };
		await expect(
			loadModel(bad, {
				assets: assets([]),
				storage: { getModel: () => Promise.resolve(null), putModel: () => Promise.resolve() },
				sha256,
			}),
		).rejects.toBeInstanceOf(ModelIntegrityError);
	});
});
