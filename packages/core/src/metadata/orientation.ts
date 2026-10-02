// SPDX-License-Identifier: Apache-2.0
import type { Orientation } from './exif.ts';

/**
 * How to turn stored pixels into the upright photo: flip horizontally first
 * (when `flip`), then rotate clockwise. Every EXIF orientation is one of these
 * eight. Hush never rotates pixels (§2.6); this is only for drawing previews.
 */
export interface DisplayTransform {
	flip: boolean;
	rotate: 0 | 90 | 180 | 270;
}

const TRANSFORMS: Record<Orientation, DisplayTransform> = {
	1: { flip: false, rotate: 0 },
	2: { flip: true, rotate: 0 },
	3: { flip: false, rotate: 180 },
	4: { flip: true, rotate: 180 },
	5: { flip: true, rotate: 270 },
	6: { flip: false, rotate: 90 },
	7: { flip: true, rotate: 90 },
	8: { flip: false, rotate: 270 },
};

export function displayTransform(orientation: Orientation): DisplayTransform {
	return TRANSFORMS[orientation];
}

export function orientationOf(transform: DisplayTransform): Orientation {
	for (const [key, value] of Object.entries(TRANSFORMS)) {
		if (value.flip === transform.flip && value.rotate === transform.rotate) return Number(key) as Orientation;
	}
	return 1;
}

/** Width and height as the photo is displayed: orientations 5–8 turn it on its side. */
export function displaySize(
	width: number,
	height: number,
	orientation: Orientation,
): { width: number; height: number } {
	return orientation >= 5 ? { width: height, height: width } : { width, height };
}

/**
 * The EXIF orientation equivalent to a HEIF/AVIF item's transforms (ISO/IEC
 * 23008-12): `irot` rotates anticlockwise by `angle` quarter turns, then `imir`
 * mirrors — mode 0 exchanges top and bottom, mode 1 left and right (as in
 * libavif: EXIF 4 ↔ mode 0, EXIF 2 ↔ mode 1).
 */
export function orientationFromHeif(angle: number, mirror: 0 | 1 | null): Orientation {
	const quarter = ((angle % 4) + 4) % 4;
	let rotate: number;
	if (mirror === null) rotate = 360 - 90 * quarter;
	else if (mirror === 1) rotate = 90 * quarter;
	else rotate = 90 * quarter + 180;
	return orientationOf({ flip: mirror !== null, rotate: (rotate % 360) as DisplayTransform['rotate'] });
}
