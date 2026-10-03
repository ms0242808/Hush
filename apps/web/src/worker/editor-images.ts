// SPDX-License-Identifier: Apache-2.0
import { iccDescription, type Image8, type PhotoInfo } from '@hush/core';

/** The fit-to-screen view never needs more than this many pixels along its longer side. */
export const OVERVIEW_MAX_SIDE = 3072;

/**
 * The whole photo, downscaled by a whole-number box filter for the
 * fit-to-screen view (§2.2: the on-screen preview is always a crop or a
 * downscale). Stored orientation, RGBA. Box averaging reads every pixel once
 * and never rings; at fit size, noise is invisible anyway.
 */
export function overviewOf(image: Image8, maxSide = OVERVIEW_MAX_SIDE): Image8 {
	const factor = Math.max(1, Math.ceil(Math.max(image.width, image.height) / maxSide));
	const width = Math.max(1, Math.floor(image.width / factor));
	const height = Math.max(1, Math.floor(image.height / factor));
	const out = new Uint8Array(width * height * 4);
	const { channels, data } = image;
	if (factor === 1) {
		for (let p = 0, o = 0; o < out.length; p += channels, o += 4) {
			out[o] = data[p]!;
			out[o + 1] = data[p + 1]!;
			out[o + 2] = data[p + 2]!;
			out[o + 3] = 255;
		}
		return { width, height, channels: 4, data: out };
	}
	const sums = new Uint32Array(width * 3);
	const area = factor * factor;
	for (let oy = 0; oy < height; oy++) {
		sums.fill(0);
		for (let dy = 0; dy < factor; dy++) {
			const row = (oy * factor + dy) * image.width * channels;
			for (let ox = 0; ox < width; ox++) {
				let p = row + ox * factor * channels;
				let r = 0;
				let g = 0;
				let b = 0;
				for (let dx = 0; dx < factor; dx++, p += channels) {
					r += data[p]!;
					g += data[p + 1]!;
					b += data[p + 2]!;
				}
				sums[ox * 3]! += r;
				sums[ox * 3 + 1]! += g;
				sums[ox * 3 + 2]! += b;
			}
		}
		for (let ox = 0; ox < width; ox++) {
			const o = (oy * width + ox) * 4;
			out[o] = Math.round(sums[ox * 3]! / area);
			out[o + 1] = Math.round(sums[ox * 3 + 1]! / area);
			out[o + 2] = Math.round(sums[ox * 3 + 2]! / area);
			out[o + 3] = 255;
		}
	}
	return { width, height, channels: 4, data: out };
}

/**
 * The colour space to draw the preview in. Pixels are decoded without colour
 * conversion (§2.6), so a Display P3 photo must be drawn into a P3 canvas or
 * it looks dull; other profiles are drawn as sRGB.
 */
export function previewColourSpace(info: PhotoInfo): 'srgb' | 'display-p3' {
	if (info.colour === 'nclx-p3') return 'display-p3';
	if (info.colour === 'icc' && info.icc) {
		const name = iccDescription(info.icc) ?? '';
		if (/display p3|\bp3\b/i.test(name)) return 'display-p3';
	}
	return 'srgb';
}

/** The ICC profile's own name, for diagnostics and the export panel. */
export function profileName(info: PhotoInfo): string | null {
	return info.icc ? iccDescription(info.icc) : null;
}
