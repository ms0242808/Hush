// SPDX-License-Identifier: Apache-2.0
import type { Backend } from './types.ts';

/**
 * `/models/manifest.json` (§4.3). Switching models is an edit to this file:
 * the pipeline reads tiling and input conventions from here, never from code.
 */
export interface ModelManifest {
	schema: 1;
	active: Record<string, string>;
	models: ModelEntry[];
}

export type Precision = 'fp16' | 'fp32' | 'int8';

export interface ModelVariant {
	precision: Precision;
	bytes: number;
	sha256: string;
	/** Paths relative to the manifest. Concatenated in order, they are the ONNX file. */
	parts: string[];
	/** Backends this variant is meant for: fp16 needs `shader-f16` on WebGPU; int8 is for the processor. */
	backends: Backend[];
}

export interface ModelEntry {
	id: string;
	family: string;
	task: string;
	label: Record<string, string>;
	variants: ModelVariant[];
	tile: { padMultiple: number; overlap: number };
	input: { range: [number, number]; layout: 'NCHW'; colour: 'RGB' };
	source: { repo: string; revision: string };
	licence: { code: string; weights: string; trainingData: string };
}

export class ManifestError extends Error {
	constructor(path: string, problem: string) {
		super(`models manifest: ${path} ${problem}`);
		this.name = 'ManifestError';
	}
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function object(value: unknown, path: string): Json {
	if (!isObject(value)) throw new ManifestError(path, 'must be an object');
	return value;
}

function string(value: unknown, path: string): string {
	if (typeof value !== 'string' || value === '') throw new ManifestError(path, 'must be a non-empty string');
	return value;
}

function positiveInteger(value: unknown, path: string, allowZero = false): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
		throw new ManifestError(path, allowZero ? 'must be a non-negative integer' : 'must be a positive integer');
	}
	return value;
}

function array(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value) || value.length === 0) throw new ManifestError(path, 'must be a non-empty array');
	return value;
}

function stringRecord(value: unknown, path: string): Record<string, string> {
	const record = object(value, path);
	for (const [key, entry] of Object.entries(record)) string(entry, `${path}.${key}`);
	return record as Record<string, string>;
}

const PRECISIONS: readonly Precision[] = ['fp16', 'fp32', 'int8'];
const BACKENDS: readonly Backend[] = ['webgpu', 'wasm'];

function parseVariant(value: unknown, path: string): ModelVariant {
	const v = object(value, path);
	const precision = v['precision'];
	if (!PRECISIONS.includes(precision as Precision)) {
		throw new ManifestError(`${path}.precision`, `must be one of ${PRECISIONS.join(', ')}`);
	}
	const sha256 = string(v['sha256'], `${path}.sha256`);
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ManifestError(`${path}.sha256`, 'must be 64 lowercase hex digits');
	const backends = array(v['backends'], `${path}.backends`).map((b, i) => {
		if (!BACKENDS.includes(b as Backend)) {
			throw new ManifestError(`${path}.backends[${i}]`, `must be one of ${BACKENDS.join(', ')}`);
		}
		return b as Backend;
	});
	return {
		precision: precision as Precision,
		bytes: positiveInteger(v['bytes'], `${path}.bytes`),
		sha256,
		parts: array(v['parts'], `${path}.parts`).map((p, i) => string(p, `${path}.parts[${i}]`)),
		backends,
	};
}

