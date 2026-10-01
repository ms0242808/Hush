// SPDX-License-Identifier: Apache-2.0
/**
 * The pipeline worker. Everything heavy — decoding, tiling, inference,
 * blending, encoding — happens here; the main thread only draws. Pixels cross
 * the boundary only as previews (transferred ImageBitmaps) and as the final
 * encoded file (a transferred buffer).
 */
import {
	megapixelsPerSecond,
	parseManifest,
	pickModel,
	pickVariant,
	type Backend,
	type Image8,
	type ModelEntry,
	type ModelManifest,
	type ModelVariant,
	type Precision,
	type TiledProgress,
	type TiledStats,
} from '@hush/core';
import { denoise } from '@hush/ops';
import * as Comlink from 'comlink';
import { probeGpu } from '../lib/gpu-probe.ts';
import { decodePhoto, encodeJpeg, type PhotoFormat } from './codecs.ts';
import { isModelCached, loadModel } from './model-store.ts';
import { clampRect, cropImage, psnr, toBitmap, type Rect } from './pixels.ts';
import { createSession, loadRuntime, type OrtLogLevel, type SessionInfo } from './runtime.ts';
import { SYNTHETIC_SIZES, syntheticPhoto, type SyntheticSize } from './synthetic.ts';

const MANIFEST_URL = new URL('/models/manifest.json', self.location.origin).href;
const now = () => performance.now();

export interface PrepareRequest {
	backend: Backend;
	modelId?: string | null;
	precision?: Precision;
	threads?: number;
	/** ONNX Runtime's log level, for diagnosing which nodes run where (?ortLog=verbose on the bench). */
	logLevel?: OrtLogLevel;
	/** Benchmark experiments only: WebGPU execution-provider options (?ep=key:value on the bench). */
	webgpuOptions?: Record<string, string>;
}

export interface PrepareResult {
	backend: Backend;
	modelId: string;
	precision: Precision;
	modelBytes: number;
	fromCache: boolean;
	modelMs: number;
	runtimeMs: number;
	runtimeBytes: number;
	sessionMs: number;
	threads: number;
	licence: ModelEntry['licence'];
}

export interface OpenResult {
	name: string;
	format: PhotoFormat | 'synthetic';
	width: number;
	height: number;
	openMs: number;
}

export interface RunRequest {
	tileSize: number;
	strength?: number;
}

export interface RunResult {
	backend: Backend;
	modelId: string;
	precision: Precision;
	width: number;
	height: number;
	tileSize: number;
	ms: number;
	mpPerSecond: number;
	stats: TiledStats;
}

export interface SeamResult {
	size: number;
	tileSize: number;
	psnr: number;
	maxDiff: number;
}

export interface CropResult {
	rect: Rect;
	before: ImageBitmap;
	after: ImageBitmap | null;
}

interface Prepared {
	backend: Backend;
	model: ModelEntry;
	variant: ModelVariant;
	info: SessionInfo;
	threads: number;
}

let manifest: ModelManifest | null = null;
let prepared: Prepared | null = null;
let source: { image: Image8; name: string } | null = null;
let result: Image8 | null = null;
let cancel = { aborted: false };

