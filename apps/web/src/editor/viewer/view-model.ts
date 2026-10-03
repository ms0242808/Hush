// SPDX-License-Identifier: Apache-2.0
import {
	displaySize,
	displayToStoredAffine,
	displayToStoredPoint,
	displayToStoredRect,
	intersectRects,
	pixelBounds,
	type Affine,
	type Orientation,
	type Point,
	type Rect,
	type Size,
} from '@hush/core';

/**
 * The viewer's geometry, kept free of the DOM so it can be tested.
 *
 * Three spaces: device pixels of the viewer (top-left origin), the photo as
 * displayed (upright, in photo pixels) and the photo as stored. At 100%, one
 * photo pixel is one device pixel (§5.3), so the photo's origin on screen is
 * always a whole device pixel and nothing is ever resampled.
 */
export type Zoom = 'fit' | 1 | 2;

export interface Photo {
	stored: Size;
	orientation: Orientation;
}

export interface View {
	zoom: Zoom;
	/** The display point at the centre of the viewer, in photo pixels. */
	centre: Point;
}

export function displayed(photo: Photo): Size {
	return displaySize(photo.stored.width, photo.stored.height, photo.orientation);
}

/** Device pixels per photo pixel. Fit never enlarges a photo past 100%. */
export function scaleOf(zoom: Zoom, viewport: Size, photo: Photo): number {
	if (zoom !== 'fit') return zoom;
	const shown = displayed(photo);
	return Math.min(1, viewport.width / shown.width, viewport.height / shown.height);
}

/** Keep the photo covering the viewer when it's larger; centre it when it's smaller. */
export function clampCentre(centre: Point, scale: number, viewport: Size, photo: Photo): Point {
	const shown = displayed(photo);
	const clampAxis = (value: number, view: number, length: number) => {
		const half = view / (2 * scale);
		return half * 2 >= length ? length / 2 : Math.min(length - half, Math.max(half, value));
	};
	return { x: clampAxis(centre.x, viewport.width, shown.width), y: clampAxis(centre.y, viewport.height, shown.height) };
}

/**
 * Where display point (0, 0) lands, in device pixels. Whole pixels at 100% and
 * above, so photo pixels sit exactly on device pixels.
 */
export function originOf(view: View, viewport: Size, photo: Photo): Point {
	const scale = scaleOf(view.zoom, viewport, photo);
	const centre = clampCentre(view.centre, scale, viewport, photo);
	const x = viewport.width / 2 - centre.x * scale;
	const y = viewport.height / 2 - centre.y * scale;
	return scale >= 1 ? { x: Math.round(x), y: Math.round(y) } : { x, y };
}

/** Device pixel → display photo point. */
export function deviceToDisplay(point: Point, view: View, viewport: Size, photo: Photo): Point {
	const scale = scaleOf(view.zoom, viewport, photo);
	const origin = originOf(view, viewport, photo);
	return { x: (point.x - origin.x) / scale, y: (point.y - origin.y) / scale };
}

/** Device pixels → stored photo pixels, as one affine map: what the shader samples with. */
export function deviceToStored(view: View, viewport: Size, photo: Photo): Affine {
	const scale = scaleOf(view.zoom, viewport, photo);
	const origin = originOf(view, viewport, photo);
	const [a, b, c, d, e, f] = displayToStoredAffine(photo.orientation, photo.stored);
	return [
		a / scale,
		b / scale,
		c / scale,
		d / scale,
		e - (a * origin.x + c * origin.y) / scale,
		f - (b * origin.x + d * origin.y) / scale,
	];
}

