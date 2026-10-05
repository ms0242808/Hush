// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Download, Page } from '@playwright/test';
import exifr from 'exifr';
import { expect, fixture, test, waitForPreview } from './fixtures';
import './harness';
import { inverted } from './metadata';

/**
 * Phase 3, batches (§2.7, §2.8, §5.4): a grid of thumbnails, one shared set
 * of settings, a queue that exports one photo at a time to a folder (skipping
 * what's already there) or to ZIP files in parts, pause, cancel and retry, a
 * failed save that keeps its photo, and a batch that picks up again after a
 * reload. CI runs the processor path with the invert test model, so every
 * result is exactly 255 − original.
 *
 * Folders are Chrome's private file system standing in for the user's own.
 * Reading a stored folder handle back after a reload crashes Playwright's
 * headless Chromium (installed Chrome is fine), so resuming a folder batch is
 * checked in e2e/real; here the ZIP path resumes, which keeps no handles.
 */

type Photo = { status: string; name: string; fraction: number };

const EXIF_OPTIONS = {
	tiff: true,
	exif: true,
	gps: true,
	interop: true,
	ifd1: true,
	translateValues: false,
	reviveValues: false,
};

/** showDirectoryPicker answering with folders of Chrome's private file system, in the order asked for. */
async function folders(page: Page, names: string[] = ['Wedding'], failWith?: string) {
	await page.addInitScript(
		([queue, failure]) => {
			let asked = 0;
			const failing = <T extends object>(target: T, intercept: (key: string | symbol) => unknown): T =>
				new Proxy(target, {
					get(object, key) {
						const replaced = intercept(key);
						if (replaced !== undefined) return replaced;
						const value = Reflect.get(object, key) as unknown;
						return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(object) : value;
					},
				});
			(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
				async () => {
					const name = queue[Math.min(asked++, queue.length - 1)]!;
					let folder = await navigator.storage.getDirectory();
					for (const part of name.split('/')) folder = await folder.getDirectoryHandle(part, { create: true });
					// The first folder can refuse every write, the way a full disk or a blocked folder does.
					if (!failure || asked > 1) return folder;
					return failing(folder, (key) =>
						key === 'getFileHandle'
							? async (file: string, init?: FileSystemGetFileOptions) =>
									failing(await folder.getFileHandle(file, init), (k) =>
										k === 'createWritable'
											? () => Promise.reject(Object.assign(new Error(failure), { name: failure }))
											: undefined,
									)
							: undefined,
					);
				};
		},
		[names, failWith ?? null] as const,
	);
}

async function choose(page: Page, names: readonly string[], button = 'Choose photos') {
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: button }).click();
	await (await chooser).setFiles(names.map(fixture));
}

/** Put a fixture into a private-file-system folder, as if it were on disk already. */
async function put(page: Page, folder: string, name: string, bytes: Buffer) {
	await page.evaluate(
		async ([dir, file, data]) => {
			let handle = await navigator.storage.getDirectory();
			for (const part of dir.split('/')) handle = await handle.getDirectoryHandle(part, { create: true });
			const writable = await (await handle.getFileHandle(file, { create: true })).createWritable();
			await writable.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
			await writable.close();
		},
		[folder, name, bytes.toString('base64')] as const,
	);
}

async function list(page: Page, folder: string): Promise<string[]> {
	return page.evaluate(async (dir) => {
		let handle = await navigator.storage.getDirectory();
		for (const part of dir.split('/')) handle = await handle.getDirectoryHandle(part);
		const names: string[] = [];
		for await (const name of handle.keys()) names.push(name);
		return names.sort();
	}, folder);
}

async function read(page: Page, filePath: string): Promise<Buffer> {
	const base64 = await page.evaluate(async (p) => {
		const parts = p.split('/');
		let handle = await navigator.storage.getDirectory();
		for (const part of parts.slice(0, -1)) handle = await handle.getDirectoryHandle(part);
		const file = await (await handle.getFileHandle(parts.at(-1)!)).getFile();
		const bytes = new Uint8Array(await file.arrayBuffer());
		let binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(binary);
	}, filePath);
	return Buffer.from(base64, 'base64');
}

