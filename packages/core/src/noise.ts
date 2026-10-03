// SPDX-License-Identifier: Apache-2.0
import type { Image8 } from './types.ts';
import type { Point, Size } from './view.ts';

/**
 * Where a photo is noisiest (§5.3: the viewer opens at 100% on the noisiest
 * region — noise is invisible at fit-to-screen).
 *
 * The photo is divided into cells. In a patch at the centre of each cell, the
 * noise level is estimated with Immerkær's fast estimator (a 3 × 3 Laplacian
 * difference mask whose mean absolute response is proportional to the noise
 * σ), on luminance and on the two colour-difference channels, in 8 × 8
 * sub-blocks. A low percentile of the sub-blocks is the cell's score, so
 * edges and texture — which also excite the mask — don't count as noise:
 * a flat noisy sky beats a sharp, clean brick wall. Clipped patches score
 * zero: blown highlights and crushed shadows hide noise rather than show it.
 */

export interface NoiseMapOptions {
	/** Side of a grid cell, in stored pixels. */
	cell?: number;
	/** Most pixels to analyse over the whole photo; patches shrink to fit. */
	budget?: number;
}

export interface NoiseMap {
	width: number;
	height: number;
	cell: number;
	columns: number;
	rows: number;
	/** Estimated noise per cell, row-major, in 8-bit levels (σ of luminance plus a share of colour). */
	scores: Float32Array;
}

const SUB_BLOCK = 8;
const MIN_PATCH = 16;
const MAX_PATCH = 64;
/** sqrt(π/2) / 6: Immerkær's mask responds to Gaussian noise of σ with a mean |response| of 6σ·sqrt(2/π). */
const IMMERKAER = Math.sqrt(Math.PI / 2) / 6;
/** How much colour noise counts next to luminance noise. Cameras' colour noise is blotchy and very visible. */
const COLOUR_SHARE = 0.25;
/** The sub-block percentile taken as the patch's noise: low, to ignore edges and texture. */
const PERCENTILE = 0.25;

export function noiseMap(image: Image8, options: NoiseMapOptions = {}): NoiseMap {
	const { width, height } = image;
	const cell = Math.max(SUB_BLOCK, Math.round(options.cell ?? 128));
	const columns = Math.max(1, Math.ceil(width / cell));
	const rows = Math.max(1, Math.ceil(height / cell));
	const scores = new Float32Array(columns * rows);
	const budget = options.budget ?? 1_500_000;

	// Patch side: a multiple of the sub-block, as large as the budget allows, never past the cell or the photo.
	const fit = Math.floor(Math.sqrt(budget / (columns * rows)) / SUB_BLOCK) * SUB_BLOCK;
	const limit = Math.floor(Math.min(cell, width - 2, height - 2) / SUB_BLOCK) * SUB_BLOCK;
	const patch = Math.min(MAX_PATCH, Math.max(MIN_PATCH, fit), limit);
	if (patch < SUB_BLOCK) return { width, height, cell, columns, rows, scores };

	const side = patch + 2; // one pixel of border for the 3 × 3 mask
	const y = new Float32Array(side * side);
	const cb = new Float32Array(side * side);
	const cr = new Float32Array(side * side);
	const blocks = (patch / SUB_BLOCK) ** 2;
	const sigmas = new Float32Array(blocks);

	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const centreX = Math.min(width, column * cell + cell / 2);
			const centreY = Math.min(height, row * cell + cell / 2);
			const x0 = clampInt(Math.round(centreX - side / 2), 0, width - side);
			const y0 = clampInt(Math.round(centreY - side / 2), 0, height - side);
			if (!loadPatch(image, x0, y0, side, y, cb, cr)) continue; // clipped: shows no noise
			measureBlocks(y, cb, cr, side, patch, sigmas);
			sigmas.sort();
			scores[row * columns + column] = sigmas[Math.floor(PERCENTILE * (blocks - 1))]!;
		}
	}
	return { width, height, cell, columns, rows, scores };
}

/** Fill the patch's luminance and colour-difference planes. False when the patch is mostly clipped. */
function loadPatch(
	image: Image8,
	x0: number,
	y0: number,
	side: number,
	y: Float32Array,
	cb: Float32Array,
	cr: Float32Array,
): boolean {
	const { width, channels, data } = image;
	let clipped = 0;
	let luminance = 0;
	for (let j = 0; j < side; j++) {
		let p = ((y0 + j) * width + x0) * channels;
		const o = j * side;
		for (let i = 0; i < side; i++, p += channels) {
			const r = data[p]!;
			const g = data[p + 1]!;
			const b = data[p + 2]!;
			const l = 0.299 * r + 0.587 * g + 0.114 * b;
			y[o + i] = l;
			cb[o + i] = 0.564 * (b - l);
			cr[o + i] = 0.713 * (r - l);
			luminance += l;
			if (r === 0 || g === 0 || b === 0 || r === 255 || g === 255 || b === 255) clipped++;
		}
	}
	const count = side * side;
	const mean = luminance / count;
	return clipped * 2 < count && mean >= 4 && mean <= 251;
}

