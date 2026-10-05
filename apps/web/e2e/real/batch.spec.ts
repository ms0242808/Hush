// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import exifr from 'exifr';
import { expect, test } from '../fixtures';
import '../harness';

/**
 * Phase 3's acceptance check, with the real NAFNet on this machine's GPU, in
 * installed Chrome (which keeps folder handles across a reload):
 *
 *   "100 × 45 MP JPEGs complete in Chrome with flat memory, saved to a
 *    folder. Kill the tab halfway, reopen, grant permission — the batch
 *    resumes and skips what's done."
 *
 * HUSH_BATCH_COUNT sets the number of photos (default 6; the acceptance run
 * is 100, about two and a half hours on an M1 Pro). The folder is Chrome's
 * private file system standing in for the photographer's own, in a Chrome
 * profile on disk (a default Playwright context keeps it in memory, which
 * would both run out of room and count the photos as the app's memory).
 * "Kill the tab" is harder here: the whole Chrome is killed (SIGKILL), then
 * started again on the same profile. Memory is the whole Chrome process tree
 * (browser, GPU, renderer and its workers), sampled from the operating
 * system as the batch runs.
 *
 * HUSH_PHOTOS (comma-separated paths) runs a batch of real photos instead:
 * timings, EXIF kept, and the exports copied out for a look at 100%.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const LARGE = path.join(here, '.photos', 'synthetic-8256x5504.jpg');
const COUNT = Number(process.env['HUSH_BATCH_COUNT'] ?? 6);
const EXIF_OPTIONS = {
	tiff: true,
	exif: true,
	gps: true,
	interop: true,
	ifd1: true,
	makerNote: true,
	translateValues: false,
	reviveValues: false,
};

test.beforeAll(() => {
	if (existsSync(LARGE)) return;
	execFileSync('uv', ['run', 'make_large.py'], {
		cwd: path.resolve(here, '../../../../tools/fixtures'),
		stdio: 'inherit',
	});
});

function note(name: string, value: string) {
	test.info().annotations.push({ type: name, description: value });
	console.log(`${test.info().title} — ${name}: ${value}`);
}

/** showDirectoryPicker answering with folders of Chrome's private file system, for every page of the context. */
async function folders(context: BrowserContext, name: string) {
	await context.addInitScript((folder) => {
		(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
			async () => (await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true });
	}, name);
}

/** A folder of `count` copies of one photo, written once from disk and copied inside the browser. */
async function fillFolder(page: Page, folder: string, file: string, count: number) {
	await page.evaluate(
		async ([dir, data, n]) => {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry(dir, { recursive: true }).catch(() => {});
			const handle = await root.getDirectoryHandle(dir, { create: true });
			const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
			for (let i = 1; i <= n; i++) {
				const name = `DSC_${String(i).padStart(4, '0')}.jpg`;
				const writable = await (await handle.getFileHandle(name, { create: true })).createWritable();
				await writable.write(bytes);
				await writable.close();
			}
		},
		[folder, readFileSync(file).toString('base64'), count] as const,
	);
}

async function list(page: Page, folder: string): Promise<string[]> {
	return page.evaluate(async (dir) => {
		let handle = await navigator.storage.getDirectory();
		for (const part of dir.split('/')) handle = await handle.getDirectoryHandle(part);
		const names: string[] = [];
		for await (const name of handle.keys()) names.push(name);
		return names.sort();
	}, folder);
}

async function read(page: Page, filePath: string): Promise<Buffer> {
	const base64 = await page.evaluate(async (p) => {
		const parts = p.split('/');
		let handle = await navigator.storage.getDirectory();
		for (const part of parts.slice(0, -1)) handle = await handle.getDirectoryHandle(part);
		const bytes = new Uint8Array(await (await (await handle.getFileHandle(parts.at(-1)!)).getFile()).arrayBuffer());
		let binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(binary);
	}, filePath);
	return Buffer.from(base64, 'base64');
}

