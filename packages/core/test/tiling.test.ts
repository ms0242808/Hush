// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { featherWindow, normalisedAxisWeights, planAxis, planTiles, reflectIndex } from '../src/index.ts';

describe('reflectIndex', () => {
	it('mirrors without repeating the edge pixel', () => {
		const length = 5;
		const mapped = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => reflectIndex(i, length));
		expect(mapped).toEqual([2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 0, 1]);
	});

	it('maps everything to 0 for a one-pixel side', () => {
		expect([-3, 0, 1, 7].map((i) => reflectIndex(i, 1))).toEqual([0, 0, 0, 0]);
	});
});

describe('planAxis', () => {
	const lengths = [1, 7, 15, 16, 17, 100, 463, 464, 465, 511, 512, 513, 1000, 4000, 6000, 8256];
	const configs = [
		{ tileSize: 64, overlap: 16, padMultiple: 16 },
		{ tileSize: 256, overlap: 32, padMultiple: 16 },
		{ tileSize: 512, overlap: 48, padMultiple: 16 },
		{ tileSize: 520, overlap: 48, padMultiple: 16 }, // rounds down to 512
		{ tileSize: 768, overlap: 64, padMultiple: 16, margin: 16 },
	];

	for (const config of configs) {
		for (const length of lengths) {
			it(`covers ${length} px with ${JSON.stringify(config)}`, () => {
				const axis = planAxis(length, config);
				const margin = config.margin ?? config.overlap;
				expect(axis.size % config.padMultiple).toBe(0);
				expect(axis.size).toBeLessThanOrEqual(Math.max(config.tileSize, length + 2 * margin + config.padMultiple));
				expect(axis.starts[0]).toBe(-margin);

				const last = axis.starts.at(-1)!;
				expect(last + axis.size).toBeGreaterThanOrEqual(length + margin);
				for (let i = 1; i < axis.starts.length; i++) {
					const previous = axis.starts[i - 1]!;
					const current = axis.starts[i]!;
					expect(current).toBeGreaterThan(previous);
					expect(previous + axis.size - current).toBeGreaterThanOrEqual(config.overlap);
				}
			});
		}
	}

	it('uses one shrunken tile when the image fits', () => {
		expect(planAxis(100, { tileSize: 512, overlap: 48, padMultiple: 16 })).toEqual({ size: 208, starts: [-48] });
	});

	it('rejects tiles no larger than the overlap', () => {
		expect(() => planAxis(1000, { tileSize: 40, overlap: 48, padMultiple: 16 })).toThrow(RangeError);
	});

	it('rejects nonsense sizes', () => {
		expect(() => planAxis(0, { tileSize: 512, overlap: 48, padMultiple: 16 })).toThrow(RangeError);
		expect(() => planAxis(10.5, { tileSize: 512, overlap: 48, padMultiple: 16 })).toThrow(RangeError);
	});

	it('shares the length evenly instead of clamping a last tile', () => {
		// 6000 × 4000 at up to 1024 px: fixed tiles would process 1.53× the pixels.
		const plan = planTiles(6000, 4000, { tileSize: 1024, overlap: 48, padMultiple: 16 });
		const processed = plan.tileCount * plan.x.size * plan.y.size;
		expect(processed / (6000 * 4000)).toBeLessThan(1.2);
		expect(plan.x.size).toBeLessThanOrEqual(1024);
		expect(plan.y.size).toBeLessThanOrEqual(1024);
	});

	it('counts tiles across both axes', () => {
		const plan = planTiles(6000, 4000, { tileSize: 512, overlap: 48, padMultiple: 16 });
		expect(plan.tileCount).toBe(plan.x.starts.length * plan.y.starts.length);
		expect(plan.x.starts.length).toBe(14);
		expect(plan.y.starts.length).toBe(9);
	});
});

describe('feathering', () => {
	it('is strictly positive and symmetric', () => {
		const w = featherWindow(64, 16);
		expect(Math.min(...w)).toBeGreaterThan(0);
		for (let i = 0; i < 64; i++) expect(w[i]).toBeCloseTo(w[63 - i]!, 6);
		expect(w[32]).toBe(1);
	});

	it('sums to one where neighbours overlap by exactly the ramp', () => {
		const ramp = 24;
		const w = featherWindow(128, ramp);
		const stride = 128 - ramp;
		for (let j = 0; j < ramp; j++) expect(w[stride + j]! + w[j]!).toBeCloseTo(1, 6);
	});

	it('normalises every covered pixel to a total weight of one', () => {
		for (const length of [1, 33, 500, 1999]) {
			const axis = planAxis(length, { tileSize: 128, overlap: 32, padMultiple: 16 });
			const weights = normalisedAxisWeights(axis, length, 32);
			for (let p = 0; p < length; p++) {
				let total = 0;
				axis.starts.forEach((start, t) => {
					const i = p - start;
					if (i >= 0 && i < axis.size) total += weights[t]![i]!;
				});
				expect(total).toBeCloseTo(1, 5);
			}
		}
	});
});
