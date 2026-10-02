// SPDX-License-Identifier: Apache-2.0
import type { Backend } from '@hush/core';

/**
 * Tile side per backend, from the Phase 0 measurements (docs/phase-0-results.md):
 * larger tiles waste less work on overlap, until the GPU stops getting faster.
 */
export const DEFAULT_TILE_SIZE: Record<Backend, number> = {
	webgpu: 512,
	wasm: 512,
};

/** JPEG quality for exports (§2.6). */
export const JPEG_QUALITY = 95;

/** `?model=<id>` picks a model from the manifest for side-by-side testing (§4.3). */
export function modelOverride(): string | null {
	return new URLSearchParams(window.location.search).get('model');
}

/** On a metered connection the model downloads only after the user agrees (§5.6). */
export function isSaveData(): boolean {
	return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}
