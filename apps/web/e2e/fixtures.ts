// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import './harness';

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

/** Choose a photo through the drop zone's button (or, in the editor, ⌘/Ctrl+O). */
export async function choosePhoto(page: Page, name: string, button = 'Choose photos') {
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: button }).click();
	await (await chooser).setFiles(fixture(name));
}

interface EditorProbe {
	model: string;
	done: number;
	planned: number;
	running: boolean;
	error: string | null;
	backend: string | null;
}

/** The editor's state, through its test hook (non-production builds only). */
export function editorState(page: Page): Promise<EditorProbe | null> {
	return page.evaluate(() => {
		const state = window.__hushEditor?.getState();
		if (!state) return null;
		return {
			model: state.model.status,
			done: state.preview.done,
			planned: state.preview.planned,
			running: state.preview.running,
			error: state.preview.error?.name ?? null,
			backend: state.backend,
		};
	});
}

/** Wait until the model is ready and every preview tile the view needs is drawn. */
export async function waitForPreview(page: Page, timeout = 30_000) {
	await expect
		.poll(
			async () => {
				const state = await editorState(page);
				return (
					state !== null &&
					state.model === 'ready' &&
					state.planned > 0 &&
					state.done === state.planned &&
					!state.running
				);
			},
			{ timeout, intervals: [100] },
		)
		.toBe(true);
}

/**
 * The photo as the viewer draws it at 100%: the original, or entirely the
 * result (divider at the left edge). Pixels exactly as on screen, RGBA.
 */
export async function readPhoto(page: Page, mode: 'original' | 'result') {
	const photo = await page.evaluate((which) => {
		const read = window.__hushViewer?.readPhoto(which);
		return read ? { width: read.width, height: read.height, data: Array.from(read.data) } : null;
	}, mode);
	if (!photo) throw new Error('The viewer is not ready');
	return photo;
}
