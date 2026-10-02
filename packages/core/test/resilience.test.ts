// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
	blendRowsTo8Bit,
	bytesEqual,
	chooseTileSize,
	DeviceLostError,
	InferenceError,
	MAX_RECOVERIES,
	minTileSize,
	OutOfMemoryError,
	planTiles,
	runTiled,
	type Image8,
	type TileInfer,
	type TileOptions,
} from '../src/index.ts';

function randomImage(width: number, height: number, seed = 5): Image8 {
	const data = new Uint8Array(width * height * 3);
	let s = seed;
	for (let i = 0; i < data.length; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		data[i] = s >>> 24;
	}
	return { width, height, channels: 3, data };
}

/** Run with an identity model that misbehaves as told, and return the 8-bit result. */
async function run(
	image: Image8,
	options: TileOptions,
	infer: TileInfer,
	extra: Partial<Parameters<typeof runTiled>[0]> = {},
) {
	const out: Image8 = { ...image, data: new Uint8Array(image.data.length) };
	const stats = await runTiled({
		image,
		plan: planTiles(image.width, image.height, options),
		infer,
		onRows: (rows) => blendRowsTo8Bit(rows, image, out, 1),
		...extra,
	});
	return { out, stats };
}

const identity: TileInfer = (input) => Promise.resolve(input.slice());

describe('out of GPU memory (§2.3)', () => {
	it('halves the tiles, finishes the photo exactly, and reports the size to remember', async () => {
		const image = randomImage(1500, 1100);
		const remembered: number[] = [];
		const { out, stats } = await run(
			image,
			{ tileSize: 1024, overlap: 32, padMultiple: 16 },
			(input, w, h) => {
				if (w * h > 250 * 250) return Promise.reject(new InferenceError('out-of-memory', 'GPUOutOfMemoryError'));
				return identity(input, w, h);
			},
			{ onBackoff: (size) => remembered.push(size) },
		);
		expect(bytesEqual(out.data, image.data), 'output matches the input exactly').toBe(true);
		// 800 × 608 tiles → 400 (sub-tiles 320 × 352, still too big) → 192.
		expect(stats.backoffs).toBe(2);
		expect(remembered).toEqual([400, 192]);
		expect(stats.finalTileSize).toBe(192);
		// The plan never changed: the band and its rows are the original ones.
		expect(stats).toMatchObject({ tileWidth: 800, tileHeight: 608 });
	});

	it('gives up with a clear error once tiles can’t get smaller', async () => {
		const image = randomImage(300, 300);
		await expect(
			run(image, { tileSize: 256, overlap: 32, padMultiple: 16 }, () =>
				Promise.reject(new InferenceError('out-of-memory', 'no memory at all')),
			),
		).rejects.toBeInstanceOf(OutOfMemoryError);
	});
});