function named(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

async function loadManifest(): Promise<ModelManifest> {
	if (manifest) return manifest;
	const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
	if (!response.ok) throw named('ModelError', `models/manifest.json: HTTP ${response.status}`);
	manifest = parseManifest(await response.json());
	return manifest;
}

/** Run the denoiser, failing fast if the GPU device is lost mid-run. */
async function denoiseWith(
	ready: Prepared,
	image: Image8,
	tileSize: number,
	strength: number,
	onProgress?: (p: TiledProgress) => void,
) {
	const run = denoise(image, {
		model: ready.model,
		session: ready.info.session,
		tileSize,
		params: { strength },
		...(onProgress && { onProgress }),
		signal: cancel,
		now,
	});
	if (!ready.info.deviceLost) return run;
	const lost = ready.info.deviceLost.then((reason) => {
		prepared = null;
		throw named('DeviceLostError', `The GPU device was lost (${reason})`);
	});
	return Promise.race([run, lost]);
}

const api = {
	/** WebGPU as seen from inside this worker. */
	probe: probeGpu,

	manifest: loadManifest,

	isCached: (sha256: string) => isModelCached(sha256),

	/** Load the runtime and model for a backend and create a session. Idempotent for the same request. */
	async prepare(
		request: PrepareRequest,
		onProgress?: (received: number, total: number) => void,
	): Promise<PrepareResult> {
		const loaded = await loadManifest();
		const model = pickModel(loaded, 'denoise', request.modelId);
		let shaderF16 = false;
		if (request.backend === 'webgpu') {
			const probe = await probeGpu();
			if (probe.webgpu !== 'adapter') throw named('WebGpuUnavailableError', `WebGPU in a worker: ${probe.webgpu}`);
			shaderF16 = probe.shaderF16;
		}
		const variant = pickVariant(model, {
			backend: request.backend,
			shaderF16,
			...(request.precision && { precision: request.precision }),
		});
		const threads =
			request.threads ?? (request.backend === 'wasm' ? Math.max(1, (navigator.hardwareConcurrency || 2) - 1) : 1);

		const [runtime, file] = await Promise.all([
			loadRuntime(request.backend, threads, now, request.logLevel),
			loadModel(variant, MANIFEST_URL, (received, total) => onProgress?.(received, total), now),
		]);
		if (prepared?.variant.sha256 !== variant.sha256) {
			await prepared?.info.session.dispose();
			prepared = null;
			prepared = {
				backend: request.backend,
				model,
				variant,
				info: await createSession(runtime, file.bytes, now, request.logLevel, request.webgpuOptions),
				threads: runtime.threads,
			};
		}
		return {
			backend: request.backend,
			modelId: model.id,
			precision: variant.precision,
			modelBytes: variant.bytes,
			fromCache: file.fromCache,
			modelMs: file.ms,
			runtimeMs: runtime.loadMs,
			runtimeBytes: runtime.wasmBytes,
			sessionMs: prepared.info.createMs,
			threads: runtime.threads,
			licence: model.licence,
		};
	},

	async openFile(file: File): Promise<OpenResult> {
		const start = now();
		source = null;
		result = null;
		const { image, format } = await decodePhoto(await file.arrayBuffer());
		source = { image, name: file.name };
		return { name: file.name, format, width: image.width, height: image.height, openMs: now() - start };
	},

	openSynthetic(size: SyntheticSize): OpenResult {
		const start = now();
		const { width, height } = SYNTHETIC_SIZES[size];
		source = { image: syntheticPhoto(width, height), name: `synthetic-${size}` };
		result = null;
		return { name: source.name, format: 'synthetic', width, height, openMs: now() - start };
	},

	async run(request: RunRequest, onProgress?: (progress: TiledProgress) => void): Promise<RunResult> {
		if (!prepared) throw named('StateError', 'No model is ready');
		if (!source) throw named('StateError', 'No photo is open');
		cancel = { aborted: false };
		result = null;
		const start = now();
		const { image, stats } = await denoiseWith(
			prepared,
			source.image,
			request.tileSize,
			request.strength ?? 1,
			onProgress,
		);
		const ms = now() - start;
		result = image;
		return {
			backend: prepared.backend,
			modelId: prepared.model.id,
			precision: prepared.variant.precision,
			width: image.width,
			height: image.height,
			tileSize: stats.tileWidth,
			ms,
			mpPerSecond: megapixelsPerSecond(image.width, image.height, ms),
			stats,
		};
	},

	cancel(): void {
		cancel.aborted = true;
	},

	/** The same region of the original and the result, for a 1:1 preview. */
	async crop(rect: Rect): Promise<CropResult> {
		if (!source) throw named('StateError', 'No photo is open');
		const clamped = clampRect(source.image, rect);
		const before = await toBitmap(cropImage(source.image, clamped));
		const after = result ? await toBitmap(cropImage(result, clamped)) : null;
		return Comlink.transfer({ rect: clamped, before, after }, after ? [before, after] : [before]);
	},

	/**
	 * Seam check: denoise a centre crop once as a single tile and once tiled,
	 * and compare. Global pooling inside the model makes tiles differ slightly;
	 * feathering has to hide that.
	 */
	async seamCheck(tileSize: number, size = 1024): Promise<SeamResult> {
		if (!prepared) throw named('StateError', 'No model is ready');
		if (!source) throw named('StateError', 'No photo is open');
		const { image } = source;
		const crop = cropImage(image, {
			x: (image.width - size) / 2,
			y: (image.height - size) / 2,
			width: size,
			height: size,
		});
		cancel = { aborted: false };
		const overlap = prepared.model.tile.overlap;
		const whole = await denoiseWith(prepared, crop, Math.max(crop.width, crop.height) + 2 * overlap + 16, 1);
		const tiled = await denoiseWith(prepared, crop, tileSize, 1);
		return { size: crop.width, tileSize: tiled.stats.tileWidth, ...psnr(whole.image, tiled.image) };
	},

	async exportJpeg(quality = 95): Promise<{ bytes: Uint8Array; ms: number }> {
		if (!result) throw named('StateError', 'Nothing to export');
		const start = now();
		const bytes = await encodeJpeg(result, quality);
		return Comlink.transfer({ bytes, ms: now() - start }, [bytes.buffer]);
	},

	async release(): Promise<void> {
		await prepared?.info.session.dispose();
		prepared = null;
		source = null;
		result = null;
	},
};

export type PipelineApi = typeof api;

Comlink.expose(api);
