// SPDX-License-Identifier: Apache-2.0
import type { FinalRows } from './band.ts';
import { reflectIndex } from './tiling.ts';
import type { Image8 } from './types.ts';

/**
 * The adjust stage (§2.5). Inference runs once; every slider is a cheap blend
 * between the original and the model's output, so on a preview the sliders
 * feel instant and on export they cost one pass over finished rows.
 *
 * With Δ = denoised − original, split into luminance ΔY (BT.601 weights, as
 * JPEG's YCbCr) and the colour change that leaves luminance alone (Δ − ΔY):
 *
 *   out = original + strength × (luma × ΔY′ + colour × (Δ − ΔY))
 *   ΔY′ = (1 − detail) × ΔY + detail × blur(ΔY)
 *
 * Detail restores the original's fine luminance texture: at 1, only the
 * coarse part of the luminance change is applied, so grain-sized texture
 * comes back while blotchy low-frequency noise stays removed. It is the
 * "add back original − blur(original)" of the spec, taken relative to the
 * model's output so the fine band isn't counted twice and edges don't
 * sharpen. The blur is a 5-tap binomial (σ = 1 px) with mirrored edges.
 */
export interface AdjustParams {
	/** 0 keeps the original; 1 applies the full result. */
	strength: number;
	/** How much luminance noise to remove. */
	luma: number;
	/** How much colour noise to remove. */
	colour: number;
	/** How much of the original's fine texture to restore. */
	detail: number;
}

/** The model's output, unchanged. */
export const NEUTRAL_ADJUST: AdjustParams = { strength: 1, luma: 1, colour: 1, detail: 0 };

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
const KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16] as const;
const RADIUS = 2;
const RING = 2 * RADIUS + 1;

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * Applies the adjust stage to rows as the band finishes them, writing 8-bit
 * output. The vertical blur needs two rows below the one being written, so
 * output trails input by two rows; `finish()` writes the last ones. Memory is
 * five rows of floats, whatever the photo's size.
 *
 * `output` may be the same image as `original`: each row is read before it
 * is overwritten, and rows still to come are never touched. That is how an
 * export keeps one copy of a 100 MP photo instead of two.
 */
export class RowAdjuster {
	readonly width: number;
	readonly height: number;
	private readonly original: Image8;
	private readonly output: Image8;
	private readonly lumaWeight: number;
	private readonly colourWeight: number;
	private readonly detail: number;
	/** Δ per row slot, planar RGB, in levels (0–255 scale). */
	private readonly delta: Float32Array;
	/** Horizontally blurred ΔY per row slot. */
	private readonly blurred: Float32Array;
	private readonly lumaRow: Float32Array;
	/** Rows received / written so far. */
	private received = 0;
	private written = 0;

	constructor(original: Image8, output: Image8, params: AdjustParams) {
		if (output.width !== original.width || output.height !== original.height || output.channels !== original.channels) {
			throw new RangeError('Output must match the original in size and channels');
		}
		this.width = original.width;
		this.height = original.height;
		this.original = original;
		this.output = output;
		const strength = clamp01(params.strength);
		this.lumaWeight = strength * clamp01(params.luma);
		this.colourWeight = strength * clamp01(params.colour);
		this.detail = clamp01(params.detail);
		this.delta = new Float32Array(RING * 3 * this.width);
		this.blurred = new Float32Array(RING * this.width);
		this.lumaRow = new Float32Array(this.width);
	}

	get floatBytes(): number {
		return this.delta.byteLength + this.blurred.byteLength + this.lumaRow.byteLength;
	}

	get rowsWritten(): number {
		return this.written;
	}

	/** Feed finished rows, in order, exactly once each. */
	push(rows: FinalRows): void {
		if (rows.y0 !== this.received) throw new RangeError(`Expected row ${this.received}, got ${rows.y0}`);
		for (let y = rows.y0; y < rows.y1; y++) {
			this.take(rows, y);
			this.received = y + 1;
			while (this.written + RADIUS < this.received && this.written < this.height) this.emit(this.written++);
		}
	}