/** Decode a file with Hush's own codecs, on /bench/, in a second tab of the same browser. */
async function decode(page: Page, bytes: Buffer) {
	const bench = await page.context().newPage();
	try {
		await bench.goto('/bench/?backend=wasm');
		await bench.waitForFunction(() => window.__hushPipeline !== undefined);
		const image = await bench.evaluate((data) => window.__hushPipeline!.decode(data), bytes.toString('base64'));
		return { width: image.width, height: image.height, data: new Uint8Array(Buffer.from(image.data, 'base64')) };
	} finally {
		await bench.close();
	}
}

function cell(page: Page, name: string) {
	return page.locator(`[data-testid="batch-photo"][data-name="${name}"]`);
}

function photos(page: Page): Promise<Photo[]> {
	return page.evaluate(() =>
		(
			window.__hushBatch!.getState().photos as unknown as {
				status: string;
				file: File;
				fraction: number;
			}[]
		).map((p) => ({ status: p.status, name: p.file.name, fraction: p.fraction })),
	);
}

/** Wait, frame by frame, until the n-th photo of the batch reaches a state: some last well under a second. */
async function statusOf(page: Page, index: number, status: string) {
	await page.waitForFunction(
		([i, wanted]) => window.__hushBatch!.getState().photos[i]?.status === wanted,
		[index, status] as const,
		{ polling: 'raf', timeout: 15_000 },
	);
}

async function readyToExport(page: Page) {
	await expect(page.getByTestId('batch-export')).toBeEnabled({ timeout: 30_000 });
}

