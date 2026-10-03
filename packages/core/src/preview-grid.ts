// SPDX-License-Identifier: Apache-2.0
import { featherWindow } from './feather.ts';
import { intersectRects, type Point, type Rect } from './view.ts';

/**
 * The preview grid (§5.3, §4.6 "preview crop"): how the editor shows a
 * denoised photo at 100% within seconds, without denoising all of it.
 *
 * Tiles sit on one fixed grid for the whole session, anchored so that one tile
 * is centred where the viewer opens (the noisiest region). Neighbours overlap
 * by exactly the model's overlap and blend with the same raised-cosine
 * feather as an export, so the weights of all tiles covering a pixel sum to 1
 * and no seam shows. Each tile is computed once, in the order the viewer
 * needs them, and cached; panning back reuses them. With only some
 * neighbours done, a pixel is the weighted average of those that are, so the
 * preview is always a valid image and only ever gets more exact.
 */

export interface PreviewGridOptions {
	/** Stored photo size. */
	width: number;
	height: number;
	/** Tile side: a multiple of the model's pad multiple. */
	tileSize: number;
	/** The model's overlap, which is also the feather ramp. */
	overlap: number;
	/** A tile is centred on this stored point. */
	anchor: Point;
}

export interface TileIndex {
	i: number;
	j: number;
}

export class PreviewGrid {
	readonly width: number;
	readonly height: number;
	readonly tileSize: number;
	readonly overlap: number;
	readonly stride: number;
	readonly originX: number;
	readonly originY: number;
	/** Feather weights along either axis of a tile. */
	readonly weights: Float32Array;
	/** Valid tile indices, inclusive. A tile is valid unless the part of it inside the photo lies in a ramp a neighbour covers. */
	readonly iMin: number;
	readonly iMax: number;
	readonly jMin: number;
	readonly jMax: number;

	constructor(options: PreviewGridOptions) {
		const { width, height, tileSize, overlap } = options;
		if (!Number.isInteger(tileSize) || tileSize <= 2 * overlap) {
			throw new RangeError(`Tile size ${tileSize} must be an integer larger than twice the overlap ${overlap}`);
		}
		this.width = width;
		this.height = height;
		this.tileSize = tileSize;
		this.overlap = overlap;
		this.stride = tileSize - overlap;
		this.originX = Math.round(options.anchor.x - tileSize / 2);
		this.originY = Math.round(options.anchor.y - tileSize / 2);
		this.weights = featherWindow(tileSize, overlap);
		[this.iMin, this.iMax] = this.validRange(this.originX, width);
		[this.jMin, this.jMax] = this.validRange(this.originY, height);
	}

	/** Tiles i with x0 + T − O > 0 and x0 + O < length: everything else is a sliver its neighbour covers. */
	private validRange(origin: number, length: number): [number, number] {
		const { tileSize, overlap, stride } = this;
		const first = Math.floor((overlap - tileSize - origin) / stride) + 1;
		const last = Math.ceil((length - overlap - origin) / stride) - 1;
		return [first, Math.max(first, last)];
	}

	get columns(): number {
		return this.iMax - this.iMin + 1;
	}

	get rows(): number {
		return this.jMax - this.jMin + 1;
	}

	/** A stable number for a tile, for caches. */
	key(i: number, j: number): number {
		return (j - this.jMin) * this.columns + (i - this.iMin);
	}

	/** The tile's footprint in stored coordinates; it may extend past the photo (reflection padding). */
	tileRect(i: number, j: number): Rect {
		return {
			x: this.originX + i * this.stride,
			y: this.originY + j * this.stride,
			width: this.tileSize,
			height: this.tileSize,
		};
	}

	/** The part of a tile inside the photo: the pixels it contributes to. */
	tileArea(i: number, j: number): Rect | null {
		return intersectRects(this.tileRect(i, j), { x: 0, y: 0, width: this.width, height: this.height });
	}

