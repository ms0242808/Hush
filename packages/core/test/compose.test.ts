// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { blendRowsTo8Bit, type Image8 } from '../src/index.ts';

describe('blendRowsTo8Bit', () => {
	const original: Image8 = {
		width: 2,
		height: 1,
		channels: 4,
		data: Uint8Array.from([10, 20, 30, 77, 240, 250, 0, 9]),
	};
	// Planar RGB for 2 pixels: R plane, G plane, B plane.
	const planes = Float32Array.from([1.2, 0.5, 0.5, 1, -0.3, 0]);

	it('writes the model output at strength 1, clamped to 0–255, keeping alpha', () => {
		const out: Image8 = { ...original, data: new Uint8Array(8) };
		blendRowsTo8Bit({ y0: 0, y1: 1, width: 2, planes, planeStride: 2 }, original, out, 1);
		expect(Array.from(out.data)).toEqual([255, 128, 0, 77, 128, 255, 0, 9]);
	});

	it('mixes original and output in between', () => {
		const out: Image8 = { ...original, data: new Uint8Array(8) };
		blendRowsTo8Bit({ y0: 0, y1: 1, width: 2, planes, planeStride: 2 }, original, out, 0.5);
		// R: 10 + 0.5 × (306 − 10) = 158; G: 20 + 0.5 × (127.5 − 20) = 73.75 → 74
		expect(out.data[0]).toBe(158);
		expect(out.data[1]).toBe(74);
		expect(out.data[3]).toBe(77);
	});
});