test.describe('a batch of photos (§5.4)', () => {
	test('several photos make a grid: upright thumbnails, sizes, and refusals that say why', async ({ page }) => {
		await page.goto('/');
		await choose(page, ['noisy-gradient.jpg', 'meta-camera.jpg', 'meta-phone.heic', 'refuse-cmyk.jpg']);
		await expect(page.getByTestId('batch-count')).toHaveText('4 photos');
		await expect(page.getByTestId('batch-photo')).toHaveCount(4);
		// The camera JPEG is stored sideways with orientation 6: its thumbnail stands upright.
		const upright = cell(page, 'meta-camera.jpg').getByTestId('thumbnail');
		await expect(upright).toBeVisible();
		await expect
			.poll(() => upright.evaluate((img: HTMLImageElement) => img.naturalHeight > img.naturalWidth && img.complete))
			.toBe(true);
		// HEIC thumbnails come from Hush's own decoder, where the browser has none.
		await expect(cell(page, 'meta-phone.heic').getByTestId('thumbnail')).toBeVisible();
		const cmyk = cell(page, 'refuse-cmyk.jpg');
		await expect(cmyk).toHaveAttribute('data-status', 'refused');
		await expect(cmyk.getByTestId('batch-reason')).toContainText('CMYK JPEG');
		await readyToExport(page);
		await expect(page.getByTestId('batch-export')).toContainText('Export 3 photos');
	});

	test('exports to a folder: every file there, EXIF intact, the model’s own pixels', async ({ page }) => {
		await folders(page);
		await page.goto('/');
		await choose(page, ['noisy-gradient.png', 'meta-camera.jpg']);
		await readyToExport(page);
		await page.getByTestId('batch-export').click();
		const summary = page.getByTestId('batch-summary');
		await expect(summary).toContainText('2 photos exported to Wedding', { timeout: 30_000 });
		await expect(page.getByTestId('save-location')).toHaveText(/Saving to: Wedding/);
		expect(await list(page, 'Wedding')).toEqual(['meta-camera-denoised.jpg', 'noisy-gradient-denoised.png']);
		await expect(cell(page, 'meta-camera.jpg')).toHaveAttribute('data-status', 'saved');

		const jpeg = await read(page, 'Wedding/meta-camera-denoised.jpg');
		const [before, after] = (await Promise.all([
			exifr.parse(readFileSync(fixture('meta-camera.jpg')), EXIF_OPTIONS),
			exifr.parse(jpeg, EXIF_OPTIONS),
		])) as [Record<string, unknown>, Record<string, unknown>];
		const changed = Object.keys({ ...before, ...after }).filter(
			(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
		);
		expect(changed).toEqual(['Software']);

		const png = await decode(page, await read(page, 'Wedding/noisy-gradient-denoised.png'));
		const original = await decode(page, readFileSync(fixture('noisy-gradient.png')));
		expect(Buffer.from(png.data).equals(Buffer.from(inverted(original.data)))).toBe(true);
	});

	test('a folder of photos saves into a “denoised” folder inside it, leaving other files alone', async ({ page }) => {
		await folders(page, ['Shoot']);
		await page.goto('/');
		await put(page, 'Shoot', 'IMG_0002.jpg', readFileSync(fixture('noisy-gradient.jpg')));
		await put(page, 'Shoot', 'IMG_0010.jpg', readFileSync(fixture('meta-camera.jpg')));
		await put(page, 'Shoot', 'IMG_0002.CR3', Buffer.from('raw'));
		await put(page, 'Shoot/older', 'IMG_0001.jpg', readFileSync(fixture('noisy-gradient.jpg')));
		await page.getByRole('button', { name: 'Choose folder' }).click();
		await expect(page.getByTestId('batch-count')).toHaveText('2 photos');
		await expect(page.getByTestId('batch-panel')).toContainText('From Shoot');
		await expect(page.getByTestId('batch-panel')).toContainText('1 other file in the folder is left alone');
		// File-name order as people read it: 2 before 10.
		expect((await photos(page)).map((p) => p.name)).toEqual(['IMG_0002.jpg', 'IMG_0010.jpg']);
		await expect(page.getByTestId('save-location')).toHaveText(/Saving to: Shoot\/denoised/);
		await readyToExport(page);
		await page.getByTestId('batch-export').click();
		await expect(page.getByTestId('batch-summary')).toContainText('2 photos exported to Shoot/denoised', {
			timeout: 30_000,
		});
		expect(await list(page, 'Shoot/denoised')).toEqual(['IMG_0002-denoised.jpg', 'IMG_0010-denoised.jpg']);
	});

	test('photos already exported to the folder are skipped, and left as they were (§2.7)', async ({ page }) => {
		await folders(page);
		await page.goto('/');
		await put(page, 'Wedding', 'noisy-gradient-denoised.jpg', Buffer.from('exported earlier'));
		await choose(page, ['noisy-gradient.jpg', 'meta-camera.jpg']);
		await readyToExport(page);
		await page.getByTestId('batch-export').click();
		const summary = page.getByTestId('batch-summary');
		await expect(summary).toContainText('1 photo exported to Wedding', { timeout: 30_000 });
		await expect(summary).toContainText('1 was already exported');
		await expect(cell(page, 'noisy-gradient.jpg')).toHaveAttribute('data-status', 'skipped');
		await expect(cell(page, 'noisy-gradient.jpg')).toContainText('Already exported');
		expect((await read(page, 'Wedding/noisy-gradient-denoised.jpg')).toString()).toBe('exported earlier');
		expect(await list(page, 'Wedding')).toEqual(['meta-camera-denoised.jpg', 'noisy-gradient-denoised.jpg']);
	});

	test('two photos with the same name don’t overwrite each other', async ({ page }) => {
		await folders(page);
		await page.goto('/');
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('button', { name: 'Choose photos' }).click();
		const bytes = readFileSync(fixture('noisy-gradient.jpg'));
		await (
			await chooser
		).setFiles([
			{ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: bytes },
			{ name: 'img_0001.JPG', mimeType: 'image/jpeg', buffer: readFileSync(fixture('meta-camera.jpg')) },
		]);
		await readyToExport(page);
		await page.getByTestId('batch-export').click();
		await expect(page.getByTestId('batch-summary')).toContainText('2 photos exported', { timeout: 30_000 });
		expect(await list(page, 'Wedding')).toEqual(['IMG_0001-denoised.jpg', 'img_0001-denoised (2).JPG']);
	});
});

test.describe('a dropped folder (§5.2)', () => {
	/** Drop one "folder" on the page: a DataTransfer whose single item answers as a directory. */
	async function dropFolder(page: Page, mode: 'handle' | 'entries') {
		const photos = {
			'IMG_0002.jpg': readFileSync(fixture('noisy-gradient.jpg')).toString('base64'),
			'IMG_0010.jpg': readFileSync(fixture('meta-camera.jpg')).toString('base64'),
			'IMG_0002.CR3': Buffer.from('raw').toString('base64'),
		};
		await page.evaluate(
			async ([files, how]) => {
				const decoded = Object.entries(files).map(
					([name, data]) => new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name),
				);
				let folder: FileSystemDirectoryHandle | null = null;
				if (how === 'handle') {
					// Chrome and Edge: the drop gives a handle, kept so the batch can resume.
					folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('Dropped', { create: true });
					for (const file of decoded) {
						const writable = await (await folder.getFileHandle(file.name, { create: true })).createWritable();
						await writable.write(file);
						await writable.close();
					}
				}
				// Safari and Firefox: the older entries API, handing entries over in chunks.
				const entries = decoded.map((file) => ({
					isFile: true,
					isDirectory: false,
					name: file.name,
					file: (resolve: (f: File) => void) => resolve(file),
				}));
				const directory = {
					isFile: false,
					isDirectory: true,
					name: 'Dropped',
					createReader: () => {
						const chunks = [entries.slice(0, 2), entries.slice(2), []];
						return { readEntries: (resolve: (e: unknown[]) => void) => resolve(chunks.shift() ?? []) };
					},
				};
				const proto = DataTransferItem.prototype as unknown as Record<string, unknown>;
				proto['webkitGetAsEntry'] = () => directory;
				proto['getAsFileSystemHandle'] = () => Promise.resolve(folder);
				const transfer = new DataTransfer();
				transfer.items.add(new File([], 'Dropped'));
				window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
			},
			[photos, mode] as const,
		);
	}

	test('in Chrome and Edge it keeps its handle: saved into “denoised” inside it', async ({ page }) => {
		await page.goto('/');
		await dropFolder(page, 'handle');
		await expect(page.getByTestId('batch-count')).toHaveText('2 photos');
		await expect(page.getByTestId('batch-panel')).toContainText('From Dropped');
		await expect(page.getByTestId('save-location')).toHaveText(/Saving to: Dropped\/denoised/);
		await readyToExport(page);
		await page.getByTestId('batch-export').click();
		await expect(page.getByTestId('batch-summary')).toContainText('2 photos exported to Dropped/denoised', {
			timeout: 30_000,
		});
		expect(await list(page, 'Dropped/denoised')).toEqual(['IMG_0002-denoised.jpg', 'IMG_0010-denoised.jpg']);
	});

	test('elsewhere it is read through the entries API: photos only, in name order', async ({ page }) => {
		await page.addInitScript(() => Reflect.deleteProperty(window, 'showDirectoryPicker'));
		await page.goto('/');
		await dropFolder(page, 'entries');
		await expect(page.getByTestId('batch-count')).toHaveText('2 photos');
		await expect(page.getByTestId('batch-panel')).toContainText('1 other file in the folder is left alone');
		expect((await photos(page)).map((p) => p.name)).toEqual(['IMG_0002.jpg', 'IMG_0010.jpg']);
		await expect(page.getByTestId('save-location')).toHaveText('Saving to: ZIP files in Downloads');
	});
});

