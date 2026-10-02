// SPDX-License-Identifier: Apache-2.0

/**
 * Tile layout for one image.
 *
 * The image is virtually extended by `margin` pixels of reflection on every
 * side, so real border pixels never sit at a tile edge, where a convolutional
 * model's own zero padding degrades its output. Tiles then cover the extended
 * image with at least `overlap` pixels shared between neighbours; the last tile
 * on each axis is pulled back to end exactly at the extended edge.
 */
export interface TileOptions {
	/** Preferred tile side in pixels. Rounded down to a multiple of `padMultiple`. */
	tileSize: number;
	/** Minimum overlap between neighbouring tiles, in pixels. Also the feather ramp length. */
	overlap: number;
	/** Every tile side must be a multiple of this (the model's downsampling factor). */
	padMultiple: number;
	/** Reflection margin around the image. Defaults to `overlap`. */
	margin?: number;
}

export interface TileAxis {
	/** Tile length along this axis: a multiple of `padMultiple`. */
	size: number;
	/** Tile start positions in image coordinates. Negative means reflection padding. */
	starts: number[];
}

export interface TilePlan {
	width: number;
	height: number;
	overlap: number;
	padMultiple: number;
	x: TileAxis;
	y: TileAxis;
	tileCount: number;
}

export function roundUpTo(value: number, multiple: number): number {
	return Math.ceil(value / multiple) * multiple;
}

/**
 * `tileSize` is a ceiling, not a target. The axis gets the fewest tiles that
 * cover it, and those tiles shrink to share the length evenly. Fixed-size
 * tiles with a clamped last tile make the model process 1.4–1.5× the photo's
 * pixels; even sharing brings that to about 1.15× at the same overlap.
 */
export function planAxis(length: number, options: TileOptions): TileAxis {
	const { overlap, padMultiple } = options;
	const margin = options.margin ?? overlap;
	if (!Number.isInteger(length) || length < 1)
		throw new RangeError(`Image side must be a positive integer, got ${length}`);
	if (!Number.isInteger(padMultiple) || padMultiple < 1)
		throw new RangeError(`padMultiple must be ≥ 1, got ${padMultiple}`);
	if (!Number.isInteger(overlap) || overlap < 0) throw new RangeError(`overlap must be ≥ 0, got ${overlap}`);
	if (!Number.isInteger(margin) || margin < 0) throw new RangeError(`margin must be ≥ 0, got ${margin}`);

	const maxTile = Math.floor(options.tileSize / padMultiple) * padMultiple;
	if (maxTile <= overlap) {
		throw new RangeError(`Tile size ${maxTile} must be larger than the overlap ${overlap}`);
	}

	const start = -margin;
	const extended = length + 2 * margin;
	if (extended <= maxTile) {
		// One tile is enough; shrink it to the smallest legal size.
		return { size: roundUpTo(extended, padMultiple), starts: [start] };
	}

	// n tiles of size s cover the axis with overlap ≥ o when n·s − (n−1)·o ≥ extended.
	const sizeFor = (n: number) => roundUpTo(Math.ceil((extended + (n - 1) * overlap) / n), padMultiple);
	let count = Math.ceil((extended - overlap) / (maxTile - overlap));
	let size = sizeFor(count);
	while (size > maxTile) size = sizeFor(++count); // rounding up to padMultiple can push past the ceiling
	const span = extended - size;
	const starts: number[] = [];
	for (let i = 0; i < count; i++) starts.push(start + Math.floor((i * span) / (count - 1)));
	return { size, starts };
}

export function planTiles(width: number, height: number, options: TileOptions): TilePlan {
	const x = planAxis(width, options);
	const y = planAxis(height, options);
	return {
		width,
		height,
		overlap: options.overlap,
		padMultiple: options.padMultiple,
		x,
		y,
		tileCount: x.starts.length * y.starts.length,
	};
}

/**
 * The smallest tile worth running: below this, overlap dominates and
 * out-of-memory backoff gives up rather than crawl.
 */
export function minTileSize(overlap: number, padMultiple: number): number {
	return roundUpTo(Math.max(128, 2 * overlap + padMultiple), padMultiple);
}

export interface TileSizeInput {
	/** The backend's preferred ceiling (from measurements). */
	preferred: number;
	padMultiple: number;
	overlap: number;
	/** Bytes the model needs per input pixel for its largest intermediate tensor. */
	bytesPerPixel?: number;
	/** The largest single GPU buffer (and binding) the device allows. */
	maxBufferBytes?: number;
	/** A smaller ceiling learned earlier in the session, after running out of memory. */
	remembered?: number | null;
}

/**
 * The tile ceiling for this device (§2.3): the preferred size, capped so the
 * model's largest tensor fits the device's buffer limits, and never above a
 * size that already ran out of memory this session. The first tile is the
 * probe: if it still fails, the tiler halves from there.
 */
export function chooseTileSize(input: TileSizeInput): number {
	const { padMultiple, overlap } = input;
	let size = input.preferred;
	if (input.remembered) size = Math.min(size, input.remembered);
	if (input.bytesPerPixel && input.maxBufferBytes) {
		size = Math.min(size, Math.floor(Math.sqrt((input.maxBufferBytes * 0.9) / input.bytesPerPixel)));
	}
	size = Math.floor(size / padMultiple) * padMultiple;
	return Math.max(size, minTileSize(overlap, padMultiple));
}

/**
 * Mirror an out-of-range index back into [0, length) without repeating the edge
 * pixel (…, 2, 1, 0, 1, 2, …), the same rule as numpy's 'reflect' mode.
 */
export function reflectIndex(index: number, length: number): number {
	if (length === 1) return 0;
	const period = 2 * (length - 1);
	let i = index % period;
	if (i < 0) i += period;
	return i < length ? i : period - i;
}
