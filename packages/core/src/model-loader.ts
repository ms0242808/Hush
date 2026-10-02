// SPDX-License-Identifier: Apache-2.0
import type { AssetSource, ModelStorage } from './adapters.ts';
import { parseManifest, type ModelManifest, type ModelVariant } from './manifest.ts';
import { assembleVariant } from './model-parts.ts';
import type { Bytes } from './types.ts';

/** Where the manifest lives, relative to the app root (§4.3). */
export const MANIFEST_PATH = 'models/manifest.json';

export async function loadManifest(assets: AssetSource): Promise<ModelManifest> {
	return parseManifest(await assets.json(MANIFEST_PATH));
}

/** Manifest-relative part path → app-root-relative path ("parts/x.000" → "models/parts/x.000"). */
export function modelPartPath(part: string): string {
	const segments = MANIFEST_PATH.split('/').slice(0, -1);
	for (const segment of part.split('/')) {
		if (segment === '..') segments.pop();
		else if (segment !== '.' && segment !== '') segments.push(segment);
	}
	return segments.join('/');
}

export interface ModelLoadOptions {
	assets: AssetSource;
	storage: ModelStorage;
	sha256: (bytes: Bytes) => Promise<string>;
	/** Bytes received so far, out of the variant's total. */
	onProgress?: (received: number, total: number) => void;
}

export interface ModelLoadResult {
	bytes: Bytes;
	fromCache: boolean;
}

/**
 * The model file for a variant: from storage when it is there and still
 * hashes right (storage can be truncated or tampered with), otherwise
 * downloaded part by part, verified against the manifest and stored.
 */
export async function loadModel(variant: ModelVariant, options: ModelLoadOptions): Promise<ModelLoadResult> {
	const { assets, storage, sha256, onProgress } = options;
	const cached = await storage.getModel(variant.sha256).catch(() => null);
	if (cached && cached.byteLength === variant.bytes && (await sha256(cached)) === variant.sha256) {
		onProgress?.(variant.bytes, variant.bytes);
		return { bytes: cached, fromCache: true };
	}
	const bytes = await assembleVariant({
		variant,
		fetchPart: (part, onBytes) => assets.bytes(modelPartPath(part), onBytes),
		sha256,
		...(onProgress && { onProgress }),
	});
	try {
		await storage.putModel(variant.sha256, bytes);
	} catch {
		// Out of quota or storage blocked: the model still works for this visit.
	}
	return { bytes, fromCache: false };
}