test.describe('running a batch (§2.7)', () => {
	test('pause holds the photo partway; resume carries on; cancel stops; “Export the rest” finishes', async ({
		page,
	}) => {
		await page.addInitScript(() => {
			const calls: string[] = [];
			(window as unknown as { __wakeLocks: string[] }).__wakeLocks = calls;
			Object.defineProperty(navigator, 'wakeLock', {
				configurable: true,
				value: {
					request: async () => {
						calls.push('request');
						const sentinel = new EventTarget() as EventTarget & { release: () => Promise<void> };
						sentinel.release = async () => {
							calls.push('release');
						};
						return sentinel;
					},
				},
			});
		});
		await folders(page);
		await page.goto('/');
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('button', { name: 'Choose photos' }).click();
		// The first is 1024 × 768: six tiles on the processor, so a pause can land between them.
		await (
			await chooser
		).setFiles([
			{ name: 'IMG_0001.png', mimeType: 'image/png', buffer: readFileSync(fixture('golden/noisy-1024x768.png')) },
			{ name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: readFileSync(fixture('noisy-gradient.jpg')) },
			{ name: 'IMG_0003.jpg', mimeType: 'image/jpeg', buffer: readFileSync(fixture('meta-camera.jpg')) },
		]);
		await readyToExport(page);
		await page.evaluate(() => window.__hushBatchFaults!({ delayMs: 800 }));
		await page.getByTestId('batch-export').click();

		const footer = page.getByTestId('batch-footer');
		await expect(footer).toHaveAttribute('data-state', 'running');
		await statusOf(page, 0, 'processing');
		await expect(page.getByTestId('batch-headline')).toHaveText('Exporting 1 of 3');
		expect(await page.evaluate(() => (window as unknown as { __wakeLocks: string[] }).__wakeLocks)).toEqual([
			'request',
		]);

		await footer.getByRole('button', { name: 'Pause' }).click();
		await expect(footer).toHaveAttribute('data-state', 'paused');
		await expect(page.getByTestId('batch-headline')).toHaveText('Paused · 1 of 3');
		// The tile in flight finishes; then the photo holds at the next one.
		await page.waitForTimeout(1200);
		const held = await photos(page);
		await page.waitForTimeout(1600);
		expect(await photos(page)).toEqual(held);
		expect(held[0]!.status).toBe('processing');
		expect(held[0]!.fraction).toBeLessThan(0.85);
		expect(held[1]!.status).toBe('queued');
		// A paused batch lets the screen sleep.
		expect(await page.evaluate(() => (window as unknown as { __wakeLocks: string[] }).__wakeLocks)).toEqual([
			'request',
			'release',
		]);

		await footer.getByRole('button', { name: 'Resume' }).click();
		await statusOf(page, 0, 'saved');
		await statusOf(page, 1, 'processing');
		await footer.getByRole('button', { name: 'Cancel' }).click();
		const summary = page.getByTestId('batch-summary');
		await expect(summary).toContainText('1 photo exported to Wedding');
		await expect(summary).toContainText("Stopped. 2 photos weren't exported.");
		expect((await photos(page)).map((p) => p.status)).toEqual(['saved', 'cancelled', 'cancelled']);
		expect(await list(page, 'Wedding')).toEqual(['IMG_0001-denoised.png']);

		await page.evaluate(() => window.__hushBatchFaults!({}));
		await summary.getByRole('button', { name: 'Export the rest' }).click();
		await expect(page.getByTestId('batch-summary')).toContainText('2 photos exported to Wedding', { timeout: 30_000 });
		expect(await list(page, 'Wedding')).toEqual([
			'IMG_0001-denoised.png',
			'IMG_0002-denoised.jpg',
			'IMG_0003-denoised.jpg',
		]);
	});

	test('a save that fails pauses the batch, keeps the photo, and saves it elsewhere without redoing it', async ({
		page,
	}) => {
		await folders(page, ['Wedding', 'Elsewhere'], 'QuotaExceededError');
		await page.goto('/');
		await choose(page, ['noisy-gradient.jpg', 'meta-camera.jpg']);
		await readyToExport(page);
		await page.getByTestId('batch-export').click();
		const problem = page.getByTestId('batch-problem');
		await expect(problem).toContainText("meta-camera-denoised.jpg couldn't be saved: the disk is full.", {
			timeout: 30_000,
		});
		await expect(page.getByTestId('batch-footer')).toHaveAttribute('data-state', 'paused');
		expect((await photos(page)).map((p) => p.status)).toEqual(['saving', 'queued']);
		await problem.getByRole('button', { name: 'Choose another folder…' }).click();
		await expect(page.getByTestId('batch-summary')).toContainText('2 photos exported to Elsewhere', {
			timeout: 30_000,
		});
		expect(await list(page, 'Elsewhere')).toEqual(['meta-camera-denoised.jpg', 'noisy-gradient-denoised.jpg']);
	});

	test('a photo that can’t be opened fails alone, says why, and the rest are exported', async ({ page }) => {
		await folders(page);
		await page.goto('/');
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('button', { name: 'Choose photos' }).click();
		// Its header reads fine; its pixels don't (scrambled scan data): it fails when its turn comes, not before.
		const good = readFileSync(fixture('noisy-gradient.jpg'));
		const scrambled = Buffer.from(good);
		for (let i = Math.floor(good.length * 0.4); i < good.length - 16; i += 7)
			scrambled[i] = (scrambled[i]! * 31 + 17) & 255;
		await (
			await chooser
		).setFiles([
			{ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: scrambled },
			{ name: 'fine.jpg', mimeType: 'image/jpeg', buffer: good },
		]);
		await readyToExport(page);
		await expect(page.getByTestId('batch-export')).toContainText('Export 2 photos');
		await page.getByTestId('batch-export').click();
		const summary = page.getByTestId('batch-summary');
		await expect(summary).toContainText('1 photo exported to Wedding', { timeout: 30_000 });
		await expect(summary).toContainText("1 couldn't be exported");
		const broken = cell(page, 'broken.jpg');
		await expect(broken).toHaveAttribute('data-status', 'failed');
		await expect(broken.getByTestId('batch-reason')).toContainText("broken.jpg couldn't be opened");
		// The file is the problem: retrying it can't help, so there's no Retry on it.
		await expect(broken.getByRole('button', { name: 'Retry' })).toHaveCount(0);
		expect(await list(page, 'Wedding')).toEqual(['fine-denoised.jpg']);
	});

	test('§5.12: hours of work on the processor ask first; Start anyway runs it', async ({ page }) => {
		await folders(page);
		await page.goto('/');
		await choose(page, ['noisy-gradient.jpg', 'meta-camera.jpg']);
		await readyToExport(page);
		await page.evaluate(() => window.__hushBatch!.setState({ estimateMs: 14 * 3_600_000 }));
		await page.getByTestId('batch-export').click();
		const dialog = page.getByTestId('long-batch');
		await expect(dialog).toContainText('This batch would take about 14 h on this computer.');
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(dialog).toBeHidden();
		expect((await photos(page)).map((p) => p.status)).toEqual(['queued', 'queued']);
		await page.getByTestId('batch-export').click();
		await page.getByTestId('long-batch').getByRole('button', { name: 'Start anyway' }).click();
		await expect(page.getByTestId('batch-summary')).toContainText('2 photos exported to Wedding', { timeout: 30_000 });
	});
});