function parseModel(value: unknown, path: string): ModelEntry {
	const m = object(value, path);
	const tile = object(m['tile'], `${path}.tile`);
	const input = object(m['input'], `${path}.input`);
	const range = input['range'];
	if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => typeof n === 'number')) {
		throw new ManifestError(`${path}.input.range`, 'must be [min, max]');
	}
	if (input['layout'] !== 'NCHW') throw new ManifestError(`${path}.input.layout`, 'must be "NCHW"');
	if (input['colour'] !== 'RGB') throw new ManifestError(`${path}.input.colour`, 'must be "RGB"');
	const source = object(m['source'], `${path}.source`);
	const licence = object(m['licence'], `${path}.licence`);

	return {
		id: string(m['id'], `${path}.id`),
		family: string(m['family'], `${path}.family`),
		task: string(m['task'], `${path}.task`),
		label: stringRecord(m['label'], `${path}.label`),
		variants: array(m['variants'], `${path}.variants`).map((v, i) => parseVariant(v, `${path}.variants[${i}]`)),
		tile: {
			padMultiple: positiveInteger(tile['padMultiple'], `${path}.tile.padMultiple`),
			overlap: positiveInteger(tile['overlap'], `${path}.tile.overlap`, true),
		},
		input: { range: [range[0] as number, range[1] as number], layout: 'NCHW', colour: 'RGB' },
		source: {
			repo: string(source['repo'], `${path}.source.repo`),
			revision: string(source['revision'], `${path}.source.revision`),
		},
		licence: {
			code: string(licence['code'], `${path}.licence.code`),
			weights: string(licence['weights'], `${path}.licence.weights`),
			trainingData: string(licence['trainingData'], `${path}.licence.trainingData`),
		},
	};
}

/** Validate a parsed `manifest.json`. Throws a ManifestError naming the offending field. */
export function parseManifest(value: unknown): ModelManifest {
	const root = object(value, '(root)');
	if (root['schema'] !== 1) throw new ManifestError('schema', `must be 1 (got ${JSON.stringify(root['schema'])})`);
	const active = stringRecord(root['active'], 'active');
	const models = array(root['models'], 'models').map((m, i) => parseModel(m, `models[${i}]`));

	const ids = new Set<string>();
	for (const model of models) {
		if (ids.has(model.id)) throw new ManifestError('models', `contains "${model.id}" twice`);
		ids.add(model.id);
	}
	for (const [task, id] of Object.entries(active)) {
		const model = models.find((m) => m.id === id);
		if (!model) throw new ManifestError(`active.${task}`, `names "${id}", which is not in models`);
		if (model.task !== task) throw new ManifestError(`active.${task}`, `names "${id}", a ${model.task} model`);
	}
	return { schema: 1, active, models };
}

/**
 * The model to use for a task: the `?model=<id>` override when it names a
 * model for that task, otherwise the manifest's active one.
 */
export function pickModel(manifest: ModelManifest, task: string, overrideId?: string | null): ModelEntry {
	if (overrideId) {
		const override = manifest.models.find((m) => m.id === overrideId && m.task === task);
		if (override) return override;
	}
	const activeId = manifest.active[task];
	const model = manifest.models.find((m) => m.id === activeId);
	if (!model) throw new ManifestError(`active.${task}`, 'is not set');
	return model;
}

export interface VariantNeeds {
	backend: Backend;
	/** WebGPU adapter exposes `shader-f16`. */
	shaderF16: boolean;
	/** Force a precision (benchmarks, bug reproduction). */
	precision?: Precision;
}

/**
 * The variant to download. WebGPU prefers fp16 when the adapter can run it and
 * falls back to fp32. The processor prefers int8 when the manifest lists one
 * for it, then fp32: fp16 brings no speed on the CPU path.
 */
export function pickVariant(model: ModelEntry, needs: VariantNeeds): ModelVariant {
	const usable = model.variants.filter(
		(v) =>
			v.backends.includes(needs.backend) && (v.precision !== 'fp16' || needs.backend !== 'webgpu' || needs.shaderF16),
	);
	const order: Precision[] = needs.precision
		? [needs.precision]
		: needs.backend === 'webgpu'
			? ['fp16', 'fp32']
			: ['int8', 'fp32'];
	for (const precision of order) {
		const variant = usable.find((v) => v.precision === precision);
		if (variant) return variant;
	}
	const what = needs.precision ? `${needs.precision} variant` : 'variant';
	const limitation = needs.backend === 'webgpu' && !needs.shaderF16 ? ' without shader-f16' : '';
	throw new ManifestError(`models[${model.id}]`, `has no ${what} for ${needs.backend}${limitation}`);
}
