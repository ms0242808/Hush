// SPDX-License-Identifier: Apache-2.0
import { InferenceError, parseRecipe, type Image8, type InferenceSession } from '@hush/core';
import { describe, expect, it } from 'vitest';
import {
	createDenoiseOperation,
	defaultRecipe,
	denoise,
	denoiseParams,
	DENOISE_CONTROLS,
	OPERATIONS,
} from '../src/index.ts';

const model = { tile: { padMultiple: 16, overlap: 16 } };

function session(transform: (v: number) => number): InferenceSession {
	return {
		backend: 'wasm',
		run: (input) => Promise.resolve(input.map(transform)),
		dispose: () => Promise.resolve(),
	};
}

function noise(width: number, height: number, channels: 3 | 4, seed = 7): Image8 {
	const data = new Uint8Array(width * height * channels);
	let s = seed;
	for (let i = 0; i < data.length; i++) {
		s = (s * 1103515245 + 12345) >>> 0;
		data[i] = s >>> 24;
	}
	return { width, height, channels, data };
}

describe('denoise', () => {
	it('returns the input unchanged when the model is the identity', async () => {
		const image = noise(131, 97, 4);
		const { image: out, stats } = await denoise(image, { model, session: session((v) => v), tileSize: 64 });
		expect(out.data).toEqual(image.data);
		expect(stats.tileCount).toBeGreaterThan(1);
	});

	it('keeps the original at strength 0 whatever the model does', async () => {
		const image = noise(70, 50, 3);
		const { image: out } = await denoise(image, {
			model,
			session: session(() => 0),
			tileSize: 48,
			params: { strength: 0 },
		});
		expect(out.data).toEqual(image.data);
	});

	it('blends linearly between original and model output', async () => {
		const flat: Image8 = { width: 40, height: 30, channels: 3, data: new Uint8Array(40 * 30 * 3).fill(100) };
		const { image: out } = await denoise(flat, {
			model,
			session: session(() => 200 / 255),
			tileSize: 32,
			params: { strength: 0.25 },
		});
		expect(new Set(out.data)).toEqual(new Set([125]));
	});

	it('writes in place when asked, with the same result as a separate output', async () => {
		const params = { strength: 0.8, luma: 0.9, colour: 0.5, detail: 0.4 };
		const image = noise(150, 110, 4, 3);
		const separate = await denoise(image, { model, session: session((v) => 1 - v), tileSize: 64, params });
		const copy: Image8 = { ...image, data: image.data.slice() };
		const inPlace = await denoise(copy, { model, session: session((v) => 1 - v), tileSize: 64, params, output: copy });
		expect(inPlace.image).toBe(copy);
		expect(copy.data).toEqual(separate.image.data);
	});

	it('recovers a lost device through the session, without restarting the photo', async () => {
		let lost = 2;
		let recoveries = 0;
		const flaky: InferenceSession = {
			backend: 'webgpu',
			run: (input) => {
				if (lost-- === 1) return Promise.reject(new InferenceError('device-lost', 'GPU device lost'));
				return Promise.resolve(input.slice());
			},
			recover: () => {
				recoveries++;
				return Promise.resolve();
			},
			dispose: () => Promise.resolve(),
		};
		const image = noise(200, 150, 3);
		const result = await denoise(image, { model, session: flaky, tileSize: 64 });
		expect(result.image.data).toEqual(image.data);
		expect(recoveries).toBe(1);
		expect(result.stats.recoveries).toBe(1);
	});
});

