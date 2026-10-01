// SPDX-License-Identifier: Apache-2.0
import { BandAccumulator, type FinalRows } from './band.ts';
import { normalisedAxisWeights } from './feather.ts';
import { reflectIndex, type TilePlan } from './tiling.ts';
import { CancelledError, type CancelSignal, type Clock, type Image8 } from './types.ts';

export interface TiledProgress {
	tilesDone: number;
	tileCount: number;
	/** Rows of the image that are final. */
	rowsDone: number;
	/** Bands (tile rows) finished, out of `bandCount`. */
	bandsDone: number;
	bandCount: number;
}

export interface TiledStats {
	tileCount: number;
	tileWidth: number;
	tileHeight: number;
	/** The band's float buffer. */
	bandFloatBytes: number;
	/** Two input tiles (double-buffered) plus one output tile. */
	tileFloatBytes: number;
	/** Peak float memory the pipeline itself holds: band plus tiles. Independent of image height. */
	peakFloatBytes: number;
	/** From the first `infer` call to its result: includes shader compilation and warm-up. */
	firstTileMs: number;
	/** Time spent waiting for inference. */
	waitMs: number;
	/** Time spent preparing tiles, accumulating and finishing rows on this thread. */
	cpuMs: number;
	totalMs: number;
}

export interface TiledRunOptions {
	image: Image8;
	plan: TilePlan;
	/** Runs the model on one NCHW tile. May reject; the run then rejects with the same error. */
	infer: (input: Float32Array, width: number, height: number) => Promise<Float32Array>;
	/** Receives every row exactly once, top to bottom, as soon as it is final. */
	onRows: (rows: FinalRows) => void;
	onProgress?: (progress: TiledProgress) => void;
	signal?: CancelSignal;
	now?: Clock;
}

/**
 * Copy one tile out of an 8-bit interleaved image into NCHW float32 in [0, 1],
 * mirroring at the image edges.
 */
export function extractTile(
	image: Image8,
	x0: number,
	y0: number,
	tileWidth: number,
	tileHeight: number,
	out: Float32Array,
): void {
	const { width, height, channels, data } = image;
	const plane = tileWidth * tileHeight;
	const columns = new Int32Array(tileWidth);
	for (let i = 0; i < tileWidth; i++) columns[i] = reflectIndex(x0 + i, width) * channels;

	const scale = 1 / 255;
	for (let j = 0; j < tileHeight; j++) {
		const rowBase = reflectIndex(y0 + j, height) * width * channels;
		const o = j * tileWidth;
		for (let i = 0; i < tileWidth; i++) {
			const s = rowBase + columns[i]!;
			out[o + i] = data[s]! * scale;
			out[plane + o + i] = data[s + 1]! * scale;
			out[2 * plane + o + i] = data[s + 2]! * scale;
		}
	}
}

/**
 * Run a model over an image tile by tile, in row-major order, blending
 * overlapping tiles with a cosine feather and releasing rows through a
 * row band. The next tile is prepared while the current one is inferring.
 */
export async function runTiled(options: TiledRunOptions): Promise<TiledStats> {
	const { image, plan, infer, onRows, onProgress, signal } = options;
	const now = options.now ?? (() => 0);
	const startedAt = now();
	const tileWidth = plan.x.size;
	const tileHeight = plan.y.size;
	const columnsPerRow = plan.x.starts.length;
	const bandCount = plan.y.starts.length;

	const wx = normalisedAxisWeights(plan.x, image.width, plan.overlap);
	const wy = normalisedAxisWeights(plan.y, image.height, plan.overlap);
	const band = new BandAccumulator(image.width, image.height, tileHeight);
	const inputs = [new Float32Array(3 * tileWidth * tileHeight), new Float32Array(3 * tileWidth * tileHeight)];

	const tileAt = (k: number) => {
		const xi = k % columnsPerRow;
		const yi = Math.floor(k / columnsPerRow);
		return { xi, yi, x0: plan.x.starts[xi]!, y0: plan.y.starts[yi]! };
	};

	let cpuMs = 0;
	let waitMs = 0;
	let firstTileMs = 0;
	let rowsDone = 0;
	let bandsDone = 0;
	const release = (upTo: number) => {
		band.release(upTo, (rows) => {
			onRows(rows);
			rowsDone = rows.y1;
		});
	};

	const prepare = (k: number) => {
		const t0 = now();
		const tile = tileAt(k);
		extractTile(image, tile.x0, tile.y0, tileWidth, tileHeight, inputs[k % 2]!);
		cpuMs += now() - t0;
	};

	prepare(0);
	let pending: Promise<Float32Array> = infer(inputs[0]!, tileWidth, tileHeight);
	try {
		for (let k = 0; k < plan.tileCount; k++) {
			if (signal?.aborted) throw new CancelledError();
			const hasNext = k + 1 < plan.tileCount;
			if (hasNext) prepare(k + 1);

			const waitStart = now();
			const output = await pending;
			const waited = now() - waitStart;
			waitMs += waited;
			if (k === 0) firstTileMs = now() - startedAt;
			if (output.length !== 3 * tileWidth * tileHeight) {
				throw new RangeError(`Model returned ${output.length} values for a ${tileWidth}×${tileHeight} tile`);
			}

			if (hasNext) pending = infer(inputs[(k + 1) % 2]!, tileWidth, tileHeight);

			const t0 = now();
			const tile = tileAt(k);
			band.add(output, tileWidth, tileHeight, tile.x0, tile.y0, wx[tile.xi]!, wy[tile.yi]!);
			if (tile.xi === columnsPerRow - 1) {
				const nextStart = tile.yi + 1 < bandCount ? Math.max(0, plan.y.starts[tile.yi + 1]!) : image.height;
				release(nextStart);
				bandsDone++;
			}
			cpuMs += now() - t0;

			onProgress?.({ tilesDone: k + 1, tileCount: plan.tileCount, rowsDone, bandsDone, bandCount });
		}
	} catch (error) {
		pending.catch(() => {}); // a tile still in flight must not surface as an unhandled rejection
		throw error;
	}

	const bandFloatBytes = band.floatBytes;
	const tileFloatBytes = 3 * (3 * tileWidth * tileHeight * 4);
	return {
		tileCount: plan.tileCount,
		tileWidth,
		tileHeight,
		bandFloatBytes,
		tileFloatBytes,
		peakFloatBytes: bandFloatBytes + tileFloatBytes,
		firstTileMs,
		waitMs,
		cpuMs,
		totalMs: now() - startedAt,
	};
}
