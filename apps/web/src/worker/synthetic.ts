// SPDX-License-Identifier: Apache-2.0
import type { Image8 } from '@hush/core';

/** Benchmark sizes. Throughput is content-independent, so synthetic photos measure speed honestly. */
export const SYNTHETIC_SIZES = {
	'1mp': { width: 1024, height: 1024 },
	'24mp': { width: 6000, height: 4000 },
	'45mp': { width: 8256, height: 5504 },
} as const;

export type SyntheticSize = keyof typeof SYNTHETIC_SIZES;

/**
 * A deterministic "photo": smooth colour gradients, hard-edged shapes and fine
 * stripes for detail, plus high-ISO-like luminance and colour noise. Separable
 * gradients keep a 45 MP image to well under a second to generate.
 */
export function syntheticPhoto(width: number, height: number, seed = 1): Image8 {
	const data = new Uint8Array(width * height * 4);
	const colX = new Float32Array(width * 3);
	const rowY = new Float32Array(height * 3);
	for (let x = 0; x < width; x++) {
		const u = x / width;
		colX[x * 3] = 0.45 + 0.3 * Math.sin(u * 5.1);
		colX[x * 3 + 1] = 0.35 + 0.2 * Math.cos(u * 3.3);
		colX[x * 3 + 2] = 0.3 + 0.25 * Math.sin(u * 2.2 + 1);
	}
	for (let y = 0; y < height; y++) {
		const v = y / height;
		rowY[y * 3] = 0.15 * Math.cos(v * 4.2);
		rowY[y * 3 + 1] = 0.2 * Math.sin(v * 3.1 + 0.5);
		rowY[y * 3 + 2] = 0.15 * Math.cos(v * 2.4 + 2);
	}

	let state = seed >>> 0 || 1;
	const random = () => {
		// xorshift32: fast and good enough for noise
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4294967296;
	};
	// Sum of two uniforms: a cheap, bounded bell curve with σ ≈ 0.41 × amplitude.
	const noise = (amplitude: number) => (random() + random() - 1) * amplitude;

	const stripeTop = Math.floor(height * 0.62);
	const stripeBottom = Math.floor(height * 0.78);
	const boxLeft = Math.floor(width * 0.18);
	const boxRight = Math.floor(width * 0.42);
	const boxTop = Math.floor(height * 0.2);
	const boxBottom = Math.floor(height * 0.5);

	for (let y = 0; y < height; y++) {
		const inStripes = y >= stripeTop && y < stripeBottom;
		const inBoxRows = y >= boxTop && y < boxBottom;
		for (let x = 0; x < width; x++) {
			let r = colX[x * 3]! + rowY[y * 3]!;
			let g = colX[x * 3 + 1]! + rowY[y * 3 + 1]!;
			let b = colX[x * 3 + 2]! + rowY[y * 3 + 2]!;
			if (inBoxRows && x >= boxLeft && x < boxRight) {
				r = 0.82;
				g = 0.78;
				b = 0.7;
			}
			if (inStripes && x % 6 < 3) {
				r *= 0.55;
				g *= 0.55;
				b *= 0.55;
			}
			const luma = noise(0.11);
			const p = (y * width + x) * 4;
			data[p] = clamp255((r + luma + noise(0.05)) * 255);
			data[p + 1] = clamp255((g + luma + noise(0.05)) * 255);
			data[p + 2] = clamp255((b + luma + noise(0.05)) * 255);
			data[p + 3] = 255;
		}
	}
	return { width, height, channels: 4, data };
}

function clamp255(value: number): number {
	return value <= 0 ? 0 : value >= 255 ? 255 : (value + 0.5) | 0;
}
