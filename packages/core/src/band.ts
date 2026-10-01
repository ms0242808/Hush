// SPDX-License-Identifier: Apache-2.0

/**
 * A run of finished rows, handed to the caller exactly once. Values are planar
 * RGB floats: channel `c`, image row `y`, column `x` is at
 * `planes[c * planeStride + (y - y0) * width + x]`.
 */
export interface FinalRows {
	y0: number;
	y1: number;
	width: number;
	planes: Float32Array;
	planeStride: number;
}

/**
 * Row-band accumulation.
 *
 * Holds one tile-height of rows in float instead of the whole image. Tiles add
 * their weighted output into the band; once no remaining tile can touch a row,
 * the row is final, is handed to a sink, and the band slides down. Peak float
 * memory is `3 × rows × width × 4` bytes whatever the image height — about 50 MB
 * for an 8256-px-wide photo with 512-px tiles, instead of over 500 MB for a
 * whole-image buffer.
 */
export class BandAccumulator {
	readonly width: number;
	readonly height: number;
	readonly rows: number;
	readonly planes: Float32Array;
	/** The image row stored in band row 0. */
	start = 0;

	constructor(width: number, height: number, rows: number) {
		this.width = width;
		this.height = height;
		this.rows = Math.min(rows, height);
		this.planes = new Float32Array(3 * this.rows * width);
	}

	get floatBytes(): number {
		return this.planes.byteLength;
	}

	/**
	 * Add one tile's NCHW output, weighted by `wx[i] * wy[j]`. The tile may
	 * extend past the image (reflection padding); those pixels are skipped.
	 */
	add(
		tile: Float32Array,
		tileWidth: number,
		tileHeight: number,
		x0: number,
		y0: number,
		wx: Float32Array,
		wy: Float32Array,
	): void {
		const { width, planes, rows, start } = this;
		const ix0 = Math.max(0, x0);
		const ix1 = Math.min(width, x0 + tileWidth);
		const iy0 = Math.max(0, y0);
		const iy1 = Math.min(this.height, y0 + tileHeight);
		if (iy0 < start || iy1 > start + rows) {
			throw new RangeError(`Tile rows ${iy0}–${iy1} fall outside the band ${start}–${start + rows}`);
		}

		const planeStride = rows * width;
		const tilePlane = tileWidth * tileHeight;
		for (let c = 0; c < 3; c++) {
			for (let y = iy0; y < iy1; y++) {
				const ty = y - y0;
				const rowWeight = wy[ty]!;
				const tileRow = c * tilePlane + ty * tileWidth - x0;
				const bandRow = c * planeStride + (y - start) * width;
				for (let x = ix0; x < ix1; x++) {
					planes[bandRow + x]! += tile[tileRow + x]! * wx[x - x0]! * rowWeight;
				}
			}
		}
	}

	/** Hand rows [start, upTo) to `sink`, then slide the band down to start at `upTo`. */
	release(upTo: number, sink: (rows: FinalRows) => void): void {
		const { width, planes, rows } = this;
		const end = Math.min(upTo, this.height);
		if (end <= this.start) return;

		sink({ y0: this.start, y1: end, width, planes, planeStride: rows * width });

		const shift = end - this.start;
		const keep = Math.max(0, rows - shift);
		const planeStride = rows * width;
		for (let c = 0; c < 3; c++) {
			const base = c * planeStride;
			if (keep > 0) planes.copyWithin(base, base + shift * width, base + rows * width);
			planes.fill(0, base + keep * width, base + planeStride);
		}
		this.start = end;
	}
}
