// SPDX-License-Identifier: Apache-2.0
/**
 * The pipeline worker. Everything heavy — decoding, tiling, inference,
 * blending, encoding, metadata — happens here; the main thread only draws.
 * Pixels cross the boundary only as previews (transferred ImageBitmaps) and
 * as finished files (transferred buffers).
 */
import {
	blankPhotoInfo,
	bytesPerPixel,
	chooseTileSize,
	DEFAULT_OUTPUT,
	deviceClass,
	encodePhoto,
	loadManifest,
	loadModel,
	MAX_MEGAPIXELS,
	megapixelsPerSecond,
	PhotoTooLargeError,
	pickModel,
	pickVariant,
	processPhoto,
	readPhoto,
	runRecipe,
	type Backend,
	type ColourSource,
	type DecodedOrientation,
	type Image8,
	type MetadataWarning,
	type ModelEntry,
	type ModelManifest,
	type ModelVariant,
	type Orientation,
	type OutputSettings,
	type PhotoInfo,
	type PhotoProgress,
	type Precision,
	type Recipe,
	type TiledProgress,
	type TiledStats,
} from '@hush/core';
import { createDenoiseOperation, defaultRecipe, OPERATIONS } from '@hush/ops';
import * as Comlink from 'comlink';
import '../lib/worker-errors.ts';
import { DEFAULT_TILE_SIZE } from '../lib/defaults.ts';
import { sniffFormat, type PhotoFormat } from '../lib/formats.ts';
import { probeGpu } from '../lib/gpu-probe.ts';
import { browserCodecs } from './adapters/codecs.ts';
import { loadRuntime, OrtSession, type FaultPlan, type OrtLogLevel } from './adapters/inference.ts';
import { browserAssets, browserStorage, browserZlib, memoryOutput, named, sha256Hex } from './adapters/platform.ts';
import { clampRect, cropImage, psnr, toBitmap, type Rect } from './pixels.ts';
import { SYNTHETIC_SIZES, syntheticPhoto, type SyntheticSize } from './synthetic.ts';

const now = () => performance.now();
/** The `Software` tag on every export (§2.6). */
const SOFTWARE = 'Hush';
/** Fault injection exists for the end-to-end tests only, never in a production build. */
const TESTING = import.meta.env.MODE !== 'production';

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
	/** The tile ceiling this device gets: the backend's default, capped by GPU limits and earlier backoffs. */
	tileSize: number;
	licence: ModelEntry['licence'];
}

export interface OpenResult {
	name: string;
	format: PhotoFormat | 'synthetic';
	width: number;
	height: number;
	/** How to display the stored pixels upright (EXIF 1–8). The preview rotates; the pixels never do. */
	orientation: Orientation;
	bitDepth: number;
	colour: ColourSource;
	warnings: MetadataWarning[];
	openMs: number;
}

export interface RunRequest {
	/** Tile ceiling; by default the one `prepare` chose. */
	tileSize?: number;
	/** The recipe to apply; by default the model's output unchanged. */
	recipe?: Recipe;
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
	/** Float memory at the peak: band, tiles and the adjust stage's rows. */
	peakFloatBytes: number;
}

export interface SeamResult {
	size: number;
	tileSize: number;
	psnr: number;
	maxDiff: number;
}

export interface CropResult {
	rect: Rect;
	orientation: Orientation;
	before: ImageBitmap;
	after: ImageBitmap | null;
}

export interface ExportResult {
	bytes: Uint8Array;
	name: string;
	mimeType: string;
	warnings: MetadataWarning[];
	encodeMs: number;
	metadataMs: number;
}

export interface ProcessResult extends ExportResult {
	backend: Backend;
	width: number;
	height: number;
	source: {
		format: string;
		width: number;
		height: number;
		bitDepth: number;
		colour: ColourSource;
		hadLocation: boolean;
	};
	stats: {
		readMs: number;
		decodeMs: number;
		processMs: number;
		saveMs: number;
		totalMs: number;
		mpPerSecond: number;
		tiled: TiledStats | null;
		peakFloatBytes: number;
	};
}

interface Prepared {
	backend: Backend;
	model: ModelEntry;
	variant: ModelVariant;
	session: OrtSession;
	threads: number;
	tileSize: number;
	result: Omit<PrepareResult, 'tileSize'>;
}

interface Source {
	name: string;
	/** The file as it arrived, for its metadata at export; null for synthetic photos. */
	info: PhotoInfo;
	orientation: DecodedOrientation;
	image: Image8;
}

