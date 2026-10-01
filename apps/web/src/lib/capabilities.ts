// SPDX-License-Identifier: Apache-2.0
import { assessGpu, type GpuAssessment, type GpuFacts } from '@hush/core';
import { probeGpu, type GpuProbe } from './gpu-probe.ts';
import { isChromium } from './utils.ts';

export interface Capabilities {
	probe: GpuProbe;
	facts: GpuFacts;
	assessment: GpuAssessment;
}

/** WebGL's renderer string: only a hint for which message to show, never a gate. */
export function readWebGlRenderer(): { renderer: string | null; vendor: string | null } {
	try {
		const canvas = document.createElement('canvas');
		const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
		if (!gl) return { renderer: null, vendor: null };
		const info = gl.getExtension('WEBGL_debug_renderer_info');
		const renderer: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
		const vendor: unknown = gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
		gl.getExtension('WEBGL_lose_context')?.loseContext();
		return {
			renderer: typeof renderer === 'string' ? renderer : null,
			vendor: typeof vendor === 'string' ? vendor : null,
		};
	} catch {
		return { renderer: null, vendor: null };
	}
}

/**
 * Which §2.10 situation this browser is in. WebGL is only consulted when it
 * can change the message (no usable WebGPU) or when asked for diagnostics, so
 * a normal first load never spins up a WebGL context.
 */
export async function detectCapabilities(options: { alwaysReadWebGl?: boolean } = {}): Promise<Capabilities> {
	const probe = await probeGpu();
	const needWebGl = options.alwaysReadWebGl === true || probe.webgpu !== 'adapter';
	const { renderer, vendor } = needWebGl ? readWebGlRenderer() : { renderer: null, vendor: null };
	const facts: GpuFacts = {
		webgpu: probe.webgpu,
		webglRenderer: renderer,
		webglVendor: vendor,
		chromium: isChromium(),
	};
	return { probe, facts, assessment: assessGpu(facts) };
}