test.describe('the settings are the batch’s (§5.4)', () => {
	test('click a photo to tune it; ← → move through the batch; the export uses those settings', async ({ page }) => {
		await folders(page);
		await page.goto('/');
		await choose(page, ['noisy-gradient.png', 'meta-camera.jpg', 'noisy-gradient.jpg']);
		await readyToExport(page);
		// In name order: meta-camera.jpg, noisy-gradient.jpg, noisy-gradient.png.
		await cell(page, 'noisy-gradient.png')
			.getByRole('button', { name: /^Open noisy-gradient.png/ })
			.click();
		await expect(page.getByTestId('editor')).toBeVisible();
		await expect(page.getByTestId('batch-position')).toHaveText('3 of 3');
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByTestId('batch-position')).toHaveText('2 of 3');
		await expect(page.getByRole('heading', { name: 'noisy-gradient.jpg' })).toBeVisible();
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByRole('heading', { name: 'meta-camera.jpg' })).toBeVisible();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('heading', { name: 'noisy-gradient.png' })).toBeVisible();
		await expect(page.getByTestId('batch-position')).toHaveText('3 of 3');
		// Strength 0 on this photo: the batch's export is the original, exactly.
		await waitForPreview(page);
		const strength = page.getByRole('slider', { name: 'Strength' });
		await strength.focus();
		await page.keyboard.press('Home');
		await expect(strength).toHaveAttribute('aria-valuenow', '0');
		await page.getByTestId('batch-back').click();
		await expect(page.getByTestId('batch-grid')).toBeVisible();
		await expect(page.getByRole('slider', { name: 'Strength' })).toHaveAttribute('aria-valuenow', '0');
		await page.getByTestId('batch-export').click();
		await expect(page.getByTestId('batch-summary')).toContainText('3 photos exported', { timeout: 30_000 });
		const png = await decode(page, await read(page, 'Wedding/noisy-gradient-denoised.png'));
		const original = await decode(page, readFileSync(fixture('noisy-gradient.png')));
		expect(Buffer.from(png.data).equals(Buffer.from(original.data))).toBe(true);
	});

	test('⌘/Ctrl+E in a photo of the batch exports the whole batch', async ({ page }) => {
		await folders(page);
		await page.goto('/');
		await choose(page, ['noisy-gradient.jpg', 'meta-camera.jpg']);
		await readyToExport(page);
		await cell(page, 'meta-camera.jpg').getByRole('button', { name: /^Open/ }).click();
		await expect(page.getByTestId('editor')).toBeVisible();
		await page.keyboard.press('ControlOrMeta+e');
		await expect(page.getByTestId('batch-summary')).toContainText('2 photos exported to Wedding', { timeout: 30_000 });
	});

	test('more photos dropped onto the grid join the batch', async ({ page }) => {
		await page.goto('/');
		await choose(page, ['noisy-gradient.jpg', 'meta-camera.jpg']);
		await expect(page.getByTestId('batch-photo')).toHaveCount(2);
		const bytes = readFileSync(fixture('noisy-gradient.png')).toString('base64');
		await page.evaluate((data) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'dropped.png'));
			window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
		}, bytes);
		await expect(page.getByTestId('batch-photo')).toHaveCount(3);
		await expect(page.getByTestId('batch-count')).toHaveText('3 photos');
	});
});

