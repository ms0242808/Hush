// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from '@playwright/test';

/**
 * Checks that need the real NAFNet model and a real GPU: golden images,
 * seams, device-loss recovery on WebGPU, and a 102 MP photo through the
 * model. Run locally — CI has neither the published model nor a GPU:
 *
 *   pnpm fetch-models --from tools/models/out   (or from Hugging Face once published)
 *   pnpm --filter @hush/web e2e:real
 *
 * The build ships the release models in the `e2e` mode, which keeps fault
 * injection, served with the production `_headers` by `wrangler dev`. The
 * browser is the installed Google Chrome, which has WebGPU on this machine's
 * GPU; Playwright's bundled Chromium may not.
 */
const port = 8791;

export default defineConfig({
	testDir: 'e2e/real',
	timeout: 600_000,
	fullyParallel: false,
	workers: 1,
	reporter: 'list',
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		channel: 'chrome',
		viewport: { width: 1280, height: 800 },
		locale: 'en-US',
	},
	webServer: {
		command: `pnpm exec wrangler dev --config ../../deploy/cloudflare/wrangler.jsonc --assets dist-real --port ${port} --ip 127.0.0.1`,
		url: `http://127.0.0.1:${port}/`,
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: 'ignore',
		stderr: 'pipe',
	},
});
