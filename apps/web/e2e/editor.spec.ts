// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { adjustImage, parseRecipe, type Image8 } from '@hush/core';
import type { Page } from '@playwright/test';
import exifr from 'exifr';
import { choosePhoto, expect, fixture, readPhoto, test, waitForPreview } from './fixtures';

/**
 * Phase 2, the single-photo editor (§5.3): live sliders that match the export
 * exactly, presets, export settings, every save method, the model download,
 * capability-specific behaviour, keyboard, About and diagnostics, zh-Hant.
 * The test model inverts colours, so "the result" is always 255 − original.
 */

type Params = { strength: number; luma: number; colour: number; detail: number };

/** What core's adjust stage makes of the original and the model's output: the export's own math. */
function expectedResult(original: { width: number; height: number; data: number[] }, params: Params): number[] {
	const { width, height } = original;
	const image: Image8 = { width, height, channels: 4, data: Uint8Array.from(original.data) };
	const plane = width * height;
	const denoised = new Float32Array(3 * plane);
	for (let i = 0; i < plane; i++) {
		for (let c = 0; c < 3; c++) denoised[c * plane + i] = (255 - original.data[i * 4 + c]!) / 255;
	}
	return Array.from(adjustImage(image, denoised, params).data);
}

async function setParams(page: Page, params: Params) {
	await page.evaluate((next) => window.__hushEditor!.setState({ params: next }), params);
}

function worstDifference(a: number[], b: number[]): number {
	let worst = 0;
	for (let i = 0; i < a.length; i += 4) {
		for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[i + c]! - b[i + c]!));
	}
	return worst;
}

const SETTINGS: Params[] = [
	{ strength: 0.6, luma: 0.8, colour: 0.5, detail: 0 },
	{ strength: 1, luma: 0.7, colour: 1, detail: 0.45 },
	{ strength: 0.35, luma: 1, colour: 0.2, detail: 1 },
];

async function exportFile(page: Page) {
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export' }).click();
	const file = await download;
	return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

test.describe('live sliders (§2.5)', () => {
	test('the viewer’s shader computes exactly what an export computes', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		expect(await page.evaluate(() => window.__hushViewer!.state().renderer)).toBe('webgl2');
		const original = await readPhoto(page, 'original');
		for (const params of SETTINGS) {
			await setParams(page, params);
			const result = await readPhoto(page, 'result');
			expect(
				worstDifference(result.data, expectedResult(original, params)),
				JSON.stringify(params),
			).toBeLessThanOrEqual(1);
		}
	});

	test('without WebGL2, Canvas 2D runs core’s own adjust code: identical', async ({ page }) => {
		await page.addInitScript(() => {
			const getContext = HTMLCanvasElement.prototype.getContext;
			HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
				if (type === 'webgl2') return null;
				return (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
			} as typeof HTMLCanvasElement.prototype.getContext;
		});
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		expect(await page.evaluate(() => window.__hushViewer!.state().renderer)).toBe('canvas2d');
		const original = await readPhoto(page, 'original');
		for (const params of SETTINGS) {
			await setParams(page, params);
			const result = await readPhoto(page, 'result');
			expect(worstDifference(result.data, expectedResult(original, params)), JSON.stringify(params)).toBe(0);
		}
	});

	test('sliders work from the keyboard, double-click resets one, ⌘/Ctrl+Z resets all', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		const strength = page.getByRole('slider', { name: 'Strength' });
		await expect(strength).toHaveAttribute('aria-valuenow', '100');
		await strength.focus();
		await page.keyboard.press('Home');
		await expect(strength).toHaveAttribute('aria-valuenow', '0');
		// Strength 0: the result is the original, exactly.
		const original = await readPhoto(page, 'original');
		expect(worstDifference((await readPhoto(page, 'result')).data, original.data)).toBe(0);

		const detail = page.getByRole('slider', { name: 'Detail' });
		await detail.focus();
		await page.keyboard.press('PageUp');
		await expect(detail).toHaveAttribute('aria-valuenow', '10');
		await page.getByText('Detail', { exact: true }).dblclick();
		await expect(detail).toHaveAttribute('aria-valuenow', '0');

		await page.getByTestId('viewer').focus();
		await page.keyboard.press('ControlOrMeta+z');
		await expect(strength).toHaveAttribute('aria-valuenow', '100');
	});
});

