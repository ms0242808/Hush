// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
	containsRect,
	displayToStoredAffine,
	displayToStoredPoint,
	displayToStoredRect,
	displayTransform,
	intersectRects,
	pixelBounds,
	storedToDisplayPoint,
	storedToDisplayRect,
	type Orientation,
} from '../src/index.ts';

const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const stored = { width: 7, height: 4 };

/** Where a stored pixel lands on screen, the slow obvious way: flip, then rotate clockwise. */
function expectedPixel(o: Orientation, x: number, y: number): [number, number] {
	const { flip, rotate } = displayTransform(o);
	let px = flip ? stored.width - 1 - x : x;
	let py = y;
	let w = stored.width;
	let h = stored.height;
	for (let r = 0; r < rotate; r += 90) {
		[px, py] = [h - 1 - py, px];
		[w, h] = [h, w];
	}
	return [px, py];
}

describe('display ↔ stored geometry (§2.6: pixels never rotate, the view does)', () => {
	for (const o of ORIENTATIONS) {
		it(`orientation ${o}: every pixel centre lands where EXIF says, and maps back`, () => {
			for (let y = 0; y < stored.height; y++) {
				for (let x = 0; x < stored.width; x++) {
					const shown = storedToDisplayPoint({ x: x + 0.5, y: y + 0.5 }, o, stored);
					expect([shown.x - 0.5, shown.y - 0.5]).toEqual(expectedPixel(o, x, y));
					const back = displayToStoredPoint(shown, o, stored);
					expect(back.x).toBeCloseTo(x + 0.5, 10);
					expect(back.y).toBeCloseTo(y + 0.5, 10);
				}
			}
		});

		it(`orientation ${o}: the affine map agrees with the point map`, () => {
			const [a, b, c, d, e, f] = displayToStoredAffine(o, stored);
			for (const point of [
				{ x: 0, y: 0 },
				{ x: 1.25, y: 3.5 },
				{ x: 3, y: 0.75 },
			]) {
				const expected = displayToStoredPoint(point, o, stored);
				expect(a * point.x + c * point.y + e).toBeCloseTo(expected.x, 10);
				expect(b * point.x + d * point.y + f).toBeCloseTo(expected.y, 10);
			}
		});

		it(`orientation ${o}: rectangles round-trip and keep their area`, () => {
			const rect = { x: 1, y: 0.5, width: 4, height: 2.5 };
			const shown = storedToDisplayRect(rect, o, stored);
			expect(shown.width * shown.height).toBeCloseTo(rect.width * rect.height, 10);
			const back = displayToStoredRect(shown, o, stored);
			expect(back.x).toBeCloseTo(rect.x, 10);
			expect(back.y).toBeCloseTo(rect.y, 10);
			expect(back.width).toBeCloseTo(rect.width, 10);
			expect(back.height).toBeCloseTo(rect.height, 10);
		});
	}

	it('sideways orientations swap the axes of a rectangle', () => {
		const shown = storedToDisplayRect({ x: 0, y: 0, width: 7, height: 4 }, 6, stored);
		expect(shown).toEqual({ x: 0, y: 0, width: 4, height: 7 });
	});
});

describe('rectangle helpers', () => {
	it('intersects, or says there is no overlap', () => {
		expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 8, width: 10, height: 10 })).toEqual({
			x: 5,
			y: 8,
			width: 5,
			height: 2,
		});
		expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
	});

	it('knows containment, edges included', () => {
		const outer = { x: 0, y: 0, width: 10, height: 10 };
		expect(containsRect(outer, { x: 0, y: 0, width: 10, height: 10 })).toBe(true);
		expect(containsRect(outer, { x: 1, y: 1, width: 10, height: 2 })).toBe(false);
	});

	it('rounds outwards to whole pixels', () => {
		expect(pixelBounds({ x: 1.5, y: -0.25, width: 2, height: 1 })).toEqual({ x: 1, y: -1, width: 3, height: 2 });
	});
});
