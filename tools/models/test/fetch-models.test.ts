// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../../limits.ts';
import {
	parseOnly,
	partNames,
	sha256,
	sourceDescription,
	splitBytes,
	type LockModel,
	type ModelLock,
} from '../fetch-models.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('splitBytes', () => {
	it('cuts into parts no larger than the limit and loses nothing', () => {
		const bytes = Uint8Array.from({ length: 2500 }, (_, i) => i % 251);
		const parts = splitBytes(bytes, 1000);
		expect(parts.map((p) => p.byteLength)).toEqual([1000, 1000, 500]);
		expect(Buffer.concat(parts)).toEqual(Buffer.from(bytes));
	});

	it('defaults to the 24 MiB rule', () => {
		expect(MAX_FILE_BYTES).toBe(24 * 1024 * 1024);
		expect(splitBytes(new Uint8Array(10))).toHaveLength(1);
	});
});

describe('naming and sources', () => {
	const model = { id: 'nafnet-sidd-w32' } as LockModel;
	const variant = { precision: 'fp16', sha256: 'ab'.repeat(32) } as LockModel['variants'][number];

	it('names parts by content, so they can be cached forever', () => {
		expect(partNames(model, variant, 2)).toEqual([
			'parts/nafnet-sidd-w32.fp16.abababababab.onnx.000',
			'parts/nafnet-sidd-w32.fp16.abababababab.onnx.001',
		]);
	});

	it('describes where the files come from', () => {
		const lock = { source: { kind: 'huggingface', repo: 'org/repo', revision: 'abc' } } as ModelLock;
		expect(sourceDescription(lock)).toEqual({ repo: 'https://huggingface.co/org/repo', revision: 'abc' });
		const unpublished = { source: { kind: 'huggingface', repo: 'org/repo', revision: null } } as ModelLock;
		expect(sourceDescription(unpublished).revision).toBe('local-export');
	});

	it('parses --only filters', () => {
		const only = parseOnly(['nafnet-sidd-w32:fp16,fp32', 'nafnet-sidd-w64']);
		expect([...(only.get('nafnet-sidd-w32') ?? [])]).toEqual(['fp16', 'fp32']);
		expect(only.get('nafnet-sidd-w64')).toBeNull();
	});
});

describe('fetch-models --set test', () => {
	it('verifies, splits and writes a manifest the app accepts', async () => {
		const out = mkdtempSync(path.join(tmpdir(), 'hush-models-'));
		execFileSync(process.execPath, [path.join(here, '..', 'fetch-models.ts'), '--set', 'test', '--out', out]);
		const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
			active: Record<string, string>;
			models: Array<{ id: string; variants: Array<{ bytes: number; sha256: string; parts: string[] }> }>;
		};
		const { parseManifest } = await import('../../../packages/core/src/index.ts');
		expect(() => parseManifest(manifest)).not.toThrow();
		expect(manifest.active['denoise']).toBe('hush-test-invert');
		for (const model of manifest.models) {
			for (const variant of model.variants) {
				const joined = Buffer.concat(variant.parts.map((part) => readFileSync(path.join(out, part))));
				expect(joined.byteLength).toBe(variant.bytes);
				expect(sha256(joined)).toBe(variant.sha256);
			}
		}
		for (const file of readdirSync(path.join(out, 'parts'))) {
			expect(statSync(path.join(out, 'parts', file)).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
		}
	});
});
