// SPDX-License-Identifier: Apache-2.0
import type { OutputFormat } from './formats.ts';
import { planTiles } from './tiling.ts';

/**
 * How long an export will take on this machine (§2.10: "about 6 minutes per
 * photo on this computer", shown before Export is pressed, not after). The
 * model's cost is measured on the preview's own tiles — per pixel it is flat
 * across tile sizes, so preview tiles predict export tiles — and multiplied by
 * the pixels the export's tile plan will actually feed the model, overlap
 * included.
 */

export interface TileConventions {
	/** The export's tile ceiling. */
	size: number;
	overlap: number;
	padMultiple: number;
}

/** Pixels the model processes for a photo: tiles × tile area, overlap and reflection margins included. */
export function modelPixels(width: number, height: number, tile: TileConventions): number {
	const plan = planTiles(width, height, { tileSize: tile.size, overlap: tile.overlap, padMultiple: tile.padMultiple });
	return plan.tileCount * plan.x.size * plan.y.size;
}

/**
 * Typical encoder time per megapixel, in ms, on a laptop CPU (MozJPEG at
 * quality 95 measured 15 s for 45 MP on an M1 Pro). Only for the estimate.
 */
export const ENCODE_MS_PER_MEGAPIXEL: Record<OutputFormat, number> = { jpeg: 340, png: 450, webp: 900 };

export interface ExportEstimate {
	width: number;
	height: number;
	tile: TileConventions;
	/** Measured model time per input pixel, in ms. */
	msPerModelPixel: number;
	format: OutputFormat;
	/** Work before processing starts, e.g. decoding the photo again after an earlier export. */
	extraMs?: number;
}

export function estimateExportMs(input: ExportEstimate): number {
	const model = modelPixels(input.width, input.height, input.tile) * input.msPerModelPixel;
	const encode = ((input.width * input.height) / 1e6) * ENCODE_MS_PER_MEGAPIXEL[input.format];
	return model + encode + (input.extraMs ?? 0);
}

/**
 * Model milliseconds per pixel from timed tiles. The first tile on a new
 * session includes shader compilation and warm-up, so it is left out when
 * there are others; the median resists a tile that waited on something else.
 */
export function msPerPixel(samples: readonly { ms: number; pixels: number }[]): number | null {
	const usable = samples.length > 1 ? samples.slice(1) : samples;
	if (usable.length === 0) return null;
	const rates = usable.map((sample) => sample.ms / sample.pixels).sort((a, b) => a - b);
	const middle = Math.floor(rates.length / 2);
	return rates.length % 2 === 1 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2;
}

/** A photo of a batch, as far as the estimate cares. */
export interface BatchEstimatePhoto {
	width: number;
	height: number;
	format: OutputFormat;
}

/**
 * How long a batch will take on this machine (§5.12: "This batch would take
 * about 14 hours on this computer"), summed photo by photo, with `decodeMs`
 * per megapixel for reading each one in. Photos whose size isn't known yet
 * count as the average of the rest.
 */
export function estimateBatchMs(
	photos: readonly (BatchEstimatePhoto | null)[],
	tile: TileConventions,
	msPerModelPixel: number,
	decodeMsPerMegapixel = DECODE_MS_PER_MEGAPIXEL,
): number {
	const known = photos.filter((photo): photo is BatchEstimatePhoto => photo !== null);
	if (known.length === 0) return 0;
	const each = known.map(
		(photo) =>
			estimateExportMs({ ...photo, tile, msPerModelPixel }) +
			((photo.width * photo.height) / 1e6) * decodeMsPerMegapixel,
	);
	const sum = each.reduce((total, ms) => total + ms, 0);
	return sum + (photos.length - known.length) * (sum / known.length);
}

/** MozJPEG decoding, per megapixel (0.8 s for 45 MP on an M1 Pro). Only for the estimate. */
export const DECODE_MS_PER_MEGAPIXEL = 18;
