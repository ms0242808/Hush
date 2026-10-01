// SPDX-License-Identifier: Apache-2.0
import type { Image8, InferenceSession } from '@hush/core';
import { describe, expect, it } from 'vitest';
import { denoise } from '../src/index.ts';

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
});
