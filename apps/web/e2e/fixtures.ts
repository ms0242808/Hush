// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

export const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);

interface Watch {
	/** Requests to any origin other than the page's own. */
	foreign: string[];
	/** CSP violations, from the page (securitypolicyviolation) and from workers (console). */
	csp: string[];
	pageErrors: string[];
}

/**
 * Every test watches the privacy promise: no request may leave the origin and
 * no CSP violation may occur (§6.6 rule 2). The checks run after each test.
 */
export const test = base.extend<{ watch: Watch }>({
	watch: [
		async ({ page, baseURL }, use) => {
			const origin = new URL(baseURL!).origin;
			const watch: Watch = { foreign: [], csp: [], pageErrors: [] };
			page.on('request', (request) => {
				const url = request.url();
				if (url.startsWith('blob:') || url.startsWith('data:')) return;
				if (new URL(url).origin !== origin) watch.foreign.push(url);
			});
			page.on('console', (message) => {
				if (/Content Security Policy|Refused to (load|connect|execute|create)/i.test(message.text())) {
					watch.csp.push(message.text());
				}
			});
			page.on('pageerror', (error) => watch.pageErrors.push(error.message));
			await page.addInitScript(() => {
				document.addEventListener('securitypolicyviolation', (event) => {
					console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`);
				});
			});
			await use(watch);
			expect(watch.foreign, 'requests left the origin').toEqual([]);
			expect(watch.csp, 'CSP violations').toEqual([]);
			expect(watch.pageErrors, 'uncaught page errors').toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };

/** Read the 1:1 before/after canvases of the compare view. */
export async function readComparison(page: Page) {
	return page.evaluate(() => {
		const canvases = [...document.querySelectorAll<HTMLCanvasElement>('[data-testid="compare-frame"] canvas')];
		const read = (canvas: HTMLCanvasElement) =>
			Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
		return {
			width: canvases[0]!.width,
			height: canvases[0]!.height,
			before: read(canvases[0]!),
			after: read(canvases[1]!),
		};
	});
}
