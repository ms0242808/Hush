// SPDX-License-Identifier: Apache-2.0
import {
	previewVerdict,
	throughputVerdict,
	type Backend,
	type MachineClass,
	type Precision,
	type Verdict,
} from '@hush/core';
import type { Capabilities } from '@/lib/capabilities';
import type { GpuProbe } from '@/lib/gpu-probe';
import type { OpenResult, PrepareResult, RunResult, SeamResult } from '@/worker/pipeline.worker';

export type ImageChoice = '1mp' | '24mp' | '45mp' | 'file';

export interface BenchConfig {
	backend: Backend;
	modelId: string;
	precision: Precision | 'auto';
	tileSize: number;
	image: ImageChoice;
	machine: MachineClass;
	threads: number | null;
}

export interface BenchRow {
	id: number;
	kind: 'run' | 'seam';
	config: BenchConfig;
	prepare: PrepareResult;
	open: OpenResult;
	run?: RunResult;
	seam?: SeamResult;
	/** Index of this run on a warm session: 0 includes shader compilation and warm-up. */
	warm: number;
	verdict?: Verdict;
	error?: string;
}

export interface BenchEnvironment {
	at: string;
	version: string;
	userAgent: string;
	brands: string;
	main: Capabilities | null;
	worker: GpuProbe | null;
	ort: { version: string; webgpuWasmBytes: number; wasmWasmBytes: number };
}

export function verdictFor(row: BenchRow): Verdict | undefined {
	if (!row.run) return undefined;
	const megapixels = (row.run.width * row.run.height) / 1e6;
	if (row.config.backend === 'webgpu' && megapixels <= 1.1) return previewVerdict(row.run.ms / 1000);
	return throughputVerdict(row.run.mpPerSecond, row.config.backend === 'wasm' ? 'cpu' : row.config.machine);
}

const mb = (bytes: number) => (bytes / 1048576).toFixed(0);
const s = (ms: number) => (ms / 1000).toFixed(2);

export function describeAdapter(probe: GpuProbe | null | undefined): string {
	if (!probe?.adapter) return probe ? probe.webgpu : 'unknown';
	const { vendor, architecture, description } = probe.adapter;
	return [vendor, architecture, description].filter(Boolean).join(' · ') || 'adapter (details hidden)';
}

/** A Markdown table for docs/phase-0-results.md. */
export function toMarkdown(environment: BenchEnvironment, rows: BenchRow[]): string {
	const header = [
		`Browser: ${environment.brands || environment.userAgent}`,
		`WebGPU (worker): ${describeAdapter(environment.worker)}; shader-f16: ${environment.worker?.shaderF16 ? 'yes' : 'no'}`,
		`Situation (§2.10): ${environment.main?.assessment.situation ?? 'unknown'}; WebGL: ${environment.main?.facts.webglRenderer ?? 'n/a'}`,
		`Cores: ${environment.worker?.hardwareConcurrency ?? '?'}; cross-origin isolated: ${environment.worker?.crossOriginIsolated ? 'yes' : 'no'}; ORT ${environment.ort.version}`,
	];
	const lines = [
		'| Backend | Model | Precision | Photo | Tile | Run | Time (s) | MP/s | First tile (s) | Band (MiB) | Peak float (MiB) | Verdict |',
		'| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
	];
	for (const row of rows) {
		if (row.kind === 'seam' && row.seam) {
			lines.push(
				`| ${row.config.backend} | ${row.prepare.modelId} | ${row.prepare.precision} | seam check ${row.seam.size}² | ${row.seam.tileSize} | — | — | — | — | — | — | tiled vs whole: ${row.seam.psnr.toFixed(1)} dB, max diff ${row.seam.maxDiff} |`,
			);
			continue;
		}
		if (!row.run) continue;
		const r = row.run;
		lines.push(
			`| ${r.backend} | ${r.modelId} | ${r.precision} | ${r.width}×${r.height} | ${r.tileSize} | ${row.warm === 0 ? 'cold' : `warm ${row.warm}`} | ${s(r.ms)} | ${r.mpPerSecond.toFixed(2)} | ${s(r.stats.firstTileMs)} | ${mb(r.stats.bandFloatBytes)} | ${mb(r.stats.peakFloatBytes)} | ${row.verdict ?? ''} |`,
		);
	}
	return `${header.map((h) => `- ${h}`).join('\n')}\n\n${lines.join('\n')}\n`;
}
