// SPDX-License-Identifier: Apache-2.0
import { BandAccumulator, type FinalRows } from './band.ts';
import { DeviceLostError, inferenceFailure, OutOfMemoryError } from './errors.ts';
import { normalisedAxisWeights } from './feather.ts';
import { minTileSize, planTiles, reflectIndex, type TilePlan } from './tiling.ts';
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
	/** Two input tiles (double-buffered) plus one output tile, and any subdivision buffers. */
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
	/** Times the run ran out of memory and halved its tile size. */
	backoffs: number;
	/** Times the run recreated a lost device. */
	recoveries: number;
	/** The largest tile actually sent to the model by the end of the run. */
	finalTileSize: number;
}

export type TileInfer = (input: Float32Array, width: number, height: number) => Promise<Float32Array>;

export interface TiledRunOptions {
	image: Image8;
	plan: TilePlan;
	/** Runs the model on one NCHW tile. May reject; the run then rejects with the same error. */
	infer: TileInfer;
	/** Receives every row exactly once, top to bottom, as soon as it is final. */
	onRows: (rows: FinalRows) => void;
	onProgress?: (progress: TiledProgress) => void;
	signal?: CancelSignal;
	now?: Clock;
	/**
	 * Recreate the inference session after its GPU device was lost (§2.3). The
	 * tile that failed is retried; finished tiles and the band are kept, so the
	 * photo is never restarted.
	 */
	recover?: (error: unknown) => Promise<void>;
	/** Called when the run had to shrink its tiles, so the session can start there next time. */
	onBackoff?: (tileSize: number) => void;
}

/** Device losses survived per photo before giving up. */
export const MAX_RECOVERIES = 3;

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

/** Copy a region of an NCHW float image (mirrored at its edges) into another NCHW buffer. */
function extractFloatTile(
	source: Float32Array,
	width: number,
	height: number,
	x0: number,
	y0: number,
	tileWidth: number,
	tileHeight: number,
	out: Float32Array,
): void {
	const sourcePlane = width * height;
	const plane = tileWidth * tileHeight;
	for (let j = 0; j < tileHeight; j++) {
		const sy = reflectIndex(y0 + j, height) * width;
		for (let i = 0; i < tileWidth; i++) {
			const s = sy + reflectIndex(x0 + i, width);
			const o = j * tileWidth + i;
			out[o] = source[s]!;
			out[plane + o] = source[sourcePlane + s]!;
			out[2 * plane + o] = source[2 * sourcePlane + s]!;
		}
	}
}

/**
 * Run the model on a tile too big for the current memory budget by splitting
 * it into feathered sub-tiles: the tile's output is the same blend the whole
 * photo uses, so the global plan (and the band) never changes mid-photo.
 */
async function inferSubdivided(
	input: Float32Array,
	width: number,
	height: number,
	ceiling: number,
	plan: TilePlan,
	infer: TileInfer,
	onBuffer: (bytes: number) => void,
): Promise<Float32Array> {
	const sub = planTiles(width, height, { tileSize: ceiling, overlap: plan.overlap, padMultiple: plan.padMultiple });
	const wx = normalisedAxisWeights(sub.x, width, plan.overlap);
	const wy = normalisedAxisWeights(sub.y, height, plan.overlap);
	const out = new Float32Array(3 * width * height);
	const tile = new Float32Array(3 * sub.x.size * sub.y.size);
	onBuffer(out.byteLength + 2 * tile.byteLength);
	const plane = width * height;
	const tilePlane = sub.x.size * sub.y.size;
	for (let yi = 0; yi < sub.y.starts.length; yi++) {
		for (let xi = 0; xi < sub.x.starts.length; xi++) {
			const x0 = sub.x.starts[xi]!;
			const y0 = sub.y.starts[yi]!;
			extractFloatTile(input, width, height, x0, y0, sub.x.size, sub.y.size, tile);
			const result = await infer(tile, sub.x.size, sub.y.size);
			if (result.length !== tile.length) {
				throw new RangeError(`Model returned ${result.length} values for a ${sub.x.size}×${sub.y.size} tile`);
			}
			const rowWeights = wy[yi]!;
			const columnWeights = wx[xi]!;
			for (let j = Math.max(0, -y0); j < sub.y.size && y0 + j < height; j++) {
				const w = rowWeights[j]!;
				if (w === 0) continue;
				for (let i = Math.max(0, -x0); i < sub.x.size && x0 + i < width; i++) {
					const weight = w * columnWeights[i]!;
					const t = j * sub.x.size + i;
					const o = (y0 + j) * width + x0 + i;
					out[o]! += result[t]! * weight;
					out[plane + o]! += result[tilePlane + t]! * weight;
					out[2 * plane + o]! += result[2 * tilePlane + t]! * weight;
				}
			}
		}
	}
	return out;
}