/** Per 8 × 8 sub-block of the patch interior: the combined noise σ, in levels. */
function measureBlocks(
	y: Float32Array,
	cb: Float32Array,
	cr: Float32Array,
	side: number,
	patch: number,
	out: Float32Array,
): void {
	const perRow = patch / SUB_BLOCK;
	out.fill(0);
	const sums = new Float64Array(out.length * 3);
	for (let j = 1; j <= patch; j++) {
		const blockRow = Math.floor((j - 1) / SUB_BLOCK) * perRow;
		for (let i = 1; i <= patch; i++) {
			const block = blockRow + Math.floor((i - 1) / SUB_BLOCK);
			const k = j * side + i;
			sums[block * 3]! += Math.abs(laplacian(y, k, side));
			sums[block * 3 + 1]! += Math.abs(laplacian(cb, k, side));
			sums[block * 3 + 2]! += Math.abs(laplacian(cr, k, side));
		}
	}
	const scale = IMMERKAER / (SUB_BLOCK * SUB_BLOCK);
	for (let b = 0; b < out.length; b++) {
		out[b] = scale * (sums[b * 3]! + COLOUR_SHARE * (sums[b * 3 + 1]! + sums[b * 3 + 2]!));
	}
}

/** Immerkær's mask [1 −2 1; −2 4 −2; 1 −2 1]: zero on any linear ramp, so smooth shading doesn't count. */
function laplacian(plane: Float32Array, k: number, side: number): number {
	const up = k - side;
	const down = k + side;
	return (
		plane[up - 1]! -
		2 * plane[up]! +
		plane[up + 1]! -
		2 * plane[k - 1]! +
		4 * plane[k]! -
		2 * plane[k + 1]! +
		plane[down - 1]! -
		2 * plane[down]! +
		plane[down + 1]!
	);
}

/**
 * The centre of the `window`-sized area (in stored pixels) with the most
 * noise, kept inside the photo. Ties go to the area nearest the centre, so a
 * photo with no measurable noise opens in the middle.
 */
export function noisiestPoint(map: NoiseMap, window: Size): Point {
	const { columns, rows, cell, scores, width, height } = map;
	const wc = clampInt(Math.round(window.width / cell), 1, columns);
	const hc = clampInt(Math.round(window.height / cell), 1, rows);

	// Summed-area table over the cell scores.
	const stride = columns + 1;
	const table = new Float64Array(stride * (rows + 1));
	for (let j = 0; j < rows; j++) {
		let run = 0;
		for (let i = 0; i < columns; i++) {
			run += scores[j * columns + i]!;
			table[(j + 1) * stride + i + 1] = table[j * stride + i + 1]! + run;
		}
	}

	let best = -1;
	let bestDistance = Infinity;
	let point: Point = { x: width / 2, y: height / 2 };
	for (let j = 0; j + hc <= rows; j++) {
		for (let i = 0; i + wc <= columns; i++) {
			const sum =
				table[(j + hc) * stride + i + wc]! -
				table[j * stride + i + wc]! -
				table[(j + hc) * stride + i]! +
				table[j * stride + i]!;
			const x = Math.min(width, (i + wc / 2) * cell);
			const y = Math.min(height, (j + hc / 2) * cell);
			const distance = (x - width / 2) ** 2 + (y - height / 2) ** 2;
			// Scores are floats; treat near-equal sums as ties so the centre wins them.
			if (sum > best + 1e-6 || (Math.abs(sum - best) <= 1e-6 && distance < bestDistance)) {
				best = sum;
				bestDistance = distance;
				point = { x, y };
			}
		}
	}
	// Nothing measurable anywhere (a clean render, a flat test card): the middle, exactly.
	if (best <= 0) point = { x: width / 2, y: height / 2 };
	return {
		x: clampToWindow(point.x, window.width, width),
		y: clampToWindow(point.y, window.height, height),
	};
}

/** Keep a window of `size` centred on `centre` inside [0, length]; centred when it can't fit. */
function clampToWindow(centre: number, size: number, length: number): number {
	if (size >= length) return length / 2;
	return Math.min(length - size / 2, Math.max(size / 2, centre));
}

function clampInt(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