/** ZIP parts land in Downloads: collect them as they come. */
function collectDownloads(page: Page): Download[] {
	const downloads: Download[] = [];
	page.on('download', (download) => downloads.push(download));
	return downloads;
}

/** An independent reader (Python's zipfile) checks every CRC and lists what's inside. */
async function unzip(download: Download): Promise<Record<string, Buffer>> {
	const dir = mkdtempSync(path.join(tmpdir(), 'hush-batch-'));
	try {
		const file = path.join(dir, 'part.zip');
		writeFileSync(file, readFileSync(await download.path()));
		const script = [
			'import base64, json, sys, zipfile',
			'z = zipfile.ZipFile(sys.argv[1])',
			'assert z.testzip() is None',
			'print(json.dumps({i.filename: base64.b64encode(z.read(i)).decode() for i in z.infolist()}))',
		].join('\n');
		const files = JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' })) as Record<
			string,
			string
		>;
		return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, Buffer.from(data, 'base64')]));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test.describe('ZIP files in parts (§2.8: Safari, Firefox)', () => {
	test.beforeEach(async ({ page }) => {
		// A browser that can't write to folders, with parts small enough to fill from test photos.
		await page.addInitScript(() => {
			Reflect.deleteProperty(window, 'showDirectoryPicker');
			window.__hushZipPartBytes = 60_000;
		});
	});

	test('each part downloads as it fills, and every photo is in one, intact', async ({ page }) => {
		const downloads = collectDownloads(page);
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Choose folder' })).toHaveCount(0);
		await choose(page, ['noisy-gradient.jpg', 'meta-camera.jpg', 'noisy-gradient.png']);
		await expect(page.getByTestId('save-location')).toHaveText('Saving to: ZIP files in Downloads');
		await readyToExport(page);
		await page.getByTestId('batch-export').click();
		await expect(page.getByTestId('batch-summary')).toContainText(/3 photos exported to Downloads \(\d ZIP files\)/, {
			timeout: 30_000,
		});
		await expect.poll(() => downloads.length).toBeGreaterThanOrEqual(2);
		const names = downloads.map((d) => d.suggestedFilename());
		expect(names).toEqual(names.map((_, i) => `photos-denoised-${i + 1}.zip`));
		const contents = Object.assign({}, ...(await Promise.all(downloads.map(unzip)))) as Record<string, Buffer>;
		expect(Object.keys(contents).sort()).toEqual([
			'meta-camera-denoised.jpg',
			'noisy-gradient-denoised.jpg',
			'noisy-gradient-denoised.png',
		]);
		const after = (await exifr.parse(contents['meta-camera-denoised.jpg']!, EXIF_OPTIONS)) as Record<string, unknown>;
		expect(after['Software']).toBe('Hush');
		expect(after['Make']).toBe('Canon');
	});

	test('reloading mid-batch warns first; afterwards the same photos chosen again skip what’s downloaded', async ({
		page,
	}) => {
		const downloads = collectDownloads(page);
		const dialogs: string[] = [];
		page.on('dialog', (dialog) => {
			dialogs.push(dialog.type());
			void dialog.accept();
		});
		await page.goto('/');
		const files = ['noisy-gradient.jpg', 'meta-camera.jpg', 'noisy-gradient.png'];
		await choose(page, files);
		await readyToExport(page);
		await page.evaluate(() => window.__hushBatchFaults!({ delayMs: 1500 }));
		const firstPart = page.waitForEvent('download');
		await page.getByTestId('batch-export').click();
		// The first part downloads once the second photo no longer fits in it; the third is still being worked on.
		const first = Object.keys(await unzip(await firstPart));
		expect(first).toHaveLength(1);
		await page.reload();
		expect(dialogs).toEqual(['beforeunload']);

		const resume = page.getByTestId('resume-batch');
		await expect(resume).toContainText(`${first.length} of 3 photos are exported.`);
		const chooser = page.waitForEvent('filechooser');
		await resume.getByRole('button', { name: 'Choose the photos again' }).click();
		await (await chooser).setFiles(files.map(fixture));
		await expect(page.getByTestId('batch-photo').and(page.locator('[data-status="skipped"]'))).toHaveCount(
			first.length,
		);
		await expect(page.getByTestId('resumed')).toHaveText(
			`Picking up where the last batch stopped: ${first.length} photo was already exported.`,
		);
		await readyToExport(page);
		await expect(page.getByTestId('batch-export')).toContainText(`Export ${3 - first.length} photo`);
		await page.getByTestId('batch-export').click();
		await expect(page.getByTestId('batch-summary')).toContainText('exported to Downloads', { timeout: 30_000 });
		const later = await Promise.all(downloads.slice(1).map(unzip));
		const rest = later.flatMap((part) => Object.keys(part));
		expect([...first, ...rest].sort()).toEqual([
			'meta-camera-denoised.jpg',
			'noisy-gradient-denoised.jpg',
			'noisy-gradient-denoised.png',
		]);
		// Numbering carries on from the part before the reload.
		expect(downloads[1]!.suggestedFilename()).toBe('photos-denoised-2.zip');
		// Finished: nothing left to resume.
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Drop photos here to remove noise' })).toBeVisible();
		await page.waitForTimeout(500);
		await expect(page.getByTestId('resume-batch')).toHaveCount(0);
	});

	test('§5.4: above 50 photos, says why Chrome or Edge suit large batches better', async ({ page }) => {
		await page.goto('/');
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('button', { name: 'Choose photos' }).click();
		const bytes = readFileSync(fixture('noisy-gradient.jpg'));
		await (
			await chooser
		).setFiles(Array.from({ length: 51 }, (_, i) => ({ name: `IMG_${i}.jpg`, mimeType: 'image/jpeg', buffer: bytes })));
		await expect(page.getByTestId('prefer-chrome')).toHaveText(
			'Large batches work best in Chrome or Edge, which can save straight to a folder and resume if interrupted.',
		);
	});
});

test.describe('in Taiwan', () => {
	test.use({ locale: 'zh-TW' });

	test('the batch speaks Traditional Chinese with Taiwan terms', async ({ page }) => {
		await folders(page);
		await page.goto('/');
		await choose(page, ['noisy-gradient.jpg', 'meta-camera.jpg'], '選擇相片');
		await expect(page.getByTestId('batch-count')).toHaveText('2 張相片');
		await readyToExport(page);
		await expect(page.getByTestId('batch-export')).toContainText('匯出 2 張相片');
		await page.getByTestId('batch-export').click();
		await expect(page.getByTestId('batch-summary')).toContainText('已將 2 張相片匯出至「Wedding」', {
			timeout: 30_000,
		});
		await expect(cell(page, 'meta-camera.jpg')).toContainText('已匯出');
	});
});
