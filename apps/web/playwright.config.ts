// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a production build served by `wrangler dev`,
 * so the real `_headers` file applies: CSP, COOP/COEP and caching are exactly
 * what Cloudflare sends. `pnpm e2e` builds `dist-e2e` with the tiny test
 * models first (HUSH_MODELS=test), so CI needs no real model and real models
 * fetched locally are never touched.
 */
const port = 8790;

export default defineConfig({
	testDir: 'e2e',
	timeout: 60_000,
	fullyParallel: true,
	forbidOnly: !!process.env['CI'],
	retries: process.env['CI'] ? 1 : 0,
	reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: 'retain-on-failure',
		locale: 'en-US',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: `pnpm exec wrangler dev --config ../../deploy/cloudflare/wrangler.jsonc --assets dist-e2e --port ${port} --ip 127.0.0.1`,
		url: `http://127.0.0.1:${port}/`,
		reuseExistingServer: !process.env['CI'],
		timeout: 120_000,
		stdout: 'ignore',
		stderr: 'pipe',
	},
});