let manifest: ModelManifest | null = null;
let prepared: Prepared | null = null;
/** A tile size that ran out of memory earlier in this session (§2.3: remembered for the session). */
let tileCeiling: number | null = null;
let source: Source | null = null;
let result: Image8 | null = null;
let cancel = { aborted: false };

async function manifestOnce(): Promise<ModelManifest> {
	manifest ??= await loadManifest(browserAssets);
	return manifest;
}

function maxMegapixels(): number {
	const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
	return MAX_MEGAPIXELS[deviceClass(typeof memory === 'number' ? memory : null)];
}

function currentTileSize(ready: Prepared): number {
	return chooseTileSize({
		preferred: ready.tileSize,
		padMultiple: ready.model.tile.padMultiple,
		overlap: ready.model.tile.overlap,
		remembered: tileCeiling,
	});
}

function denoiseOperation(ready: Prepared, tileSize?: number) {
	return createDenoiseOperation({
		model: ready.model,
		session: ready.session,
		tileSize: () => tileSize ?? currentTileSize(ready),
		onBackoff: (size) => {
			tileCeiling = Math.min(tileCeiling ?? Infinity, size);
		},
	});
}

/** Read a file's container, refusing what Hush can't process before decoding a pixel. */
async function readFile(file: File): Promise<{ bytes: Uint8Array; info: PhotoInfo }> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const info = await readPhoto(bytes, browserZlib);
	const megapixels = (info.width * info.height) / 1e6;
	if (megapixels > maxMegapixels()) throw new PhotoTooLargeError(megapixels, maxMegapixels());
	return { bytes, info };
}

