// SPDX-License-Identifier: Apache-2.0
import { displaySize, displayTransform } from './metadata/orientation.ts';
import type { Orientation } from './metadata/exif.ts';

/**
 * Geometry between the photo as it is displayed (upright, per its EXIF
 * orientation) and as it is stored. Hush never rotates pixels (§2.6), so the
 * viewer works in display coordinates and asks for stored ones.
 *
 * Coordinates are continuous: pixel (i, j) covers [i, i + 1) × [j, j + 1).
 */
export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface Rect extends Point, Size {}

/** The affine map `[a, b, c, d, e, f]`: x′ = a·x + c·y + e, y′ = b·x + d·y + f (the canvas convention). */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

/** Where a stored point is drawn: flip first, then turn clockwise in quarter turns. */
export function storedToDisplayPoint(point: Point, orientation: Orientation, stored: Size): Point {
	const { flip, rotate } = displayTransform(orientation);
	let x = flip ? stored.width - point.x : point.x;
	let y = point.y;
	let height = stored.height;
	let width = stored.width;
	for (let turn = 0; turn < rotate; turn += 90) {
		[x, y] = [height - y, x];
		[width, height] = [height, width];
	}
	return { x, y };
}

/** The stored point drawn at a display point: the inverse of `storedToDisplayPoint`. */
export function displayToStoredPoint(point: Point, orientation: Orientation, stored: Size): Point {
	const { flip, rotate } = displayTransform(orientation);
	const shown = displaySize(stored.width, stored.height, orientation);
	let x = point.x;
	let y = point.y;
	let width = shown.width;
	let height = shown.height;
	// Undo the clockwise turns one at a time: (x, y) in (w, h) came from (y, w − x) in (h, w).
	for (let turn = 0; turn < rotate; turn += 90) {
		[x, y] = [y, width - x];
		[width, height] = [height, width];
	}
	if (flip) x = width - x;
	return { x, y };
}

function mapRect(rect: Rect, map: (point: Point) => Point): Rect {
	const a = map({ x: rect.x, y: rect.y });
	const b = map({ x: rect.x + rect.width, y: rect.y + rect.height });
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function storedToDisplayRect(rect: Rect, orientation: Orientation, stored: Size): Rect {
	return mapRect(rect, (point) => storedToDisplayPoint(point, orientation, stored));
}

export function displayToStoredRect(rect: Rect, orientation: Orientation, stored: Size): Rect {
	return mapRect(rect, (point) => displayToStoredPoint(point, orientation, stored));
}

/** `displayToStoredPoint` as one affine map, for a shader. */
export function displayToStoredAffine(orientation: Orientation, stored: Size): Affine {
	const origin = displayToStoredPoint({ x: 0, y: 0 }, orientation, stored);
	const ex = displayToStoredPoint({ x: 1, y: 0 }, orientation, stored);
	const ey = displayToStoredPoint({ x: 0, y: 1 }, orientation, stored);
	return [ex.x - origin.x, ex.y - origin.y, ey.x - origin.x, ey.y - origin.y, origin.x, origin.y];
}

/** The part two rectangles share, or null when they don't overlap. */
export function intersectRects(a: Rect, b: Rect): Rect | null {
	const x0 = Math.max(a.x, b.x);
	const y0 = Math.max(a.y, b.y);
	const x1 = Math.min(a.x + a.width, b.x + b.width);
	const y1 = Math.min(a.y + a.height, b.y + b.height);
	return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Whether `outer` contains all of `inner`. */
export function containsRect(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}

/** Grow a rectangle to whole pixels: the smallest integer rectangle that covers it. */
export function pixelBounds(rect: Rect): Rect {
	const x = Math.floor(rect.x);
	const y = Math.floor(rect.y);
	return { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y };
}
