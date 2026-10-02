// SPDX-License-Identifier: Apache-2.0
import type { OutputFormat } from './formats.ts';
import type { ModelVariant } from './manifest.ts';
import type { Zlib } from './metadata/photo.ts';
import type { Backend, Bytes, Clock, DecodedImage, Format, Image8, InferenceSession } from './types.ts';

/**
 * Everything the pipeline needs from the platform (§4.5). The browser
 * implements these with WASM codecs, ONNX Runtime Web, the Cache API and
 * same-origin fetches; the native apps will implement them natively. Core
 * never touches a platform API directly — a lint rule and Node-only tests
 * hold it to that.
 */
export interface PlatformAdapters {
	codecs: CodecAdapter;
	inference: InferenceAdapter;
	storage: ModelStorage;
	/** Reads the app's own static files (the model manifest and parts). Never sends anything. */
	assets: AssetSource;
	output: OutputAdapter;
	crypto: { sha256(bytes: Bytes): Promise<string> };
	zlib: Zlib;
	clock: { now: Clock };
}

export interface EncodeOptions {
	format: OutputFormat;
	/** 1–100, for JPEG and lossy WebP. */
	quality: number;
	/** WebP only: lossless (when the source was). */
	lossless?: boolean;
}

export interface CodecAdapter {
	/** Pixels exactly as stored: no colour conversion, 8-bit RGB(A). */
	decode(bytes: Bytes, format: Format): Promise<DecodedImage>;
	/** Pixels only: core adds the metadata. */
	encode(image: Image8, options: EncodeOptions): Promise<Bytes>;
}

export interface LoadedModel {
	variant: ModelVariant;
	bytes: Bytes;
	backend: Backend;
}

export interface InferenceAdapter {
	createSession(model: LoadedModel): Promise<InferenceSession>;
	/** Start loading the runtime for a backend, so it overlaps the model download. Optional. */
	warm?(backend: Backend): Promise<void>;
}

export interface ModelStorage {
	getModel(sha256: string): Promise<Bytes | null>;
	putModel(sha256: string, bytes: Bytes): Promise<void>;
}

export interface AssetSource {
	/** A JSON file, relative to the app root (e.g. "models/manifest.json"). */
	json(path: string): Promise<unknown>;
	/** A binary file, reporting bytes as they arrive. */
	bytes(path: string, onBytes?: (received: number) => void): Promise<Bytes>;
}

export interface SavedFile {
	name: string;
	/** Where it went, in words the interface can show ("Downloads", a folder name). */
	location: string;
}

export interface OutputAdapter {
	/** Resolves only once the platform confirms the write (§5.13: no silent failures). */
	save(name: string, bytes: Bytes, mimeType: string): Promise<SavedFile>;
}