export function applyAffine([a, b, c, d, e, f]: Affine, point: Point): Point {
	return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

export function invertAffine([a, b, c, d, e, f]: Affine): Affine {
	const det = a * d - b * c;
	if (det === 0) throw new RangeError('The view transform is not invertible');
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** The part of the photo the viewer shows, in display coordinates. */
export function visibleDisplayRect(view: View, viewport: Size, photo: Photo): Rect | null {
	const topLeft = deviceToDisplay({ x: 0, y: 0 }, view, viewport, photo);
	const bottomRight = deviceToDisplay({ x: viewport.width, y: viewport.height }, view, viewport, photo);
	const shown = displayed(photo);
	return intersectRects(
		{ x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y },
		{ x: 0, y: 0, width: shown.width, height: shown.height },
	);
}

/** The visible part in stored pixels, whole pixels. */
export function visibleStoredRect(view: View, viewport: Size, photo: Photo): Rect | null {
	const shown = visibleDisplayRect(view, viewport, photo);
	return shown ? pixelBounds(displayToStoredRect(shown, photo.orientation, photo.stored)) : null;
}

/**
 * The side of the comparison that shows the result: right of the divider
 * (`divider` is the device x). In stored pixels; null when the divider is
 * at the right edge or past the photo.
 */
export function afterStoredRect(view: View, viewport: Size, photo: Photo, divider: number): Rect | null {
	const shown = visibleDisplayRect(view, viewport, photo);
	if (!shown) return null;
	const start = deviceToDisplay({ x: divider, y: 0 }, view, viewport, photo).x;
	const after = intersectRects(shown, {
		x: start,
		y: shown.y,
		width: shown.x + shown.width - start,
		height: shown.height,
	});
	return after ? pixelBounds(displayToStoredRect(after, photo.orientation, photo.stored)) : null;
}

/** The divider's middle, in stored pixels: where the preview grows from. */
export function focusPoint(view: View, viewport: Size, photo: Photo, divider: number): Point {
	const shown = displayed(photo);
	const point = deviceToDisplay({ x: divider, y: viewport.height / 2 }, view, viewport, photo);
	const clamped = {
		x: Math.min(shown.width, Math.max(0, point.x)),
		y: Math.min(shown.height, Math.max(0, point.y)),
	};
	return displayToStoredPoint(clamped, photo.orientation, photo.stored);
}

/** Largest region side the viewer keeps on the GPU (and the worker crops: MAX_PREVIEW_SIDE). */
export const MAX_REGION_SIDE = 4096;

/**
 * The region of original pixels to load around what's visible: a margin on
 * every side so short pans don't wait for the worker, within MAX_REGION_SIDE.
 */
export function regionAround(visible: Rect, photo: Photo, margin = 0.35, maxSide = MAX_REGION_SIDE): Rect {
	const { stored } = photo;
	const limit = Math.min(maxSide, MAX_REGION_SIDE);
	const axis = (start: number, length: number, total: number) => {
		const want = Math.min(total, limit, Math.ceil(length * (1 + 2 * margin)));
		const size = Math.max(Math.min(length, limit), want);
		const centre = start + length / 2;
		const from = Math.round(Math.min(total - size, Math.max(0, centre - size / 2)));
		return [from, Math.min(size, total)] as const;
	};
	const [x, width] = axis(visible.x, visible.width, stored.width);
	const [y, height] = axis(visible.y, visible.height, stored.height);
	return { x, y, width, height };
}

/** Zoom to `zoom`, keeping the photo point under `anchor` (device pixels) where it is. */
export function zoomAt(view: View, zoom: Zoom, anchor: Point, viewport: Size, photo: Photo): View {
	const target = deviceToDisplay(anchor, view, viewport, photo);
	const scale = scaleOf(zoom, viewport, photo);
	const centre = {
		x: target.x - (anchor.x - viewport.width / 2) / scale,
		y: target.y - (anchor.y - viewport.height / 2) / scale,
	};
	return { zoom, centre: clampCentre(centre, scale, viewport, photo) };
}

/** Move the photo by a drag of (dx, dy) device pixels. */
export function panBy(view: View, dx: number, dy: number, viewport: Size, photo: Photo): View {
	const scale = scaleOf(view.zoom, viewport, photo);
	const current = clampCentre(view.centre, scale, viewport, photo);
	return {
		zoom: view.zoom,
		centre: clampCentre({ x: current.x - dx / scale, y: current.y - dy / scale }, scale, viewport, photo),
	};
}

/** A stored point as the display point the viewer centres on. */
export function storedToDisplay(point: Point, photo: Photo): Point {
	return applyAffine(invertAffine(displayToStoredAffine(photo.orientation, photo.stored)), point);
}
