// SPDX-License-Identifier: Apache-2.0
/**
 * The pipeline worker. Everything heavy — decoding, tiling, inference,
 * blending, encoding, metadata — happens here; the main thread only draws.
 * Pixels cross the boundary only as previews (transferred ImageBitmaps) and
 * as finished files (transferred buffers).
 */
import {
	asImage8,
	blankPhotoInfo,
	CancelledError,
	chooseTileSize,
	chooseVariant,
	DEFAULT_OUTPUT,
	describeSource,
	deviceClass,
	encodePhoto,
	inferenceFailure,
	loadManifest,
	MAX_MEGAPIXELS,
	megapixelsPerSecond,
	minTileSize,
	msPerPixel,
	noiseMap,
	noisiestPoint,
	PhotoTooLargeError,
	prepareModel,
	PreviewGrid,
	PreviewScheduler,
	processPhoto,
	readPhoto,
	runRecipe,
	tileCeiling,
	type Backend,
	type ColourSource,
	type DecodedOrientation,
	type Image8,
	type MetadataWarning,
	type ModelEntry,
	type ModelRequest,
	type ModelManifest,
	type ModelVariant,
	type Orientation,
	type OutputSettings,
	type PhotoInfo,
	type PhotoProgress,
	type Point,
	type Precision,
	type PreviewRequest,
	type PreviewStatus,
	type PreviewUpdate,
	type Recipe,
	type Size,
	type TiledProgress,
	type TiledStats,
} from '@hush/core';
import { createDenoiseOperation, defaultRecipe, OPERATIONS } from '@hush/ops';
import * as Comlink from 'comlink';
import { plainError, type PlainError } from '../lib/worker-errors.ts';
import { DEFAULT_TILE_SIZE } from '../lib/defaults.ts';
import { sniffFormat, type PhotoFormat } from '../lib/formats.ts';
import { probeGpu } from '../lib/gpu-probe.ts';
import { browserCodecs } from './adapters/codecs.ts';
import { browserAdapters } from './adapters/index.ts';
import { overviewOf, previewColourSpace, profileName } from './editor-images.ts';
import type { FaultPlan, OrtLogLevel, OrtSession } from './adapters/inference.ts';
import { browserAssets, browserStorage, browserZlib, memoryOutput, named } from './adapters/platform.ts';
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

/** A photo opened in the editor (Phase 2): what the viewer needs before any denoising. */
export interface EditorPhoto extends OpenResult {
	megapixels: number;
	decodeMs: number;
	/** Where the viewer opens (§5.3): the centre of the noisiest viewport-sized area, stored coordinates. */
	noisiest: Point;
	/** The whole photo, downscaled, for the fit view. Stored orientation, RGBA. */
	overview: { width: number; height: number; data: Uint8Array };
	/** The canvas colour space that shows these pixels as the photo intends. */
	previewColour: 'srgb' | 'display-p3';
	/** The embedded ICC profile's name, if any. */
	profile: string | null;
	/** The photo carries GPS coordinates (the export can remove them). */
	hadLocation: boolean;
}

export interface PreviewInfo {
	tileSize: number;
	overlap: number;
	/** The export's tile ceiling, for the estimate. */
	exportTileSize: number;
	padMultiple: number;
}

export interface PixelRegion {
	rect: Rect;
	data: Uint8Array;
}

export type EditorExportProgress =
	| { stage: 'processing'; tilesDone: number; tileCount: number; bandsDone: number; bandCount: number }
	| { stage: 'encoding' };

