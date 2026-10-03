// SPDX-License-Identifier: Apache-2.0
import {
	defaultOutputFormat,
	estimateExportMs,
	msPerPixel,
	pickModel,
	pickVariant,
	type Backend,
	type OutputFormat,
	type PreviewRequest,
	type PreviewStatus,
	type PreviewUpdate,
	type Rect,
	type Size,
} from '@hush/core';
import { isCancelled, usableElsewhere } from '@/app/errors';
import { detectCapabilities, type Capabilities } from '@/lib/capabilities';
import { isSaveData, modelOverride } from '@/lib/defaults';
import { recordError } from '@/lib/diagnostics';
import { sniffFile } from '@/lib/formats';
import { proxy, startPipeline, type Pipeline, type PipelineHandle } from '@/lib/pipeline';
import { recipeFor } from '@/lib/presets';
import {
	chooseFolder,
	folderPermission,
	recallFolder,
	rememberFolder,
	saveExport,
	SaveFailure,
	type ExportedFile,
	type SaveMethod,
} from '@/lib/save';
import { fromPlainError, type PlainError } from '@/lib/worker-errors';
import type { EditorExportProgress, PixelRegion, PrepareResult } from '@/worker/pipeline.worker';
import { recordTiming, useEditor, type ExportProgress } from './store';

/**
 * One editing session: the pipeline worker, the model in it, and the photo
 * being edited. It outlives each photo — opening the next one reuses the
 * loaded model — and writes everything the interface shows into the editor
 * store, so components only read.
 */

type PreviewListener = (update: PreviewUpdate) => void;

const named = (name: string, message = name) => Object.assign(new Error(message), { name });
const now = () => performance.now();

function record(error: unknown): void {
	useEditor.setState((state) => ({ errors: recordError(state.errors, error) }));
}

export class EditorSession {
	readonly capabilities: Promise<Capabilities>;
	/** The open photo's overview pixels, for the viewer (kept for a WebGL context restore). */
	overview: { width: number; height: number; data: Uint8Array } | null = null;
	private pipeline: PipelineHandle | null = null;
	private pipelineBackend: Backend | null = null;
	private generation = 0;
	private listeners = new Set<PreviewListener>();
	private confirmDownload: (() => void) | null = null;
	private downloadConfirmed = false;
	private samples: { ms: number; pixels: number }[] = [];
	private view: Size = { width: 1600, height: 1000 };

	constructor() {
		this.capabilities = detectCapabilities();
		void recallFolder().then((folder) => {
			if (folder) useEditor.setState({ folder, saveMethod: 'folder' });
		});
	}

	private get api(): Pipeline | null {
		return this.pipeline?.api ?? null;
	}

	/** Open a photo. `view` is the viewer's size in device pixels, for where to open (the noisiest region). */
	async open(file: File, view: Size): Promise<void> {
		const id = ++this.generation;
		this.view = view;
		this.confirmDownload = null;
		this.samples = [];
		this.overview = null;
		useEditor.setState((state) => ({
			phase: 'opening',
			photoKey: state.photoKey + 1,
			file,
			photo: null,
			openError: null,
			previewInfo: null,
			preview: { done: 0, planned: 0, running: false, error: null },
			lastSaved: null,
			unsaved: null,
			exportError: null,
			exporting: null,
			estimateMs: null,
			showOriginal: false,
			zoom: 1,
			model: state.model.status === 'ready' ? { status: 'preparing' } : state.model,
		}));
		try {
			if (!(await sniffFile(file))) throw named('UnsupportedFormatError');
			const capabilities = await this.capabilities;
			if (this.generation !== id) return;
			await this.openOn(this.chooseBackend(capabilities), file, id, true);
		} catch (error) {
			if (this.generation !== id) return;
			if (!isCancelled(error)) console.error(error);
			record(error);
			useEditor.setState({ phase: 'failed', openError: { error: toError(error), retry: isRetryableOpen(error) } });
		}
	}

	/** The same photo again, e.g. on another backend. */
	async reopen(): Promise<void> {
		const { file } = useEditor.getState();
		if (file) await this.open(file, this.view);
	}

