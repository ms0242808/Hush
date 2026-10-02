// SPDX-License-Identifier: Apache-2.0
import type { Backend } from '@hush/core';

/**
 * Tile ceiling per backend, from the Phase 0 measurements (docs/phase-0-results.md):
 * larger tiles waste less work on overlap (768 px ran 4% faster than 512 on an
 * M1 Pro; 1024 another 7%), but each tile is one long GPU job, and Windows
 * resets a GPU that stays busy for two seconds. 768 is the top of the spec's
 * range (§2.3). The device's buffer limits and out-of-memory backoff can only
 * lower it.
 */
export const DEFAULT_TILE_SIZE: Record<Backend, number> = {
	webgpu: 768,
	wasm: 512,
};

/** `?model=<id>` picks a model from the manifest for side-by-side testing (§4.3). */
export function modelOverride(): string | null {
	return new URLSearchParams(window.location.search).get('model');
}

/** On a metered connection the model downloads only after the user agrees (§5.6). */
export function isSaveData(): boolean {
	return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}
