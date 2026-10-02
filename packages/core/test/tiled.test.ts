// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
	BandAccumulator,
	blendRowsTo8Bit,
	CancelledError,
	planTiles,
	runTiled,
	type FinalRows,
	type Image8,
	type TileOptions,
} from '../src/index.ts';

function randomImage(width: number, height: number, channels: 3 | 4, seed = 1): Image8 {
	const data = new Uint8Array(width * height * channels);
	let s = seed;
	for (let i = 0; i < data.length; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		data[i] = s >>> 24;
	}
	return { width, height, channels, data };
}

/** Run the tiler and gather the float output as planar RGB, checking every row arrives once, in order. */
async function runToFloat(
	image: Image8,
	options: TileOptions,
	infer: (input: Float32Array, w: number, h: number, call: number) => Float32Array,
) {
	const plan = planTiles(image.width, image.height, options);
	const out = new Float32Array(3 * image.width * image.height);
	const plane = image.width * image.height;
	let nextRow = 0;
	let call = 0;
	const stats = await runTiled({
		image,
		plan,
		infer: (input, w, h) => Promise.resolve(infer(input, w, h, call++)),
		onRows: ({ y0, y1, width, planes, planeStride }: FinalRows) => {
			expect(y0).toBe(nextRow);
			nextRow = y1;
			for (let c = 0; c < 3; c++) {
				for (let y = y0; y < y1; y++) {
					const from = c * planeStride + (y - y0) * width;
					out.set(planes.subarray(from, from + width), c * plane + y * width);
				}
			}
		},
	});
	expect(nextRow).toBe(image.height);
	return { out, plan, stats };
}

const identity = (input: Float32Array) => input.slice();

