// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, fixture, readComparison, test } from './fixtures';

// The whole spike, end to end: decode → tile → infer in a worker → band
// accumulate → blend → preview → export. CI runs the test model, which
// inverts colours exactly, so any off-by-one anywhere shows up as a mismatch.

async function choosePhoto(page: Page, name: string) {
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Choose photo' }).click();
	await (await chooser).setFiles(fixture(name));
}

async function expectExactInversion(page: Page) {
	await expect(page.getByTestId('compare-frame')).toBeVisible();
	const { width, height, before, after } = await readComparison(page);
	expect(width).toBeGreaterThan(0);
	expect(height).toBeGreaterThan(0);
	let worst = 0;
	for (let i = 0; i < before.length; i += 4) {
		for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(255 - before[i + c]! - after[i + c]!));
	}
	expect(worst, 'largest deviation from 255 − input, in levels').toBe(0);
}

test.describe('one photo', () => {
	test('a PNG goes through the whole pipeline and comes back exactly as the model made it', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
		await expect(page.getByText('260 × 180')).toBeVisible();
		await expect(page.getByText(/s on (processor|graphics chip)/)).toBeVisible();
		await expectExactInversion(page);
	});

	test('export saves name-denoised.jpg and says where', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.jpg');
		await expect(page.getByText('Saving to: Downloads')).toBeVisible();
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
		await expect(page.getByText('dropped.png', { exact: true })).toBeVisible();
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
		await expect(page.getByText('pasted.png', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
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
		await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
	});
});

test.describe('keyboard (§5.8)', () => {
	test('\\ shows the original, the divider moves with arrow keys, ⌘/Ctrl+O opens a photo', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'noisy-gradient.png');
		await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();

		const divider = page.getByRole('slider', { name: 'Before and after' });
		await expect(divider).toHaveAttribute('aria-valuenow', '50');
		await divider.focus();
		await page.keyboard.press('ArrowLeft');
		await expect(divider).toHaveAttribute('aria-valuenow', '49');
		await page.keyboard.press('Shift+ArrowRight');
		await expect(divider).toHaveAttribute('aria-valuenow', '59');

		await page.keyboard.press('Backslash');
		await expect(page.getByText('After', { exact: true })).toHaveCount(0);
		await page.keyboard.press('Backslash');
		await expect(page.getByText('After', { exact: true })).toBeVisible();

		const chooser = page.waitForEvent('filechooser');
		await page.keyboard.press('ControlOrMeta+o');
		await chooser;
	});
});