interface ProcessRow {
	pid: number;
	ppid: number;
	rss: number;
	command: string;
}

/** The Chrome started on `profile`: the browser process and everything under it. */
function chromeTree(profile: string): ProcessRow[] {
	const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 })
		.split('\n')
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), command: m[4]! }));
	const root = rows.find(
		(row) => row.command.includes(profile) && /Google Chrome/.test(row.command) && !/--type=/.test(row.command),
	);
	if (!root) return [];
	const tree = new Set([root.pid]);
	for (let grew = true; grew;) {
		grew = false;
		for (const row of rows) {
			if (!tree.has(row.pid) && tree.has(row.ppid)) {
				tree.add(row.pid);
				grew = true;
			}
		}
	}
	return rows.filter((row) => tree.has(row.pid));
}

/** Resident memory of that Chrome, in MB: all of it, and its largest process. */
function chromeMemory(profile: string): { total: number; largest: number } | null {
	const members = chromeTree(profile);
	if (members.length === 0) return null;
	return {
		total: Math.round(members.reduce((sum, row) => sum + row.rss, 0) / 1024),
		largest: Math.round(Math.max(...members.map((row) => row.rss)) / 1024),
	};
}

/** Chrome in a profile on disk, the way a photographer's own browser keeps its files. */
async function launch(
	profile: string,
	baseURL: string,
): Promise<{ context: BrowserContext; page: Page; foreign: string[] }> {
	const context = await chromium.launchPersistentContext(profile, {
		channel: 'chrome',
		baseURL,
		viewport: { width: 1280, height: 800 },
		locale: 'en-US',
	});
	await context.addInitScript(() => {
		(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
			async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Shoot', { create: true });
	});
	const foreign: string[] = [];
	const origin = new URL(baseURL).origin;
	context.on('request', (request) => {
		const url = request.url();
		if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== origin) foreign.push(url);
	});
	const page = context.pages()[0] ?? (await context.newPage());
	return { context, page, foreign };
}

interface Progress {
	saved: number;
	skipped: number;
	failed: number;
	state: string;
	etaMs: number | null;
	activeMs: number;
}

function progress(page: Page): Promise<Progress> {
	return page.evaluate(() => {
		const s = window.__hushBatch!.getState();
		const run = s['run'] as { etaMs: number | null; activeMs: number } | null;
		const count = (status: string) => s.photos.filter((p) => p.status === status).length;
		return {
			saved: count('saved'),
			skipped: count('skipped'),
			failed: count('failed'),
			state: s.state,
			etaMs: run?.etaMs ?? null,
			activeMs: run?.activeMs ?? 0,
		};
	});
}

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

