// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 0 measurements: drive the benchmark page with Playwright and record
 * the results in docs/phase-0/results/.
 *
 *   pnpm build && pnpm preview              (serves dist with the production headers)
 *   node apps/web/scripts/measure.ts --suite gpu --label m1-pro-chrome
 *
 * Options:
 *   --suite gpu|cpu|smoke   what to run (default gpu)
 *   --browser chrome|msedge|chromium|webkit|firefox   (default chrome: the installed Google Chrome)
 *   --url <origin>          default http://127.0.0.1:8788
 *   --label <name>          output file name
 *   --headed                show the browser
 *   --cpu-only              launch Chromium with the GPU disabled (the §2.10 CPU path)
 *
 * Peak memory is the browser's whole process tree (RSS, sampled every 250 ms),
 * which includes the GPU process. It is an upper bound on what Hush adds.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from '@playwright/test';

/** The slice of the bench page's window.__hushBench this script drives. */
interface BenchHandle {
	ready: Promise<void>;
	run(config: Record<string, unknown>, repeat?: number): Promise<unknown[]>;
	seam(config: Record<string, unknown>, size?: number): Promise<unknown>;
	environment(): unknown;
	markdown(): string;
}

declare global {
	interface Window {
		__hushBench?: BenchHandle;
	}
}

interface Step {
	kind: 'run' | 'seam';
	config: Record<string, unknown>;
	repeat?: number;
	size?: number;
	note: string;
}

const W32 = 'nafnet-sidd-w32';
const W64 = 'nafnet-sidd-w64';

const SUITES: Record<string, Step[]> = {
	smoke: [
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W32, image: '1mp', tileSize: 1136 },
			repeat: 1,
			note: 'smoke',
		},
	],
	gpu: [
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp16', image: '1mp', tileSize: 1136 },
			repeat: 3,
			note: 'preview, one tile',
		},
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp32', image: '1mp', tileSize: 1136 },
			repeat: 2,
			note: 'preview, fp32',
		},
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp16', image: '24mp', tileSize: 512 },
			note: '24 MP, tiles ≤ 512',
		},
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp16', image: '24mp', tileSize: 768 },
			note: '24 MP, tiles ≤ 768',
		},
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp16', image: '24mp', tileSize: 1024 },
			note: '24 MP, tiles ≤ 1024',
		},
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp16', image: '45mp', tileSize: 1024 },
			note: '45 MP, tiles ≤ 1024',
		},
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp32', image: '24mp', tileSize: 1024 },
			note: '24 MP, fp32',
		},
		{
			kind: 'seam',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp16', image: '24mp', tileSize: 512 },
			size: 1024,
			note: 'seams, 512 tiles',
		},
		{
			kind: 'seam',
			config: { backend: 'webgpu', modelId: W32, precision: 'fp16', image: '24mp', tileSize: 1024 },
			size: 1024,
			note: 'seams, 1024 tiles',
		},
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W64, precision: 'fp16', image: '1mp', tileSize: 1136 },
			repeat: 2,
			note: 'width-64 preview',
		},
		{
			kind: 'run',
			config: { backend: 'webgpu', modelId: W64, precision: 'fp16', image: '24mp', tileSize: 1024 },
			note: 'width-64, 24 MP',
		},
	],
	cpu: [
		{
			kind: 'run',
			config: { backend: 'wasm', modelId: W32, precision: 'fp32', image: '1mp', tileSize: 512 },
			repeat: 2,
			note: 'processor, fp32',
		},
		{
			kind: 'run',
			config: { backend: 'wasm', modelId: W32, precision: 'fp32', image: '24mp', tileSize: 512 },
			note: 'processor, 24 MP fp32',
		},
	],
};

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.resolve(here, '../../../docs/phase-0/results');

/** Sum the RSS of a process and all its descendants, in MB. */
function treeRssMb(rootPid: number): number {
	const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
		.trim()
		.split('\n')
		.map((line) => line.trim().split(/\s+/).map(Number) as [number, number, number]);
	const children = new Map<number, number[]>();
	for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]));
	let total = 0;
	const stack = [rootPid];
	while (stack.length > 0) {
		const pid = stack.pop()!;
		total += rss.get(pid) ?? 0;
		stack.push(...(children.get(pid) ?? []));
	}
	return total / 1024;
}