test.describe('the comparison (§5.3)', () => {
	test('press and hold shows the original; Z and the toolbar change the zoom', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		const viewer = page.getByTestId('viewer');
		const photo = await page.evaluate(() => window.__hushViewer!.state().photo);
		const box = (await viewer.boundingBox())!;
		await page.mouse.move(box.x + photo.x + photo.width * 0.75, box.y + photo.y + photo.height / 2);
		await page.mouse.down();
		await expect(page.getByText('Original', { exact: true })).toBeVisible();
		await expect(viewer).toHaveAttribute('data-comparing', 'false');
		await page.mouse.up();
		await expect(viewer).toHaveAttribute('data-comparing', 'true');

		await viewer.focus();
		await page.keyboard.press('z');
		await expect(viewer).toHaveAttribute('data-zoom', 'fit');
		// A photo smaller than the viewer is already whole at 100%: Fit keeps the comparison.
		await expect(viewer).toHaveAttribute('data-comparing', 'true');
		await page.getByRole('radio', { name: '200%' }).click();
		await expect(viewer).toHaveAttribute('data-zoom', '2');
		expect(await page.evaluate(() => window.__hushViewer!.state().photo)).toMatchObject({ width: 520, height: 360 });
	});

	test('dragging the divider moves it and stays on the photo', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		const handle = page.getByRole('slider', { name: 'Before and after' });
		const box = (await handle.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 - 64, box.y + box.height / 2, { steps: 4 });
		await page.mouse.up();
		const value = Number(await handle.getAttribute('aria-valuenow'));
		expect(value).toBeLessThan(50);
		expect(value).toBeGreaterThan(40);
	});
});

test.describe('presets (§4.5, §5.3)', () => {
	test('save, apply, update, rename, export, delete', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		await setParams(page, { strength: 0.7, luma: 0.8, colour: 1, detail: 0.3 });
		const menu = page.getByTestId('preset-menu');
		await expect(menu).toContainText('Edited');

		await menu.click();
		await page.getByRole('menuitem', { name: 'Save as preset…' }).click();
		await page.getByRole('textbox', { name: 'Name' }).fill('Wedding reception');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Saved “Wedding reception”.')).toBeVisible();
		await expect(menu).toHaveText(/Wedding reception/);
		await expect(menu).not.toContainText('Edited');

		// Back to the defaults, then apply the preset again.
		await menu.click();
		await page.getByRole('menuitemradio', { name: 'Default' }).click();
		await expect(page.getByRole('slider', { name: 'Strength' })).toHaveAttribute('aria-valuenow', '100');
		await menu.click();
		await page.getByRole('menuitemradio', { name: 'Wedding reception' }).click();
		await expect(page.getByRole('slider', { name: 'Strength' })).toHaveAttribute('aria-valuenow', '70');

		await setParams(page, { strength: 0.5, luma: 0.8, colour: 1, detail: 0.3 });
		await menu.click();
		await page.getByRole('menuitem', { name: 'Update “Wedding reception”' }).click();
		await expect(menu).not.toContainText('Edited');

		await menu.click();
		await page.getByRole('menuitem', { name: 'Rename…' }).click();
		await page.getByRole('textbox', { name: 'Name' }).fill('Reception, ISO 6400');
		await page.getByRole('button', { name: 'Rename', exact: true }).click();
		await expect(menu).toHaveText(/Reception, ISO 6400/);

		await menu.click();
		const download = page.waitForEvent('download');
		await page.getByRole('menuitem', { name: 'Export as file' }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe('Reception,-ISO-6400.hush-preset.json');
		const recipe = parseRecipe(JSON.parse(readFileSync(await file.path(), 'utf8')), {
			denoise: { controls: [] },
		});
		expect(recipe).toMatchObject({ schema: 1, name: 'Reception, ISO 6400', ops: [{ op: 'denoise' }] });

		// Presets outlive the visit.
		await page.reload();
		await choosePhoto(page, 'noisy-gradient.png');
		await expect(page.getByTestId('preset-menu')).toHaveText(/Reception, ISO 6400/);
		await expect(page.getByRole('slider', { name: 'Strength' })).toHaveAttribute('aria-valuenow', '50');

		await page.getByTestId('preset-menu').click();
		await page.getByRole('menuitem', { name: 'Delete…' }).click();
		const dialog = page.getByRole('dialog', { name: 'Delete “Reception, ISO 6400”?' });
		await dialog.getByRole('button', { name: 'Delete' }).click();
		await expect(page.getByTestId('preset-menu')).toHaveText(/Default/);
	});

	test('imports presets, and says which files it couldn’t, and why', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		await page.getByTestId('preset-menu').click();
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Import presets…' }).click();
		const json = (value: unknown, name: string) => ({
			name,
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(value)),
		});
		await (
			await chooser
		).setFiles([
			json(
				{ schema: 1, name: 'Concert', ops: [{ op: 'denoise', params: { strength: 0.25 } }] },
				'concert.hush-preset.json',
			),
			json({ schema: 2, name: 'Future', ops: [] }, 'future.hush-preset.json'),
			json({ schema: 1, ops: [{ op: 'upscale', params: {} }] }, 'upscale.hush-preset.json'),
		]);
		const status = page.getByRole('status').filter({ hasText: 'Imported 1 preset.' });
		await expect(status).toContainText('future.hush-preset.json was made by a newer version of Hush.');
		await expect(status).toContainText('upscale.hush-preset.json uses “upscale”');
		await expect(page.getByTestId('preset-menu')).toHaveText(/Concert/);
		await expect(page.getByRole('slider', { name: 'Strength' })).toHaveAttribute('aria-valuenow', '25');
	});
});

