// SPDX-License-Identifier: Apache-2.0

/**
 * What Hush can't do without (§5.10: every state has a designed screen,
 * "unsupported browser" included): WebAssembly with SIMD for the codecs and
 * the runtime, module workers, and a secure context — Web Crypto verifies the
 * model, and cross-origin isolation needs it.
 */
export type Support = { ok: true } | { ok: false; reason: 'insecure' | 'old-browser' };

/** The smallest module using a SIMD instruction (v128.const; i8x16.popcnt), as wasm-feature-detect checks it. */
const SIMD_PROBE = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function checkSupport(): Support {
	if (globalThis.isSecureContext === false) return { ok: false, reason: 'insecure' };
	try {
		const wasm = typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
		const workers = typeof Worker === 'function';
		const bitmaps = typeof createImageBitmap === 'function';
		return wasm && workers && bitmaps ? { ok: true } : { ok: false, reason: 'old-browser' };
	} catch {
		return { ok: false, reason: 'old-browser' };
	}
}
