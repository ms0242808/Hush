// SPDX-License-Identifier: Apache-2.0
import type { ControlSchema, Params } from './recipe.ts';
import type { TiledProgress, TiledStats } from './tiled.ts';
import type { CancelSignal, Clock, Image8 } from './types.ts';

/**
 * One kind of edit a recipe step can name (§4.5). Denoise is the only one
 * this phase; sharpen, upscale and the rest will implement the same shape.
 */
export interface ImageOperation {
	readonly id: string;
	/** Present for operations that run a model over tiles; absent for per-pixel ones. */
	readonly tiling?: { padMultiple: number; overlap: number; scale: 1 | 2 | 4 };
	readonly controls: readonly ControlSchema[];
	run(job: OperationRun): Promise<OperationResult>;
	dispose(): Promise<void>;
}

export interface OperationRun {
	input: Image8;
	/** Where results go: a new image, or `input` itself to process in place. */
	output: Image8;
	params: Params;
	signal?: CancelSignal;
	now?: Clock;
	onProgress?: (progress: TiledProgress) => void;
}

export interface OperationResult {
	/** Tiling statistics, for operations that tile. */
	stats: TiledStats | null;
	/** Float memory the operation held at its peak beyond the tiler's band and tiles (counted in `stats`). */
	floatBytes: number;
}
