// SPDX-License-Identifier: Apache-2.0
import type { TileAxis } from './tiling.ts';

/**
 * A tile's blending weights along one axis: raised-cosine ramps of `ramp`
 * pixels at both ends, flat 1 in between. Two neighbours overlapping by exactly
 * `ramp` pixels sum to 1 everywhere in the overlap (cos² + sin² = 1), so the
 * blend is seamless. Every weight is strictly positive, so any pixel covered by
 * a tile can be normalised.
 */
export function featherWindow(size: number, ramp: number): Float32Array {
	const r = Math.min(ramp, Math.floor(size / 2));
	const weights = new Float32Array(size);
	for (let i = 0; i < size; i++) {
		const fromStart = i;
		const fromEnd = size - 1 - i;
		const up = fromStart < r ? rampAt(fromStart, r) : 1;
		const down = fromEnd < r ? rampAt(fromEnd, r) : 1;
		weights[i] = up * down;
	}
	return weights;
}

function rampAt(position: number, ramp: number): number {
	return 0.5 - 0.5 * Math.cos((Math.PI * (position + 0.5)) / ramp);
}

/**
 * Per-tile weights along one axis, already divided by the total weight every
 * tile puts on each pixel. Because the tile grid is a full cartesian product,
 * the 2-D weight of a tile is `x[i] * y[j]` and the weights of all tiles
 * covering a pixel sum to exactly 1 — no weight buffer, no division per pixel.
 * Entries that fall outside the image are 0.
 */
export function normalisedAxisWeights(axis: TileAxis, length: number, ramp: number): Float32Array[] {
	const window = featherWindow(axis.size, ramp);
	const total = new Float64Array(length);
	for (const start of axis.starts) {
		for (let i = 0; i < axis.size; i++) {
			const p = start + i;
			if (p >= 0 && p < length) total[p]! += window[i]!;
		}
	}

	return axis.starts.map((start) => {
		const weights = new Float32Array(axis.size);
		for (let i = 0; i < axis.size; i++) {
			const p = start + i;
			if (p >= 0 && p < length) weights[i] = window[i]! / total[p]!;
		}
		return weights;
	});
}
