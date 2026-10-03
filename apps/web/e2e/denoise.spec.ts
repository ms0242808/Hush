// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { choosePhoto, editorState, expect, fixture, readPhoto, test, waitForPreview } from './fixtures';

// The whole path, end to end: decode → preview tiles in a worker → feathered
// composite → the viewer's adjust shader → export at full size. CI runs the
// test model, which inverts colours exactly, so any off-by-one anywhere shows
// up as a mismatch.

async function expectExactInversion(page: Page) {
	await waitForPreview(page);
	const original = await readPhoto(page, 'original');
	const result = await readPhoto(page, 'result');
	expect(original.width).toBeGreaterThan(0);
	expect([result.width, result.height]).toEqual([original.width, original.height]);
	let worst = 0;
	for (let i = 0; i < original.data.length; i += 4) {
		for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(255 - original.data[i + c]! - result.data[i + c]!));
	}
	expect(worst, 'largest deviation from 255 − input, in levels').toBe(0);
}

test.describe('one photo', () => {
	test('a PNG goes through the whole pipeline and comes back exactly as the model made it', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled();
		await expect(page.getByTestId('photo-size')).toHaveText(/^260 × 180 · /);
		await expectExactInversion(page);
	});

	test('export saves name-denoised.jpg and says where', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.jpg');
		await expect(page.getByText('Saving to: Downloads')).toBeVisible();
		await waitForPreview(page);
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Export' }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe('noisy-gradient-denoised.jpg');
		const bytes = readFileSync(await file.path());
		expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
		expect(bytes.byteLength).toBeGreaterThan(1000);
		await expect(page.getByText('Saved noisy-gradient-denoised.jpg to Downloads')).toBeVisible();
	});

	test('a photo dropped anywhere on the window is opened', async ({ page }) => {
		await page.goto('/');
		const bytes = [...readFileSync(fixture('noisy-gradient.png'))];
		await page.evaluate((data) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array(data)], 'dropped.png', { type: 'image/png' }));
			document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
		}, bytes);
		await expect(page.getByTestId('drop-zone')).toHaveAttribute('data-over', 'true');
		await expect(page.getByRole('heading', { name: 'Release to remove noise' })).toBeVisible();
		await page.evaluate((data) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array(data)], 'dropped.png', { type: 'image/png' }));
			document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
		}, bytes);
		await expect(page.getByRole('heading', { name: 'dropped.png' })).toBeVisible();
		await expectExactInversion(page);
	});

	test('a pasted photo is opened', async ({ page }) => {
		await page.goto('/');
		const bytes = [...readFileSync(fixture('noisy-gradient.png'))];
		await page.evaluate((data) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array(data)], 'pasted.png', { type: 'image/png' }));
			window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, cancelable: true }));
		}, bytes);
		await expect(page.getByRole('heading', { name: 'pasted.png' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled();
	});

	test('another photo dropped on the editor replaces the one open, keeping the model', async ({ page }) => {
		const parts: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/models/parts/')) parts.push(request.url());
		});
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		const fetched = parts.length;
		expect(fetched).toBeGreaterThan(0);
		const bytes = [...readFileSync(fixture('noisy-gradient.jpg'))];
		await page.evaluate((data) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array(data)], 'second.jpg', { type: 'image/jpeg' }));
			document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
		}, bytes);
		await expect(page.getByText('Release to open this photo')).toBeVisible();
		await page.evaluate((data) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array(data)], 'second.jpg', { type: 'image/jpeg' }));
			document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
		}, bytes);
		await expect(page.getByRole('heading', { name: 'second.jpg' })).toBeVisible();
		await waitForPreview(page);
		expect(parts.length, 'the model is not fetched again').toBe(fetched);
	});

	test('a file that isn’t a photo gets a clear message, and the way back', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'not-a-photo.txt');
		await expect(page.getByRole('alert')).toContainText("not-a-photo.txt isn't a format Hush can open yet.");
		await page.getByRole('button', { name: 'Open another photo' }).click();
		await expect(page.getByRole('button', { name: 'Choose photo' })).toBeVisible();
	});

	test('a damaged photo gets a clear message that stays, while the model download carries on', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'corrupt.jpg');
		const alert = page.getByRole('alert');
		await expect(alert).toContainText("corrupt.jpg couldn't be opened.");
		// The model download started in parallel; its late progress must not replace the error.
		await page.waitForTimeout(1500);
		await expect(alert).toBeVisible();
		await expect(page.getByRole('progressbar')).toHaveCount(0);
		await page.getByRole('button', { name: 'Open another photo' }).click();
		await expect(page.getByRole('button', { name: 'Choose photo' })).toBeVisible();
	});

	test('a model that returns NaN is refused instead of exporting a black photo', async ({ page }) => {
		await page.goto('/?model=hush-test-nan');
		await choosePhoto(page, 'noisy-gradient.png');
		await expect(page.getByRole('alert')).toContainText(
			'Noise removal produced an unusable result, so nothing was saved.',
		);
		await expect(page.getByRole('button', { name: 'Export' })).toBeDisabled();
		expect((await editorState(page))?.error).toBe('ModelOutputError');
	});
});

test.describe('the viewer', () => {
	test('stays idle once drawn: no redraw loop', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		await page.waitForTimeout(500);
		const draws = () => page.evaluate(() => window.__hushViewer!.draws);
		const settled = await draws();
		await page.waitForTimeout(1500);
		expect(await draws(), 'redraws while nothing changed').toBe(settled);
	});

	test('draws at 100%: one photo pixel per device pixel, upright, centred', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);
		const state = await page.evaluate(() => window.__hushViewer!.state());
		expect(state.zoom).toBe(1);
		expect([state.photo.width, state.photo.height]).toEqual([260, 180]);
		expect(Math.abs(state.photo.x - (state.viewport.width - 260) / 2)).toBeLessThanOrEqual(1);
	});
});

test.describe('keyboard (§5.8)', () => {
	test('\\ shows the original, the divider moves with arrow keys, ⌘/Ctrl+O opens a photo', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await waitForPreview(page);

		const divider = page.getByRole('slider', { name: 'Before and after' });
		await expect(divider).toHaveAttribute('aria-valuenow', '50');
		await divider.focus();
		await page.keyboard.press('ArrowLeft');
		await expect(divider).toHaveAttribute('aria-valuenow', '49');
		await page.keyboard.press('Shift+ArrowRight');
		await expect(divider).toHaveAttribute('aria-valuenow', '59');

		await page.keyboard.press('Backslash');
		await expect(page.getByText('After', { exact: true })).toHaveCount(0);
		await expect(page.getByText('Original', { exact: true })).toBeVisible();
		await page.keyboard.press('Backslash');
		await expect(page.getByText('After', { exact: true })).toBeVisible();

		const chooser = page.waitForEvent('filechooser');
		await page.keyboard.press('ControlOrMeta+o');
		await chooser;
	});
});
