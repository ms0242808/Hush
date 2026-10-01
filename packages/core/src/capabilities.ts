// SPDX-License-Identifier: Apache-2.0
import type { Backend } from './types.ts';

/**
 * Which of the §2.10 situations this browser is in. Detection gathers facts
 * per platform; deciding what they mean lives here so it can be tested
 * without a browser.
 *
 *   webgpu               a hardware WebGPU adapter: the fast path
 *   browser-unsupported  no WebGPU, but WebGL sees a real GPU: another browser would be faster
 *   acceleration-off     no WebGPU and a software WebGL renderer: hardware acceleration is off or blocklisted
 *   no-gpu               no GPU acceleration at all: virtual machines, remote desktops
 *   fallback-adapter     WebGPU offers only a CPU-emulated adapter: never used, slower than WASM
 */
export type GpuSituation = 'webgpu' | 'browser-unsupported' | 'acceleration-off' | 'no-gpu' | 'fallback-adapter';

/** The message the interface shows for a situation (§5.12). */
export type GpuNotice = 'none' | 'use-another-browser' | 'update-browser' | 'turn-on-acceleration' | 'processor-only';

export type WebGpuFact = 'unavailable' | 'no-adapter' | 'fallback-adapter' | 'adapter';

export interface GpuFacts {
	/** `navigator.gpu` missing → unavailable; `requestAdapter()` null → no-adapter. */
	webgpu: WebGpuFact;
	/** WebGL's unmasked renderer string, or the plain one; null when WebGL can't start. */
	webglRenderer: string | null;
	webglVendor?: string | null;
	/** The browser is Chrome or Edge, where the fix is an update rather than a switch. */
	chromium?: boolean;
}

export type RendererHint = 'hardware' | 'software' | 'virtual' | 'none';

export interface GpuAssessment {
	situation: GpuSituation;
	notice: GpuNotice;
	/** Where inference runs automatically. Never a fallback WebGPU adapter. */
	backend: Backend;
	rendererHint: RendererHint;
}

const SOFTWARE_RENDERER =
	/swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render driver|software rasterizer|software renderer|gdi generic/i;
const VIRTUAL_GPU =
	/vmware|virtualbox|vbox|parallels|qemu|virgl|virtio|hyper-v|microsoft remote display|citrix|red hat|bochs|\butm\b/i;

/**
 * The WebGL renderer string is only a hint: browsers may mask it for privacy
 * ("Apple GPU", "Mozilla"). A masked string counts as hardware, so it only ever
 * changes which message is shown, never whether the GPU is used.
 */
export function rendererHint(renderer: string | null, vendor?: string | null): RendererHint {
	if (renderer === null) return 'none';
	const text = `${renderer} ${vendor ?? ''}`;
	if (VIRTUAL_GPU.test(text)) return 'virtual';
	if (SOFTWARE_RENDERER.test(text)) return 'software';
	return 'hardware';
}

export function assessGpu(facts: GpuFacts): GpuAssessment {
	const hint = rendererHint(facts.webglRenderer, facts.webglVendor);
	if (facts.webgpu === 'adapter') {
		return { situation: 'webgpu', notice: 'none', backend: 'webgpu', rendererHint: hint };
	}

	const noticeFromRenderer = (): GpuNotice => {
		switch (hint) {
			case 'hardware':
				return facts.chromium ? 'update-browser' : 'use-another-browser';
			case 'software':
				return 'turn-on-acceleration';
			case 'virtual':
			case 'none':
				return 'processor-only';
		}
	};

	if (facts.webgpu === 'fallback-adapter') {
		return { situation: 'fallback-adapter', notice: noticeFromRenderer(), backend: 'wasm', rendererHint: hint };
	}

	const situation: GpuSituation =
		hint === 'hardware' ? 'browser-unsupported' : hint === 'software' ? 'acceleration-off' : 'no-gpu';
	return { situation, notice: noticeFromRenderer(), backend: 'wasm', rendererHint: hint };
}
