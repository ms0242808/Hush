// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { compositeTiles, PreviewGrid, tileToRgb8, type Rect } from '../src/index.ts';

/** Every valid tile, filled by `value(i, j, x, y)` for each pixel of its footprint (x, y in image coordinates). */
function tiles(grid: PreviewGrid, value: (i: number, j: number, x: number, y: number) => number) {
	const store = new Map<number, Uint8Array>();
	for (let j = grid.jMin; j <= grid.jMax; j++) {
		for (let i = grid.iMin; i <= grid.iMax; i++) {
			const rect = grid.tileRect(i, j);
			const rgb = new Uint8Array(grid.tileSize * grid.tileSize * 3);
			for (let ty = 0; ty < grid.tileSize; ty++) {
				for (let tx = 0; tx < grid.tileSize; tx++) {
					const v = value(i, j, rect.x + tx, rect.y + ty);
					rgb.fill(
						Math.max(0, Math.min(255, Math.round(v))),
						(ty * grid.tileSize + tx) * 3,
						(ty * grid.tileSize + tx) * 3 + 3,
					);
				}
			}
			store.set(grid.key(i, j), rgb);
		}
	}
	return store;
}

function composite(grid: PreviewGrid, store: Map<number, Uint8Array>, rect: Rect) {
	const out = new Uint8Array(rect.width * rect.height * 4);
	const covered = compositeTiles(grid, rect, (i, j) => store.get(grid.key(i, j)), out);
	return { out, covered };
}

const whole = (grid: PreviewGrid): Rect => ({ x: 0, y: 0, width: grid.width, height: grid.height });

