// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { choosePhoto, expect, fixture, readPhoto, test, waitForPreview } from './fixtures';
import { extract, profileName, readExif } from './metadata';

/**
 * Phase 1 through the app as it stands: real camera and phone files open,
 * show upright, and export in their delivery format with their metadata.
 */

/** The red square in the corner of the scene, as the original and as the (inverted) result. */
async function expectUprightCorner(page: Page) {
	await waitForPreview(page);
	const before = await readPhoto(page, 'original');
	const after = await readPhoto(page, 'result');
	expect([before.width, before.height], 'drawn upright: portrait').toEqual([180, 260]);
	const width = before.width;
	const at = (photo: { data: number[] }, x: number, y: number) =>
		photo.data.slice((y * width + x) * 4, (y * width + x) * 4 + 3);
	const [r, g, b] = at(before, 20, 20);
	expect(r).toBeGreaterThan(150);
	expect(g).toBeLessThan(110);
	expect(b).toBeLessThan(110);
	const [ir, ig, ib] = at(after, 20, 20);
	expect(ir).toBeLessThan(105);
	expect(ig).toBeGreaterThan(145);
	expect(ib).toBeGreaterThan(145);
}

async function exportFile(page: Page) {
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export' }).click();
	const file = await download;
	return { name: file.suggestedFilename(), bytes: new Uint8Array(readFileSync(await file.path())) };
}

test.describe('photos from cameras and phones', () => {
	test('a JPEG with orientation 6 is shown upright, and saved as stored with its tag', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'meta-camera.jpg');
		await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
		// Stored 260 × 180, shown upright: a portrait photo reads as portrait.
		await expect(page.getByTestId('photo-size')).toHaveText(/^180 × 260 · /);
		await expectUprightCorner(page);

		const { name, bytes } = await exportFile(page);
		expect(name).toBe('meta-camera-denoised.jpg');
		const exif = await readExif(extract(bytes).exif!);
		expect(exif.ifd0).toMatchObject({ Make: 'Canon', Software: 'Hush', Orientation: 6 });
		expect(exif.gps).toBeDefined();
		await expect(page.getByText('Saved meta-camera-denoised.jpg to Downloads')).toBeVisible();
	});

	test('an iPhone-style HEIC opens upright and exports as a JPEG that stays upright', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'meta-phone.heic');
		await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
		await expect(page.getByTestId('photo-size')).toHaveText(/^180 × 260 · /);
		await expectUprightCorner(page);

		const { name, bytes } = await exportFile(page);
		expect(name).toBe('meta-phone-denoised.jpg');
		const out = extract(bytes);
		const exif = await readExif(out.exif!);
		expect(exif.ifd0).toMatchObject({ Make: 'Canon', Software: 'Hush', Orientation: 1 });
		expect(profileName(out.icc)).toBe('Display P3');
	});

	test('an AVIF opens upright from its container rotation', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'meta-camera.avif');
		await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
		await expectUprightCorner(page);
	});

	test('a CMYK JPEG and an animated WebP are refused with what to do instead', async ({ page }) => {
		await page.goto('/');
		await choosePhoto(page, 'refuse-cmyk.jpg');
		await expect(page.getByRole('alert')).toContainText('refuse-cmyk.jpg is a CMYK JPEG, made for printing presses.');
		await page.getByRole('button', { name: 'Open another photo' }).click();
		await choosePhoto(page, 'refuse-animated.webp');
		await expect(page.getByRole('alert')).toContainText('refuse-animated.webp is animated.');
	});

	test.describe('in Taiwan', () => {
		test.use({ locale: 'zh-TW' });

		test('the refusals speak Traditional Chinese too', async ({ page }) => {
			await page.goto('/');
			const chooser = page.waitForEvent('filechooser');
			await page.getByRole('button', { name: '選擇相片' }).click();
			await (await chooser).setFiles(fixture('refuse-cmyk.jpg'));
			await expect(page.getByRole('alert')).toContainText('是供印刷使用的 CMYK JPEG');
		});
	});
});

test.describe('the pipeline check on /bench/', () => {
	test('runs a photo end to end and compares the metadata that went in and came out', async ({ page }) => {
		await page.goto('/bench/?backend=wasm');
		const check = page.getByTestId('pipeline-check');
		const chooser = page.waitForEvent('filechooser');
		await check.getByRole('button', { name: 'Choose photo' }).click();
		await (await chooser).setFiles(fixture('meta-camera.jpg'));
		await expect(check.getByTestId('pipeline-file')).toContainText('meta-camera.jpg');
		await check.getByLabel('Remove location').check();
		await check.getByRole('button', { name: 'Run pipeline' }).click();

		const table = check.getByTestId('pipeline-metadata');
		await expect(table).toBeVisible();
		await expect(check.getByTestId('pipeline-stages').locator('[data-state="done"]')).toHaveCount(5);
		const row = (field: string) => table.locator(`tr[data-field="${field}"]`);
		await expect(row('software')).toHaveAttribute('data-changed', 'true');
		await expect(row('software').locator('td').nth(1)).toHaveText('Hush');
		await expect(row('location')).toHaveAttribute('data-changed', 'true');
		await expect(row('location').locator('td').nth(0)).toContainText('25.0368° N, 121.5627° E');
		await expect(row('location').locator('td').nth(1)).toHaveText('—');
		for (const field of ['camera', 'lens', 'taken', 'exposure', 'profile', 'iptc', 'orientation', 'size']) {
			await expect(row(field), `${field} unchanged`).toHaveAttribute('data-changed', 'false');
		}
		await expect(row('camera').locator('td').nth(0)).toHaveText('Canon EOS R5');
		await expect(row('iptc').locator('td').nth(0)).toHaveText('“First dance”');
		await expect(check.getByRole('link', { name: 'Download meta-camera-denoised.jpg' })).toBeVisible();
	});
});