	private chooseBackend(capabilities: Capabilities): Backend {
		const { processing } = useEditor.getState();
		if (processing === 'wasm') return 'wasm';
		if (processing === 'webgpu') return capabilities.probe.webgpu === 'adapter' ? 'webgpu' : 'wasm';
		return capabilities.assessment.backend;
	}

	/** One worker holds one runtime (§2.4): changing backend means a new worker. */
	private ensurePipeline(backend: Backend): Pipeline {
		if (this.pipeline && this.pipelineBackend !== backend) this.dropPipeline();
		if (!this.pipeline) {
			this.pipeline = startPipeline();
			this.pipelineBackend = backend;
		}
		return this.pipeline.api;
	}

	private dropPipeline(): void {
		this.pipeline?.terminate();
		this.pipeline = null;
		this.pipelineBackend = null;
		useEditor.setState({ model: { status: 'idle' }, modelInfo: null, previewInfo: null });
	}

	private async openOn(backend: Backend, file: File, id: number, mayFallBack: boolean): Promise<void> {
		const live = () => this.generation === id;
		const api = this.ensurePipeline(backend);
		useEditor.setState({ backend });

		// The photo and the model at once: the photo shows as soon as it's decoded,
		// even while a first-time model download is still running (§5.6).
		const model = this.prepareModel(api, backend, id);
		model.catch(() => {}); // handled below, once the photo is in
		const opened = await api.openForEditing(file, this.view);
		if (!live()) return;
		const { overview, ...photo } = opened;
		this.overview = overview;
		recordTiming('decode', opened.decodeMs);
		useEditor.setState({ phase: 'editing', photo });

		let prepared: PrepareResult;
		try {
			prepared = await model;
		} catch (error) {
			if (!live()) return;
			if (backend === 'webgpu' && mayFallBack && usableElsewhere(error)) {
				// §2.10: a driver that passes detection but fails the runtime still gets the processor.
				console.warn('WebGPU failed; using the processor instead.', error);
				record(error);
				this.dropPipeline();
				await this.openOn('wasm', file, id, false);
				return;
			}
			throw error;
		}
		if (!live()) return;
		await this.startPreview(api, id, prepared);
	}

	private async prepareModel(api: Pipeline, backend: Backend, id: number): Promise<PrepareResult> {
		const live = () => this.generation === id;
		const manifest = await api.manifest();
		const model = pickModel(manifest, 'denoise', modelOverride());
		let shaderF16 = false;
		if (backend === 'webgpu') {
			const probe = await api.probe();
			if (probe.webgpu !== 'adapter') throw named('WebGpuUnavailableError', `WebGPU in a worker: ${probe.webgpu}`);
			shaderF16 = probe.shaderF16;
		}
		const variant = pickVariant(model, { backend, shaderF16 });
		const cached = await api.isCached(variant.sha256);
		if (!cached && isSaveData() && !this.downloadConfirmed) {
			useEditor.setState({ model: { status: 'confirm', bytes: variant.bytes } });
			await new Promise<void>((resolve) => (this.confirmDownload = resolve));
			if (!live()) throw named('CancelledError', 'Cancelled');
		}
		useEditor.setState({
			model: cached ? { status: 'preparing' } : { status: 'downloading', received: 0, total: variant.bytes },
		});
		let lastReport = 0;
		const result = await api.prepare(
			{ backend, modelId: model.id },
			proxy((received: number, total: number) => {
				if (!live() || cached) return;
				const t = now();
				if (received < total && t - lastReport < 50) return; // a few updates a second is plenty
				lastReport = t;
				useEditor.setState({
					model: received < total ? { status: 'downloading', received, total } : { status: 'preparing' },
				});
			}),
		);
		if (live()) {
			recordTiming(result.fromCache ? 'model from cache' : 'model download', result.modelMs);
			recordTiming('session', result.sessionMs);
			useEditor.setState({
				model: { status: 'ready' },
				modelInfo: {
					id: result.modelId,
					label: model.label,
					precision: result.precision,
					bytes: result.modelBytes,
					fromCache: result.fromCache,
					licence: model.licence,
					source: model.source,
					threads: result.threads,
				},
			});
		}
		return result;
	}

	/** §5.6: the user agreed to download the model on a metered connection. */
	acceptDownload(): void {
		this.downloadConfirmed = true;
		this.confirmDownload?.();
		this.confirmDownload = null;
	}