test('Phase 3 acceptance: N × 45 MP JPEGs to a folder with flat memory; Chrome killed halfway, reopened, resumed', async ({
	baseURL,
}) => {
	test.setTimeout(COUNT * 300_000 + 900_000);
	const killAt = Math.max(1, Math.floor(COUNT / 2));
	const profile = mkdtempSync(path.join(tmpdir(), 'hush-batch-profile-'));
	const samples: { at: number; saved: number; total: number; largest: number }[] = [];
	const started = Date.now();
	let saved = 0;
	const sampler = setInterval(() => {
		const memory = chromeMemory(profile);
		if (memory) samples.push({ at: Date.now() - started, saved, ...memory });
	}, 20_000);
	/** Requests to other origins, per launch (filled as they happen). */
	const foreign: string[][] = [];

	try {
		const first = await launch(profile, baseURL!);
		foreign.push(first.foreign);
		const page = first.page;
		await page.goto('/');
		await fillFolder(page, 'Shoot', LARGE, COUNT);
		await page.getByRole('button', { name: 'Choose folder' }).click();
		await expect(page.getByTestId('batch-count')).toHaveText(`${COUNT} photos`);
		await expect(page.getByTestId('save-location')).toHaveText(/Saving to: Shoot\/denoised/);
		const button = page.getByTestId('batch-export');
		await expect(button).toBeEnabled({ timeout: 600_000 });
		note(
			'before starting',
			`${await button.innerText()} · backend ${await page.evaluate(() => window.__hushEditor!.getState().backend)}`,
		);
		await button.click();
		await expect(page.getByTestId('batch-footer')).toHaveAttribute('data-state', 'running');
		let firstEta: number | null = null;
		for (;;) {
			const now = await progress(page);
			saved = now.saved;
			firstEta ??= now.etaMs;
			if (now.failed > 0) throw new Error(`${now.failed} photo(s) failed`);
			if (now.saved >= killAt) break;
			await page.waitForTimeout(2000);
		}
		const beforeKill = await progress(page);
		note(
			'first half',
			`${beforeKill.saved} saved in ${minutes(Date.now() - started)} (${(beforeKill.activeMs / beforeKill.saved / 1000).toFixed(1)} s per photo) · time left then: ${minutes(beforeKill.etaMs ?? 0)} · first estimate on screen: ${minutes(firstEta ?? 0)}`,
		);

		// Kill Chrome outright, mid-photo: no unload handlers, nothing flushed.
		for (const row of chromeTree(profile)) {
			try {
				process.kill(row.pid, 'SIGKILL');
			} catch {
				// already gone
			}
		}
		await first.context.close().catch(() => {});

		// Reopen: the same profile, the same page.
		const second = await launch(profile, baseURL!);
		foreign.push(second.foreign);
		const reopened = second.page;
		try {
			await reopened.goto('/');
			const resume = reopened.getByTestId('resume-batch');
			await expect(resume).toContainText(`${beforeKill.saved} of ${COUNT} photos from Shoot are exported.`, {
				timeout: 30_000,
			});
			const resumedAt = Date.now();
			await resume.getByRole('button', { name: 'Continue' }).click();
			await expect(reopened.getByTestId('batch-footer')).toBeVisible({ timeout: 120_000 });
			for (;;) {
				const now = await progress(reopened);
				saved = now.saved + now.skipped;
				if (now.failed > 0) throw new Error(`${now.failed} photo(s) failed after reopening`);
				if (now.state === 'finished') break;
				await reopened.waitForTimeout(2000);
			}
			const summary = reopened.getByTestId('batch-summary');
			await expect(summary).toContainText(`${COUNT - beforeKill.saved} photos exported to Shoot/denoised`);
			await expect(summary).toContainText(`${beforeKill.saved} were already exported`);
			const end = await progress(reopened);
			note(
				'second half',
				`${end.saved} exported and ${end.skipped} skipped in ${minutes(Date.now() - resumedAt)} after reopening`,
			);

			const outputs = await list(reopened, 'Shoot/denoised');
			expect(outputs).toHaveLength(COUNT);
			expect(outputs[0]).toBe('DSC_0001-denoised.jpg');
			const [before, after] = (await Promise.all([
				exifr.parse(readFileSync(LARGE), EXIF_OPTIONS),
				exifr.parse(await read(reopened, `Shoot/denoised/${outputs.at(-1)!}`), EXIF_OPTIONS),
			])) as [Record<string, unknown>, Record<string, unknown>];
			const changed = Object.keys({ ...before, ...after }).filter(
				(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
			);
			expect(changed).toEqual(['Software']);
		} finally {
			await second.context.close();
		}
		expect(foreign.flat(), 'requests left the origin').toEqual([]);
	} finally {
		clearInterval(sampler);
		rmSync(profile, { recursive: true, force: true });
		const file = test.info().outputPath('memory.json');
		writeFileSync(file, JSON.stringify(samples, null, 1));
		await test.info().attach('memory', { path: file, contentType: 'application/json' });
	}

	// Flat memory: once warmed up, Chrome holds no more after the last photos than after the first ones.
	const firstHalf = samples.filter((s) => s.saved >= 1 && s.saved < killAt);
	const secondHalf = samples.filter((s) => s.saved >= killAt + 1);
	const peak = (list: typeof samples) => Math.max(...list.map((s) => s.total));
	note(
		'memory (Chrome process tree, RSS)',
		`${samples.length} samples · first half peak ${peak(firstHalf)} MB · after reopening peak ${peak(secondHalf)} MB · overall ${Math.min(...samples.map((s) => s.total))}–${peak(samples)} MB · largest single process ${Math.max(...samples.map((s) => s.largest))} MB`,
	);
	if (firstHalf.length > 0 && secondHalf.length > 0) expect(peak(secondHalf)).toBeLessThan(peak(firstHalf) * 1.25);
});

test('real photos (HUSH_PHOTOS): a batch of them, timed, EXIF kept, exports copied out to look at', async ({
	context,
	page,
}) => {
	const list_ = (process.env['HUSH_PHOTOS'] ?? '').split(',').filter(Boolean);
	test.skip(list_.length === 0, 'Set HUSH_PHOTOS to comma-separated photo paths to run this');
	test.setTimeout(list_.length * 400_000 + 600_000);
	await folders(context, 'Lake');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Choose photos' }).click();
	await (await chooser).setFiles(list_);
	await expect(page.getByTestId('batch-photo')).toHaveCount(list_.length);
	const button = page.getByTestId('batch-export');
	await expect(button).toBeEnabled({ timeout: 600_000 });
	await expect(page.getByTestId('thumbnail')).toHaveCount(list_.length, { timeout: 60_000 });
	await page.screenshot({ path: test.info().outputPath('1-grid.png') });
	note('before starting', await button.innerText());

	// Open the first to look at the settings on it, then back.
	await page.getByTestId('batch-photo').first().getByRole('button', { name: /^Open/ }).click();
	await page.waitForFunction(
		() => {
			const s = window.__hushEditor?.getState();
			return !!s && s.preview.planned > 0 && s.preview.done === s.preview.planned && !s.preview.running;
		},
		null,
		{ timeout: 120_000 },
	);
	await page.screenshot({ path: test.info().outputPath('2-editor.png') });
	await page.getByTestId('batch-back').click();

	const started = Date.now();
	await page.getByTestId('batch-export').click();
	await page.waitForTimeout(8000);
	await page.screenshot({ path: test.info().outputPath('3-running.png') });
	await expect(page.getByTestId('batch-summary')).toContainText(`${list_.length} photos exported to Lake`, {
		timeout: list_.length * 400_000,
	});
	await page.screenshot({ path: test.info().outputPath('4-done.png') });
	note('batch', `${list_.length} photos in ${((Date.now() - started) / 1000).toFixed(1)} s`);

	const outputs = await list(page, 'Lake');
	const out = test.info().outputPath('exports');
	mkdirSync(out, { recursive: true });
	for (const [i, source] of list_.entries()) {
		const name = outputs.find((o) => o.startsWith(path.parse(source).name))!;
		const bytes = await read(page, `Lake/${name}`);
		writeFileSync(path.join(out, name), bytes);
		const [before, after] = (await Promise.all([
			exifr.parse(readFileSync(source), EXIF_OPTIONS),
			exifr.parse(bytes, EXIF_OPTIONS),
		])) as [Record<string, unknown> | undefined, Record<string, unknown> | undefined];
		const a = before ?? {};
		const b = after ?? {};
		const changed = Object.keys({ ...a, ...b }).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
		note(
			`photo ${i + 1}`,
			`${name}, ${(bytes.length / 1e6).toFixed(1)} MB · ${Object.keys(a).length} tags, changed: ${changed.join(', ') || 'none'}`,
		);
		expect(changed.filter((key) => key !== 'Software')).toEqual([]);
	}
});
