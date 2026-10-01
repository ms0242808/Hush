// SPDX-License-Identifier: Apache-2.0

/** Raw file or buffer contents. */
export type Bytes = Uint8Array;

export type Format = 'jpeg' | 'png' | 'webp' | 'heic' | 'avif';

export type ColourSpace = 'srgb' | 'display-p3' | 'adobe-rgb' | 'linear' | 'icc';

/**
 * A decoded image. `bitDepth` and `colourSpace` exist so the pipeline can grow
 * into 16-bit and float working spaces; this phase only produces 8-bit.
 */
export interface RawImage {
	width: number;
	height: number;
	channels: 3 | 4;
	bitDepth: 8 | 16 | 32;
	colourSpace: ColourSpace;
	icc?: Bytes;
	data: Uint8Array | Uint16Array | Float32Array;
}

/** The 8-bit interleaved case the pipeline works on this phase. */
export interface Image8 {
	width: number;
	height: number;
	channels: 3 | 4;
	data: Uint8Array;
}

/** The subset of AbortSignal the pipeline needs, so core doesn't depend on DOM or Node types. */
export interface CancelSignal {
	readonly aborted: boolean;
}

export class CancelledError extends Error {
	constructor() {
		super('Cancelled');
		this.name = 'CancelledError';
	}
}

/** A monotonic clock in milliseconds, injected so core never touches `performance`. */
export type Clock = () => number;

export type Backend = 'webgpu' | 'wasm';

/**
 * One loaded model, ready to run on single tiles. Implemented per platform
 * (ONNX Runtime Web in the browser; native runtimes later).
 */
export interface InferenceSession {
	readonly backend: Backend;
	/**
	 * Run the model on one tile. `input` is NCHW float32 RGB in [0, 1], shape
	 * [1, 3, height, width]; the result has the same shape. The caller may reuse
	 * `input` as soon as the returned promise settles.
	 */
	run(input: Float32Array, width: number, height: number): Promise<Float32Array>;
	dispose(): Promise<void>;
}
