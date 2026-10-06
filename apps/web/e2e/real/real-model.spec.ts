// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, fixture, test } from '../fixtures';
import '../harness';

/**
 * The real NAFNet model on this machine's GPU (`pnpm e2e:real`, locally).
 * Results are printed and attached to the test, for docs/phase-1-results.md.
 */

interface Processed {
	bytes: string;
	backend: string;
	stats: {
		processMs: number;
		mpPerSecond: number;
		peakFloatBytes: number;
		tiled: { backoffs: number; recoveries: number; tileWidth: number } | null;
	};
}

const GOLDEN_INPUT = 'golden/noisy-1024x768.png';
/** One pass over the whole photo: what the model means, which tiling approaches to about 45 dB. */
const GOLDEN_WHOLE = 'golden/nafnet-sidd-w32.fp32.png';
/** The same tiling Hush does under these ceilings, written independently: only fp16 and summation order differ. */
const GOLDEN_TILED: Record<number, string> = {
	592: 'golden/nafnet-sidd-w32.fp32.tiled-768.png',
	416: 'golden/nafnet-sidd-w32.fp32.tiled-512.png',
};
const base64Of = (name: string) => readFileSync(fixture(name)).toString('base64');

async function open(page: Page, backend: 'webgpu' | 'wasm') {
	await page.goto(`/bench/?backend=${backend}`);
	await page.waitForFunction(() => window.__hushPipeline !== undefined && window.__hushBench !== undefined);
	await page.evaluate(() => window.__hushBench!.ready);
}

function note(name: string, value: string) {
	test.info().annotations.push({ type: name, description: value });
	console.log(`${test.info().title} — ${name}: ${value}`);
}

async function compareWithGolden(page: Page, outputBase64: string, referenceName = GOLDEN_WHOLE) {
	const [out, reference] = await Promise.all([
		page.evaluate((data) => window.__hushPipeline!.decode(data), outputBase64),
		page.evaluate((data) => window.__hushPipeline!.decode(data), base64Of(referenceName)),
	]);
	expect([out.width, out.height]).toEqual([reference.width, reference.height]);
	const a = Buffer.from(out.data, 'base64');
	const b = Buffer.from(reference.data, 'base64');
	let sum = 0;
	let worst = 0;
	for (let i = 0; i < a.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			const d = a[i + c]! - b[i + c]!;
			sum += d * d;
			worst = Math.max(worst, Math.abs(d));
		}
	}
	const psnr = sum === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sum / ((a.length / 4) * 3)));
	return { psnr, worst };
}

/** Mean step between horizontal neighbours over RGB: a denoiser's output is smoother than its input. */
function roughness(rgba: Buffer, width: number): number {
	let sum = 0;
	let count = 0;
	for (let i = 4; i < rgba.length; i += 4) {
		if ((i / 4) % width === 0) continue;
		for (let c = 0; c < 3; c++) sum += Math.abs(rgba[i + c]! - rgba[i - 4 + c]!);
		count += 3;
	}
	return sum / count;
}

async function processGolden(page: Page) {
	return (await page.evaluate(([name, data]) => window.__hushPipeline!.process(name, data), [
		'noisy-1024x768.png',
		base64Of(GOLDEN_INPUT),
	] as const)) as Processed;
}

