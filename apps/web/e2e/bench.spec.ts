// SPDX-License-Identifier: Apache-2.0
import { expect, test } from './fixtures';

// The Phase 0 benchmark page: it must work on any machine someone opens it
// on, since that's how the remaining measurements get made.
test.describe('benchmark page', () => {
	test('reports the environment and measures a run on the processor', async ({ page }) => {
		await page.goto('/bench/?backend=wasm');
		await expect(page.getByTestId('isolated')).toHaveText('yes (threads on)');
		await expect(page.getByTestId('situation')).not.toBeEmpty();

		await page.getByTestId('bench-run').click();
		const results = page.getByTestId('bench-results');
		await expect(results.getByRole('row')).toHaveCount(2); // header + one run
		await expect(results).toContainText('wasm');
		await expect(results).toContainText('hush-test-invert');
		await expect(results).toContainText('1024×1024');
	});

	test('the seam check finds tiling invisible for a per-pixel model', async ({ page }) => {
		await page.goto('/bench/?backend=wasm');
		await page.getByRole('button', { name: 'Seam check' }).click();
		await expect(page.getByTestId('bench-results')).toContainText('tiled vs whole: Infinity dB · max diff 0');
	});
});
