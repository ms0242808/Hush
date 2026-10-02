// SPDX-License-Identifier: Apache-2.0
import { displayTransform, type Orientation } from '@hush/core';
import { describe, expect, it } from 'vitest';
import { displaySize, orientationMatrix, storedCropSize } from './orientation';

/** Where a stored pixel lands on screen, the slow obvious way: flip, then rotate clockwise. */
function expected(o: Orientation, x: number, y: number, width: number, height: number): [number, number] {
	const { flip, rotate } = displayTransform(o);
	let px = flip ? width - 1 - x : x;
	let py = y;
	let w = width;
	let h = height;
	for (let r = 0; r < rotate; r += 90) {
		[px, py] = [h - 1 - py, px];
		[w, h] = [h, w];
	}
	return [px, py];
}

describe('drawing a photo upright', () => {
	const width = 7;
	const height = 4;
	for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
		it(`orientation ${o} puts every pixel where EXIF says`, () => {
			const [a, b, c, d, e, f] = orientationMatrix(o, width, height);
			const size = displaySize(width, height, o);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					// The pixel's centre, transformed, lands in the centre of its display pixel.
					const cx = x + 0.5;
					const cy = y + 0.5;
					const dx = a * cx + c * cy + e - 0.5;
					const dy = b * cx + d * cy + f - 0.5;
					expect([dx, dy]).toEqual(expected(o, x, y, width, height));
					expect(dx).toBeLessThan(size.width);
					expect(dy).toBeLessThan(size.height);
				}
			}
		});
	}

	it('crops sideways photos with the axes swapped, so they fill the stage', () => {
		expect(storedCropSize({ width: 1600, height: 900 }, { width: 6000, height: 4000 }, 1)).toEqual({
			width: 1600,
			height: 900,
		});
		expect(storedCropSize({ width: 1600, height: 900 }, { width: 6000, height: 4000 }, 6)).toEqual({
			width: 900,
			height: 1600,
		});
		expect(storedCropSize({ width: 1600, height: 900 }, { width: 300, height: 200 }, 8)).toEqual({
			width: 300,
			height: 200,
		});
	});
});