describe('runTiled', () => {
	const cases: Array<[number, number, 3 | 4, TileOptions]> = [
		[517, 389, 3, { tileSize: 128, overlap: 32, padMultiple: 16 }],
		[517, 389, 4, { tileSize: 64, overlap: 16, padMultiple: 16 }],
		[1000, 37, 3, { tileSize: 96, overlap: 24, padMultiple: 16, margin: 8 }],
		[1, 1, 4, { tileSize: 64, overlap: 16, padMultiple: 16 }],
		[300, 300, 3, { tileSize: 512, overlap: 48, padMultiple: 16 }],
	];

	for (const [width, height, channels, options] of cases) {
		it(`reconstructs a ${width}×${height}×${channels} image exactly through an identity model`, async () => {
			const image = randomImage(width, height, channels);
			const plan = planTiles(width, height, options);
			const result: Image8 = { width, height, channels, data: new Uint8Array(image.data.length) };
			await runTiled({
				image,
				plan,
				infer: (input) => Promise.resolve(identity(input)),
				onRows: (rows) => blendRowsTo8Bit(rows, image, result, 1),
			});
			expect(result.data).toEqual(image.data);
		});
	}

	it('leaves no seam when every tile is off by a different constant', async () => {
		// Flat grey through a "model" that adds a per-tile bias of up to ±0.02,
		// the kind of tile-to-tile drift global pooling causes. A hard tile edge
		// would jump by up to 10 levels; the cosine feather must turn it into a
		// ramp of under one level per pixel (worst case 0.04 × π / 2·32 ≈ 0.5 level).
		const width = 700;
		const height = 500;
		const grey: Image8 = { width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(128) };
		const biases = Array.from({ length: 200 }, (_, i) => 0.02 * Math.sin(i * 12.9898));
		const { out } = await runToFloat(grey, { tileSize: 128, overlap: 32, padMultiple: 16 }, (input, _w, _h, call) =>
			input.map((v) => v + biases[call]!),
		);

		let maxStep = 0;
		for (let c = 0; c < 3; c++) {
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const i = c * width * height + y * width + x;
					if (x > 0) maxStep = Math.max(maxStep, Math.abs(out[i]! - out[i - 1]!));
					if (y > 0) maxStep = Math.max(maxStep, Math.abs(out[i]! - out[i - width]!));
				}
			}
		}
		expect(maxStep).toBeLessThan(1 / 255);
	});

	it('keeps a smooth gradient smooth across tile and band boundaries', async () => {
		const width = 640;
		const height = 480;
		const data = new Uint8Array(width * height * 3);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const p = (y * width + x) * 3;
				data[p] = Math.round((255 * x) / (width - 1));
				data[p + 1] = Math.round((255 * y) / (height - 1));
				data[p + 2] = 128;
			}
		}
		const image: Image8 = { width, height, channels: 3, data };
		const result: Image8 = { width, height, channels: 3, data: new Uint8Array(data.length) };
		const plan = planTiles(width, height, { tileSize: 96, overlap: 32, padMultiple: 16 });
		await runTiled({
			image,
			plan,
			// A model that blurs horizontally a little: zero padding at tile edges darkens them.
			infer: (input, w, h) => {
				const out = new Float32Array(input.length);
				for (let c = 0; c < 3; c++) {
					for (let y = 0; y < h; y++) {
						for (let x = 0; x < w; x++) {
							const i = c * w * h + y * w + x;
							const left = x > 0 ? input[i - 1]! : 0;
							const right = x < w - 1 ? input[i + 1]! : 0;
							out[i] = 0.25 * left + 0.5 * input[i]! + 0.25 * right;
						}
					}
				}
				return Promise.resolve(out);
			},
			onRows: (rows) => blendRowsTo8Bit(rows, image, result, 1),
		});
		for (let y = 0; y < height; y++) {
			for (let x = 1; x < width - 1; x++) {
				const p = (y * width + x) * 3;
				expect(Math.abs(result.data[p]! - data[p]!)).toBeLessThanOrEqual(1);
				expect(Math.abs(result.data[p + 1]! - data[p + 1]!)).toBeLessThanOrEqual(1);
			}
		}
	});

	it('bounds float memory by one band at the tile ceiling, however tall the photo', async () => {
		const options = { tileSize: 128, overlap: 32, padMultiple: 16 };
		const width = 300;
		// Band of ceiling height, plus two input tiles and one output tile at the ceiling.
		const bound = 3 * 128 * width * 4 + 3 * (3 * 128 * 128 * 4);
		for (const height of [200, 2000, 8000]) {
			const { stats } = await runToFloat(randomImage(width, height, 3), options, identity);
			expect(stats.peakFloatBytes).toBeLessThanOrEqual(bound);
			expect(stats.bandFloatBytes).toBe(3 * stats.tileHeight * width * 4);
		}
	});

	it('stops when cancelled', async () => {
		const image = randomImage(400, 400, 3);
		const signal = { aborted: false };
		const run = runTiled({
			image,
			plan: planTiles(400, 400, { tileSize: 64, overlap: 16, padMultiple: 16 }),
			infer: (input) => Promise.resolve(input),
			onRows: () => {},
			onProgress: ({ tilesDone }) => {
				if (tilesDone === 3) signal.aborted = true;
			},
			signal,
		});
		await expect(run).rejects.toBeInstanceOf(CancelledError);
	});

	it('surfaces inference errors', async () => {
		const run = runTiled({
			image: randomImage(200, 200, 3),
			plan: planTiles(200, 200, { tileSize: 64, overlap: 16, padMultiple: 16 }),
			infer: () => Promise.reject(new Error('GPU device lost')),
			onRows: () => {},
		});
		await expect(run).rejects.toThrow('GPU device lost');
	});

	it('rejects a model output of the wrong size', async () => {
		const run = runTiled({
			image: randomImage(100, 100, 3),
			plan: planTiles(100, 100, { tileSize: 64, overlap: 16, padMultiple: 16 }),
			infer: () => Promise.resolve(new Float32Array(10)),
			onRows: () => {},
		});
		await expect(run).rejects.toThrow(RangeError);
	});

	it('reports progress per tile and per band', async () => {
		const seen: number[] = [];
		const plan = planTiles(300, 300, { tileSize: 128, overlap: 32, padMultiple: 16 });
		await runTiled({
			image: randomImage(300, 300, 3),
			plan,
			infer: (input) => Promise.resolve(input),
			onRows: () => {},
			onProgress: ({ tilesDone, tileCount, bandsDone, bandCount, rowsDone }) => {
				seen.push(tilesDone);
				expect(tileCount).toBe(plan.tileCount);
				expect(bandCount).toBe(plan.y.starts.length);
				expect(bandsDone).toBeLessThanOrEqual(bandCount);
				expect(rowsDone).toBeLessThanOrEqual(300);
			},
		});
		expect(seen).toEqual(Array.from({ length: plan.tileCount }, (_, i) => i + 1));
	});
});

describe('BandAccumulator', () => {
	it('refuses a tile outside the band', () => {
		const band = new BandAccumulator(10, 100, 16);
		const ones = new Float32Array(16).fill(1);
		expect(() => band.add(new Float32Array(3 * 16 * 16), 16, 16, 0, 40, ones, ones)).toThrow(RangeError);
	});

	it('clears released rows', () => {
		const band = new BandAccumulator(4, 20, 8);
		band.planes.fill(1);
		band.release(5, () => {});
		expect(band.start).toBe(5);
		const plane = band.planes.subarray(0, 8 * 4);
		expect(Array.from(plane.subarray(0, 3 * 4))).toEqual(new Array(12).fill(1));
		expect(Array.from(plane.subarray(3 * 4))).toEqual(new Array(20).fill(0));
	});
});
