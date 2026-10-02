// SPDX-License-Identifier: Apache-2.0
import {
	blendRowsTo8Bit,
	planTiles,
	runTiled,
	type CancelSignal,
	type Clock,
	type Image8,
	type InferenceSession,
	type ModelEntry,
	type TiledProgress,
	type TiledStats,
} from '@hush/core';

export interface DenoiseParams {
	/** 0 keeps the original, 1 is the model's full output. */
	strength: number;
}

export const DEFAULT_DENOISE_PARAMS: DenoiseParams = { strength: 1 };

export interface DenoiseOptions {
	/** The manifest entry: tiling conventions come from here, never from code. */
	model: Pick<ModelEntry, 'tile'>;
	session: InferenceSession;
	/** Preferred tile side; rounded down to the model's pad multiple. */
	tileSize: number;
	params?: DenoiseParams;
	onProgress?: (progress: TiledProgress) => void;
	signal?: CancelSignal;
	now?: Clock;
}

export interface DenoiseResult {
	image: Image8;
	stats: TiledStats;
}

/**
 * Denoise one 8-bit image: tile it, run the model once per tile, blend the
 * tiles through a row band and write each finished row straight into the
 * 8-bit output. No full-size float buffer is ever allocated.
 */
export async function denoise(image: Image8, options: DenoiseOptions): Promise<DenoiseResult> {
	const { model, session, tileSize } = options;
	const { strength } = options.params ?? DEFAULT_DENOISE_PARAMS;
	const out: Image8 = {
		width: image.width,
		height: image.height,
		channels: image.channels,
		data: new Uint8Array(image.data.length),
	};
	const plan = planTiles(image.width, image.height, {
		tileSize,
		overlap: model.tile.overlap,
		padMultiple: model.tile.padMultiple,
	});

	const stats = await runTiled({
		image,
		plan,
		infer: (input, width, height) => session.run(input, width, height),
		onRows: (rows) => blendRowsTo8Bit(rows, image, out, strength),
		...(options.onProgress && { onProgress: options.onProgress }),
		...(options.signal && { signal: options.signal }),
		...(options.now && { now: options.now }),
	});
	return { image: out, stats };
}
