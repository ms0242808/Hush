// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ManifestError, parseManifest, pickModel, pickVariant, type ModelEntry } from '../src/index.ts';

const sha = (c: string) => c.repeat(64);

function model(id: string, overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id,
		family: 'nafnet',
		task: 'denoise',
		label: { en: 'NAFNet', 'zh-Hant': 'NAFNet' },
		variants: [
			{ precision: 'fp16', bytes: 10, sha256: sha('a'), parts: ['parts/a.000'], backends: ['webgpu'] },
			{
				precision: 'fp32',
				bytes: 20,
				sha256: sha('b'),
				parts: ['parts/b.000', 'parts/b.001'],
				backends: ['webgpu', 'wasm'],
			},
			{ precision: 'int8', bytes: 5, sha256: sha('c'), parts: ['parts/c.000'], backends: ['wasm'] },
		],
		tile: { padMultiple: 16, overlap: 48 },
		input: { range: [0, 1], layout: 'NCHW', colour: 'RGB' },
		source: { repo: 'https://huggingface.co/example/model', revision: 'abc123' },
		licence: { code: 'MIT', weights: 'MIT', trainingData: 'MIT' },
		...overrides,
	};
}

const manifest = () => ({
	schema: 1,
	active: { denoise: 'nafnet-sidd-w32' },
	models: [model('nafnet-sidd-w32'), model('nafnet-sidd-w64')],
});

describe('parseManifest', () => {
	it('accepts a valid manifest', () => {
		const parsed = parseManifest(manifest());
		expect(parsed.models.map((m) => m.id)).toEqual(['nafnet-sidd-w32', 'nafnet-sidd-w64']);
		expect(parsed.models[0]!.tile).toEqual({ padMultiple: 16, overlap: 48 });
	});

	it.each([
		['an unknown schema', { ...manifest(), schema: 2 }, 'schema'],
		['a missing model list', { ...manifest(), models: [] }, 'models'],
		['an active model that does not exist', { ...manifest(), active: { denoise: 'scunet' } }, 'active.denoise'],
		['a duplicate id', { ...manifest(), models: [model('x'), model('x')], active: {} }, 'twice'],
		[
			'a short hash',
			{
				...manifest(),
				models: [
					model('nafnet-sidd-w32', {
						variants: [{ precision: 'fp32', bytes: 1, sha256: 'abc', parts: ['p'], backends: ['wasm'] }],
					}),
				],
			},
			'sha256',
		],
		[
			'an unknown precision',
			{
				...manifest(),
				models: [
					model('nafnet-sidd-w32', {
						variants: [{ precision: 'fp8', bytes: 1, sha256: sha('d'), parts: ['p'], backends: ['wasm'] }],
					}),
				],
			},
			'precision',
		],
		[
			'an unknown backend',
			{
				...manifest(),
				models: [
					model('nafnet-sidd-w32', {
						variants: [{ precision: 'fp32', bytes: 1, sha256: sha('d'), parts: ['p'], backends: ['webgl'] }],
					}),
				],
			},
			'backends',
		],
		[
			'a non-NCHW layout',
			{
				...manifest(),
				models: [model('nafnet-sidd-w32', { input: { range: [0, 1], layout: 'NHWC', colour: 'RGB' } })],
			},
			'layout',
		],
		[
			'a zero pad multiple',
			{ ...manifest(), models: [model('nafnet-sidd-w32', { tile: { padMultiple: 0, overlap: 48 } })] },
			'padMultiple',
		],
		['a non-object', 'nope', '(root)'],
	])('rejects %s', (_, value, field) => {
		expect(() => parseManifest(value)).toThrow(ManifestError);
		expect(() => parseManifest(value)).toThrow(field);
	});
});

describe('pickModel', () => {
	const parsed = parseManifest(manifest());

	it('uses the active model by default', () => {
		expect(pickModel(parsed, 'denoise').id).toBe('nafnet-sidd-w32');
	});

	it('honours a ?model= override for the same task', () => {
		expect(pickModel(parsed, 'denoise', 'nafnet-sidd-w64').id).toBe('nafnet-sidd-w64');
	});

	it('ignores an override that names no such model', () => {
		expect(pickModel(parsed, 'denoise', 'missing').id).toBe('nafnet-sidd-w32');
	});
});

describe('pickVariant', () => {
	const entry = parseManifest(manifest()).models[0] as ModelEntry;

	it('prefers fp16 on a WebGPU adapter with shader-f16', () => {
		expect(pickVariant(entry, { backend: 'webgpu', shaderF16: true }).precision).toBe('fp16');
	});

	it('falls back to fp32 on WebGPU without shader-f16', () => {
		expect(pickVariant(entry, { backend: 'webgpu', shaderF16: false }).precision).toBe('fp32');
	});

	it('prefers int8 on the processor, then fp32', () => {
		expect(pickVariant(entry, { backend: 'wasm', shaderF16: false }).precision).toBe('int8');
		const noInt8 = { ...entry, variants: entry.variants.filter((v) => v.precision !== 'int8') };
		expect(pickVariant(noInt8, { backend: 'wasm', shaderF16: false }).precision).toBe('fp32');
	});

	it('honours a forced precision', () => {
		expect(pickVariant(entry, { backend: 'wasm', shaderF16: false, precision: 'fp32' }).precision).toBe('fp32');
	});

	it('explains when nothing fits', () => {
		expect(() => pickVariant(entry, { backend: 'webgpu', shaderF16: false, precision: 'int8' })).toThrow(
			'has no int8 variant for webgpu without shader-f16',
		);
	});
});
