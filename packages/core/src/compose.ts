// SPDX-License-Identifier: Apache-2.0
import type { FinalRows } from './band.ts';
import type { Image8 } from './types.ts';

/**
 * Write finished rows into the 8-bit output, blended with the original:
 * `out = original + strength × (denoised − original)`. Alpha is copied from
 * the original. This is where the per-row adjust stage (luminance, colour,
 * detail) plugs in next phase; it only ever needs the matching original rows.
 */
export function blendRowsTo8Bit(rows: FinalRows, original: Image8, out: Image8, strength: number): void {
	const { y0, y1, width, planes, planeStride } = rows;
	const channels = original.channels;
	const src = original.data;
	const dst = out.data;
	const s = Math.min(1, Math.max(0, strength));

	for (let y = y0; y < y1; y++) {
		const bandRow = (y - y0) * width;
		const pixelRow = y * width * channels;
		for (let x = 0; x < width; x++) {
			const p = pixelRow + x * channels;
			for (let c = 0; c < 3; c++) {
				const before = src[p + c]!;
				const after = planes[c * planeStride + bandRow + x]! * 255;
				const q = before + s * (after - before) + 0.5;
				dst[p + c] = q <= 0 ? 0 : q >= 255 ? 255 : q | 0;
			}
			if (channels === 4) dst[p + 3] = src[p + 3]!;
		}
	}
}