test.describe('NAFNet, through the whole pipeline', () => {
	for (const backend of ['webgpu', 'wasm'] as const) {
		test(`golden image on ${backend}: tiled, banded and encoded, it matches the CPU references`, async ({ page }) => {
			await open(page, backend);
			const result = await processGolden(page);
			expect(result.backend).toBe(backend);
			const tileWidth = result.stats.tiled!.tileWidth;
			const whole = await compareWithGolden(page, result.bytes);
			note(
				'against one pass',
				`${whole.psnr.toFixed(1)} dB, at most ${whole.worst} levels apart; ${tileWidth}-px tiles`,
			);
			expect(whole.psnr).toBeGreaterThan(44);
			const tiledReference = GOLDEN_TILED[tileWidth];
			expect(tiledReference, `a tiled reference for ${tileWidth}-px tiles`).toBeDefined();
			const tiled = await compareWithGolden(page, result.bytes, tiledReference);
			note('against the same tiling', `${tiled.psnr.toFixed(1)} dB, at most ${tiled.worst} levels apart`);
			expect(tiled.psnr).toBeGreaterThan(55);
			expect(tiled.worst).toBeLessThanOrEqual(3);
		});
	}

	for (const backend of ['webgpu', 'wasm'] as const) {
		test(`a dark JPEG shadow on ${backend}: denoised, not run away into stripes`, async ({ page }) => {
			// SIDD has no JPEG blocking; on a high-ISO shadow that has it, NAFNet's channel attention
			// runs away unless the export bounds it (tools/models/calibrate.py), and the output is
			// many times rougher than the input: 2-pixel stripes.
			await open(page, backend);
			const input = base64Of('dark-shadow.jpg');
			const result = (await page.evaluate(([name, data]) => window.__hushPipeline!.process(name, data), [
				'dark-shadow.jpg',
				input,
			] as const)) as Processed;
			const [before, after] = await Promise.all(
				[input, result.bytes].map((data) => page.evaluate((bytes) => window.__hushPipeline!.decode(bytes), data)),
			);
			const ratio =
				roughness(Buffer.from(after!.data, 'base64'), after!.width) /
				roughness(Buffer.from(before!.data, 'base64'), before!.width);
			note('roughness', `${ratio.toFixed(2)} × the input's`);
			expect(ratio).toBeLessThan(1);
		});
	}

	test('seams on webgpu: 768-px tiles against one tile, on a 1024² crop of a 24 MP photo', async ({ page }) => {
		await open(page, 'webgpu');
		const row = await page.evaluate(() =>
			window.__hushBench!.seam({ backend: 'webgpu', image: '24mp', tileSize: 768 }, 1024),
		);
		note('seam', `${row.seam!.psnr.toFixed(1)} dB, max ${row.seam!.maxDiff} levels, ${row.seam!.tileSize}-px tiles`);
		expect(row.seam!.psnr).toBeGreaterThan(45);
	});

	test('speed on webgpu: 24 MP and 45 MP, warm', async ({ page }) => {
		await open(page, 'webgpu');
		for (const image of ['24mp', '45mp'] as const) {
			const rows = await page.evaluate(
				(photo) => window.__hushBench!.run({ backend: 'webgpu', image: photo }, 2),
				image,
			);
			const warm = rows.at(-1)!.run!;
			note(
				`speed ${image}`,
				`${(warm.ms / 1000).toFixed(1)} s, ${warm.mpPerSecond.toFixed(2)} MP/s, ${warm.tileSize}-px tiles`,
			);
			expect(warm.mpPerSecond).toBeGreaterThan(0.3);
		}
	});

	test('device lost on webgpu: a real device.destroy() mid-photo is recovered, and the result still matches', async ({
		page,
	}) => {
		await open(page, 'webgpu');
		await page.evaluate(() => window.__hushPipeline!.injectFaults({ loseDeviceOnRun: 2 }));
		const result = await processGolden(page);
		expect(result.stats.tiled?.recoveries).toBe(1);
		const { psnr } = await compareWithGolden(page, result.bytes);
		note('recovered', `1 device recovered; ${psnr.toFixed(1)} dB against the reference`);
		expect(psnr).toBeGreaterThan(45);
	});

	test('out of memory on webgpu: tiles halve and the result still matches', async ({ page }) => {
		await open(page, 'webgpu');
		await page.evaluate(() => window.__hushPipeline!.injectFaults({ outOfMemoryAbove: 400 * 400 }));
		const result = await processGolden(page);
		expect(result.stats.tiled!.backoffs).toBeGreaterThanOrEqual(1);
		const { psnr } = await compareWithGolden(page, result.bytes);
		const state = await page.evaluate(() => window.__hushPipeline!.sessionState());
		note(
			'backoff',
			`${result.stats.tiled!.backoffs} backoff(s) to ${state.tileSize}-px tiles; ${psnr.toFixed(1)} dB against the reference`,
		);
		// Smaller tiles see less of the photo in each global pool, so they drift further from one
		// pass (45 dB at 592 px, about 43.5 at 288): a sanity bound, not a seam measure.
		expect(psnr).toBeGreaterThan(42);
	});

	test('a 102 MP photo through NAFNet on webgpu, float memory bounded by one band', async ({ page }) => {
		await open(page, 'webgpu');
		const result = (await page.evaluate(() => window.__hushPipeline!.processSynthetic(11648, 8736))) as {
			decoded: { width: number; height: number };
			byteLength: number;
			encodeMs: number;
			stats: {
				processMs: number;
				totalMs: number;
				mpPerSecond: number;
				peakFloatBytes: number;
				tiled: { bandFloatBytes: number; tileWidth: number; tileHeight: number };
			};
		};
		expect(result.decoded).toEqual({ width: 11648, height: 8736 });
		const { stats } = result;
		note(
			'102 MP',
			`${(stats.processMs / 1000).toFixed(1)} s denoising (${stats.mpPerSecond.toFixed(2)} MP/s), ${(result.encodeMs / 1000).toFixed(1)} s encoding, ${(stats.totalMs / 1000).toFixed(1)} s in all; peak float ${(stats.peakFloatBytes / 2 ** 20).toFixed(0)} MiB with ${stats.tiled.tileWidth}×${stats.tiled.tileHeight} tiles`,
		);
		expect(stats.tiled.bandFloatBytes).toBe(3 * stats.tiled.tileHeight * 11648 * 4);
		expect(stats.peakFloatBytes).toBeLessThan(0.11 * 3 * 11648 * 8736 * 4);
	});
});