	/** Try the model again after a failed download or a GPU that stopped responding. */
	async retryModel(): Promise<void> {
		this.dropPipeline();
		await this.reopen();
	}

	private async startPreview(api: Pipeline, id: number, prepared: PrepareResult): Promise<void> {
		const live = () => this.generation === id;
		const started = now();
		let first = true;
		const info = await api.previewStart(
			proxy((update: PreviewUpdate) => {
				if (!live()) return;
				if (first) {
					first = false;
					recordTiming('first preview tile', now() - started);
				}
				if (update.tileMs !== undefined) this.sample(update.tileMs);
				for (const listener of this.listeners) listener(update);
			}),
			proxy((status: PreviewStatus) => {
				if (live()) useEditor.setState((state) => ({ preview: { ...status, error: state.preview.error } }));
			}),
			proxy((plain: PlainError) => {
				if (!live()) return;
				const error = fromPlainError(plain);
				console.error(error);
				record(error);
				useEditor.setState((state) => ({ preview: { ...state.preview, running: false, error } }));
			}),
		);
		if (!live()) return;
		useEditor.setState({ previewInfo: info });
		recordTiming('tile ceiling', prepared.tileSize);
	}

	private sample(ms: number): void {
		const { previewInfo } = useEditor.getState();
		if (!previewInfo) return;
		this.samples.push({ ms, pixels: previewInfo.tileSize ** 2 });
		if (this.samples.length > 32) this.samples.splice(1, 1);
		const rate = msPerPixel(this.samples);
		if (rate !== null) useEditor.setState({ msPerModelPixel: rate });
		this.refreshEstimate();
	}

	/** §2.10: "about 6 minutes on this computer", from the preview's own measured tiles. */
	refreshEstimate(): void {
		const { photo, previewInfo, msPerModelPixel, exportSettings } = useEditor.getState();
		if (!photo || !previewInfo || msPerModelPixel === null) return;
		const format: OutputFormat =
			exportSettings.format === 'auto'
				? defaultOutputFormat(photo.format === 'synthetic' ? 'png' : photo.format)
				: exportSettings.format;
		const estimateMs = estimateExportMs({
			width: photo.width,
			height: photo.height,
			tile: { size: previewInfo.exportTileSize, overlap: previewInfo.overlap, padMultiple: previewInfo.padMultiple },
			msPerModelPixel,
			format,
		});
		useEditor.setState({ estimateMs });
	}

	// ── What the viewer asks for ──────────────────────────────────────────────

