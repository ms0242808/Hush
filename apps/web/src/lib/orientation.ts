// SPDX-License-Identifier: Apache-2.0
import { displaySize, type Orientation } from '@hush/core';

export { displaySize };

export type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

/**
 * The canvas transform that draws a stored `width` × `height` image upright,
 * per its EXIF orientation, into a canvas of `displaySize(...)`. Pixels are
 * never rotated (§2.6); only the preview is.
 */
export function orientationMatrix(orientation: Orientation, width: number, height: number): Matrix {
	switch (orientation) {
		case 2:
			return [-1, 0, 0, 1, width, 0];
		case 3:
			return [-1, 0, 0, -1, width, height];
		case 4:
			return [1, 0, 0, -1, 0, height];
		case 5:
			return [0, 1, 1, 0, 0, 0];
		case 6:
			return [0, 1, -1, 0, height, 0];
		case 7:
			return [0, -1, -1, 0, height, width];
		case 8:
			return [0, -1, 1, 0, 0, width];
		default:
			return [1, 0, 0, 1, 0, 0];
	}
}

/**
 * The stored-pixel crop that fills a stage of `stage` device pixels once
 * drawn upright: orientations 5–8 swap the axes.
 */
export function storedCropSize(
	stage: { width: number; height: number },
	image: { width: number; height: number },
	orientation: Orientation,
): { width: number; height: number } {
	const sideways = orientation >= 5;
	return {
		width: Math.min(sideways ? stage.height : stage.width, image.width),
		height: Math.min(sideways ? stage.width : stage.height, image.height),
	};
}