test.describe('export (§2.6, §5.3)', () => {
	test('the exported file’s EXIF matches the original’s, apart from Software', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'meta-camera.jpg');
		await waitForPreview(page);
		const { name, bytes } = await exportFile(page);
		expect(name).toBe('meta-camera-denoised.jpg');
		const options = {
			tiff: true,
			exif: true,
			gps: true,
			interop: true,
			ifd1: true,
			translateValues: false,
			reviveValues: false,
		};
		const [before, after] = (await Promise.all([
			exifr.parse(readFileSync(fixture('meta-camera.jpg')), options),
			exifr.parse(bytes, options),
		])) as [Record<string, unknown>, Record<string, unknown>];
		const changed = Object.keys({ ...before, ...after }).filter(
			(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
		);
		expect(changed).toEqual(['Software']);
		expect(after['Software']).toBe('Hush');
	});

	test('format, suffix and location removal from Advanced', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'meta-camera.jpg');
		await waitForPreview(page);
		await page.getByRole('button', { name: 'Advanced' }).click();
		await expect(page.getByText('This photo has GPS coordinates.')).toBeVisible();
		await page.getByTestId('format').getByRole('radio', { name: 'PNG' }).click();
		const suffix = page.getByRole('textbox', { name: 'Added to the file name' });
		await suffix.fill('-clean');
		await expect(page.getByTestId('output-name')).toHaveText('Saves as meta-camera-clean.png');
		await page.getByRole('switch', { name: 'Remove location' }).click();
		const { name, bytes } = await exportFile(page);
		expect(name).toBe('meta-camera-clean.png');
		expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		const gps = (await exifr.gps(bytes).catch(() => undefined)) as unknown;
		expect(gps ?? null).toBeNull();
		// The settings are remembered.
		await page.reload();
		await choosePhoto(page, 'meta-camera.jpg');
		await page.getByRole('button', { name: 'Advanced' }).click();
		await expect(page.getByTestId('output-name')).toHaveText('Saves as meta-camera-clean.png');
	});

	test('⌘/Ctrl+E exports, and the estimate shows on the button when it’s worth planning around', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		await page.evaluate(() => window.__hushEditor!.setState({ estimateMs: 6 * 60_000 }));
		await expect(page.getByRole('button', { name: 'Export (about 6 min)' })).toBeVisible();
		const download = page.waitForEvent('download');
		await page.keyboard.press('ControlOrMeta+e');
		expect((await download).suggestedFilename()).toBe('noisy-gradient-denoised.png');
	});
});

