// SPDX-License-Identifier: Apache-2.0
import type { Image8 } from '@hush/core';

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The on-screen preview is always a crop or a downscale, never the full photo
 * (§2.2): ImageBitmaps this large are refused by browsers anyway.
 */
export const MAX_PREVIEW_SIDE = 4096;

/** Clamp a requested crop to the image and to the preview limit. */
export function clampRect(image: Image8, rect: Rect): Rect {
	const width = Math.max(1, Math.min(Math.round(rect.width), image.width, MAX_PREVIEW_SIDE));
	const height = Math.max(1, Math.min(Math.round(rect.height), image.height, MAX_PREVIEW_SIDE));
	const x = Math.max(0, Math.min(Math.round(rect.x), image.width - width));
	const y = Math.max(0, Math.min(Math.round(rect.y), image.height - height));
	return { x, y, width, height };
}

/** Copy a region out as a standalone RGBA image. */
export function cropImage(image: Image8, rect: Rect): Image8 {
	const { x, y, width, height } = clampRect(image, rect);
	const data = new Uint8Array(width * height * 4);
	for (let row = 0; row < height; row++) {
		const from = ((y + row) * image.width + x) * 4;
		data.set(image.data.subarray(from, from + width * 4), row * width * 4);
	}
	return { width, height, channels: 4, data };
}

/** Pixels for the on-screen preview, which is always a crop or a downscale (never full size). */
export function toBitmap(image: Image8): Promise<ImageBitmap> {
	const pixels = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength);
	return createImageBitmap(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), {
		colorSpaceConversion: 'none',
		premultiplyAlpha: 'none',
	});
}

/** PSNR between two same-sized RGBA images over RGB, in dB. */
export function psnr(a: Image8, b: Image8): { psnr: number; maxDiff: number } {
	let sum = 0;
	let maxDiff = 0;
	let count = 0;
	for (let i = 0; i < a.data.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			const d = a.data[i + c]! - b.data[i + c]!;
			sum += d * d;
			count++;
			if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d);
		}
	}
	const mse = sum / count;
	return { psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), maxDiff };
}