export interface EditedExport extends ExportResult {
	backend: Backend;
	width: number;
	height: number;
	processMs: number;
	totalMs: number;
	stats: TiledStats | null;
	peakFloatBytes: number;
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
/** A model load in flight, so a second request for the same file joins it instead of loading it twice. */
let loading: { sha256: string; job: Promise<void>; listeners: Set<(received: number, total: number) => void> } | null =
	null;
/** A tile size that ran out of memory earlier in this session (§2.3: remembered for the session). */
let rememberedTile: number | null = null;
let source: Source | null = null;
let result: Image8 | null = null;
let cancel = { aborted: false };

/** Preview tiles: about half a second each on a laptop GPU, a few seconds on the processor (§4.6, §2.10). */
const PREVIEW_TILE = 512;
/** On the processor, the preview covers about this much around the divider: "about 512 × 512" (§2.10). */
const CPU_PREVIEW_RADIUS = 200;

interface Editing {
	file: File;
	decodeMs: number;
	noisiest: Point;
	/** An export wrote over the decoded pixels: decode again before reading them. */
	consumed: boolean;
	redecode: Promise<void> | null;
}

interface PreviewCallbacks {
	onUpdate: (update: PreviewUpdate) => unknown;
	onStatus: (status: PreviewStatus) => unknown;
	onError: (error: PlainError) => unknown;
}

interface Preview {
	scheduler: PreviewScheduler;
	callbacks: PreviewCallbacks;
	last: PreviewRequest | null;
}

let editing: Editing | null = null;
let preview: Preview | null = null;
let exporting = false;

/** Fire a main-thread callback without waiting on it, and without an unhandled rejection if the page went away. */
function notify(call: () => unknown): void {
	try {
		void Promise.resolve(call()).catch(() => {});
	} catch {
		// The proxy was released.
	}
}

function previewTileSize(ready: Prepared): number {
	const { padMultiple, overlap } = ready.model.tile;
	const size = Math.min(PREVIEW_TILE, currentTileSize(ready));
	return Math.max(Math.floor(size / padMultiple) * padMultiple, minTileSize(overlap, padMultiple));
}

/** Keep finished preview tiles within what's left of a few hundred MB once the photo itself is held. */
function previewCacheBytes(image: Image8): number {
	return Math.min(160 * 2 ** 20, Math.max(32 * 2 ** 20, 400 * 2 ** 20 - image.data.byteLength));
}

function startScheduler(ready: Prepared, callbacks: PreviewCallbacks, tileSize: number): PreviewInfo {
	if (!source || !editing) throw named('StateError', 'No photo is open');
	preview?.scheduler.dispose();
	const grid = new PreviewGrid({
		width: source.image.width,
		height: source.image.height,
		tileSize,
		overlap: ready.model.tile.overlap,
		anchor: editing.noisiest,
	});
	const scheduler = new PreviewScheduler({
		image: () => source!.image,
		session: ready.session,
		grid,
		now,
		cacheBytes: previewCacheBytes(source.image),
		focusRadius: CPU_PREVIEW_RADIUS,
		onUpdate: (update) => notify(() => callbacks.onUpdate(Comlink.transfer(update, [update.pixels.buffer]))),
		onStatus: (status) => notify(() => callbacks.onStatus(status)),
		onError: (error) => onPreviewError(error),
	});
	const last = preview?.last ?? null;
	preview = { scheduler, callbacks, last };
	if (editing.consumed || exporting) void scheduler.pause();
	if (last) scheduler.request(last);
	return {
		tileSize,
		overlap: ready.model.tile.overlap,
		exportTileSize: currentTileSize(ready),
		padMultiple: ready.model.tile.padMultiple,
	};
}

/** Out of memory on a preview tile: halve it (and what exports start with), like the export tiler would (§2.3). */
function onPreviewError(error: unknown): void {
	const current = preview;
	if (!current || !prepared) return;
	if (inferenceFailure(error) === 'out-of-memory') {
		const smaller = current.scheduler.grid.tileSize / 2;
		const { overlap, padMultiple } = prepared.model.tile;
		if (smaller >= minTileSize(overlap, padMultiple)) {
			rememberedTile = Math.min(rememberedTile ?? Infinity, smaller);
			startScheduler(prepared, current.callbacks, Math.floor(smaller / padMultiple) * padMultiple);
			return;
		}
	}
	notify(() => current.callbacks.onError(plainError(error)));
}

/** Decode the open photo again, after an export wrote over it, so the viewer can keep reading it. */
function startRedecode(): Promise<void> {
	const current = editing;
	if (!current) return Promise.resolve();
	current.redecode ??= (async () => {
		if (!source) return;
		// Let the old pixels go before the decoder allocates new ones: a 100 MP photo is held once.
		source.image = { ...source.image, data: new Uint8Array(0) };
		const bytes = new Uint8Array(await current.file.arrayBuffer());
		const decoded = await browserCodecs.decode(bytes, source.info.format);
		if (editing !== current || !source) return;
		source.image = asImage8(decoded.image);
		current.consumed = false;
	})().finally(() => {
		current.redecode = null;
		if (editing === current && !exporting) preview?.scheduler.resume();
	});
	return current.redecode;
}

async function ensureDecoded(): Promise<void> {
	if (editing?.consumed) await startRedecode();
}

/** Forget the editor's photo and preview: another photo is being opened, or the bench took over. */
function closeEditing(): void {
	preview?.scheduler.dispose();
	preview = null;
	editing = null;
}

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
		remembered: rememberedTile,
	});
}

