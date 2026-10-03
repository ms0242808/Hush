// SPDX-License-Identifier: Apache-2.0
import type { Backend, GpuSituation } from '@hush/core';

/**
 * "Copy diagnostics" (§4.7, §5.12): what a bug report needs — browser,
 * graphics adapter, the §2.10 situation, backend, timings, error codes — and
 * nothing about the photo beyond its shape. There is no field for a file
 * name, EXIF or pixels, so none can leak; error messages are left out too,
 * because they can quote a file name. The user pastes this into a GitHub
 * issue themselves: Hush sends nothing.
 */
export interface Diagnostics {
	version: string;
	browser: string;
	platform: string;
	language: string;
	situation: GpuSituation | 'unknown';
	adapter: string;
	shaderF16: boolean | null;
	webglRenderer: string | null;
	crossOriginIsolated: boolean;
	cores: number;
	/** GB, Chrome and Edge only. */
	deviceMemory: number | null;
	processing: {
		setting: 'auto' | Backend;
		backend: Backend | null;
		model: string | null;
		precision: string | null;
		threads: number | null;
		exportTile: number | null;
		previewTile: number | null;
		modelFromCache: boolean | null;
	};
	photo: { format: string; megapixels: number; bitDepth: number; colour: string; orientation: number } | null;
	timings: { label: string; ms: number }[];
	errors: { name: string; code: string | null; count: number }[];
}

const yesNo = (value: boolean | null) => (value === null ? 'unknown' : value ? 'yes' : 'no');
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

export function diagnosticsText(d: Diagnostics): string {
	const lines = [
		`Hush ${d.version} · ${d.language}`,
		`Browser: ${d.browser || 'unknown'} · ${d.platform || 'unknown platform'}`,
		`Graphics (§2.10 situation): ${d.situation} · adapter: ${d.adapter} · shader-f16: ${yesNo(d.shaderF16)}`,
	];
	if (d.webglRenderer) lines.push(`WebGL renderer: ${d.webglRenderer}`);
	lines.push(
		`Processor: ${d.cores} threads · memory: ${d.deviceMemory === null ? 'unknown' : `${d.deviceMemory} GB`} · cross-origin isolated: ${yesNo(d.crossOriginIsolated)}`,
	);
	const p = d.processing;
	const runsOn = p.backend ?? 'not started';
	const model = p.model ? `${p.model} ${p.precision ?? ''}`.trim() : 'not loaded';
	const tiles = p.exportTile ? ` · tiles: ${p.exportTile} (preview ${p.previewTile ?? '—'})` : '';
	const threads = p.threads ? ` · ${p.threads} threads` : '';
	const cache = p.modelFromCache === null ? '' : ` · model ${p.modelFromCache ? 'from cache' : 'downloaded'}`;
	lines.push(`Processing: ${p.setting} → ${runsOn} · ${model}${tiles}${threads}${cache}`);
	if (d.photo) {
		const { format, megapixels, bitDepth, colour, orientation } = d.photo;
		lines.push(
			`Photo: ${format} · ${megapixels.toFixed(1)} MP · ${bitDepth}-bit · colour: ${colour} · orientation ${orientation}`,
		);
	}
	if (d.timings.length > 0) {
		lines.push(`Timings: ${d.timings.map((timing) => `${timing.label} ${seconds(timing.ms)}`).join(' · ')}`);
	}
	lines.push(
		`Errors: ${
			d.errors.length === 0
				? 'none'
				: d.errors.map((e) => `${e.name}${e.code ? ` (${e.code})` : ''} ×${e.count}`).join(', ')
		}`,
	);
	return `${lines.join('\n')}\n`;
}

/** Count an error by its name and code only: messages can quote a file name. */
export function recordError(errors: Diagnostics['errors'], error: unknown): Diagnostics['errors'] {
	const name = error instanceof Error ? error.name : 'Error';
	const raw =
		error && typeof error === 'object'
			? ((error as { code?: unknown; kind?: unknown; problem?: unknown }).code ??
				(error as { kind?: unknown }).kind ??
				(error as { problem?: unknown }).problem)
			: null;
	const code = typeof raw === 'string' ? raw : null;
	const existing = errors.find((e) => e.name === name && e.code === code);
	if (existing) return errors.map((e) => (e === existing ? { ...e, count: e.count + 1 } : e));
	return [...errors, { name, code, count: 1 }];
}

/** "Google Chrome 154" from UA client hints, or the user-agent string where there are none (Safari, Firefox). */
export function browserName(): string {
	const data = (
		navigator as Navigator & {
			userAgentData?: { brands?: Array<{ brand: string; version: string }>; platform?: string };
		}
	).userAgentData;
	const brands = data?.brands
		?.filter((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand))
		.map((b) => `${b.brand} ${b.version}`)
		.join(', ');
	return brands || navigator.userAgent;
}

export function platformName(): string {
	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	if (data?.platform) return data.platform;
	const ua = navigator.userAgent;
	if (/Windows/.test(ua)) return 'Windows';
	if (/Mac OS X/.test(ua)) return /iPhone|iPad/.test(ua) ? 'iOS' : 'macOS';
	if (/Android/.test(ua)) return 'Android';
	if (/Linux/.test(ua)) return 'Linux';
	return '';
}