	/** Write the rows still held back. Call once every row has been pushed. */
	finish(): void {
		if (this.received !== this.height) throw new RangeError(`Only ${this.received} of ${this.height} rows arrived`);
		while (this.written < this.height) this.emit(this.written++);
	}

	/** Compute Δ and the horizontally blurred ΔY for one incoming row. */
	private take(rows: FinalRows, y: number): void {
		const { width, delta, blurred, lumaRow } = this;
		const { planes, planeStride } = rows;
		const channels = this.original.channels;
		const src = this.original.data;
		const slot = y % RING;
		const deltaBase = slot * 3 * width;
		const bandRow = (y - rows.y0) * width;
		const pixelRow = y * width * channels;
		for (let x = 0; x < width; x++) {
			const p = pixelRow + x * channels;
			const dr = planes[bandRow + x]! * 255 - src[p]!;
			const dg = planes[planeStride + bandRow + x]! * 255 - src[p + 1]!;
			const db = planes[2 * planeStride + bandRow + x]! * 255 - src[p + 2]!;
			delta[deltaBase + x] = dr;
			delta[deltaBase + width + x] = dg;
			delta[deltaBase + 2 * width + x] = db;
			lumaRow[x] = LUMA_R * dr + LUMA_G * dg + LUMA_B * db;
		}
		const blurBase = slot * width;
		if (this.detail === 0) return;
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let k = -RADIUS; k <= RADIUS; k++) {
				const xi = x + k < 0 || x + k >= width ? reflectIndex(x + k, width) : x + k;
				sum += KERNEL[k + RADIUS]! * lumaRow[xi]!;
			}
			blurred[blurBase + x] = sum;
		}
	}

	/** Write output row y. Every row in its blur window has arrived. */
	private emit(y: number): void {
		const { width, delta, blurred, detail, lumaWeight, colourWeight } = this;
		const channels = this.original.channels;
		const src = this.original.data;
		const dst = this.output.data;
		const deltaBase = (y % RING) * 3 * width;
		const window: number[] = [];
		if (detail > 0)
			for (let k = -RADIUS; k <= RADIUS; k++) window.push((reflectIndex(y + k, this.height) % RING) * width);
		const pixelRow = y * width * channels;
		for (let x = 0; x < width; x++) {
			const dr = delta[deltaBase + x]!;
			const dg = delta[deltaBase + width + x]!;
			const db = delta[deltaBase + 2 * width + x]!;
			const dy = LUMA_R * dr + LUMA_G * dg + LUMA_B * db;
			let dyAdjusted = dy;
			if (detail > 0) {
				let coarse = 0;
				for (let k = 0; k < RING; k++) coarse += KERNEL[k]! * blurred[window[k]! + x]!;
				dyAdjusted = (1 - detail) * dy + detail * coarse;
			}
			const luminance = lumaWeight * dyAdjusted;
			const p = pixelRow + x * channels;
			const r = src[p]! + luminance + colourWeight * (dr - dy) + 0.5;
			const g = src[p + 1]! + luminance + colourWeight * (dg - dy) + 0.5;
			const b = src[p + 2]! + luminance + colourWeight * (db - dy) + 0.5;
			dst[p] = r <= 0 ? 0 : r >= 255 ? 255 : r | 0;
			dst[p + 1] = g <= 0 ? 0 : g >= 255 ? 255 : g | 0;
			dst[p + 2] = b <= 0 ? 0 : b >= 255 ? 255 : b | 0;
			if (channels === 4) dst[p + 3] = src[p + 3]!;
		}
	}
}

/**
 * The adjust stage over a whole image at once, from a planar float result.
 * For previews and tests; exports stream rows through RowAdjuster instead.
 */
export function adjustImage(original: Image8, denoised: Float32Array, params: AdjustParams, output?: Image8): Image8 {
	const out = output ?? {
		width: original.width,
		height: original.height,
		channels: original.channels,
		data: new Uint8Array(original.data.length),
	};
	const adjuster = new RowAdjuster(original, out, params);
	adjuster.push({
		y0: 0,
		y1: original.height,
		width: original.width,
		planes: denoised,
		planeStride: original.width * original.height,
	});
	adjuster.finish();
	return out;
}
