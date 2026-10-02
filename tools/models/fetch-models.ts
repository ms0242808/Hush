// SPDX-License-Identifier: Apache-2.0
/**
 * Fetch, verify and split the models Hush serves, and write the manifest.
 *
 *   node tools/models/fetch-models.ts                       release models from Hugging Face (pinned revision)
 *   node tools/models/fetch-models.ts --from tools/models/out  release models from a local export
 *   node tools/models/fetch-models.ts --set test            the tiny models CI's end-to-end tests use
 *
 * Options:
 *   --only <id>[:<precision>,…]   limit to one model (and some precisions); repeatable
 *   --out <dir>                   default apps/web/.models/<set>, which the web build ships at /models/
 *
 * Every file is checked against the sha256 in the lock file before it is split
 * into ≤ 24 MiB, content-addressed parts. A changed upstream file fails the
 * build instead of shipping silently.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_FILE_BYTES } from '../limits.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

type Precision = 'fp16' | 'fp32' | 'int8';
type Backend = 'webgpu' | 'wasm';

export interface LockVariant {
	precision: Precision;
	file: string;
	bytes: number;
	sha256: string;
	backends: Backend[];
}

export interface LockModel {
	id: string;
	family: string;
	task: string;
	label: Record<string, string>;
	tile: { padMultiple: number; overlap: number; channels?: number };
	input: { range: [number, number]; layout: 'NCHW'; colour: 'RGB' };
	licence: { code: string; weights: string; trainingData: string };
	variants: LockVariant[];
}

/** One model in /models/manifest.json (§4.3). */
interface ManifestModel extends Omit<LockModel, 'variants'> {
	variants: Array<Omit<LockVariant, 'file'> & { parts: string[] }>;
	source: { repo: string; revision: string };
}

export interface ModelLock {
	schema: 1;
	/** Where the files are published. `revision: null` means not published yet: use --from. */
	source: { kind: 'huggingface'; repo: string; revision: string | null } | { kind: 'repository'; path: string };
	active: Record<string, string>;
	models: LockModel[];
}

export function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Split into parts of at most `maxBytes`. */
export function splitBytes(bytes: Uint8Array, maxBytes = MAX_FILE_BYTES): Uint8Array[] {
	const parts: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += maxBytes)
		parts.push(bytes.subarray(offset, offset + maxBytes));
	return parts;
}

export function partNames(model: LockModel, variant: LockVariant, count: number): string[] {
	const stem = `${model.id}.${variant.precision}.${variant.sha256.slice(0, 12)}.onnx`;
	return Array.from({ length: count }, (_, i) => `parts/${stem}.${String(i).padStart(3, '0')}`);
}

export function sourceDescription(lock: ModelLock): { repo: string; revision: string } {
	if (lock.source.kind === 'repository') return { repo: lock.source.path, revision: 'in-repository' };
	return {
		repo: `https://huggingface.co/${lock.source.repo}`,
		revision: lock.source.revision ?? 'local-export',
	};
}

/** Parse `--only nafnet-sidd-w32:fp16,fp32` filters. */
export function parseOnly(values: string[]): Map<string, Set<Precision> | null> {
	const filters = new Map<string, Set<Precision> | null>();
	for (const value of values) {
		const [id, precisions] = value.split(':');
		filters.set(id!, precisions ? new Set(precisions.split(',') as Precision[]) : null);
	}
	return filters;
}

async function download(url: string, cachePath: string, expected: LockVariant): Promise<Uint8Array> {
	if (existsSync(cachePath)) {
		const cached = new Uint8Array(readFileSync(cachePath));
		if (sha256(cached) === expected.sha256) return cached;
	}
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	mkdirSync(path.dirname(cachePath), { recursive: true });
	writeFileSync(cachePath, bytes);
	return bytes;
}

async function readVariant(lock: ModelLock, variant: LockVariant, from: string | undefined, lockDir: string) {
	if (from) return new Uint8Array(readFileSync(path.resolve(from, variant.file)));
	if (lock.source.kind === 'repository')
		return new Uint8Array(readFileSync(path.resolve(lockDir, lock.source.path, variant.file)));
	if (!lock.source.revision) {
		throw new Error(
			`${variant.file}: ${lock.source.repo} has no published revision in the lock file yet. ` +
				'Export the models and pass --from tools/models/out (see tools/models/README.md).',
		);
	}
	const url = `https://huggingface.co/${lock.source.repo}/resolve/${lock.source.revision}/${variant.file}`;
	return download(url, path.join(here, '.cache', 'downloads', variant.sha256), variant);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			set: { type: 'string', default: 'release' },
			from: { type: 'string' },
			only: { type: 'string', multiple: true, default: [] },
			out: { type: 'string' },
		},
	});
	const lockPath =
		values.set === 'test' ? path.join(here, 'test-models', 'models.lock.json') : path.join(here, 'models.lock.json');
	const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as ModelLock;
	const only = parseOnly(values.only);
	const out = path.resolve(
		values.out ?? path.join(repoRoot, 'apps/web/.models', values.set === 'test' ? 'test' : 'release'),
	);

	rmSync(out, { recursive: true, force: true });
	mkdirSync(path.join(out, 'parts'), { recursive: true });

	const models: ManifestModel[] = [];
	for (const model of lock.models) {
		if (only.size > 0 && !only.has(model.id)) continue;
		const precisions = only.get(model.id);
		const variants: ManifestModel['variants'] = [];
		for (const variant of model.variants) {
			if (precisions && !precisions.has(variant.precision)) continue;
			const bytes = await readVariant(lock, variant, values.from, path.dirname(lockPath));
			const actual = sha256(bytes);
			if (bytes.byteLength !== variant.bytes || actual !== variant.sha256) {
				throw new Error(
					`${variant.file}: got ${bytes.byteLength} bytes, sha256 ${actual}; ` +
						`the lock file pins ${variant.bytes} bytes, sha256 ${variant.sha256}`,
				);
			}
			const parts = splitBytes(bytes);
			const names = partNames(model, variant, parts.length);
			parts.forEach((part, i) => writeFileSync(path.join(out, names[i]!), part));
			variants.push({
				precision: variant.precision,
				bytes: variant.bytes,
				sha256: variant.sha256,
				parts: names,
				backends: variant.backends,
			});
			console.log(
				`  ${model.id} ${variant.precision.padEnd(4)} ${(variant.bytes / 1e6).toFixed(1).padStart(6)} MB  ${parts.length} part(s)`,
			);
		}
		if (variants.length > 0) {
			models.push({
				id: model.id,
				family: model.family,
				task: model.task,
				label: model.label,
				variants,
				tile: model.tile,
				input: model.input,
				source: sourceDescription(lock),
				licence: model.licence,
			});
		}
	}
	if (models.length === 0) throw new Error('No models selected');

	const ids = new Set(models.map((m) => m.id));
	const active = Object.fromEntries(
		Object.entries(lock.active).map(([task, id]) => [task, ids.has(id) ? id : models.find((m) => m.task === task)!.id]),
	);
	const manifest = { schema: 1, active, models };
	writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
	console.log(`Wrote ${path.relative(repoRoot, out)}/manifest.json (${models.length} model(s))`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