function denoiseOperation(ready: Prepared, tileSize?: number) {
	return createDenoiseOperation({
		model: ready.model,
		session: ready.session,
		tileSize: () => tileSize ?? currentTileSize(ready),
		onBackoff: (size) => {
			rememberedTile = Math.min(rememberedTile ?? Infinity, size);
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
		let shaderF16 = false;
		if (request.backend === 'webgpu') {
			const probe = await probeGpu();
			if (probe.webgpu !== 'adapter') throw named('WebGpuUnavailableError', `WebGPU in a worker: ${probe.webgpu}`);
			shaderF16 = probe.shaderF16;
		}
		const modelRequest: ModelRequest = {
			task: 'denoise',
			modelId: request.modelId ?? null,
			backend: request.backend,
			shaderF16,
			...(request.precision && { precision: request.precision }),
		};
		const { variant } = chooseVariant(loaded, modelRequest);
		const threads =
			request.threads ?? (request.backend === 'wasm' ? Math.max(1, (navigator.hardwareConcurrency || 2) - 1) : 1);

		// Two opens in quick succession share one load: one download, one session, progress to both.
		if (loading?.sha256 === variant.sha256) {
			const listener = (received: number, total: number) => onProgress?.(received, total);
			loading.listeners.add(listener);
			try {
				await loading.job;
			} finally {
				loading?.listeners.delete(listener);
			}
		}
		if (prepared?.variant.sha256 !== variant.sha256) {
			const listeners = new Set<(received: number, total: number) => void>();
			if (onProgress) listeners.add((received, total) => onProgress(received, total));
			const job = (async () => {
				await prepared?.session.dispose();
				prepared = null;
				const adapters = browserAdapters({
					threads,
					...(request.logLevel && { logLevel: request.logLevel }),
					...(request.webgpuOptions && { webgpuOptions: request.webgpuOptions }),
				});
				const ready = await prepareModel(loaded, modelRequest, adapters, (received, total) => {
					for (const listener of listeners) listener(received, total);
				});
				const session = ready.session as OrtSession; // the browser's inference adapter makes OrtSessions
				prepared = {
					backend: request.backend,
					model: ready.model,
					variant: ready.variant,
					session,
					threads: session.runtime.threads,
					// The ceiling: the backend's measured best, capped so the model's largest tensor fits the GPU's buffers.
					tileSize: tileCeiling(ready, DEFAULT_TILE_SIZE[request.backend]),
					result: {
						backend: request.backend,
						modelId: ready.model.id,
						precision: ready.variant.precision,
						modelBytes: ready.variant.bytes,
						fromCache: ready.fromCache,
						modelMs: ready.loadMs,
						runtimeMs: session.runtime.loadMs,
						runtimeBytes: session.runtime.wasmBytes,
						sessionMs: ready.sessionMs,
						threads: session.runtime.threads,
						licence: ready.model.licence,
					},
				};
			})();
			loading = { sha256: variant.sha256, job, listeners };
			try {
				await job;
			} finally {
				if (loading?.job === job) loading = null;
			}
		} else {
			onProgress?.(variant.bytes, variant.bytes);
		}
		if (!prepared) throw named('ModelError', 'The model did not load');
		return { ...prepared.result, tileSize: currentTileSize(prepared) };
	},

	/** Open a photo for the interactive flow: read its container and decode it, keeping both. */
	async openFile(file: File): Promise<OpenResult> {
		const start = now();
		closeEditing();
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
		closeEditing();
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

	// ── The editor (Phase 2) ────────────────────────────────────────────────

	/**
	 * Open a photo for the editor: refuse what can't be processed, decode it,
	 * and find where to open the viewer (§5.3: at 100% on the noisiest
	 * region). `view` is the viewer's size in display pixels at 100%.
	 */
	async openForEditing(file: File, view: Size): Promise<EditorPhoto> {
		const start = now();
		closeEditing();
		source = null;
		result = null;
		const { bytes, info } = await readFile(file);
		const decodeStart = now();
		const decoded = await browserCodecs.decode(bytes, info.format);
		const image = asImage8(decoded.image);
		const decodeMs = now() - decodeStart;
		source = { name: file.name, info, orientation: decoded.orientation, image };
		const orientation = decoded.orientation === 'applied' ? 1 : info.orientation;
		// The view is measured upright; the noise search works on stored pixels.
		const window = orientation >= 5 ? { width: view.height, height: view.width } : view;
		const noisiest = noisiestPoint(noiseMap(image), window);
		editing = { file, decodeMs, noisiest, consumed: false, redecode: null };
		const overview = overviewOf(image);
		const described = describeSource(info);
		return Comlink.transfer(
			{
				name: file.name,
				format: info.format,
				width: image.width,
				height: image.height,
				orientation,
				bitDepth: info.bitDepth,
				colour: info.colour,
				warnings: info.warnings,
				openMs: now() - start,
				megapixels: (image.width * image.height) / 1e6,
				decodeMs,
				noisiest,
				overview: { width: overview.width, height: overview.height, data: overview.data },
				previewColour: previewColourSpace(info),
				profile: profileName(info),
				hadLocation: described.hadLocation,
			},
			[overview.data.buffer],
		);
	},

	/** The original pixels of a region (stored coordinates, clamped to the photo), RGBA. Null while exporting. */
	async region(rect: Rect): Promise<PixelRegion | null> {
		if (exporting) return null;
		await ensureDecoded();
		if (!source || exporting) return null;
		const clamped = clampRect(source.image, rect);
		const { data } = cropImage(source.image, clamped);
		return Comlink.transfer({ rect: clamped, data }, [data.buffer]);
	},

	/**
	 * Start the progressive preview for the open photo on the prepared model.
	 * Finished areas arrive through `onUpdate` as RGBA; `onStatus` reports
	 * progress; `onError` reports what the preview can't recover from.
	 */
	previewStart(
		onUpdate: PreviewCallbacks['onUpdate'],
		onStatus: PreviewCallbacks['onStatus'],
		onError: PreviewCallbacks['onError'],
	): PreviewInfo {
		if (!prepared) throw named('StateError', 'No model is ready');
		return startScheduler(prepared, { onUpdate, onStatus, onError }, previewTileSize(prepared));
	},

	/** What the viewer shows now. Replaces the previous request between tiles. */
	previewRequest(request: PreviewRequest): void {
		if (!preview) return;
		preview.last = request;
		preview.scheduler.request(request);
	},

	/** Send finished areas over `rect` again, after the viewer loaded a new region. */
	previewResend(rect: Rect): void {
		preview?.scheduler.resend(rect);
	},

	/** The model's measured speed on this machine, for the export estimate (§2.10). */
	previewSpeed(): { msPerModelPixel: number | null; tiles: number } {
		const samples = preview?.scheduler.samples ?? [];
		return { msPerModelPixel: msPerPixel(samples), tiles: samples.length };
	},

	/**
	 * Export the open photo at full resolution with a recipe (§5.3): the
	 * preview pauses, the recipe runs over the decoded pixels in place — a
	 * 100 MP photo is held once — then the file is encoded with the
	 * original's metadata. The photo is decoded again afterwards, in the
	 * background, so the viewer carries on.
	 */
	async exportEdited(
		recipe: Recipe,
		settings: Partial<OutputSettings> = {},
		onProgress?: (progress: EditorExportProgress) => void,
	): Promise<EditedExport> {
		if (!prepared) throw named('StateError', 'No model is ready');
		if (!source || !editing) throw named('StateError', 'No photo is open');
		if (exporting) throw named('StateError', 'An export is already running');
		exporting = true;
		cancel = { aborted: false };
		const started = now();
		try {
			await preview?.scheduler.pause();
			await ensureDecoded();
			const ready = prepared;
			const photo = source;
			const signal = cancel;
			editing.consumed = true; // from here on the pixels are being written over
			const t = now();
			const processed = await runRecipe(photo.image, recipe, {
				operations: { denoise: denoiseOperation(ready) },
				signal,
				now,
				onProgress: (tiles) => onProgress?.({ stage: 'processing', ...tiles }),
			});
			const processMs = now() - t;
			if (signal.aborted) throw new CancelledError();
			onProgress?.({ stage: 'encoding' });
			const exported = await encodePhoto(
				photo.image,
				photo.info,
				photo.orientation,
				{ name: photo.name, output: { ...DEFAULT_OUTPUT, ...settings } },
				{ codecs: browserCodecs, zlib: browserZlib, software: SOFTWARE, now },
			);
			if (signal.aborted) throw new CancelledError();
			return Comlink.transfer(
				{
					bytes: exported.bytes,
					name: exported.name,
					mimeType: exported.mimeType,
					warnings: exported.warnings,
					encodeMs: exported.encodeMs,
					metadataMs: exported.metadataMs,
					backend: ready.backend,
					width: photo.image.width,
					height: photo.image.height,
					processMs,
					totalMs: now() - started,
					stats: processed.tiled,
					peakFloatBytes: (processed.tiled?.peakFloatBytes ?? 0) + processed.floatBytes,
				},
				[exported.bytes.buffer],
			);
		} finally {
			exporting = false;
			if (editing?.consumed) void startRedecode().catch(() => {});
			else preview?.scheduler.resume();
		}
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
		closeEditing();
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
		closeEditing();
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
		closeEditing();
		await prepared?.session.dispose();
		prepared = null;
		source = null;
		result = null;
	},
};

export type PipelineApi = typeof api;

Comlink.expose(api);
