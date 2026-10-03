// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import exifr from 'exifr';
import { expect, test } from '../fixtures';
import '../harness';

/**
 * Phase 2's acceptance check, with the real NAFNet on this machine's GPU:
 *
 *   "A photographer drops a 45 MP JPEG, sees a clear before/after at 100%
 *    within the preview target once the model is cached, and exports a file
 *    whose EXIF matches the original."
 *
 * The 45 MP JPEG is synthetic (tools/fixtures/make_large.py writes it on the
 * first run). Set HUSH_PHOTO to a real photo to run the same checks on it.
 * Results are printed and attached, for docs/phase-2-results.md.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const LARGE = path.join(here, '.photos', 'synthetic-8256x5504.jpg');
const EXIF_OPTIONS = {
	tiff: true,
	exif: true,
	gps: true,
	interop: true,
	ifd1: true,
	makerNote: true,
	translateValues: false,
	reviveValues: false,
};

test.beforeAll(() => {
	if (existsSync(LARGE)) return;
	execFileSync('uv', ['run', 'make_large.py'], {
		cwd: path.resolve(here, '../../../../tools/fixtures'),
		stdio: 'inherit',
	});
});

function note(name: string, value: string) {
	test.info().annotations.push({ type: name, description: value });
	console.log(`${test.info().title} — ${name}: ${value}`);
}

async function choose(page: Page, file: string) {
	const chooser = page.waitForEvent('filechooser');
	await page
		.getByRole('button', { name: /^(Choose photo|Open another photo)$/ })
		.first()
		.click();
	await (await chooser).setFiles(file);
}

interface Timeline {
	shown: number;
	firstTile: number;
	oneMegapixel: number;
	whole: number;
	tiles: number;
}

/** Time from choosing the photo: on screen, first denoised tile, ~1 MP around the divider, the whole view. */
async function openAndTime(page: Page, file: string): Promise<Timeline> {
	const started = Date.now();
	await choose(page, file);
	let shown = 0;
	let firstTile = 0;
	let oneMegapixel = 0;
	for (;;) {
		const state = await page.evaluate(() => {
			const s = window.__hushEditor?.getState();
			const ready = document.querySelector('[data-testid="viewer"]')?.getAttribute('data-ready') === 'true';
			return s
				? {
						ready,
						done: s.preview.done,
						planned: s.preview.planned,
						running: s.preview.running,
						error: s.preview.error?.name ?? null,
						tile: (s.previewInfo as { tileSize: number } | null)?.tileSize ?? 0,
					}
				: null;
		});
		const t = Date.now() - started;
		if (state?.error) throw new Error(`The preview failed: ${state.error}`);
		if (state?.ready && !shown) shown = t;
		if (state && state.done >= 1 && !firstTile) firstTile = t;
		// Four preview tiles of 512 px are about one megapixel around the divider.
		if (state && state.done >= Math.min(4, state.planned) && state.planned > 0 && !oneMegapixel) oneMegapixel = t;
		if (state && state.planned > 0 && state.done === state.planned && !state.running) {
			return { shown, firstTile, oneMegapixel, whole: t, tiles: state.planned };
		}
		if (t > 300_000) throw new Error('The preview did not finish in 5 minutes');
		await page.waitForTimeout(25);
	}
}

/** How noisy the visible photo is: mean absolute Laplacian of luminance, original and result. */
function noiseLevels(page: Page) {
	return page.evaluate(() => {
		const level = (photo: { width: number; height: number; data: Uint8Array } | null) => {
			if (!photo) return NaN;
			const { width, height, data } = photo;
			const y = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
			let sum = 0;
			let count = 0;
			for (let row = 1; row < height - 1; row += 2) {
				for (let col = 1; col < width - 1; col += 2) {
					const i = (row * width + col) * 4;
					sum += Math.abs(4 * y(i) - y(i - 4) - y(i + 4) - y(i - width * 4) - y(i + width * 4));
					count++;
				}
			}
			return sum / count;
		};
		return {
			original: level(window.__hushViewer!.readPhoto('original')),
			result: level(window.__hushViewer!.readPhoto('result')),
		};
	});
}

async function exportAndCompare(page: Page, source: string) {
	const download = page.waitForEvent('download', { timeout: 600_000 });
	const started = Date.now();
	await page.getByTestId('export-button').click();
	const file = await download;
	const ms = Date.now() - started;
	await expect(page.getByText(/^Saved .+ to Downloads$/)).toBeVisible({ timeout: 60_000 });
	const out = readFileSync(await file.path());
	const [before, after] = (await Promise.all([
		exifr.parse(readFileSync(source), EXIF_OPTIONS),
		exifr.parse(out, EXIF_OPTIONS),
	])) as [Record<string, unknown> | undefined, Record<string, unknown> | undefined];
	const a = before ?? {};
	const b = after ?? {};
	const changed = Object.keys({ ...a, ...b }).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
	return {
		ms,
		name: file.suggestedFilename(),
		bytes: out.byteLength,
		tags: Object.keys(a).length,
		changed,
		software: b['Software'],
	};
}

