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

	test('the 100% preview stays inside its panel when the page scrolls', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 640 });
		await page.goto('/bench/?backend=wasm');
		await page.getByTestId('bench-run').click();
		const frame = page.getByTestId('compare-frame');
		await expect(frame).toBeVisible();
		// Clicking Run scrolled the page to reach the button; scroll back after the preview is laid out.
		const scrolled = await page.evaluate(() => window.scrollY);
		expect(scrolled).toBeGreaterThan(0);
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.waitForTimeout(200);
		const { inside, scale } = await page.evaluate(() => {
			const stage = document.querySelector('[data-testid="compare-stage"]')!.getBoundingClientRect();
			const box = document.querySelector('[data-testid="compare-frame"]')!.getBoundingClientRect();
			const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="compare-frame"] canvas')!;
			return {
				inside:
					box.left >= stage.left - 0.5 &&
					box.right <= stage.right + 0.5 &&
					box.top >= stage.top - 0.5 &&
					box.bottom <= stage.bottom + 0.5,
				// One photo pixel per device pixel.
				scale: canvas.width / (canvas.getBoundingClientRect().width * window.devicePixelRatio),
			};
		});
		expect(inside).toBe(true);
		expect(scale).toBeCloseTo(1, 5);
	});
});