test.describe('saving to a folder (§2.8, §5.13)', () => {
	/** Chrome's own private file system stands in for a folder the user picked. */
	async function folderPicker(page: Page, options: { failWith?: string } = {}) {
		await page.addInitScript((failWith) => {
			(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
				async () => {
					const root = await navigator.storage.getDirectory();
					const folder = await root.getDirectoryHandle('Wedding', { create: true });
					if (!failWith) return folder;
					return new Proxy(folder, {
						get(target, key) {
							if (key === 'getFileHandle') {
								return async (name: string, init?: FileSystemGetFileOptions) => {
									const handle = await target.getFileHandle(name, init);
									return new Proxy(handle, {
										get(file, prop) {
											if (prop === 'createWritable') {
												return async () => {
													const writable = await file.createWritable();
													return new Proxy(writable, {
														get(stream, method) {
															if (method === 'write') {
																return () => Promise.reject(Object.assign(new Error(failWith), { name: failWith }));
															}
															const value = Reflect.get(stream, method) as unknown;
															return typeof value === 'function'
																? (value as (...a: unknown[]) => unknown).bind(stream)
																: value;
														},
													});
												};
											}
											const value = Reflect.get(file, prop) as unknown;
											return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(file) : value;
										},
									});
								};
							}
							const value = Reflect.get(target, key) as unknown;
							return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
						},
					});
				};
		}, options.failWith ?? null);
	}

	async function chooseFolder(page: Page) {
		await page.getByTestId('save-location').click();
		await page.getByRole('menuitem', { name: 'Choose a folder…' }).click();
		await expect(page.getByTestId('save-location')).toHaveText(/Saving to: Wedding/);
	}

	test('writes into the folder, never over an existing file, and remembers the folder', async ({ page }) => {
		await folderPicker(page);
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.jpg');
		await waitForPreview(page);
		await chooseFolder(page);
		await page.getByRole('button', { name: 'Export' }).click();
		await expect(page.getByText('Saved noisy-gradient-denoised.jpg to Wedding')).toBeVisible();
		await page.getByRole('button', { name: 'Export' }).click();
		await expect(page.getByText('Saved noisy-gradient-denoised (2).jpg to Wedding')).toBeVisible();
		const written = await page.evaluate(async () => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('Wedding');
			const file = await (await folder.getFileHandle('noisy-gradient-denoised.jpg')).getFile();
			return Array.from(new Uint8Array(await file.slice(0, 3).arrayBuffer()));
		});
		expect(written).toEqual([0xff, 0xd8, 0xff]);

		// Remembered for the next visit (IndexedDB). Only the key is read back here: Playwright's
		// headless Chromium crashes deserialising a stored private-file-system handle (installed
		// Chrome doesn't; the real-model suite checks the reload there).
		const keys = await page.evaluate(
			() =>
				new Promise<string[]>((resolve, reject) => {
					const open = indexedDB.open('hush');
					open.onsuccess = () => {
						const request = open.result.transaction('handles').objectStore('handles').getAllKeys();
						request.onsuccess = () => resolve(request.result.map(String));
						request.onerror = () => reject(request.error);
					};
					open.onerror = () => reject(open.error);
				}),
		);
		expect(keys).toContain('export-folder');
	});

	test('a failed write says why, keeps the file, and saves it another way without processing again', async ({
		page,
	}) => {
		await folderPicker(page, { failWith: 'QuotaExceededError' });
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.jpg');
		await waitForPreview(page);
		await chooseFolder(page);
		await page.getByRole('button', { name: 'Export' }).click();
		const alert = page.getByRole('alert');
		await expect(alert).toContainText("noisy-gradient-denoised.jpg couldn't be saved: the disk is full.");
		const exports = await page.evaluate(() => window.__hushEditor!.getState().timings['export']);
		const download = page.waitForEvent('download');
		await alert.getByRole('button', { name: 'Download instead' }).click();
		expect((await download).suggestedFilename()).toBe('noisy-gradient-denoised.jpg');
		await expect(page.getByText('Saved noisy-gradient-denoised.jpg to Downloads')).toBeVisible();
		expect(await page.evaluate(() => window.__hushEditor!.getState().timings['export'])).toBe(exports);
	});
});

