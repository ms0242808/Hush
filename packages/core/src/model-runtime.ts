// SPDX-License-Identifier: Apache-2.0
import type { PlatformAdapters } from './adapters.ts';
import {
	bytesPerPixel,
	pickModel,
	pickVariant,
	type ModelEntry,
	type ModelManifest,
	type ModelVariant,
	type Precision,
} from './manifest.ts';
import { loadModel } from './model-loader.ts';
import { chooseTileSize } from './tiling.ts';
import type { Backend, InferenceSession } from './types.ts';

/** What to run: a task, on a backend, with what the device can do (§2.4, §4.3). */
export interface ModelRequest {
	task: string;
	/** The `?model=<id>` override, when it names a model for this task. */
	modelId?: string | null;
	backend: Backend;
	/** The WebGPU adapter exposes `shader-f16`. */
	shaderF16: boolean;
	/** Force a precision (benchmarks, bug reproduction). */
	precision?: Precision;
}

/** The manifest entry and the file a request resolves to. */
export function chooseVariant(
	manifest: ModelManifest,
	request: ModelRequest,
): { model: ModelEntry; variant: ModelVariant } {
	const model = pickModel(manifest, request.task, request.modelId);
	const variant = pickVariant(model, {
		backend: request.backend,
		shaderF16: request.shaderF16,
		...(request.precision && { precision: request.precision }),
	});
	return { model, variant };
}

export interface PreparedModel {
	model: ModelEntry;
	variant: ModelVariant;
	session: InferenceSession;
	fromCache: boolean;
	/** Reading the model from storage, or downloading and verifying it — alongside the runtime warming up. */
	loadMs: number;
	sessionMs: number;
}

/**
 * Resolve a request to a model file, load it (storage first, verified; else
 * downloaded in parts and verified, §4.3) while the platform warms its
 * runtime, and create a session through the platform's inference adapter.
 */
export async function prepareModel(
	manifest: ModelManifest,
	request: ModelRequest,
	adapters: Pick<PlatformAdapters, 'assets' | 'storage' | 'crypto' | 'inference' | 'clock'>,
	onProgress?: (received: number, total: number) => void,
): Promise<PreparedModel> {
	const { model, variant } = chooseVariant(manifest, request);
	const now = adapters.clock.now;
	const start = now();
	const [file] = await Promise.all([
		loadModel(variant, {
			assets: adapters.assets,
			storage: adapters.storage,
			sha256: (bytes) => adapters.crypto.sha256(bytes),
			...(onProgress && { onProgress }),
		}),
		adapters.inference.warm?.(request.backend),
	]);
	const loadMs = now() - start;
	const sessionStart = now();
	const session = await adapters.inference.createSession({ variant, bytes: file.bytes, backend: request.backend });
	return { model, variant, session, fromCache: file.fromCache, loadMs, sessionMs: now() - sessionStart };
}

/**
 * The tile ceiling for a prepared model (§2.3): the backend's preferred size,
 * capped so the model's largest tensor fits the device's buffers, and never
 * above a size that ran out of memory earlier in the session.
 */
export function tileCeiling(
	prepared: Pick<PreparedModel, 'model' | 'variant' | 'session'>,
	preferred: number,
	remembered: number | null = null,
): number {
	const maxBufferBytes = prepared.session.maxBufferBytes;
	return chooseTileSize({
		preferred,
		padMultiple: prepared.model.tile.padMultiple,
		overlap: prepared.model.tile.overlap,
		bytesPerPixel: bytesPerPixel(prepared.model, prepared.variant),
		...(maxBufferBytes && { maxBufferBytes }),
		remembered,
	});
}
