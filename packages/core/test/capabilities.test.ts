// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { assessGpu, rendererHint } from '../src/index.ts';

// Renderer strings as browsers report them.
const APPLE_M1 = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)';
const INTEL_IRIS = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const BASIC_RENDER = 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)';
const LLVMPIPE = 'llvmpipe (LLVM 15.0.7, 256 bits)';
const VMWARE = 'ANGLE (VMware, Inc., SVGA3D; build: RELEASE; LLVM;, D3D11)';
const RDP = 'ANGLE (Microsoft, Microsoft Remote Display Adapter Direct3D11 vs_5_0 ps_5_0, D3D11)';

describe('rendererHint', () => {
	it.each([
		[APPLE_M1, 'hardware'],
		[INTEL_IRIS, 'hardware'],
		['Apple GPU', 'hardware'], // Safari masks the real name
		['Mozilla', 'hardware'], // Firefox with fingerprinting resistance
		[SWIFTSHADER, 'software'],
		[BASIC_RENDER, 'software'],
		[LLVMPIPE, 'software'],
		[VMWARE, 'virtual'],
		[RDP, 'virtual'],
		[null, 'none'],
	] as const)('%s → %s', (renderer, hint) => {
		expect(rendererHint(renderer)).toBe(hint);
	});
});

describe('assessGpu (§2.10)', () => {
	it('uses a hardware WebGPU adapter and says nothing', () => {
		expect(assessGpu({ webgpu: 'adapter', webglRenderer: APPLE_M1 })).toEqual({
			situation: 'webgpu',
			notice: 'none',
			backend: 'webgpu',
			rendererHint: 'hardware',
		});
	});

	it('suggests another browser when WebGPU is missing but the GPU is real', () => {
		const result = assessGpu({ webgpu: 'unavailable', webglRenderer: INTEL_IRIS });
		expect(result).toMatchObject({ situation: 'browser-unsupported', notice: 'use-another-browser', backend: 'wasm' });
	});

	it('suggests an update instead when already in Chrome or Edge', () => {
		const result = assessGpu({ webgpu: 'no-adapter', webglRenderer: INTEL_IRIS, chromium: true });
		expect(result).toMatchObject({ situation: 'browser-unsupported', notice: 'update-browser' });
	});

	it('asks to turn hardware acceleration on for a software renderer', () => {
		for (const renderer of [SWIFTSHADER, BASIC_RENDER, LLVMPIPE]) {
			expect(assessGpu({ webgpu: 'unavailable', webglRenderer: renderer })).toMatchObject({
				situation: 'acceleration-off',
				notice: 'turn-on-acceleration',
				backend: 'wasm',
			});
		}
	});

	it('never uses a fallback (CPU-emulated) WebGPU adapter', () => {
		const result = assessGpu({ webgpu: 'fallback-adapter', webglRenderer: SWIFTSHADER });
		expect(result).toMatchObject({ situation: 'fallback-adapter', backend: 'wasm', notice: 'turn-on-acceleration' });
	});

	it('says processor-only on virtual machines and remote desktops', () => {
		for (const renderer of [VMWARE, RDP, null]) {
			expect(assessGpu({ webgpu: 'unavailable', webglRenderer: renderer })).toMatchObject({
				situation: 'no-gpu',
				notice: 'processor-only',
				backend: 'wasm',
			});
		}
	});

	it('lets the renderer string pick only the message, never the backend', () => {
		// A masked or odd renderer with a working adapter still runs on the GPU.
		expect(assessGpu({ webgpu: 'adapter', webglRenderer: SWIFTSHADER }).backend).toBe('webgpu');
		expect(assessGpu({ webgpu: 'adapter', webglRenderer: null }).backend).toBe('webgpu');
	});
});