	/** Valid tiles whose contribution touches `rect`. */
	tilesIn(rect: Rect): TileIndex[] {
		const { originX, originY, stride, tileSize } = this;
		const i0 = Math.max(this.iMin, Math.floor((rect.x - originX - tileSize) / stride) + 1);
		const i1 = Math.min(this.iMax, Math.ceil((rect.x + rect.width - originX) / stride) - 1);
		const j0 = Math.max(this.jMin, Math.floor((rect.y - originY - tileSize) / stride) + 1);
		const j1 = Math.min(this.jMax, Math.ceil((rect.y + rect.height - originY) / stride) - 1);
		const tiles: TileIndex[] = [];
		for (let j = j0; j <= j1; j++) {
			for (let i = i0; i <= i1; i++) {
				const area = this.tileArea(i, j);
				if (area && intersectRects(area, rect)) tiles.push({ i, j });
			}
		}
		return tiles;
	}

	/**
	 * The order to compute tiles in: those touching `priority` (the visible
	 * "after" side of the comparison) first, then by distance from `focus`
	 * (the divider) to the tile's centre.
	 */
	order(tiles: readonly TileIndex[], focus: Point, priority: Rect | null = null): TileIndex[] {
		const half = this.tileSize / 2;
		const ranked = tiles.map((tile) => {
			const rect = this.tileRect(tile.i, tile.j);
			const area = this.tileArea(tile.i, tile.j);
			const touches = priority === null || (area !== null && intersectRects(area, priority) !== null);
			const distance = (rect.x + half - focus.x) ** 2 + (rect.y + half - focus.y) ** 2;
			return { tile, touches, distance };
		});
		ranked.sort((a, b) => (a.touches === b.touches ? a.distance - b.distance : a.touches ? -1 : 1));
		return ranked.map((entry) => entry.tile);
	}
}

/**
 * Blend the available tiles over `rect` (whole pixels inside the photo) into
 * RGBA. Alpha is 255 where at least one tile covers the pixel and 0 where
 * none does yet. `tileAt` returns a tile's output as 8-bit interleaved RGB,
 * or undefined when it isn't computed. Returns how many pixels are covered.
 */
export function compositeTiles(
	grid: PreviewGrid,
	rect: Rect,
	tileAt: (i: number, j: number) => Uint8Array | undefined,
	out: Uint8Array,
): number {
	const { width, height } = rect;
	if (out.length !== width * height * 4) throw new RangeError('Output must be RGBA for the whole rectangle');
	const sums = new Float32Array(width * height * 3);
	const total = new Float32Array(width * height);
	const { weights, tileSize } = grid;

	for (const { i, j } of grid.tilesIn(rect)) {
		const tile = tileAt(i, j);
		if (!tile) continue;
		const footprint = grid.tileRect(i, j);
		const overlap = intersectRects(footprint, rect);
		if (!overlap) continue;
		for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
			const wy = weights[y - footprint.y]!;
			const tileRow = (y - footprint.y) * tileSize - footprint.x;
			const outRow = (y - rect.y) * width - rect.x;
			for (let x = overlap.x; x < overlap.x + overlap.width; x++) {
				const w = wy * weights[x - footprint.x]!;
				const t = (tileRow + x) * 3;
				const o = outRow + x;
				sums[o * 3]! += w * tile[t]!;
				sums[o * 3 + 1]! += w * tile[t + 1]!;
				sums[o * 3 + 2]! += w * tile[t + 2]!;
				total[o]! += w;
			}
		}
	}

	let covered = 0;
	for (let o = 0; o < total.length; o++) {
		const w = total[o]!;
		const p = o * 4;
		if (w > 0) {
			out[p] = Math.round(sums[o * 3]! / w);
			out[p + 1] = Math.round(sums[o * 3 + 1]! / w);
			out[p + 2] = Math.round(sums[o * 3 + 2]! / w);
			out[p + 3] = 255;
			covered++;
		} else {
			out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 0;
		}
	}
	return covered;
}

/** A model output tile (NCHW float RGB in [0, 1]) as 8-bit interleaved RGB. */
export function tileToRgb8(output: Float32Array, size: number, into?: Uint8Array): Uint8Array {
	const plane = size * size;
	if (output.length !== 3 * plane) throw new RangeError(`Expected ${3 * plane} values, got ${output.length}`);
	const rgb = into ?? new Uint8Array(3 * plane);
	for (let k = 0; k < plane; k++) {
		for (let c = 0; c < 3; c++) {
			const v = output[c * plane + k]! * 255 + 0.5;
			rgb[k * 3 + c] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
		}
	}
	return rgb;
}
