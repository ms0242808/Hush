// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { estimateExportMs, modelPixels, msPerPixel, planTiles } from '../src/index.ts';

describe('export estimate (§2.10)', () => {
	const tile = { size: 768, overlap: 48, padMultiple: 16 };

	it('counts the pixels the model really processes, overlap included', () => {
		const plan = planTiles(6000, 4000, { tileSize: 768, overlap: 48, padMultiple: 16 });
		expect(modelPixels(6000, 4000, tile)).toBe(plan.tileCount * plan.x.size * plan.y.size);
		// Overlap and reflection margins cost something, but far less than double.
		expect(modelPixels(6000, 4000, tile) / 24e6).toBeGreaterThan(1.05);
		expect(modelPixels(6000, 4000, tile) / 24e6).toBeLessThan(1.4);
	});

	it('reproduces the Phase 1 measurement: 24 MP at 0.52 MP/s is about 46 s of denoising', () => {
		// 0.52 MP/s of photo, measured with this tile plan: back out the per-model-pixel rate.
		const msPerModelPixel = 46_100 / modelPixels(6000, 4000, tile);
		const ms = estimateExportMs({ width: 6000, height: 4000, tile, msPerModelPixel, format: 'jpeg' });
		expect(ms).toBeGreaterThan(46_100 + 5_000); // plus encoding
		expect(ms).toBeLessThan(46_100 + 12_000);
	});

	it('scales with the processor: ten times slower per pixel, ten times the model time', () => {
		const fast = estimateExportMs({ width: 6000, height: 4000, tile, msPerModelPixel: 1e-3, format: 'png' });
		const slow = estimateExportMs({ width: 6000, height: 4000, tile, msPerModelPixel: 1e-2, format: 'png' });
		expect(slow - fast).toBeCloseTo(9e-3 * modelPixels(6000, 4000, tile), 3);
	});

	it('ignores the warm-up tile and takes the median of the rest', () => {
		expect(msPerPixel([])).toBeNull();
		expect(msPerPixel([{ ms: 900, pixels: 100 }])).toBe(9);
		expect(
			msPerPixel([
				{ ms: 5000, pixels: 100 },
				{ ms: 300, pixels: 100 },
				{ ms: 100, pixels: 100 },
				{ ms: 200, pixels: 100 },
			]),
		).toBe(2);
		expect(
			msPerPixel([
				{ ms: 5000, pixels: 100 },
				{ ms: 100, pixels: 100 },
				{ ms: 300, pixels: 100 },
			]),
		).toBe(2);
	});
});