	onPreview(listener: PreviewListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	requestPreview(request: PreviewRequest): void {
		void this.api?.previewRequest(request);
	}

	resendPreview(rect: Rect): void {
		void this.api?.previewResend(rect);
	}

	async region(rect: Rect): Promise<PixelRegion | null> {
		const api = this.api;
		return api ? await api.region(rect) : null;
	}

	// ── Export and saving (§5.3, §5.13) ───────────────────────────────────────

	/** Pick a folder to save into, and remember it. Must run from a click. */
	async pickFolder(): Promise<boolean> {
		try {
			const folder = await chooseFolder();
			if (!folder) return false;
			await rememberFolder(folder);
			useEditor.setState({ folder, saveMethod: 'folder' });
			return true;
		} catch (error) {
			record(error);
			useEditor.setState({ exportError: toError(error) });
			return false;
		}
	}

	setSaveMethod(method: SaveMethod): void {
		useEditor.setState({ saveMethod: method, exportError: null });
	}

	async export(): Promise<void> {
		const state = useEditor.getState();
		const api = this.api;
		if (!api || state.exporting || !state.photo || state.model.status !== 'ready' || !state.modelInfo) return;
		const id = this.generation;

		// A folder needs permission again after a reload, and only a click can grant it: ask now,
		// before the wait, not after (§5.13).
		const folder = state.saveMethod === 'folder' ? await this.folderForSaving() : null;
		if (state.saveMethod === 'folder' && !folder) return;

		const startedAt = now();
		const estimate = state.estimateMs;
		const progress = (next: ExportProgress) => {
			if (this.generation === id) useEditor.setState({ exporting: { ...next, startedAt } });
		};
		useEditor.setState({
			exporting: { stage: 'preparing', startedAt },
			lastSaved: null,
			unsaved: null,
			exportError: null,
		});
		try {
			const { params, exportSettings, modelInfo } = state;
			const result = await api.exportEdited(
				recipeFor(params, undefined, modelInfo.id),
				{
					format: exportSettings.format,
					quality: exportSettings.quality,
					suffix: exportSettings.suffix,
					removeLocation: exportSettings.removeLocation,
				},
				proxy((step: EditorExportProgress) => {
					if (step.stage === 'encoding') {
						progress({ stage: 'encoding' });
						return;
					}
					const fraction = step.tileCount > 0 ? step.tilesDone / step.tileCount : 0;
					const elapsed = now() - startedAt;
					const etaMs =
						fraction > 0.08
							? (elapsed / fraction) * (1 - fraction)
							: estimate !== null
								? Math.max(0, estimate - elapsed)
								: null;
					progress({ stage: 'processing', done: step.bandsDone, total: step.bandCount, fraction, etaMs });
				}),
			);
			recordTiming('export', result.totalMs);
			recordTiming('export processing', result.processMs);
			recordTiming('encode', result.encodeMs);
			if (this.generation !== id) return;
			progress({ stage: 'saving' });
			await this.save({ name: result.name, bytes: result.bytes, mimeType: result.mimeType }, folder);
		} catch (error) {
			if (this.generation !== id) return;
			if (isCancelled(error)) {
				useEditor.setState({ exportError: named('CancelledError', 'Cancelled') });
				return;
			}
			console.error(error);
			record(error);
			useEditor.setState({ exportError: toError(error) });
		} finally {
			if (this.generation === id) useEditor.setState({ exporting: null });
		}
	}

	private async folderForSaving(): Promise<FileSystemDirectoryHandle | null> {
		let { folder } = useEditor.getState();
		if (!folder) {
			if (!(await this.pickFolder())) return null;
			folder = useEditor.getState().folder;
		}
		if (!folder) return null;
		if (await folderPermission(folder, true).catch(() => false)) return folder;
		const failure = new SaveFailure('permission', 'Permission to write to the folder was not given');
		record(failure);
		useEditor.setState({ exportError: failure });
		return null;
	}

	private async save(file: ExportedFile, folder: FileSystemDirectoryHandle | null, method?: SaveMethod): Promise<void> {
		const chosen = method ?? useEditor.getState().saveMethod;
		try {
			const target =
				chosen === 'folder' && folder
					? { method: 'folder' as const, folder }
					: { method: chosen === 'share' ? ('share' as const) : ('download' as const) };
			const saved = await saveExport(file, target);
			useEditor.setState({ lastSaved: { ...saved, at: Date.now() }, unsaved: null });
		} catch (error) {
			const failure = error instanceof SaveFailure ? error : new SaveFailure('unknown', String(error));
			if (failure.problem !== 'cancelled') {
				console.error(failure);
				record(failure);
			}
			useEditor.setState({ unsaved: { file, failure } });
		}
	}

	/** Save the kept file again — after fixing the folder, or another way — without processing again. */
	async retrySave(method?: SaveMethod): Promise<void> {
		const { unsaved, saveMethod } = useEditor.getState();
		if (!unsaved) return;
		const chosen = method ?? saveMethod;
		let folder: FileSystemDirectoryHandle | null = null;
		if (chosen === 'folder') {
			folder = await this.folderForSaving();
			if (!folder) return;
		}
		await this.save(unsaved.file, folder, chosen);
	}

	cancelExport(): void {
		void this.api?.cancel();
	}

	dispose(): void {
		this.generation++;
		this.listeners.clear();
		this.pipeline?.terminate();
		this.pipeline = null;
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Retrying the same file helps when the problem wasn't the file. */
function isRetryableOpen(error: unknown): boolean {
	const name = error instanceof Error ? error.name : '';
	return !['UnsupportedPhotoError', 'UnsupportedFormatError', 'DecodeError', 'PhotoTooLargeError'].includes(name);
}

let session: EditorSession | null = null;

/** The page's one session: it keeps the model loaded from photo to photo. */
export function editorSession(): EditorSession {
	session ??= new EditorSession();
	return session;
}
