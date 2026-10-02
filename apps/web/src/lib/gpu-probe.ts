// SPDX-License-Identifier: Apache-2.0
import type { WebGpuFact } from '@hush/core';

export interface AdapterSummary {
	vendor: string;
	architecture: string;
	device: string;
	description: string;
	isFallbackAdapter: boolean;
}

export interface GpuProbe {
	webgpu: WebGpuFact;
	adapter: AdapterSummary | null;
	shaderF16: boolean;
	limits: {
		maxBufferSize: number;
		maxStorageBufferBindingSize: number;
		maxComputeWorkgroupStorageSize: number;
		maxComputeInvocationsPerWorkgroup: number;
	} | null;
	hardwareConcurrency: number;
	crossOriginIsolated: boolean;
	/** Chrome and Edge only, and capped at 8. */
	deviceMemory: number | null;
}

/**
 * What WebGPU offers in this context (window or worker). Asks for the
 * high-performance adapter, so a laptop with two GPUs reports the discrete one.
 */
export async function probeGpu(): Promise<GpuProbe> {
	const nav = navigator as Navigator & { gpu?: GPU; deviceMemory?: number };
	const base = {
		hardwareConcurrency: nav.hardwareConcurrency || 1,
		crossOriginIsolated: globalThis.crossOriginIsolated === true,
		deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
	};
	if (!nav.gpu) return { webgpu: 'unavailable', adapter: null, shaderF16: false, limits: null, ...base };

	const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
	if (!adapter) return { webgpu: 'no-adapter', adapter: null, shaderF16: false, limits: null, ...base };

	const info = adapter.info;
	const legacy = adapter as GPUAdapter & { isFallbackAdapter?: boolean };
	const isFallbackAdapter = info.isFallbackAdapter ?? legacy.isFallbackAdapter ?? false;
	return {
		webgpu: isFallbackAdapter ? 'fallback-adapter' : 'adapter',
		adapter: {
			vendor: info.vendor,
			architecture: info.architecture,
			device: info.device,
			description: info.description,
			isFallbackAdapter,
		},
		shaderF16: adapter.features.has('shader-f16'),
		limits: {
			maxBufferSize: adapter.limits.maxBufferSize,
			maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
			maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
			maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
		},
		...base,
	};
}