/**
 * Run a model over an image tile by tile, in row-major order, blending
 * overlapping tiles with a cosine feather and releasing rows through a
 * row band. The next tile is prepared while the current one is inferring.
 *
 * Failures are handled per tile, as §2.3 asks: out of GPU memory → the tile
 * is split into half-size tiles and the smaller size is kept for the rest of
 * the photo (and reported, for the session); device lost → `recover` builds a
 * new session and the same tile runs again. A second loss also halves the
 * tile size, since overlong GPU work is a common cause (Windows resets a GPU
 * that stays busy for two seconds).
 */
export async function runTiled(options: TiledRunOptions): Promise<TiledStats> {
	const { image, plan, infer, onRows, onProgress, signal, recover, onBackoff } = options;
	const now = options.now ?? (() => 0);
	const startedAt = now();
	const tileWidth = plan.x.size;
	const tileHeight = plan.y.size;
	const columnsPerRow = plan.x.starts.length;
	const bandCount = plan.y.starts.length;
	const smallest = minTileSize(plan.overlap, plan.padMultiple);

	const wx = normalisedAxisWeights(plan.x, image.width, plan.overlap);
	const wy = normalisedAxisWeights(plan.y, image.height, plan.overlap);
	const band = new BandAccumulator(image.width, image.height, tileHeight);
	const inputs = [new Float32Array(3 * tileWidth * tileHeight), new Float32Array(3 * tileWidth * tileHeight)];

	let ceiling = Math.max(tileWidth, tileHeight);
	let backoffs = 0;
	let recoveries = 0;
	let subdivisionBytes = 0;

	const tileAt = (k: number) => {
		const xi = k % columnsPerRow;
		const yi = Math.floor(k / columnsPerRow);
		return { xi, yi, x0: plan.x.starts[xi]!, y0: plan.y.starts[yi]! };
	};

	/** Halve the tile ceiling. False when it is already as small as tiles go. */
	const shrink = (): boolean => {
		const next = Math.floor(ceiling / 2 / plan.padMultiple) * plan.padMultiple;
		if (next < smallest) return false;
		ceiling = next;
		backoffs++;
		onBackoff?.(ceiling);
		return true;
	};

	/** One tile through the model, surviving out-of-memory and device loss. */
	const attempt = async (input: Float32Array): Promise<Float32Array> => {
		let lostThisTile = 0;
		for (;;) {
			try {
				if (tileWidth <= ceiling && tileHeight <= ceiling) return await infer(input, tileWidth, tileHeight);
				return await inferSubdivided(input, tileWidth, tileHeight, ceiling, plan, infer, (bytes) => {
					subdivisionBytes = Math.max(subdivisionBytes, bytes);
				});
			} catch (error) {
				const failure = inferenceFailure(error);
				if (failure === 'out-of-memory') {
					if (!shrink()) throw new OutOfMemoryError(ceiling);
					continue;
				}
				if (failure === 'device-lost') {
					if (!recover || recoveries >= MAX_RECOVERIES) {
						throw new DeviceLostError(error instanceof Error ? error.message : 'The GPU device was lost');
					}
					recoveries++;
					lostThisTile++;
					if (signal?.aborted) throw new CancelledError();
					await recover(error);
					if (lostThisTile > 1) shrink();
					continue;
				}
				throw error;
			}
		}
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
	let pending: Promise<Float32Array> = attempt(inputs[0]!);
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
			if (signal?.aborted) throw new CancelledError();

			if (hasNext) pending = attempt(inputs[(k + 1) % 2]!);

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
	const tileFloatBytes = 3 * (3 * tileWidth * tileHeight * 4) + subdivisionBytes;
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
		backoffs,
		recoveries,
		finalTileSize: Math.min(ceiling, Math.max(tileWidth, tileHeight)),
	};
}
