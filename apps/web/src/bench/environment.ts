// SPDX-License-Identifier: Apache-2.0
import type { ModelManifest } from '@hush/core';
import assets from 'virtual:ort-assets';
import { detectCapabilities } from '@/lib/capabilities';
import { startPipeline } from '@/lib/pipeline';
import type { BenchEnvironment } from './report';

export interface LoadedEnvironment {
	environment: BenchEnvironment;
	manifest: ModelManifest | null;
}

let pending: Promise<LoadedEnvironment> | null = null;

/** What the main thread and a worker each see, detected once per page. */
export function loadEnvironment(): Promise<LoadedEnvironment> {
	pending ??= detect();
	return pending;
}

async function detect(): Promise<LoadedEnvironment> {
	const main = await detectCapabilities({ alwaysReadWebGl: true });
	const probe = startPipeline();
	try {
		const [worker, manifest] = await Promise.all([probe.api.probe(), probe.api.manifest().catch(() => null)]);
		const brands = (
			navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string; version: string }> } }
		).userAgentData?.brands
			?.filter((b) => !/Not.A.Brand/i.test(b.brand))
			.map((b) => `${b.brand} ${b.version}`)
			.join(', ');
		return {
			manifest,
			environment: {
				at: new Date().toISOString(),
				version: __HUSH_VERSION__,
				userAgent: navigator.userAgent,
				brands: brands ?? '',
				main,
				worker,
				ort: {
					version: assets.version,
					webgpuWasmBytes: assets.builds.webgpu.wasmBytes,
					wasmWasmBytes: assets.builds.wasm.wasmBytes,
				},
			},
		};
	} finally {
		probe.terminate();
	}
}
