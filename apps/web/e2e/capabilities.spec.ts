// SPDX-License-Identifier: Apache-2.0
import type { Page } from '@playwright/test';
import { expect, fixture, test } from './fixtures';

interface GpuMock {
	webgpu: 'unavailable' | 'no-adapter' | 'fallback-adapter' | 'adapter';
	/** WebGL's unmasked renderer, or null when WebGL can't start at all. */
	renderer: string | null;
	/** Pretend to be Chrome or Edge (navigator.userAgentData brands). */
	chromium: boolean;
}

const INTEL_IRIS = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const VMWARE = 'ANGLE (VMware, Inc., SVGA3D; build: RELEASE; LLVM;, D3D11)';

/** Fake what the main thread sees of WebGPU and WebGL, before any page script runs. */
async function mockGpu(page: Page, mock: GpuMock) {
	await page.addInitScript((m: GpuMock) => {
		const proto = Navigator.prototype;
		Object.defineProperty(proto, 'gpu', {
			configurable: true,
			get: () =>
				m.webgpu === 'unavailable'
					? undefined
					: {
							requestAdapter: () =>
								Promise.resolve(
									m.webgpu === 'no-adapter'
										? null
										: {
												info: {
													vendor: 'test',
													architecture: 'test',
													device: '',
													description: '',
													isFallbackAdapter: m.webgpu === 'fallback-adapter',
												},
												features: new Set(m.webgpu === 'adapter' ? ['shader-f16'] : []),
												limits: {
													maxBufferSize: 268435456,
													maxStorageBufferBindingSize: 134217728,
													maxComputeWorkgroupStorageSize: 16384,
													maxComputeInvocationsPerWorkgroup: 256,
												},
											},
								),
						},
		});
		const getContext = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
			if (type === 'webgl' || type === 'webgl2') {
				if (m.renderer === null) return null;
				return {
					RENDERER: 0x1f01,
					VENDOR: 0x1f00,
					getExtension: (name: string) =>
						name === 'WEBGL_debug_renderer_info'
							? { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 }
							: null,
					getParameter: (parameter: number) =>
						parameter === 0x9246 ? m.renderer : parameter === 0x9245 ? 'Test vendor' : null,
				};
			}
			return (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
		} as typeof HTMLCanvasElement.prototype.getContext;
		Object.defineProperty(proto, 'userAgentData', {
			configurable: true,
			get: () => (m.chromium ? { brands: [{ brand: 'Google Chrome', version: '154' }] } : undefined),
		});
	}, mock);
}

const notice = (page: Page) => page.getByTestId('capability-notice');

// §2.10 / §5.12: every detection branch shows its own message: the situation,
// the consequence and the fix.
test.describe('no usable GPU', () => {
	test('a hardware WebGPU adapter: no notice at all', async ({ page }) => {
		await mockGpu(page, { webgpu: 'adapter', renderer: INTEL_IRIS, chromium: true });
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Choose photo' })).toBeVisible();
		await page.waitForTimeout(300); // detection is async; give a notice the chance to (wrongly) appear
		await expect(notice(page)).toHaveCount(0);
	});

	test('the browser can’t use a real GPU: suggests Chrome or Edge', async ({ page }) => {
		await mockGpu(page, { webgpu: 'unavailable', renderer: INTEL_IRIS, chromium: false });
		await page.goto('/');
		await expect(notice(page)).toHaveAttribute('data-situation', 'browser-unsupported');
		await expect(notice(page)).toContainText('Open Hush in Chrome or Edge for full speed.');
		await expect(notice(page).getByRole('button', { name: 'Show me how' })).toHaveCount(0);
	});

	test('already in Chrome or Edge: suggests updating instead', async ({ page }) => {
		await mockGpu(page, { webgpu: 'no-adapter', renderer: INTEL_IRIS, chromium: true });
		await page.goto('/');
		await expect(notice(page)).toHaveAttribute('data-notice', 'update-browser');
		await expect(notice(page)).toContainText('Update the browser and your graphics drivers');
	});

	test('hardware acceleration off: says so, with per-browser steps', async ({ page }) => {
		await mockGpu(page, { webgpu: 'unavailable', renderer: SWIFTSHADER, chromium: true });
		await page.goto('/');
		await expect(notice(page)).toHaveAttribute('data-situation', 'acceleration-off');
		await expect(notice(page)).toContainText('Hardware acceleration is turned off in this browser.');
		await notice(page).getByRole('button', { name: 'Show me how' }).click();
		await expect(notice(page)).toContainText('Use graphics acceleration when available');
		await expect(notice(page)).toContainText('Use hardware acceleration when available');
	});

	test('a virtual machine: processor only, honestly slow, no steps that won’t help', async ({ page }) => {
		await mockGpu(page, { webgpu: 'unavailable', renderer: VMWARE, chromium: true });
		await page.goto('/');
		await expect(notice(page)).toHaveAttribute('data-situation', 'no-gpu');
		await expect(notice(page)).toContainText('process photos on its processor');
		await expect(notice(page).getByRole('button', { name: 'Show me how' })).toHaveCount(0);
	});

	test('no WebGL at all: processor only, with steps in case acceleration is off', async ({ page }) => {
		await mockGpu(page, { webgpu: 'no-adapter', renderer: null, chromium: true });
		await page.goto('/');
		await expect(notice(page)).toHaveAttribute('data-notice', 'processor-only');
		await expect(notice(page).getByRole('button', { name: 'Show me how' })).toBeVisible();
	});

	test('the notice can be dismissed', async ({ page }) => {
		await mockGpu(page, { webgpu: 'unavailable', renderer: VMWARE, chromium: true });
		await page.goto('/');
		await notice(page).getByRole('button', { name: 'Dismiss' }).click();
		await expect(notice(page)).toHaveCount(0);
	});

	test('a CPU-emulated WebGPU adapter is never used: the photo runs on the processor', async ({ page }) => {
		await mockGpu(page, { webgpu: 'fallback-adapter', renderer: SWIFTSHADER, chromium: true });
		await page.goto('/');
		await expect(notice(page)).toHaveAttribute('data-situation', 'fallback-adapter');
		await expect(notice(page)).toContainText('Hardware acceleration is turned off');

		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('button', { name: 'Choose photo' }).click();
		await (await chooser).setFiles(fixture('noisy-gradient.png'));
		await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
		await expect(page.getByText(/s on processor/)).toBeVisible();
	});
});