test.describe('the model download (§5.6)', () => {
	test('the photo shows at once; the first download says its real size, with progress', async ({ page }) => {
		await page.route('**/models/parts/**', async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await route.continue();
		});
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		const card = page.getByTestId('model-download');
		await expect(card).toContainText('Downloading the noise model');
		await expect(card).toContainText('One-time download');
		await expect(page.getByTestId('viewer')).toHaveAttribute('data-ready', 'true');
		await waitForPreview(page);
		await expect(card).toHaveCount(0);
	});

	test('on a metered connection, asks before downloading', async ({ page }) => {
		await page.addInitScript(() => {
			Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => ({ saveData: true }) });
		});
		const parts: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/models/parts/')) parts.push(request.url());
		});
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await expect(
			page.getByText(/You're on a metered connection\. Download the noise model \(.+\) now\?/).first(),
		).toBeVisible();
		await page.waitForTimeout(500);
		expect(parts).toEqual([]);
		await page.getByRole('button', { name: 'Download', exact: true }).click();
		await waitForPreview(page);
		expect(parts.length).toBeGreaterThan(0);
	});
});

test.describe('About, shortcuts, diagnostics', () => {
	test('About names the model and its licences; Copy diagnostics leaves out the photo', async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/');
		await choosePhoto(page, 'meta-camera.jpg');
		await waitForPreview(page);
		await page.getByRole('button', { name: 'About Hush' }).click();
		const about = page.getByTestId('about');
		await expect(about.getByTestId('about-model-name')).toContainText('Test model (inverts colours)');
		await expect(about).toContainText('Apache License 2.0');
		await expect(about.getByRole('link', { name: 'Read the source code' })).toHaveAttribute(
			'href',
			'https://github.com/ms0242808/Hush',
		);
		await about.getByRole('button', { name: 'Copy diagnostics' }).click();
		await expect(about.getByRole('status')).toHaveText('Copied');
		const text = await page.evaluate(() => navigator.clipboard.readText());
		expect(text).toContain('Graphics (§2.10 situation):');
		expect(text).toContain('Processing: auto →');
		expect(text).toContain('Photo: jpeg');
		expect(text).not.toContain('meta-camera');
		expect(text).not.toContain('Canon');
	});

	test('? lists the shortcuts', async ({ page }) => {
		await page.goto('/');
		await page.keyboard.press('?');
		const dialog = page.getByTestId('shortcuts');
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('Show the original, or the comparison');
		await expect(dialog).toContainText('Reset the sliders');
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	});
});

test.describe('appearance and language (§5.1, §5.9)', () => {
	test('the light grey interface is remembered, with no dark flash on load', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('button', { name: 'Use the light grey interface' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.reload();
		// theme.js runs before the first paint.
		expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('light');
		await page.getByRole('button', { name: 'Use the dark interface' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	});

	test.describe('in Taiwan', () => {
		test.use({ locale: 'zh-TW' });

		test('the editor speaks Traditional Chinese with Taiwan photography terms', async ({ page }) => {
			await page.goto('/');
			await choosePhoto(page, 'noisy-gradient.png', '選擇相片');
			await waitForPreview(page);
			for (const text of ['強度', '明度雜訊', '色彩雜訊', '細節', '預設集', '儲存位置：下載項目', '進階']) {
				await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
			}
			await expect(page.getByRole('button', { name: '匯出' })).toBeVisible();
			await expect(page.getByText('處理前', { exact: true })).toBeVisible();
		});
	});
});

test.describe('every state has a screen (§5.10)', () => {
	test('a browser without WebAssembly is told what to use instead', async ({ page }) => {
		await page.addInitScript(() => {
			Reflect.deleteProperty(globalThis, 'WebAssembly');
		});
		await page.goto('/');
		await expect(page.getByTestId('unsupported')).toContainText("This browser can't run Hush");
		await expect(page.getByTestId('unsupported')).toContainText('latest Chrome, Edge, Safari or Firefox');
	});
});
