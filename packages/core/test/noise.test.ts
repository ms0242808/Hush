// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { noiseMap, noisiestPoint, type Image8 } from '../src/index.ts';

/** Deterministic Gaussian noise (mulberry32 + Box–Muller). */
function gaussian(seed: number) {
	let state = seed >>> 0;
	const uniform = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Image8 {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = pixel(x, y);
			const p = (y * width + x) * 4;
			data[p] = Math.max(0, Math.min(255, Math.round(r)));
			data[p + 1] = Math.max(0, Math.min(255, Math.round(g)));
			data[p + 2] = Math.max(0, Math.min(255, Math.round(b)));
			data[p + 3] = 255;
		}
	}
	return { width, height, channels: 4, data };
}

describe('the noisiest region (§5.3)', () => {
	it('estimates the noise level of a flat patch in levels', () => {
		const noise = gaussian(1);
		const sigma = 8;
		const map = noiseMap(
			image(256, 256, () => {
				const n = sigma * noise();
				return [120 + n, 120 + n, 120 + n]; // grey noise: luminance only
			}),
			{ cell: 128 },
		);
		for (const score of map.scores) {
			// A low percentile of 8 × 8 blocks reads a little under σ; it must be in the right range.
			expect(score).toBeGreaterThan(sigma * 0.7);
			expect(score).toBeLessThan(sigma * 1.15);
		}
	});

	it('finds the noisy quadrant, not the sharp texture or the smooth gradient', () => {
		const noise = gaussian(2);
		const photo = image(512, 512, (x, y) => {
			if (x < 256 && y < 256) {
				// A clean, high-contrast checkerboard: edges everywhere, no noise.
				const on = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0;
				return on ? [200, 200, 200] : [60, 60, 60];
			}
			if (x >= 256 && y >= 256) {
				const n = 18 * noise();
				return [90 + n + 6 * noise(), 90 + n, 90 + n + 6 * noise()];
			}
			return [40 + x / 8, 50 + y / 8, 60]; // smooth shading
		});
		const point = noisiestPoint(noiseMap(photo, { cell: 64 }), { width: 128, height: 128 });
		expect(point.x).toBeGreaterThan(256);
		expect(point.y).toBeGreaterThan(256);
	});

	it('ignores clipped areas, where noise is crushed out of sight', () => {
		const noise = gaussian(3);
		const photo = image(256, 128, (x) =>
			x < 128
				? [Math.max(0, 2 + 10 * noise()), 0, 0] // crushed black with stray noise
				: [100 + 4 * noise(), 100 + 4 * noise(), 100 + 4 * noise()],
		);
		const point = noisiestPoint(noiseMap(photo, { cell: 64 }), { width: 64, height: 64 });
		expect(point.x).toBeGreaterThan(128);
	});

	it('opens in the middle of a photo with no measurable noise', () => {
		const photo = image(300, 200, () => [128, 128, 128]);
		expect(noisiestPoint(noiseMap(photo), { width: 100, height: 100 })).toEqual({ x: 150, y: 100 });
	});

	it('keeps the window inside the photo, and centres a window larger than the photo', () => {
		const noise = gaussian(4);
		const photo = image(400, 300, (x, y) => (x > 350 && y > 250 ? [128 + 30 * noise(), 128, 128] : [128, 128, 128]));
		const inside = noisiestPoint(noiseMap(photo, { cell: 50 }), { width: 200, height: 100 });
		expect(inside.x).toBeLessThanOrEqual(300);
		expect(inside.y).toBeLessThanOrEqual(250);
		expect(noisiestPoint(noiseMap(photo), { width: 1000, height: 1000 })).toEqual({ x: 200, y: 150 });
	});

	it('copes with photos smaller than a sub-block', () => {
		const tiny = image(5, 4, () => [10, 20, 30]);
		const map = noiseMap(tiny);
		expect(map.scores.every((score) => score === 0)).toBe(true);
		expect(noisiestPoint(map, { width: 2, height: 2 })).toEqual({ x: 2.5, y: 2 });
	});

	it('stays within its pixel budget on a large photo', () => {
		const photo: Image8 = { width: 8256, height: 5504, channels: 4, data: new Uint8Array(8256 * 5504 * 4).fill(128) };
		const started = performance.now();
		const map = noiseMap(photo);
		expect(map.columns * map.rows).toBe(65 * 43);
		expect(performance.now() - started).toBeLessThan(1500);
	});
});
