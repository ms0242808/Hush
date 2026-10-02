// SPDX-License-Identifier: Apache-2.0
import {
	NEUTRAL_ADJUST,
	normaliseParams,
	planTiles,
	RowAdjuster,
	runTiled,
	type AdjustParams,
	type CancelSignal,
	type Clock,
	type ControlSchema,
	type Image8,
	type ImageOperation,
	type InferenceSession,
	type ModelEntry,
	type OperationCatalogue,
	type Params,
	type Recipe,
	type TiledProgress,
	type TiledStats,
} from '@hush/core';

/** The four sliders (§2.5). Defaults give the model's output unchanged. */
export const DENOISE_CONTROLS: readonly ControlSchema[] = [
	{ id: 'strength', min: 0, max: 1, step: 0.01, default: NEUTRAL_ADJUST.strength },
	{ id: 'luma', min: 0, max: 1, step: 0.01, default: NEUTRAL_ADJUST.luma },
	{ id: 'colour', min: 0, max: 1, step: 0.01, default: NEUTRAL_ADJUST.colour },
	{ id: 'detail', min: 0, max: 1, step: 0.01, default: NEUTRAL_ADJUST.detail },
];

/** Every operation this build can run, for validating recipes (§4.5). */
export const OPERATIONS: OperationCatalogue = { denoise: { controls: DENOISE_CONTROLS } };

/** A recipe with one denoise step at its defaults. */
export function defaultRecipe(modelId?: string): Recipe {
	return {
		schema: 1,
		ops: [{ op: 'denoise', ...(modelId && { model: modelId }), params: normaliseParams(DENOISE_CONTROLS) }],
	};
}

export function denoiseParams(params: Params): AdjustParams {
	return {
		strength: params['strength'] ?? NEUTRAL_ADJUST.strength,
		luma: params['luma'] ?? NEUTRAL_ADJUST.luma,
		colour: params['colour'] ?? NEUTRAL_ADJUST.colour,
		detail: params['detail'] ?? NEUTRAL_ADJUST.detail,
	};
}

export interface DenoiseOptions {
	/** The manifest entry: tiling conventions come from here, never from code. */
	model: Pick<ModelEntry, 'tile'>;
	session: InferenceSession;
	/** Preferred tile side; rounded down to the model's pad multiple. */
	tileSize: number;
	params?: Partial<AdjustParams>;
	/** Write here instead of a new image. May be the input itself: an export holds one copy of the photo. */
	output?: Image8;
	onProgress?: (progress: TiledProgress) => void;
	/** The run had to shrink its tiles after running out of memory. */
	onBackoff?: (tileSize: number) => void;
	signal?: CancelSignal;
	now?: Clock;
}

export interface DenoiseResult {
	image: Image8;
	stats: TiledStats;
	/** The adjust stage's float rows, on top of the tiler's band and tiles. */
	adjustFloatBytes: number;
}

/**
 * Denoise one 8-bit image: tile it, run the model once per tile, blend the
 * tiles through a row band, adjust each finished row (§2.5) and write it
 * straight into the 8-bit output. No full-size float buffer is ever allocated.
 */
export async function denoise(image: Image8, options: DenoiseOptions): Promise<DenoiseResult> {
	const { model, session, tileSize } = options;
	const out: Image8 = options.output ?? {
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
	const adjuster = new RowAdjuster(image, out, { ...NEUTRAL_ADJUST, ...options.params });

	const stats = await runTiled({
		image,
		plan,
		infer: (input, width, height) => session.run(input, width, height),
		onRows: (rows) => adjuster.push(rows),
		...(session.recover && { recover: () => session.recover!() }),
		...(options.onBackoff && { onBackoff: options.onBackoff }),
		...(options.onProgress && { onProgress: options.onProgress }),
		...(options.signal && { signal: options.signal }),
		...(options.now && { now: options.now }),
	});
	adjuster.finish();
	return { image: out, stats, adjustFloatBytes: adjuster.floatBytes };
}

export interface DenoiseOperationOptions {
	model: ModelEntry;
	session: InferenceSession;
	/** The tile ceiling, read at every run so a backoff earlier in the session carries over. */
	tileSize: () => number;
	onBackoff?: (tileSize: number) => void;
}

/** The denoise step of a recipe, bound to a loaded model. */
export function createDenoiseOperation(options: DenoiseOperationOptions): ImageOperation {
	const { model, session } = options;
	return {
		id: 'denoise',
		tiling: { padMultiple: model.tile.padMultiple, overlap: model.tile.overlap, scale: 1 },
		controls: DENOISE_CONTROLS,
		async run(job) {
			const result = await denoise(job.input, {
				model,
				session,
				tileSize: options.tileSize(),
				params: denoiseParams(job.params),
				output: job.output,
				...(options.onBackoff && { onBackoff: options.onBackoff }),
				...(job.onProgress && { onProgress: job.onProgress }),
				...(job.signal && { signal: job.signal }),
				...(job.now && { now: job.now }),
			});
			return { stats: result.stats, floatBytes: result.adjustFloatBytes };
		},
		dispose: () => session.dispose(),
	};
}