async function sampleDuring<T>(pid: number | undefined, task: () => Promise<T>) {
	const baseline = pid ? treeRssMb(pid) : 0;
	let peak = baseline;
	const timer = pid ? setInterval(() => (peak = Math.max(peak, treeRssMb(pid))), 250) : null;
	try {
		return { value: await task(), baselineMb: baseline, peakMb: Math.max(peak, pid ? treeRssMb(pid) : 0) };
	} finally {
		if (timer) clearInterval(timer);
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			suite: { type: 'string', default: 'gpu' },
			browser: { type: 'string', default: 'chrome' },
			url: { type: 'string', default: 'http://127.0.0.1:8788' },
			label: { type: 'string' },
			headed: { type: 'boolean', default: false },
			'cpu-only': { type: 'boolean', default: false },
		},
	});
	const steps = SUITES[values.suite];
	if (!steps) throw new Error(`Unknown suite ${values.suite}`);

	const engines: Record<string, [BrowserType, string | undefined]> = {
		chrome: [chromium, 'chrome'],
		msedge: [chromium, 'msedge'],
		chromium: [chromium, undefined],
		webkit: [webkit, undefined],
		firefox: [firefox, undefined],
	};
	const [engine, channel] = engines[values.browser] ?? engines['chrome']!;
	// launchServer exposes the browser's process, so its memory can be sampled.
	const server = await engine.launchServer({
		headless: !values.headed,
		...(channel && { channel }),
		...(values['cpu-only'] && { args: ['--disable-gpu'] }),
	});
	const pid = server.process().pid;
	const browser: Browser = await engine.connect(server.wsEndpoint());
	const page: Page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.on('pageerror', (error) => console.error('page error:', error.message));

	await page.goto(`${values.url}/bench/`);
	await page.waitForFunction(() => window.__hushBench !== undefined);
	await page.evaluate(() => window.__hushBench!.ready);

	const records = [];
	for (const step of steps) {
		const started = Date.now();
		const { value, baselineMb, peakMb } = await sampleDuring(pid, () =>
			step.kind === 'run'
				? page.evaluate(([config, repeat]) => window.__hushBench!.run(config, repeat), [
						step.config,
						step.repeat ?? 1,
					] as const)
				: page.evaluate(([config, size]) => window.__hushBench!.seam(config, size).then((row: unknown) => [row]), [
						step.config,
						step.size ?? 1024,
					] as const),
		);
		const rows = value as Array<{ run?: { ms: number; mpPerSecond: number }; seam?: { psnr: number } }>;
		const summary = rows
			.map((row) =>
				row.run
					? `${(row.run.ms / 1000).toFixed(2)} s, ${row.run.mpPerSecond.toFixed(2)} MP/s`
					: `seam ${row.seam?.psnr.toFixed(1)} dB`,
			)
			.join(' | ');
		console.log(
			`${step.note.padEnd(22)} ${summary}  (peak ${peakMb.toFixed(0)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s)`,
		);
		records.push({ step, rows, memory: { baselineMb, peakMb } });
	}

	const environment = await page.evaluate(() => window.__hushBench!.environment());
	const markdown = await page.evaluate(() => window.__hushBench!.markdown());
	await browser.close();
	await server.close();

	const machine = {
		cpu: os.cpus()[0]?.model ?? 'unknown',
		cores: os.cpus().length,
		memoryGb: Math.round(os.totalmem() / 2 ** 30),
		os: `${os.type()} ${os.release()} ${os.arch()}`,
		browser: `${values.browser}${values['cpu-only'] ? ' (--disable-gpu)' : ''}`,
	};
	const label = values.label ?? `${values.suite}-${values.browser}`;
	mkdirSync(resultsDir, { recursive: true });
	writeFileSync(
		path.join(resultsDir, `${label}.json`),
		JSON.stringify({ machine, suite: values.suite, environment, records }, null, '\t') + '\n',
	);
	const memoryTable = [
		'| Step | Peak browser memory (MB) |',
		'| --- | ---: |',
		...records.map((r) => `| ${r.step.note} | ${r.memory.peakMb.toFixed(0)} |`),
	].join('\n');
	writeFileSync(
		path.join(resultsDir, `${label}.md`),
		`# ${label}\n\n- Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.memoryGb} GB, ${machine.os}\n${markdown}\n${memoryTable}\n`,
	);
	console.log(`Wrote docs/phase-0/results/${label}.{json,md}`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
