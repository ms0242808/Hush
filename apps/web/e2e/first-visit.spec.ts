// SPDX-License-Identifier: Apache-2.0
import { expect, test } from './fixtures';

// §5.2 and §5.9: the root URL is the tool; the first paint is a drop zone with
// the privacy promise, in the visitor's language.
test.describe('first visit', () => {
	test('opens on a drop zone with the privacy promise', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Drop a photo here to remove noise' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Choose photo' })).toBeVisible();
		await expect(page.getByText('Your photos stay on this device. Nothing is uploaded.')).toBeVisible();
		await expect(page).toHaveTitle(/Hush/);
	});

	test('"How we know" explains, in three verifiable sentences, and links the source', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('button', { name: 'How we know' }).click();
		const dialog = page.getByRole('dialog', { name: 'How we know your photos stay here' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('listitem')).toHaveCount(3);
		await expect(dialog.getByRole('link', { name: 'Read the source code' })).toHaveAttribute(
			'href',
			'https://github.com/ms0242808/Hush',
		);
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	});

	test('loads no model and no runtime until a photo is chosen', async ({ page }) => {
		const heavy: string[] = [];
		page.on('request', (request) => {
			if (/\/models\/|\/ort\//.test(request.url())) heavy.push(request.url());
		});
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Choose photo' })).toBeVisible();
		await page.waitForLoadState('networkidle');
		expect(heavy).toEqual([]);
	});

	test.describe('in Taiwan', () => {
		test.use({ locale: 'zh-TW' });

		test('speaks Traditional Chinese with Taiwan photography terms', async ({ page }) => {
			await page.goto('/');
			await expect(page.getByRole('heading', { name: '將相片拖曳至此以降低雜訊' })).toBeVisible();
			await expect(page.getByText('相片只會留在這部裝置上，不會上傳到任何地方。')).toBeVisible();
			await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
		});
	});

	test.describe('in mainland China', () => {
		test.use({ locale: 'zh-CN' });

		test('falls back to English rather than Traditional Chinese', async ({ page }) => {
			await page.goto('/');
			await expect(page.getByRole('heading', { name: 'Drop a photo here to remove noise' })).toBeVisible();
		});
	});

	test('a manual language switch is remembered', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('radio', { name: '繁體中文' }).click();
		await expect(page.getByRole('heading', { name: '將相片拖曳至此以降低雜訊' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('heading', { name: '將相片拖曳至此以降低雜訊' })).toBeVisible();
		await page.getByRole('radio', { name: 'English' }).click();
		await expect(page.getByRole('heading', { name: 'Drop a photo here to remove noise' })).toBeVisible();
	});
});