describe('device lost (§2.3)', () => {
	it('recreates the session and retries the tile: the photo is never restarted', async () => {
		const image = randomImage(640, 480);
		let calls = 0;
		let lost = true;
		let recovered = 0;
		const { out, stats } = await run(
			image,
			{ tileSize: 256, overlap: 32, padMultiple: 16 },
			(input, w, h) => {
				calls++;
				if (calls === 5 && lost) {
					lost = false;
					return Promise.reject(new InferenceError('device-lost', 'GPU device was lost: unknown'));
				}
				return identity(input, w, h);
			},
			{
				recover: () => {
					recovered++;
					return Promise.resolve();
				},
			},
		);
		expect(bytesEqual(out.data, image.data), 'output matches the input exactly').toBe(true);
		expect(recovered).toBe(1);
		expect(stats.recoveries).toBe(1);
		const tiles = planTiles(640, 480, { tileSize: 256, overlap: 32, padMultiple: 16 }).tileCount;
		expect(calls).toBe(tiles + 1); // every tile once, plus the one retry
	});

	it('a second loss on the same tile also halves the tile size', async () => {
		const image = randomImage(400, 300);
		let failures = 2;
		const { out, stats } = await run(
			image,
			{ tileSize: 512, overlap: 32, padMultiple: 16 },
			(input, w, h) => {
				if (failures > 0) {
					failures--;
					return Promise.reject(new InferenceError('device-lost', 'lost'));
				}
				return identity(input, w, h);
			},
			{ recover: () => Promise.resolve() },
		);
		expect(bytesEqual(out.data, image.data), 'output matches the input exactly').toBe(true);
		expect(stats).toMatchObject({ recoveries: 2, backoffs: 1 });
	});

	it(`stops after ${MAX_RECOVERIES} recoveries, or at once without a way to recover`, async () => {
		const image = randomImage(200, 200);
		const lose: TileInfer = () => Promise.reject(new InferenceError('device-lost', 'lost again'));
		await expect(
			run(image, { tileSize: 512, overlap: 32, padMultiple: 16 }, lose, { recover: () => Promise.resolve() }),
		).rejects.toBeInstanceOf(DeviceLostError);
		await expect(run(image, { tileSize: 512, overlap: 32, padMultiple: 16 }, lose)).rejects.toBeInstanceOf(
			DeviceLostError,
		);
	});

	it('other failures surface unchanged, never retried', async () => {
		let calls = 0;
		const invalid: TileInfer = () => {
			calls++;
			return Promise.reject(new InferenceError('invalid-output', 'NaN'));
		};
		await expect(
			run(randomImage(200, 200), { tileSize: 512, overlap: 32, padMultiple: 16 }, invalid, {
				recover: () => Promise.resolve(),
			}),
		).rejects.toMatchObject({ kind: 'invalid-output' });
		expect(calls).toBe(1);
	});
});

describe('subdivided tiles are seamless', () => {
	it('a smooth gradient through a per-tile-biased model stays smooth after a backoff', async () => {
		const width = 600;
		const height = 400;
		const grey: Image8 = { width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(128) };
		let call = 0;
		const planes = new Float32Array(3 * width * height);
		await runTiled({
			image: grey,
			plan: planTiles(width, height, { tileSize: 384, overlap: 48, padMultiple: 16 }),
			infer: (input, w) => {
				if (w > 200) return Promise.reject(new InferenceError('out-of-memory', 'oom'));
				const bias = 0.02 * Math.sin(call++ * 12.9898);
				return Promise.resolve(input.map((v) => v + bias));
			},
			onRows: ({ y0, y1, planes: band, planeStride }) => {
				for (let c = 0; c < 3; c++) {
					for (let y = y0; y < y1; y++) {
						planes.set(
							band.subarray(c * planeStride + (y - y0) * width, c * planeStride + (y - y0 + 1) * width),
							c * width * height + y * width,
						);
					}
				}
			},
		});
		let worst = 0;
		for (let y = 0; y < height; y++) {
			for (let x = 1; x < width; x++)
				worst = Math.max(worst, Math.abs(planes[y * width + x]! - planes[y * width + x - 1]!));
		}
		for (let y = 1; y < height; y++) {
			for (let x = 0; x < width; x++)
				worst = Math.max(worst, Math.abs(planes[y * width + x]! - planes[(y - 1) * width + x]!));
		}
		expect(worst).toBeLessThan(1 / 255);
	});
});

describe('choosing the tile size', () => {
	it('caps the preferred size so the model’s largest tensor fits the device', () => {
		// fp16 NAFNet-w32: 64 channels × 2 bytes. A 128 MiB binding limit fits about 970 px.
		expect(
			chooseTileSize({
				preferred: 1024,
				padMultiple: 16,
				overlap: 48,
				bytesPerPixel: 128,
				maxBufferBytes: 128 * 2 ** 20,
			}),
		).toBe(960);
		expect(
			chooseTileSize({ preferred: 768, padMultiple: 16, overlap: 48, bytesPerPixel: 128, maxBufferBytes: 4 * 2 ** 30 }),
		).toBe(768);
	});

	it('never goes above a size that already ran out of memory, nor below the minimum', () => {
		expect(chooseTileSize({ preferred: 768, padMultiple: 16, overlap: 48, remembered: 384 })).toBe(384);
		expect(chooseTileSize({ preferred: 768, padMultiple: 16, overlap: 48, remembered: 16 })).toBe(minTileSize(48, 16));
		expect(minTileSize(48, 16)).toBe(128);
	});
});