const api = {
	/** WebGPU as seen from inside this worker. */
	probe: probeGpu,

	manifest: manifestOnce,

	isCached: (sha256: string) => browserStorage.has(sha256),

	/** Load the runtime and model for a backend and create a session. Idempotent for the same request. */
	async prepare(
		request: PrepareRequest,
		onProgress?: (received: number, total: number) => void,
	): Promise<PrepareResult> {
		const loaded = await manifestOnce();
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

		if (prepared?.variant.sha256 !== variant.sha256) {
			const modelStart = now();
			const [runtime, file] = await Promise.all([
				loadRuntime(request.backend, threads, now, request.logLevel),
				loadModel(variant, {
					assets: browserAssets,
					storage: browserStorage,
					sha256: sha256Hex,
					onProgress: (received, total) => onProgress?.(received, total),
				}),
			]);
			const modelMs = now() - modelStart;
			await prepared?.session.dispose();
			prepared = null;
			const session = await OrtSession.create(runtime, file.bytes, now, {
				...(request.logLevel && { logLevel: request.logLevel }),
				...(request.webgpuOptions && { webgpuOptions: request.webgpuOptions }),
			});
			// The ceiling: the backend's measured best, capped so the model's largest tensor fits the GPU's buffers.
			const tileSize = chooseTileSize({
				preferred: DEFAULT_TILE_SIZE[request.backend],
				padMultiple: model.tile.padMultiple,
				overlap: model.tile.overlap,
				bytesPerPixel: bytesPerPixel(model, variant),
				...(session.device && { maxBufferBytes: session.device.maxBufferBytes }),
			});
			prepared = {
				backend: request.backend,
				model,
				variant,
				session,
				threads: runtime.threads,
				tileSize,
				result: {
					backend: request.backend,
					modelId: model.id,
					precision: variant.precision,
					modelBytes: variant.bytes,
					fromCache: file.fromCache,
					modelMs,
					runtimeMs: runtime.loadMs,
					runtimeBytes: runtime.wasmBytes,
					sessionMs: session.createMs,
					threads: runtime.threads,
					licence: model.licence,
				},
			};
		} else {
			onProgress?.(variant.bytes, variant.bytes);
		}
		return { ...prepared.result, tileSize: currentTileSize(prepared) };
	},

	/** Open a photo for the interactive flow: read its container and decode it, keeping both. */
	async openFile(file: File): Promise<OpenResult> {
		const start = now();
		source = null;
		result = null;
		const { bytes, info } = await readFile(file);
		const decoded = await browserCodecs.decode(bytes, info.format);
		const image = decoded.image as Image8;
		source = { name: file.name, info, orientation: decoded.orientation, image };
		return {
			name: file.name,
			format: info.format,
			width: image.width,
			height: image.height,
			orientation: decoded.orientation === 'applied' ? 1 : info.orientation,
			bitDepth: info.bitDepth,
			colour: info.colour,
			warnings: info.warnings,
			openMs: now() - start,
		};
	},

	openSynthetic(size: SyntheticSize): OpenResult {
		const start = now();
		const { width, height } = SYNTHETIC_SIZES[size];
		source = {
			name: `synthetic-${size}.png`,
			info: blankPhotoInfo('png', width, height),
			orientation: 'as-stored',
			image: syntheticPhoto(width, height),
		};
		result = null;
		return {
			name: source.name,
			format: 'synthetic',
			width,
			height,
			orientation: 1,
			bitDepth: 8,
			colour: 'none',
			warnings: [],
			openMs: now() - start,
		};
	},

	/** Denoise the open photo into a separate result, keeping the original for the comparison. */
	async run(request: RunRequest = {}, onProgress?: (progress: TiledProgress) => void): Promise<RunResult> {
		if (!prepared) throw named('StateError', 'No model is ready');
		if (!source) throw named('StateError', 'No photo is open');
		cancel = { aborted: false };
		result = null;
		const ready = prepared;
		const image = source.image;
		const output: Image8 = { ...image, data: new Uint8Array(image.data.length) };
		const start = now();
		const processed = await runRecipe(image, request.recipe ?? defaultRecipe(ready.model.id), {
			operations: { denoise: denoiseOperation(ready, request.tileSize) },
			output,
			signal: cancel,
			now,
			...(onProgress && { onProgress }),
		});
		const ms = now() - start;
		result = output;
		const stats = processed.tiled!;
		return {
			backend: ready.backend,
			modelId: ready.model.id,
			precision: ready.variant.precision,
			width: image.width,
			height: image.height,
			tileSize: stats.tileWidth,
			ms,
			mpPerSecond: megapixelsPerSecond(image.width, image.height, ms),
			stats,
			peakFloatBytes: stats.peakFloatBytes + processed.floatBytes,
		};
	},

	cancel(): void {
		cancel.aborted = true;
	},

	/** The same region of the original and the result, for a 1:1 preview, and how to turn it upright. */
	async crop(rect: Rect): Promise<CropResult> {
		if (!source) throw named('StateError', 'No photo is open');
		const clamped = clampRect(source.image, rect);
		const before = await toBitmap(cropImage(source.image, clamped));
		const after = result ? await toBitmap(cropImage(result, clamped)) : null;
		const orientation = source.orientation === 'applied' ? 1 : source.info.orientation;
		return Comlink.transfer({ rect: clamped, orientation, before, after }, after ? [before, after] : [before]);
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
		const recipe = defaultRecipe(prepared.model.id);
		const run = async (tile: number) => {
			const output: Image8 = { ...crop, data: new Uint8Array(crop.data.length) };
			const stats = await runRecipe(crop, recipe, {
				operations: { denoise: denoiseOperation(prepared!, tile) },
				output,
				signal: cancel,
				now,
			});
			return { output, tileWidth: stats.tiled!.tileWidth };
		};
		const whole = await run(Math.max(crop.width, crop.height) + 2 * overlap + 16);
		const tiled = await run(tileSize);
		return { size: crop.width, tileSize: tiled.tileWidth, ...psnr(whole.output, tiled.output) };
	},

	/** Encode the last result with the original's metadata (§2.6). */
	async exportPhoto(settings: Partial<OutputSettings> = {}): Promise<ExportResult> {
		if (!result || !source) throw named('StateError', 'Nothing to export');
		const exported = await encodePhoto(
			result,
			source.info,
			source.orientation,
			{ name: source.name, output: { ...DEFAULT_OUTPUT, ...settings } },
			{ codecs: browserCodecs, zlib: browserZlib, software: SOFTWARE, now },
		);
		return Comlink.transfer(
			{
				bytes: exported.bytes,
				name: exported.name,
				mimeType: exported.mimeType,
				warnings: exported.warnings,
				encodeMs: exported.encodeMs,
				metadataMs: exported.metadataMs,
			},
			[exported.bytes.buffer],
		);
	},

	/**
	 * One photo, headless, end to end (§2.1): read → decode → denoise in place
	 * → encode → metadata. Holds the photo once; nothing is kept afterwards.
	 */
	async process(
		file: File,
		recipe: Recipe | null,
		settings: Partial<OutputSettings> = {},
		onProgress?: (progress: PhotoProgress) => void,
	): Promise<ProcessResult> {
		if (!prepared) throw named('StateError', 'No model is ready');
		const ready = prepared;
		source = null;
		result = null;
		cancel = { aborted: false };
		const output = memoryOutput();
		const done = await processPhoto(
			{
				name: file.name,
				bytes: new Uint8Array(await file.arrayBuffer()),
				recipe: recipe ?? defaultRecipe(ready.model.id),
				output: { ...DEFAULT_OUTPUT, ...settings },
			},
			{
				codecs: browserCodecs,
				output,
				zlib: browserZlib,
				operations: { denoise: denoiseOperation(ready) },
				software: SOFTWARE,
				maxMegapixels: maxMegapixels(),
				signal: cancel,
				now,
				...(onProgress && { onProgress }),
			},
		);
		return Comlink.transfer(
			{
				bytes: done.bytes,
				name: done.name,
				mimeType: done.mimeType,
				warnings: done.warnings,
				encodeMs: done.stats.encodeMs,
				metadataMs: done.stats.metadataMs,
				backend: ready.backend,
				width: done.width,
				height: done.height,
				source: done.source,
				stats: {
					readMs: done.stats.readMs,
					decodeMs: done.stats.decodeMs,
					processMs: done.stats.processMs,
					saveMs: done.stats.saveMs,
					totalMs: done.stats.totalMs,
					mpPerSecond: megapixelsPerSecond(done.width, done.height, done.stats.processMs),
					tiled: done.stats.tiled,
					peakFloatBytes: done.stats.peakFloatBytes,
				},
			},
			[done.bytes.buffer],
		);
	},

	/**
	 * A synthetic photo through the same pipeline: generated, denoised in
	 * place, encoded with metadata. For measuring very large photos (the
	 * 102 MP check) without a 100 MB test file.
	 */
	async processSynthetic(
		width: number,
		height: number,
		settings: Partial<OutputSettings> = {},
		onProgress?: (progress: TiledProgress) => void,
	): Promise<Omit<ProcessResult, 'bytes'> & { byteLength: number; decoded: { width: number; height: number } }> {
		if (!prepared) throw named('StateError', 'No model is ready');
		const ready = prepared;
		source = null;
		result = null;
		cancel = { aborted: false };
		const started = now();
		const image = syntheticPhoto(width, height);
		const info = blankPhotoInfo('png', width, height);
		const t = now();
		const processed = await runRecipe(image, defaultRecipe(ready.model.id), {
			operations: { denoise: denoiseOperation(ready) },
			signal: cancel,
			now,
			...(onProgress && { onProgress }),
		});
		const processMs = now() - t;
		const exported = await encodePhoto(
			image,
			info,
			'as-stored',
			{ name: `synthetic-${width}x${height}.jpg`, output: { ...DEFAULT_OUTPUT, format: 'jpeg', ...settings } },
			{ codecs: browserCodecs, zlib: browserZlib, software: SOFTWARE, now },
		);
		// Read the file back: the decoder has to cope with a photo this size too.
		const back = await browserCodecs.decode(exported.bytes, 'jpeg');
		return {
			byteLength: exported.bytes.byteLength,
			decoded: { width: back.image.width, height: back.image.height },
			name: exported.name,
			mimeType: exported.mimeType,
			warnings: exported.warnings,
			encodeMs: exported.encodeMs,
			metadataMs: exported.metadataMs,
			backend: ready.backend,
			width,
			height,
			source: { format: 'synthetic', width, height, bitDepth: 8, colour: 'none', hadLocation: false },
			stats: {
				readMs: 0,
				decodeMs: 0,
				processMs,
				saveMs: 0,
				totalMs: now() - started,
				mpPerSecond: megapixelsPerSecond(width, height, processMs),
				tiled: processed.tiled,
				peakFloatBytes: (processed.tiled?.peakFloatBytes ?? 0) + processed.floatBytes,
			},
		};
	},

	/** Decode any supported file back to RGBA, for checking exports. */
	async decode(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
		const format = sniffFormat(bytes.subarray(0, 64));
		if (!format) throw named('UnsupportedPhotoError', 'unknown-format');
		const { image } = await browserCodecs.decode(bytes, format);
		const data = image.data as Uint8Array;
		return Comlink.transfer({ width: image.width, height: image.height, data }, [data.buffer]);
	},

	/** End-to-end tests only: make the next runs fail the way GPUs do. */
	injectFaults(plan: FaultPlan): void {
		if (!TESTING) throw named('StateError', 'Fault injection is off in production builds');
		prepared?.session.setFaults(plan);
	},

	/** The tile ceiling the session has learned, and how often the device was recovered. */
	sessionState(): { tileSize: number | null; recoveries: number } {
		return {
			tileSize: prepared ? currentTileSize(prepared) : null,
			recoveries: prepared?.session.recoveries ?? 0,
		};
	},

	/** Recipes this build can run, for validating presets. */
	operations: () => Object.keys(OPERATIONS),

	async release(): Promise<void> {
		await prepared?.session.dispose();
		prepared = null;
		source = null;
		result = null;
	},
};

export type PipelineApi = typeof api;

Comlink.expose(api);