test('Phase 2 acceptance: a 45 MP JPEG, before/after at 100% within the preview target, EXIF kept', async ({
	page,
}) => {
	test.setTimeout(900_000);
	// First visit: the model downloads and is cached.
	await page.goto('/');
	await openAndTime(page, LARGE);
	// Then as a photographer comes back: model cached, a fresh page.
	await page.reload();
	await page.getByRole('button', { name: 'Choose photo' }).waitFor();
	await page.waitForTimeout(1500); // the editor's code warms while the page is idle, as on a real visit
	const timeline = await openAndTime(page, LARGE);
	const state = await page.evaluate(() => {
		const s = window.__hushEditor!.getState();
		return { backend: s.backend, timings: s.timings, estimate: s.estimateMs, previewInfo: s.previewInfo };
	});
	note(
		'preview, model cached',
		`photo on screen ${timeline.shown} ms · first denoised tile ${timeline.firstTile} ms · ~1 MP ${timeline.oneMegapixel} ms · whole view (${timeline.tiles} tiles) ${timeline.whole} ms · ${JSON.stringify(state.timings)}`,
	);
	expect(state.backend).toBe('webgpu');
	expect(state.timings['model from cache']).toBeDefined();
	// §4.6: the preview within 3 s (the borderline line), measured from choosing the photo — decoding and
	// building the GPU session included, which the spec's figure for the inference alone leaves out.
	expect(timeline.firstTile).toBeLessThan(3000);

	// A clear before/after: the result is visibly less noisy than the original, at 100%.
	const view = await page.evaluate(() => window.__hushViewer!.state());
	expect(view.zoom).toBe(1);
	const noise = await noiseLevels(page);
	note('noise, mean |Laplacian|', `original ${noise.original.toFixed(2)} → result ${noise.result.toFixed(2)}`);
	expect(noise.result).toBeLessThan(noise.original * 0.7);

	const exported = await exportAndCompare(page, LARGE);
	note(
		'export',
		`${exported.ms} ms (estimate ${Math.round(state.estimate ?? 0)} ms) → ${exported.name}, ${(exported.bytes / 1e6).toFixed(1)} MB · ${exported.tags} tags, changed: ${exported.changed.join(', ')}`,
	);
	expect(exported.changed).toEqual(['Software']);
	expect(exported.software).toBe('Hush');
});

test('the chosen folder survives a reload (installed Chrome keeps the handle)', async ({ page }) => {
	await page.addInitScript(() => {
		(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
			async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Wedding', { create: true });
	});
	await page.goto('/');
	await choose(page, path.join(here, '../fixtures/noisy-gradient.jpg'));
	await page.getByTestId('save-location').click();
	await page.getByRole('menuitem', { name: 'Choose a folder…' }).click();
	await expect(page.getByTestId('save-location')).toHaveText(/Saving to: Wedding/);
	await page.reload();
	await choose(page, path.join(here, '../fixtures/noisy-gradient.jpg'));
	await expect(page.getByTestId('save-location')).toHaveText(/Saving to: Wedding/);
	await page.getByTestId('export-button').click();
	await expect(page.getByText(/^Saved noisy-gradient-denoised(?: \(\d+\))?\.jpg to Wedding$/)).toBeVisible({
		timeout: 60_000,
	});
});

test('a real photo (HUSH_PHOTO): preview, a 1:1 crop across the divider, export with its EXIF', async ({ page }) => {
	const photo = process.env['HUSH_PHOTO'];
	test.skip(!photo, 'Set HUSH_PHOTO to a photo to run this');
	test.setTimeout(900_000);
	await page.goto('/');
	const timeline = await openAndTime(page, photo!);
	note(
		'preview, first visit',
		`on screen ${timeline.shown} ms · first tile ${timeline.firstTile} ms · whole view ${timeline.whole} ms`,
	);
	const noise = await noiseLevels(page);
	note('noise, mean |Laplacian|', `original ${noise.original.toFixed(2)} → result ${noise.result.toFixed(2)}`);
	await page.getByTestId('viewer').screenshot({ path: test.info().outputPath('viewer.png') });
	const exported = await exportAndCompare(page, photo!);
	note(
		'export',
		`${exported.ms} ms → ${exported.name} · ${exported.tags} tags, changed: ${exported.changed.join(', ') || 'none'}`,
	);
	expect(exported.changed.filter((key) => key !== 'Software')).toEqual([]);
});
