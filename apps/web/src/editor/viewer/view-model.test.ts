// SPDX-License-Identifier: Apache-2.0
import { storedToDisplayPoint, type Orientation } from '@hush/core';
import { describe, expect, it } from 'vitest';
import {
	afterStoredRect,
	applyAffine,
	clampCentre,
	deviceToStored,
	focusPoint,
	invertAffine,
	originOf,
	panBy,
	regionAround,
	scaleOf,
	storedToDisplay,
	visibleStoredRect,
	zoomAt,
	type Photo,
	type View,
} from './view-model';

const photo45: Photo = { stored: { width: 8256, height: 5504 }, orientation: 1 };
const viewport = { width: 2400, height: 1500 };

describe('the viewer at 100% (§5.3)', () => {
	it('maps every device pixel to exactly one photo pixel, in all eight orientations', () => {
		for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as Orientation[]) {
			const photo: Photo = { stored: { width: 900, height: 600 }, orientation };
			const view: View = { zoom: 1, centre: { x: 333.3, y: 211.7 } };
			const toStored = deviceToStored(view, { width: 401, height: 301 }, photo);
			const seen = new Set<number>();
			let offCentre = 0;
			for (let y = 0; y < 301; y += 1) {
				for (let x = 0; x < 401; x += 1) {
					const s = applyAffine(toStored, { x: x + 0.5, y: y + 0.5 });
					// Pixel centres land on pixel centres: no resampling.
					if (Math.abs((s.x % 1) - 0.5) > 1e-6 || Math.abs((s.y % 1) - 0.5) > 1e-6) offCentre++;
					seen.add(Math.floor(s.y) * 10_000 + Math.floor(s.x));
				}
			}
			expect(offCentre).toBe(0);
			expect(seen.size).toBe(401 * 301);
		}
	});

	it('draws each photo pixel as 2 × 2 device pixels at 200%', () => {
		const toStored = deviceToStored({ zoom: 2, centre: { x: 4000, y: 3000 } }, viewport, photo45);
		const a = applyAffine(toStored, { x: 10.5, y: 20.5 });
		const b = applyAffine(toStored, { x: 11.5, y: 21.5 });
		expect(Math.floor(a.x)).toBe(Math.floor(b.x));
		expect(Math.floor(a.y)).toBe(Math.floor(b.y));
	});

	it('keeps the photo’s origin on a whole device pixel at 100%', () => {
		const origin = originOf({ zoom: 1, centre: { x: 1234.4, y: 987.6 } }, viewport, photo45);
		expect(Number.isInteger(origin.x)).toBe(true);
		expect(Number.isInteger(origin.y)).toBe(true);
	});

	it('fits a large photo and never enlarges a small one', () => {
		expect(scaleOf('fit', viewport, photo45)).toBeCloseTo(Math.min(2400 / 8256, 1500 / 5504), 10);
		expect(scaleOf('fit', viewport, { stored: { width: 260, height: 180 }, orientation: 1 })).toBe(1);
		// Sideways photos fit by their upright size.
		expect(scaleOf('fit', viewport, { stored: { width: 8256, height: 5504 }, orientation: 6 })).toBeCloseTo(
			1500 / 8256,
			10,
		);
	});

	it('stops panning at the photo’s edges, and centres a photo smaller than the viewer', () => {
		const corner = clampCentre({ x: -500, y: 99999 }, 1, viewport, photo45);
		expect(corner).toEqual({ x: 1200, y: 5504 - 750 });
		const small: Photo = { stored: { width: 260, height: 180 }, orientation: 1 };
		expect(clampCentre({ x: 0, y: 0 }, 1, viewport, small)).toEqual({ x: 130, y: 90 });
		const moved = panBy({ zoom: 1, centre: { x: 4000, y: 3000 } }, 100, -50, viewport, photo45);
		expect(moved.centre).toEqual({ x: 3900, y: 3050 });
	});

	it('zooms in on the point under the pointer', () => {
		const fit: View = { zoom: 'fit', centre: { x: 4128, y: 2752 } };
		const anchor = { x: 1800, y: 400 };
		const before = applyAffine(deviceToStored(fit, viewport, photo45), anchor);
		const zoomed = zoomAt(fit, 1, anchor, viewport, photo45);
		const after = applyAffine(deviceToStored(zoomed, viewport, photo45), anchor);
		expect(Math.abs(after.x - before.x)).toBeLessThan(1);
		expect(Math.abs(after.y - before.y)).toBeLessThan(1);
	});

	it('knows what’s visible, and which part shows the result', () => {
		const view: View = { zoom: 1, centre: { x: 4000, y: 3000 } };
		expect(visibleStoredRect(view, viewport, photo45)).toEqual({ x: 2800, y: 2250, width: 2400, height: 1500 });
		expect(afterStoredRect(view, viewport, photo45, 1200)).toEqual({ x: 4000, y: 2250, width: 1200, height: 1500 });
		expect(afterStoredRect(view, viewport, photo45, 2400)).toBeNull();
		expect(focusPoint(view, viewport, photo45, 1200)).toEqual({ x: 4000, y: 3000 });
	});

	it('turns the after side and the focus into stored pixels for a portrait photo', () => {
		const portrait: Photo = { stored: { width: 6000, height: 4000 }, orientation: 6 };
		const view: View = { zoom: 1, centre: { x: 2000, y: 3000 } };
		const small = { width: 800, height: 600 };
		const after = afterStoredRect(view, small, portrait, 400)!;
		// Upright x ∈ [2000, 2400), y ∈ [2700, 3300) is stored y ∈ [1600, 2000), x ∈ [2700, 3300).
		expect(after).toEqual({ x: 2700, y: 1600, width: 600, height: 400 });
		const focus = focusPoint(view, small, portrait, 400);
		expect(storedToDisplayPoint(focus, 6, portrait.stored)).toEqual({ x: 2000, y: 3000 });
		expect(storedToDisplay(focus, portrait)).toEqual({ x: 2000, y: 3000 });
	});

	it('loads a region with a margin, inside the photo and the GPU’s limits', () => {
		const region = regionAround({ x: 2800, y: 2250, width: 2400, height: 1500 }, photo45);
		expect(region.width).toBe(Math.min(4096, Math.ceil(2400 * 1.7)));
		expect(region.x).toBeGreaterThanOrEqual(0);
		expect(region.x + region.width).toBeLessThanOrEqual(8256);
		expect(region.x).toBeLessThanOrEqual(2800);
		expect(region.y).toBeLessThanOrEqual(2250);
		expect(region.y + region.height).toBeGreaterThanOrEqual(3750);
		const edge = regionAround({ x: 0, y: 0, width: 500, height: 400 }, photo45);
		expect(edge.x).toBe(0);
		expect(edge.y).toBe(0);
		// A GPU that only takes 2048-pixel textures gets 2048-pixel regions.
		const small = regionAround({ x: 2800, y: 2250, width: 2400, height: 1500 }, photo45, 0.35, 2048);
		expect(small.width).toBe(2048);
		expect(small.height).toBe(2048);
	});

	it('inverts affine maps', () => {
		const map = deviceToStored({ zoom: 2, centre: { x: 100, y: 50 } }, viewport, {
			stored: { width: 600, height: 400 },
			orientation: 7,
		});
		const back = applyAffine(invertAffine(map), applyAffine(map, { x: 12.25, y: 7.5 }));
		expect(back.x).toBeCloseTo(12.25, 10);
		expect(back.y).toBeCloseTo(7.5, 10);
	});
});