describe('the denoise operation and its recipe', () => {
	it('declares the four sliders, and validates recipes against them', () => {
		expect(DENOISE_CONTROLS.map((c) => c.id)).toEqual(['strength', 'luma', 'colour', 'detail']);
		const recipe = parseRecipe({ schema: 1, ops: [{ op: 'denoise', params: { detail: 0.3 } }] }, OPERATIONS);
		expect(denoiseParams(recipe.ops[0]!.params)).toEqual({ strength: 1, luma: 1, colour: 1, detail: 0.3 });
		expect(defaultRecipe('nafnet-sidd-w32')).toEqual({
			schema: 1,
			ops: [{ op: 'denoise', model: 'nafnet-sidd-w32', params: { strength: 1, luma: 1, colour: 1, detail: 0 } }],
		});
	});

	it('runs from a recipe step, reading the session’s current tile size each time', async () => {
		let size = 64;
		const backoffs: number[] = [];
		const operation = createDenoiseOperation({
			model: { ...model, id: 'm' } as never,
			session: session((v) => 1 - v),
			tileSize: () => size,
			onBackoff: (s) => backoffs.push(s),
		});
		expect(operation.tiling).toEqual({ padMultiple: 16, overlap: 16, scale: 1 });
		const image = noise(90, 70, 4);
		const output: Image8 = { ...image, data: new Uint8Array(image.data.length) };
		const result = await operation.run({
			input: image,
			output,
			params: { strength: 1, luma: 1, colour: 1, detail: 0 },
		});
		expect(result.stats?.tileWidth).toBeLessThanOrEqual(64);
		for (let i = 0; i < image.data.length; i++) {
			expect(output.data[i]).toBe(i % 4 === 3 ? image.data[i] : 255 - image.data[i]!);
		}
		size = 128;
		const second = await operation.run({
			input: image,
			output,
			params: { strength: 1, luma: 1, colour: 1, detail: 0 },
		});
		expect(second.stats!.tileWidth).toBeGreaterThan(64);
		expect(result.floatBytes).toBeGreaterThan(0);
	});
});

describe('a 102 MP photo (§2.3, Phase 1 acceptance)', () => {
	// Fujifilm GFX100: 11648 × 8736 = 101.8 MP. The model is the identity and the
	// sliders neutral, so the output must reproduce every input pixel exactly.
	const width = 11648;
	const height = 8736;
	const pixel = (x: number, y: number, c: number) => (x * 3 + y * 7 + c * 85 + ((x * y) >>> 4)) & 0xff;

	it('completes in place with float memory bounded by one band, whatever the height', async () => {
		const tileSize = 768;
		const data = new Uint8Array(width * height * 3);
		for (let y = 0, p = 0; y < height; y++)
			for (let x = 0; x < width; x++, p += 3) {
				data[p] = pixel(x, y, 0);
				data[p + 1] = pixel(x, y, 1);
				data[p + 2] = pixel(x, y, 2);
			}
		const image: Image8 = { width, height, channels: 3, data };
		const result = await denoise(image, {
			model: { tile: { padMultiple: 16, overlap: 48 } },
			session: { backend: 'wasm', run: (input) => Promise.resolve(input), dispose: () => Promise.resolve() },
			tileSize,
			output: image,
		});

		// One band of floats at the tile ceiling, three tiles, and the adjust stage's five rows.
		const bandBound = 3 * tileSize * width * 4;
		const tileBound = 3 * (3 * tileSize * tileSize * 4);
		expect(result.stats.bandFloatBytes).toBeLessThanOrEqual(bandBound);
		expect(result.stats.peakFloatBytes).toBeLessThanOrEqual(bandBound + tileBound);
		expect(result.adjustFloatBytes).toBeLessThanOrEqual(6 * width * 4 * 5);
		// A whole-image float buffer would be 3 × 101.8 M × 4 = 1.2 GB; this is about a tenth of that.
		expect(result.stats.peakFloatBytes + result.adjustFloatBytes).toBeLessThan(0.11 * 3 * width * height * 4);

		let mismatches = 0;
		for (let y = 0, p = 0; y < height; y++)
			for (let x = 0; x < width; x++, p += 3) {
				if (data[p] !== pixel(x, y, 0) || data[p + 1] !== pixel(x, y, 1) || data[p + 2] !== pixel(x, y, 2))
					mismatches++;
			}
		expect(mismatches).toBe(0);

		// The bound depends on the width and the tile ceiling only: a photo a tenth as tall
		// is held under the very same bound (its tiles may even come out shorter).
		const short = await denoise(
			{ width, height: 900, channels: 3, data: new Uint8Array(width * 900 * 3) },
			{
				model: { tile: { padMultiple: 16, overlap: 48 } },
				session: { backend: 'wasm', run: (input) => Promise.resolve(input), dispose: () => Promise.resolve() },
				tileSize,
			},
		);
		expect(short.stats.bandFloatBytes).toBeLessThanOrEqual(bandBound);
		expect(result.stats.bandFloatBytes).toBe(3 * result.stats.tileHeight * width * 4);
	}, 180_000);
});