describe('the preview grid', () => {
	const shapes = [
		{ width: 1000, height: 700, tileSize: 256, overlap: 48, anchor: { x: 500, y: 350 } },
		{ width: 1000, height: 700, tileSize: 256, overlap: 48, anchor: { x: 13, y: 690 } },
		{ width: 180, height: 260, tileSize: 512, overlap: 16, anchor: { x: 90, y: 130 } },
		{ width: 37, height: 5, tileSize: 128, overlap: 48, anchor: { x: 30, y: 2 } },
	];

	for (const shape of shapes) {
		it(`${shape.width}×${shape.height}, ${shape.tileSize}-px tiles at (${shape.anchor.x}, ${shape.anchor.y}): every pixel covered, weights sum to one`, () => {
			const grid = new PreviewGrid(shape);
			const store = tiles(grid, () => 137);
			const { out, covered } = composite(grid, store, whole(grid));
			expect(covered).toBe(grid.width * grid.height);
			// One assertion over every pixel, not one per pixel: same check, a hundred times faster.
			let wrong = 0;
			for (let p = 0; p < out.length; p += 4) if (out[p] !== 137 || out[p + 3] !== 255) wrong++;
			expect(wrong).toBe(0);
		});
	}

	it('centres a tile on the anchor', () => {
		const grid = new PreviewGrid({
			width: 4000,
			height: 3000,
			tileSize: 512,
			overlap: 48,
			anchor: { x: 1800, y: 900 },
		});
		const [first] = grid.order(grid.tilesIn({ x: 1500, y: 600, width: 600, height: 600 }), { x: 1800, y: 900 });
		const rect = grid.tileRect(first!.i, first!.j);
		expect(rect.x + rect.width / 2).toBe(1800);
		expect(rect.y + rect.height / 2).toBe(900);
	});

	it('never keeps a tile whose only part inside the photo is a ramp its neighbour covers', () => {
		const grid = new PreviewGrid({ width: 1000, height: 700, tileSize: 256, overlap: 48, anchor: { x: 20, y: 20 } });
		for (let j = grid.jMin; j <= grid.jMax; j++) {
			for (let i = grid.iMin; i <= grid.iMax; i++) {
				const area = grid.tileArea(i, j)!;
				expect(area.width).toBeGreaterThan(grid.overlap);
				expect(area.height).toBeGreaterThan(grid.overlap);
			}
		}
	});

	it('blends without a seam: a ±4-level disagreement between tiles changes by at most one level per pixel', () => {
		const grid = new PreviewGrid({ width: 900, height: 600, tileSize: 256, overlap: 48, anchor: { x: 400, y: 300 } });
		// Each tile renders the same flat grey with its own small bias, as tiles of a real model do
		// (each block's global pooling sees only its own tile).
		const bias = (i: number, j: number) => ((((i * 7 + j * 3) % 3) + 3) % 3) - 1;
		const store = tiles(grid, (i, j) => 100 + 4 * bias(i, j));
		const { out } = composite(grid, store, whole(grid));
		const at = (x: number, y: number) => out[(y * grid.width + x) * 4]!;
		let steepest = 0;
		for (let y = 0; y < grid.height; y++) {
			for (let x = 0; x < grid.width; x++) {
				if (x > 0) steepest = Math.max(steepest, Math.abs(at(x, y) - at(x - 1, y)));
				if (y > 0) steepest = Math.max(steepest, Math.abs(at(x, y) - at(x, y - 1)));
			}
		}
		expect(steepest).toBeLessThanOrEqual(1);
	});

	it('reproduces the image exactly where the tiles agree', () => {
		const grid = new PreviewGrid({ width: 900, height: 600, tileSize: 256, overlap: 48, anchor: { x: 123, y: 456 } });
		const store = tiles(grid, (_i, _j, x, y) => 20 + x / 5 + y / 7);
		const { out } = composite(grid, store, whole(grid));
		for (let y = 0; y < grid.height; y += 7) {
			for (let x = 0; x < grid.width; x += 3) {
				expect(out[(y * grid.width + x) * 4]).toBe(Math.min(255, Math.round(20 + x / 5 + y / 7)));
			}
		}
	});

	it('shows what is done and marks the rest as missing', () => {
		const grid = new PreviewGrid({ width: 1000, height: 700, tileSize: 256, overlap: 48, anchor: { x: 500, y: 350 } });
		const all = tiles(grid, () => 90);
		const centre = grid.key(0, 0);
		const one = new Map([[centre, all.get(centre)!]]);
		const { out, covered } = composite(grid, one, whole(grid));
		expect(covered).toBe(256 * 256);
		const at = (x: number, y: number) => out[(y * grid.width + x) * 4 + 3];
		expect(at(500, 350)).toBe(255);
		expect(at(372, 222)).toBe(255); // the tile's own corner, ramp and all
		expect(at(371, 350)).toBe(0);
	});

	it('orders the visible "after" side first, then nearest the divider', () => {
		const grid = new PreviewGrid({
			width: 2000,
			height: 1000,
			tileSize: 256,
			overlap: 48,
			anchor: { x: 1000, y: 500 },
		});
		const visible = { x: 600, y: 300, width: 800, height: 400 };
		const after = { x: 1000, y: 300, width: 400, height: 400 };
		const ordered = grid.order(grid.tilesIn(visible), { x: 1000, y: 500 }, after);
		expect(ordered[0]).toEqual({ i: 0, j: 0 });
		const firstBefore = ordered.findIndex((t) => {
			const area = grid.tileArea(t.i, t.j)!;
			return area.x + area.width <= after.x;
		});
		const lastAfter = ordered.findLastIndex((t) => {
			const area = grid.tileArea(t.i, t.j)!;
			return area.x + area.width > after.x;
		});
		expect(firstBefore).toBeGreaterThan(lastAfter);
	});

	it('finds exactly the tiles that contribute to a rectangle', () => {
		const grid = new PreviewGrid({
			width: 2000,
			height: 1000,
			tileSize: 256,
			overlap: 48,
			anchor: { x: 1000, y: 500 },
		});
		const rect = { x: 900, y: 450, width: 300, height: 100 };
		const found = grid.tilesIn(rect).map((t) => `${t.i},${t.j}`);
		for (let j = grid.jMin; j <= grid.jMax; j++) {
			for (let i = grid.iMin; i <= grid.iMax; i++) {
				const area = grid.tileArea(i, j)!;
				const touches =
					area.x < rect.x + rect.width &&
					area.x + area.width > rect.x &&
					area.y < rect.y + rect.height &&
					area.y + area.height > rect.y;
				expect(found.includes(`${i},${j}`)).toBe(touches);
			}
		}
	});

	it('refuses tiles too small for their overlap', () => {
		expect(() => new PreviewGrid({ width: 10, height: 10, tileSize: 96, overlap: 48, anchor: { x: 5, y: 5 } })).toThrow(
			RangeError,
		);
	});
});

describe('tileToRgb8', () => {
	it('rounds and clamps NCHW floats into interleaved bytes', () => {
		const output = new Float32Array([0, 0.5, 1.2, -0.1, 1 / 255, 0.999, 0.25, 0.75, 0.002, 0.998, 0.4, 0.6]);
		// Planes R = [0, 0.5, 1.2, −0.1], G = [1/255, 0.999, 0.25, 0.75], B = [0.002, 0.998, 0.4, 0.6].
		expect([...tileToRgb8(output, 2)]).toEqual([0, 1, 1, 128, 255, 254, 255, 64, 102, 0, 191, 153]);
	});
});
