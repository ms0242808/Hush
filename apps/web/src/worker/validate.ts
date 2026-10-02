// SPDX-License-Identifier: Apache-2.0

/**
 * A sparse check that model output is finite. fp16 overflow on a GPU turns
 * whole tensors to NaN, which would otherwise export as a black photo.
 */
export function isFinitePrefix(values: Float32Array): boolean {
	for (let i = 0; i < values.length; i += 997) if (!Number.isFinite(values[i])) return false;
	return values.length === 0 || Number.isFinite(values[values.length - 1]);
}
