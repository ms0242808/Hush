// SPDX-License-Identifier: Apache-2.0
import type { Format } from './types.ts';

/**
 * Errors the pipeline raises on purpose. Each has a stable `name` (and, where
 * it needs one, a `code`), so the interface can say what happened and what to
 * do in the user's language, even after the error has crossed a worker
 * boundary as a plain object.
 */

/** Why a photo in a supported container still can't be processed. */
export type UnsupportedReason = 'unknown-format' | 'cmyk' | 'hdr' | 'animated' | 'no-image';

export class UnsupportedPhotoError extends Error {
	readonly code: UnsupportedReason;
	constructor(code: UnsupportedReason, detail?: string) {
		super(detail ? `${code}: ${detail}` : code);
		this.name = 'UnsupportedPhotoError';
		this.code = code;
	}
}

/** The bytes are a known format but the codec couldn't read them: a damaged or truncated file. */
export class DecodeError extends Error {
	readonly format: Format;
	constructor(format: Format, cause?: unknown) {
		super(cause instanceof Error ? cause.message : `Couldn't decode the ${format} file`);
		this.name = 'DecodeError';
		this.format = format;
	}
}

/** Over the §2.9 limit for this device: refused before decoding, never a crashed tab. */
export class PhotoTooLargeError extends Error {
	readonly megapixels: number;
	readonly limit: number;
	constructor(megapixels: number, limit: number) {
		super(`${megapixels.toFixed(1)} MP is over this device's ${limit} MP limit`);
		this.name = 'PhotoTooLargeError';
		this.megapixels = megapixels;
		this.limit = limit;
	}
}

/** What went wrong inside an inference session, as adapters report it. */
export type InferenceFailure = 'out-of-memory' | 'device-lost' | 'invalid-output';

/**
 * Raised by an InferenceSession. The tiler reacts to each kind: out of memory
 * → smaller tiles; device lost → a new device and session; invalid output →
 * stop, never export it.
 */
export class InferenceError extends Error {
	readonly kind: InferenceFailure;
	constructor(kind: InferenceFailure, message: string) {
		super(message);
		this.name = 'InferenceError';
		this.kind = kind;
	}
}

export function inferenceFailure(error: unknown): InferenceFailure | null {
	return error instanceof Error && error.name === 'InferenceError' ? (error as InferenceError).kind : null;
}

/** The GPU kept failing after the pipeline recreated it. */
export class DeviceLostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeviceLostError';
	}
}

/** Even the smallest tile didn't fit in memory. */
export class OutOfMemoryError extends Error {
	readonly tileSize: number;
	constructor(tileSize: number) {
		super(`Out of memory even with ${tileSize}-px tiles`);
		this.name = 'OutOfMemoryError';
		this.tileSize = tileSize;
	}
}

/** The model returned NaN or infinity: never exported (an fp16 overflow turns a photo black). */
export class ModelOutputError extends Error {
	constructor(message = 'The model returned invalid values (NaN or infinity)') {
		super(message);
		this.name = 'ModelOutputError';
	}
}

/** Saving failed. The encoded file rides along, so the caller can retry without reprocessing (§5.13). */
export class SaveError extends Error {
	readonly fileName: string;
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	constructor(fileName: string, bytes: Uint8Array, mimeType: string, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'SaveError';
		this.fileName = fileName;
		this.bytes = bytes;
		this.mimeType = mimeType;
	}
}
