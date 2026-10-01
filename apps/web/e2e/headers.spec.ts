// SPDX-License-Identifier: Apache-2.0
import { expect, test } from './fixtures';

// §4.4 and §4.7: the headers that make the privacy promise enforceable and
// the page cross-origin isolated, as Cloudflare serves them from _headers.
test.describe('response headers', () => {
	test('the page is locked to its own origin and cross-origin isolated', async ({ request }) => {
		const response = await request.get('/');
		expect(response.status()).toBe(200);
		const headers = response.headers();
		const csp = headers['content-security-policy'] ?? '';
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("connect-src 'self'");
		expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(headers['cross-origin-opener-policy']).toBe('same-origin');
		expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
		expect(headers['cross-origin-resource-policy']).toBe('same-origin');
		expect(headers['x-content-type-options']).toBe('nosniff');
		expect(headers['referrer-policy']).toBe('no-referrer');
		expect(headers['cache-control']).toBe('no-cache');
	});

	test('the model manifest always revalidates; model parts and the runtime never change', async ({ request }) => {
		const manifest = await request.get('/models/manifest.json');
		expect(manifest.headers()['cache-control']).toBe('no-cache');
		const { models } = (await manifest.json()) as { models: Array<{ variants: Array<{ parts: string[] }> }> };
		const part = await request.get(`/models/${models[0]!.variants[0]!.parts[0]!}`);
		expect(part.status()).toBe(200);
		expect(part.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
	});

	test('hashed assets are cached forever', async ({ page, request }) => {
		await page.goto('/');
		const script = await page.locator('script[type="module"][src^="/assets/"]').first().getAttribute('src');
		const response = await request.get(script!);
		expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
	});

	test('unknown paths get a 404 page with the same headers', async ({ request }) => {
		const response = await request.get('/no-such-page');
		expect(response.status()).toBe(404);
		expect(await response.text()).toContain('Open Hush');
		expect(response.headers()['content-security-policy']).toContain("connect-src 'self'");
	});

	test('the page is cross-origin isolated, so the processor path is multithreaded', async ({ page }) => {
		await page.goto('/');
		expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
		expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
	});
});
