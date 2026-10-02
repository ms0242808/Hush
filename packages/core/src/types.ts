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
	 * `input` as soon as the returned promise settles. Failures the tiler can
	 * act on are raised as InferenceError (out of memory, device lost, invalid
	 * output).
	 */
	run(input: Float32Array, width: number, height: number): Promise<Float32Array>;
	/**
	 * After a lost device: build a new device and session in place, so the
	 * next `run` works again (§2.3). Absent where devices can't be lost.
	 */
	recover?(): Promise<void>;
	/** The largest single buffer the device allows (GPUs), for sizing tiles; absent when unlimited. */
	readonly maxBufferBytes?: number | null;
	dispose(): Promise<void>;
}

/** How a codec handed back the pixels of a photo whose container says to rotate or mirror it. */
export type DecodedOrientation = 'as-stored' | 'applied';

export interface DecodedImage {
	/** 8-bit this phase. */
	image: RawImage;
	/**
	 * 'applied' when the codec already turned the pixels upright (libheif
	 * applies HEIF rotation and mirroring); 'as-stored' otherwise. Hush itself
	 * never rotates pixels (§2.6), but must not keep a rotation tag on pixels
	 * that were already rotated.
	 */
	orientation: DecodedOrientation;
}
