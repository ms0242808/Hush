// SPDX-License-Identifier: Apache-2.0
import {
	BatchRunner,
	defaultOutputFormat,
	isWorking,
	deviceClass,
	estimateBatchMs,
	MAX_MEGAPIXELS,
	PhotoTooLargeError,
	planOutputNames,
	type BatchProgressReport,
	type OutputFormat,
	type TileConventions,
} from '@hush/core';
import * as Comlink from 'comlink';
import { isRetryable } from '@/app/errors';
import { editorSession } from '@/editor/session';
import { useEditor } from '@/editor/store';
import { byName, chooseFolderOfPhotos, photosInFolder, type PhotoSelection } from '@/lib/batch-input';
import {
	clearBatchRecord,
	loadBatchHandles,
	sameFile,
	saveBatchHandles,
	saveBatchRecord,
	type BatchRecord,
} from '@/lib/batch-record';
import { recordError } from '@/lib/diagnostics';
import { keepAwake, warnBeforeLeaving } from '@/lib/keep-awake';
import type { Pipeline } from '@/lib/pipeline';
import { proxy } from '@/lib/pipeline';
import { recipeFor } from '@/lib/presets';
import {
	canSaveToFolder,
	chooseFolder,
	folderPermission,
	rememberFolder,
	saveExport,
	SaveFailure,
	taken,
} from '@/lib/save';
import { ZipParts } from '@/lib/zip-parts';
import type { BatchPhotoProgress, BatchPhotoResult } from '@/worker/pipeline.worker';
import type { PhotoFacts, PhotosApi } from '@/worker/photos.worker';
import { exportable, initialBatchState, isBusy, useBatch, type BatchDestination, type BatchPhoto } from './store';

/**
 * One batch (§2.7, §5.4): its photos, their thumbnails, and the queue that
 * exports them one at a time through the editor's pipeline worker — the same
 * model, loaded once. Writes everything the grid shows into the batch store;
 * the settings are the editor's, shared by every photo.
 */

/** A folder made inside the photos' own folder for the exports (§5.13: "Saved IMG_2041-denoised.jpg to Wedding/denoised"). */
export const INSIDE_FOLDER = 'denoised';
/** §5.12: a batch on the processor estimated beyond this asks before starting. */
const LONG_CPU_BATCH_MS = 60 * 60_000;
/** Thumbnails are sized for a grid cell this wide, in CSS pixels. */
const THUMBNAIL_CSS = 200;

const named = (name: string, message = name) => Object.assign(new Error(name === message ? name : message), { name });
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

function record(error: unknown): void {
	useEditor.setState((state) => ({ errors: recordError(state.errors, error) }));
}

/** Errors about one photo: it fails alone and the batch carries on. Anything else also pauses the batch. */
function aboutThePhoto(error: unknown): boolean {
	const name = error instanceof Error ? error.name : '';
	return !isRetryable(error) || name === 'EncodeError' || name === 'ModelOutputError';
}

function maxMegapixels(): number {
	const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
	return MAX_MEGAPIXELS[deviceClass(typeof memory === 'number' ? memory : null)];
}

function outputFormat(facts: PhotoFacts | null): OutputFormat {
	const { format } = useEditor.getState().exportSettings;
	if (format !== 'auto') return format;
	return defaultOutputFormat(facts?.format ?? 'jpeg');
}

function newId(): string {
	return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export class BatchSession {
	private generation = 0;
	private nextId = 0;
	private photosWorker: { api: Comlink.Remote<PhotosApi>; worker: Worker } | null = null;
	private photosIdle: number | null = null;
	private pumping = false;
	private wanted = new Set<string>();
	private inspected: Promise<void> = Promise.resolve();
	private settleInspected: (() => void) | null = null;

	private model: Promise<{ api: Pipeline; tile: TileConventions } | null> | null = null;
	private api: Pipeline | null = null;
	private tile: TileConventions | null = null;
	private msPerModelPixel: number | null = null;

	private runner: BatchRunner<BatchPhotoResult> | null = null;
	private outputFolder: FileSystemDirectoryHandle | null = null;
	private zip: ZipParts | null = null;
	private record: BatchRecord | null = null;
	private awake: (() => void) | null = null;
	private leaving: (() => void) | null = null;
	private flushQueued = false;

	// ── Opening ──────────────────────────────────────────────────────────────

	/** Start a batch with these photos (§5.4): the grid shows at once; sizes, thumbnails and the model follow. */
	open(selection: PhotoSelection, options: { destination?: BatchDestination | null } = {}): void {
		this.reset();
		const generation = this.generation;
		const files = selection.folder ? selection.files : [...selection.files].sort(byName);
		const editor = useEditor.getState();
		const destination: BatchDestination | null =
			options.destination !== undefined
				? options.destination
				: !canSaveToFolder()
					? { kind: 'zip' }
					: selection.folder
						? { kind: 'folder', folder: selection.folder, inside: INSIDE_FOLDER }
						: editor.folder
							? { kind: 'folder', folder: editor.folder, inside: null }
							: null;
		useBatch.setState({
			...initialBatchState(),
			active: true,
			photos: files.map((file) => this.photoFor(file)),
			source: { folder: selection.folder, name: selection.folderName, ignored: selection.ignored },
			destination,
		});
		this.inspectAll();
		this.model = this.prepareModel(generation);
	}

	/** More photos, dropped or chosen onto an open batch. They join a run in progress. */
	add(files: readonly File[]): void {
		if (!useBatch.getState().active || files.length === 0) return;
		const added = [...files].sort(byName).map((file) => this.photoFor(file));
		useBatch.setState((state) => ({ photos: [...state.photos, ...added] }));
		this.inspectAll();
		if (this.runner?.running) void this.joinRun(added.map((photo) => photo.id));
	}

	/** Take a photo out of the batch, before it's exported. */
	remove(id: string): void {
		const state = useBatch.getState();
		const photo = state.photos.find((p) => p.id === id);
		if (!photo || (this.runner?.running && !this.runner.remove(id))) return;
		if (photo.thumbnail) URL.revokeObjectURL(photo.thumbnail);
		this.wanted.delete(id);
		useBatch.setState({ photos: state.photos.filter((p) => p.id !== id) });
		if (state.editing === id) useBatch.setState({ editing: null });
		this.refreshEstimate();
	}

	/** Back to the drop zone. A batch that didn't finish can still be resumed from there. */
	close(): void {
		this.runner?.cancel();
		this.reset();
		useBatch.setState(initialBatchState());
	}

	/** Nothing left to read: let the worker go, and its decoders' memory with it, until it's needed again. */
	private endPhotosWorker(): void {
		if (this.photosIdle !== null) window.clearTimeout(this.photosIdle);
		this.photosIdle = null;
		this.photosWorker?.worker.terminate();
		this.photosWorker = null;
	}

	private reset(): void {
		this.generation++;
		for (const photo of useBatch.getState().photos) if (photo.thumbnail) URL.revokeObjectURL(photo.thumbnail);
		this.endPhotosWorker();
		this.pumping = false;
		this.wanted.clear();
		this.runner = null;
		this.outputFolder = null;
		this.zip = null;
		this.record = null;
		this.model = null;
		this.api = null;
		this.tile = null;
		this.msPerModelPixel = null;
		this.endRun();
	}

	private photoFor(file: File): BatchPhoto {
		return {
			id: `p${++this.nextId}`,
			file,
			facts: null,
			refused: null,
			thumbnail: null,
			output: null,
			status: 'queued',
			fraction: 0,
			bands: null,
			error: null,
			savedTo: null,
		};
	}

	private update(id: string, patch: Partial<BatchPhoto>): void {
		useBatch.setState((state) => ({
			photos: state.photos.map((photo) => (photo.id === id ? { ...photo, ...patch } : photo)),
		}));
	}

	private photo(id: string): BatchPhoto | undefined {
		return useBatch.getState().photos.find((p) => p.id === id);
	}

	// ── Reading the photos: sizes, refusals, thumbnails ─────────────────────

	private photos(): Comlink.Remote<PhotosApi> {
		if (this.photosIdle !== null) window.clearTimeout(this.photosIdle);
		this.photosIdle = null;
		if (!this.photosWorker) {
			const worker = new Worker(new URL('../worker/photos.worker.ts', import.meta.url), {
				type: 'module',
				name: 'hush-photos',
			});
			this.photosWorker = { api: Comlink.wrap<PhotosApi>(worker), worker };
		}
		return this.photosWorker.api;
	}

	/** The grid wants this photo's thumbnail (it scrolled into view). */
	wantThumbnail(id: string): void {
		const photo = this.photo(id);
		if (!photo || photo.thumbnail || photo.refused) return;
		this.wanted.add(id);
		this.pump();
	}

	private inspectAll(): void {
		if (!this.settleInspected) {
			this.inspected = new Promise((resolve) => (this.settleInspected = resolve));
		}
		this.pump();
	}

	/** One photo at a time: every header first (sizes drive the estimate), then the thumbnails on screen. */
	private pump(): void {
		if (this.pumping) return;
		this.pumping = true;
		const generation = this.generation;
		void (async () => {
			try {
				for (;;) {
					if (generation !== this.generation) return;
					const photos = useBatch.getState().photos;
					const next = photos.find((p) => !p.facts && !p.refused);
					if (next) {
						await this.inspect(next, generation);
						continue;
					}
					this.settleInspected?.();
					this.settleInspected = null;
					const wanted = photos.find((p) => this.wanted.has(p.id) && p.facts && !p.thumbnail);
					if (!wanted) {
						// Idle for a few seconds (scrolling brings more): end the worker.
						if (this.photosWorker && this.photosIdle === null) {
							this.photosIdle = window.setTimeout(() => this.endPhotosWorker(), 5000);
						}
						return;
					}
					this.wanted.delete(wanted.id);
					await this.thumbnail(wanted, generation);
				}
			} finally {
				if (generation === this.generation) this.pumping = false;
			}
		})();
	}

	private async inspect(photo: BatchPhoto, generation: number): Promise<void> {
		try {
			const facts = await this.photos().inspect(photo.file);
			if (generation !== this.generation) return;
			const megapixels = (facts.width * facts.height) / 1e6;
			const limit = maxMegapixels();
			if (megapixels > limit) {
				this.update(photo.id, { facts, refused: new PhotoTooLargeError(megapixels, limit) });
			} else {
				this.update(photo.id, { facts });
				this.runner?.setMegapixels(photo.id, megapixels);
			}
		} catch (error) {
			if (generation !== this.generation) return;
			this.update(photo.id, { refused: toError(error) });
		}
		this.refreshEstimate();
	}

	private async thumbnail(photo: BatchPhoto, generation: number): Promise<void> {
		try {
			const size = Math.min(512, Math.round(THUMBNAIL_CSS * Math.min(2, window.devicePixelRatio || 1)));
			const blob = await this.photos().thumbnail(photo.file, photo.facts!, size);
			if (generation !== this.generation || !this.photo(photo.id)) return;
			this.update(photo.id, { thumbnail: URL.createObjectURL(blob) });
		} catch {
			// No thumbnail: the cell shows the file name instead. Exporting doesn't depend on it.
		}
	}

	// ── The model and the estimate ───────────────────────────────────────────

	private async prepareModel(generation: number): Promise<{ api: Pipeline; tile: TileConventions } | null> {
		try {
			const { api, tile } = await editorSession().modelForBatch();
			if (generation !== this.generation) return null;
			this.api = api;
			this.tile = tile;
			useBatch.setState({ modelReady: true });
			// §2.10: the speed on this machine, from a photo's preview if one was opened, else two timed tiles.
			this.msPerModelPixel = useEditor.getState().msPerModelPixel ?? (await api.measureSpeed()).msPerModelPixel ?? null;
			if (generation !== this.generation) return null;
			this.refreshEstimate();
			return { api, tile };
		} catch (error) {
			console.error(error);
			return null;
		}
	}

	/** §5.6: the user agreed to download the model on a metered connection. */
	acceptDownload(): void {
		editorSession().acceptDownload();
	}

	/** The model again, after it failed to load. */
	retryModel(): void {
		editorSession().resetModel();
		this.api = null;
		this.tile = null;
		this.msPerModelPixel = null;
		useBatch.setState({ modelReady: false, estimateMs: null });
		this.model = this.prepareModel(this.generation);
	}

	/** The batch's estimate, recomputed when sizes or settings change. */
	refreshEstimate(): void {
		const state = useBatch.getState();
		const rate = useEditor.getState().msPerModelPixel ?? this.msPerModelPixel;
		if (!this.tile || rate === null) return;
		const todo = exportable(state.photos).filter((p) => p.status !== 'saved' && p.status !== 'skipped');
		const estimateMs = estimateBatchMs(
			todo.map((p) =>
				p.facts ? { width: p.facts.width, height: p.facts.height, format: outputFormat(p.facts) } : null,
			),
			this.tile,
			rate,
		);
		useBatch.setState({ estimateMs });
	}

	// ── Where the exports go ─────────────────────────────────────────────────

	/** Choose a folder to save into (Chrome, Edge). Must run from a click. */
	async chooseDestination(): Promise<boolean> {
		try {
			const folder = await chooseFolder();
			if (!folder) return false;
			await rememberFolder(folder);
			useEditor.setState({ folder, saveMethod: 'folder' });
			useBatch.setState({ destination: { kind: 'folder', folder, inside: null }, notice: null });
			return true;
		} catch (error) {
			record(error);
			useBatch.setState({ notice: { key: 'batch.folderFailed' } });
			return false;
		}
	}

	setDestination(destination: BatchDestination): void {
		useBatch.setState({ destination, notice: null });
	}

	/** Where to write, with permission asked now — from the click, before the wait (§5.13). */
	private async writableFolder(
		destination: Extract<BatchDestination, { kind: 'folder' }>,
	): Promise<FileSystemDirectoryHandle | null> {
		const root = destination.folder;
		if (!(await folderPermission(root, true).catch(() => false))) {
			useBatch.setState({ notice: { key: 'batch.permission', values: { folder: root.name } } });
			return null;
		}
		if (!destination.inside) return root;
		try {
			return await root.getDirectoryHandle(destination.inside, { create: true });
		} catch (error) {
			record(error);
			useBatch.setState({ notice: { key: 'batch.folderFailed' } });
			return null;
		}
	}

	// ── Running ──────────────────────────────────────────────────────────────

	/**
	 * Export the batch (§5.4: Start runs the queue). Call from the click:
	 * choosing or unlocking the folder needs it. Photos already saved in this
	 * batch are left out; ones already in the folder are skipped (§2.7).
	 */
	async start(options: { confirmed?: boolean; only?: readonly string[] } = {}): Promise<void> {
		const state = useBatch.getState();
		if (isBusy(state) || this.runner?.running) return;
		if (!this.api || !this.tile) return; // the button waits for the model
		const generation = this.generation;

		// §5.12: hours on the processor? Say so, and let the photographer decide.
		const backend = useEditor.getState().backend;
		if (!options.confirmed && backend === 'wasm' && (state.estimateMs ?? 0) > LONG_CPU_BATCH_MS) {
			useBatch.setState({ confirmLong: { estimateMs: state.estimateMs! } });
			return;
		}
		useBatch.setState({ confirmLong: null, notice: null });

		let destination = state.destination;
		if (!destination) {
			if (!(await this.chooseDestination())) return;
			destination = useBatch.getState().destination!;
		}
		const folder = destination.kind === 'folder' ? await this.writableFolder(destination) : null;
		if (destination.kind === 'folder' && !folder) return;
		if (generation !== this.generation) return;

		await this.inspected;
		if (generation !== this.generation) return;
		this.outputFolder = folder;
		this.plan();
		// Saved in this batch, or found already exported: done. Everything else runs.
		const todo = exportable(useBatch.getState().photos).filter(
			(p) => p.status !== 'saved' && p.status !== 'skipped' && (!options.only || options.only.includes(p.id)),
		);
		if (todo.length === 0) return;
		for (const photo of todo) this.update(photo.id, { status: 'queued', fraction: 0, bands: null, error: null });
		if (destination.kind === 'zip') this.zip ??= this.zipParts(1);
		await this.writeRecord(destination);
		this.run(todo.map((p) => p.id));
	}

	/**
	 * Output names for every photo not exported yet, with the settings as they
	 * are now, around the names already used. Deterministic: a batch resumed
	 * with the same settings looks for the same files.
	 */
	private plan(): void {
		const { photos } = useBatch.getState();
		const { suffix } = useEditor.getState().exportSettings;
		const final = (p: BatchPhoto) => p.status === 'saved' || p.status === 'skipped' || isWorking(p.status);
		const fresh = exportable(photos).filter((p) => !final(p));
		const taken = photos.flatMap((p) => (final(p) && p.output ? [p.output] : []));
		const names = planOutputNames(
			fresh.map((p) => ({ name: p.file.name, format: outputFormat(p.facts) })),
			suffix,
			taken,
		);
		fresh.forEach((photo, i) => this.update(photo.id, { output: names[i]! }));
	}

	private zipParts(next: number): ZipParts {
		const { source } = useBatch.getState();
		const base = `${source.name ?? 'photos'}${useEditor.getState().exportSettings.suffix || '-denoised'}`;
		// End-to-end tests make parts small, to see several from a few small photos.
		const limit = import.meta.env.MODE !== 'production' ? window.__hushZipPartBytes : undefined;
		return new ZipParts(
			base,
			next,
			(part) => {
				const ids = new Set(part.ids);
				for (const id of part.ids) this.update(id, { savedTo: part.name });
				useBatch.setState((state) => ({ parts: [...state.parts, { name: part.name, count: part.ids.length }] }));
				this.markDone((photo) => ids.has(photo.id));
				if (this.record?.destination.kind === 'zip') this.record.destination.nextPart = this.zip?.nextPart ?? next + 1;
				void this.persist();
			},
			limit,
		);
	}

	/** What a reload needs to carry on (§2.7). */
	private async writeRecord(destination: BatchDestination): Promise<void> {
		const { photos, source } = useBatch.getState();
		const editor = useEditor.getState();
		const previous = this.record;
		this.record = {
			schema: 1,
			id: previous?.id ?? newId(),
			updatedAt: Date.now(),
			source: source.folder ? { kind: 'folder', name: source.folder.name } : { kind: 'files', name: source.name },
			destination:
				destination.kind === 'folder'
					? {
							kind: 'folder',
							name: destination.inside ? `${destination.folder.name}/${destination.inside}` : destination.folder.name,
							inside: destination.inside,
						}
					: {
							kind: 'zip',
							base: this.zip?.partName.replace(/-\d+\.zip$/, '') ?? '',
							nextPart: this.zip?.nextPart ?? 1,
						},
			params: { ...editor.params },
			settings: { ...editor.exportSettings },
			items: exportable(photos).map((p) => ({
				name: p.file.name,
				size: p.file.size,
				lastModified: p.file.lastModified,
				output: p.output ?? '',
				done: p.status === 'saved' || p.status === 'skipped',
			})),
		};
		await saveBatchRecord(this.record);
		await saveBatchHandles({
			input: source.folder,
			output: destination.kind === 'folder' && !destination.inside ? destination.folder : null,
		});
	}

	private markDone(which: (photo: BatchPhoto) => boolean): void {
		if (!this.record) return;
		const photos = useBatch.getState().photos.filter(which);
		for (const item of this.record.items) {
			if (photos.some((photo) => sameFile(item, photo.file) && photo.output === item.output)) item.done = true;
		}
	}

	private async persist(): Promise<void> {
		if (!this.record) return;
		if (this.record.items.every((item) => item.done)) {
			this.record = null;
			await clearBatchRecord();
		} else {
			await saveBatchRecord(this.record);
		}
	}

	private run(ids: readonly string[]): void {
		const generation = this.generation;
		const photos = useBatch.getState().photos;
		const items = ids.map((id) => {
			const facts = photos.find((p) => p.id === id)?.facts;
			return { id, megapixels: facts ? (facts.width * facts.height) / 1e6 : 0 };
		});
		const totalMegapixels = items.reduce((sum, item) => sum + item.megapixels, 0);
		const estimate = useBatch.getState().estimateMs;
		const editor = useEditor.getState();
		const recipe = recipeFor(editor.params, undefined, editor.modelInfo?.id);
		const settings = { ...editor.exportSettings };
		const api = this.api!;

		const runner = new BatchRunner<BatchPhotoResult>(
			items,
			{
				exported: async (id) => {
					const output = this.photo(id)?.output;
					if (!this.outputFolder || !output) return false;
					try {
						return await taken(this.outputFolder, output);
					} catch (error) {
						throw new SaveFailure(
							error instanceof Error && error.name === 'NotFoundError' ? 'not-found' : 'permission',
							String(error),
						);
					}
				},
				process: async (id, report) => {
					const photo = this.photo(id);
					if (!photo) throw named('CancelledError', 'Cancelled');
					const onProgress = proxy((progress: BatchPhotoProgress) => report(toReport(progress)));
					return await api.batchProcess(photo.file, recipe, settings, { crc32: this.zip !== null }, onProgress);
				},
				save: async (id, result) => {
					const photo = this.photo(id);
					const name = photo?.output ?? result.name;
					if (this.outputFolder) {
						const saved = await saveExport(
							{ name, bytes: result.bytes, mimeType: result.mimeType },
							{ method: 'folder', folder: this.outputFolder },
						);
						const where =
							this.record?.destination.kind === 'folder' ? this.record.destination.name : this.outputFolder.name;
						if (saved.name !== name) this.update(id, { output: saved.name });
						this.update(id, { savedTo: where });
						this.markDone((p) => p.id === id);
						void this.persist();
					} else if (this.zip) {
						this.zip.add({ id, name, bytes: result.bytes, crc32: result.crc32 ?? 0, modified: new Date() });
					}
				},
				abort: () => void api.cancel(),
				hold: () => void api.holdTiles(),
				release: () => void api.releaseTiles(),
				aboutThePhoto,
				onChange: () => this.queueFlush(generation),
			},
			{
				now: () => performance.now(),
				msPerMegapixel: estimate && totalMegapixels > 0 ? estimate / totalMegapixels : null,
			},
		);
		this.runner = runner;
		this.leaving ??= warnBeforeLeaving();
		this.awake ??= keepAwake();
		void runner.start().then(async () => {
			if (generation !== this.generation) return;
			this.zip?.flush();
			this.flush(generation);
			await this.persist();
			this.endRun();
			this.refreshEstimate();
		});
	}

	/** Photos added while a run is going: plan their names and add them to it. */
	private async joinRun(ids: readonly string[]): Promise<void> {
		await this.inspected;
		if (!this.runner?.running) return;
		this.plan();
		const photos = useBatch.getState().photos.filter((p) => ids.includes(p.id) && !p.refused);
		this.runner.add(
			photos.map((p) => ({ id: p.id, megapixels: p.facts ? (p.facts.width * p.facts.height) / 1e6 : 0 })),
		);
		if (this.record) {
			this.record.items.push(
				...photos.map((p) => ({
					name: p.file.name,
					size: p.file.size,
					lastModified: p.file.lastModified,
					output: p.output ?? '',
					done: false,
				})),
			);
			void this.persist();
		}
	}

	private endRun(): void {
		this.awake?.();
		this.awake = null;
		this.leaving?.();
		this.leaving = null;
	}

	pause(): void {
		this.runner?.pause();
		// A paused batch lets the screen sleep; it still asks before the tab closes.
		this.awake?.();
		this.awake = null;
	}

	resume(): void {
		if (!this.runner) return;
		this.awake ??= keepAwake();
		this.runner.resume();
	}

	cancel(): void {
		this.runner?.cancel();
	}

	/** The ZIP part being filled, for "5 photos waiting for Wedding-denoised-2.zip". */
	zipPartName(): string {
		return this.zip?.partName ?? '';
	}

	/** §2.7: retry what failed — or, after a cancel, carry on with what was left. */
	async retry(statuses: readonly ('failed' | 'cancelled')[] = ['failed']): Promise<void> {
		const ids = useBatch
			.getState()
			.photos.filter((p) => !p.refused && (statuses as readonly string[]).includes(p.status))
			.map((p) => p.id);
		if (ids.length > 0) await this.start({ confirmed: true, only: ids });
	}

	/** After a failed save: choose another folder, then carry on, saving the kept photo there first. */
	async changeFolderAndResume(): Promise<void> {
		if (!(await this.chooseDestination())) return;
		const destination = useBatch.getState().destination;
		if (destination?.kind !== 'folder') return;
		const folder = await this.writableFolder(destination);
		if (!folder) return;
		this.outputFolder = folder;
		if (this.record?.destination.kind === 'folder') {
			this.record.destination = { kind: 'folder', name: folder.name, inside: null };
			await saveBatchHandles({ input: useBatch.getState().source.folder, output: folder });
			void this.persist();
		}
		this.resume();
	}

	/** After a failed save, unlock the same folder again (permission may have lapsed), then carry on. */
	async unlockAndResume(): Promise<void> {
		const destination = useBatch.getState().destination;
		if (destination?.kind === 'folder' && !(await this.writableFolder(destination))) return;
		this.resume();
	}

	// ── Reflecting the queue in the store ────────────────────────────────────

	private queueFlush(generation: number): void {
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => {
			this.flushQueued = false;
			this.flush(generation);
		});
	}

	private flush(generation: number): void {
		if (generation !== this.generation || !this.runner) return;
		const snapshot = this.runner.snapshot();
		const items = new Map(snapshot.items.map((item) => [item.id, item]));
		useBatch.setState((state) => ({
			state: snapshot.state,
			problem: snapshot.problem,
			run: snapshot.run,
			photos: state.photos.map((photo) => {
				const item = items.get(photo.id);
				if (!item) return photo;
				// The runner keeps each error object, so identity says whether anything changed.
				const error = item.error ? toError(item.error) : null;
				const { bands } = item;
				const same =
					photo.status === item.status &&
					photo.fraction === item.fraction &&
					photo.error === error &&
					photo.bands?.done === bands?.done &&
					photo.bands?.total === bands?.total;
				if (same) return photo;
				if (error && item.status === 'failed' && photo.status !== 'failed') record(error);
				return { ...photo, status: item.status, fraction: item.fraction, bands, error };
			}),
		}));
	}

	// ── The photo opened from the grid ───────────────────────────────────────

	edit(id: string | null): void {
		if (id && isBusy(useBatch.getState())) return;
		useBatch.setState({ editing: id });
	}

	/** The previous or next photo of the batch, in the editor (§5.8: ← →). */
	step(delta: -1 | 1): void {
		const { photos, editing } = useBatch.getState();
		const list = exportable(photos);
		const index = list.findIndex((p) => p.id === editing);
		if (index < 0) return;
		const next = list[index + delta];
		if (next) useBatch.setState({ editing: next.id });
	}

	// ── Resuming after a reload (§2.7) ───────────────────────────────────────

	/**
	 * Carry on with a batch from a folder: ask for the folders again — once,
	 * when the exports go inside the photos' folder — read the photos, and
	 * start; whatever is already there is skipped. Call from a click.
	 */
	async resumeFromFolder(saved: BatchRecord): Promise<'started' | 'needs-folder' | 'denied'> {
		const handles = await loadBatchHandles();
		const input = handles.input;
		if (!input) return 'needs-folder';
		const destination = saved.destination;
		const inside = destination.kind === 'folder' ? destination.inside : null;
		const mode = inside ? 'readwrite' : 'read';
		const permission = input as unknown as {
			requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
		};
		try {
			if (permission.requestPermission && (await permission.requestPermission({ mode })) !== 'granted') return 'denied';
		} catch {
			return 'denied';
		}
		const target: BatchDestination | null =
			destination.kind === 'zip'
				? { kind: 'zip' }
				: inside
					? { kind: 'folder', folder: input, inside }
					: handles.output
						? { kind: 'folder', folder: handles.output, inside: null }
						: null;
		const { files, ignored } = await photosInFolder(input);
		this.restore(saved, { files, folder: input, folderName: input.name, ignored }, target);
		// The output folder's permission, when it's elsewhere, is asked for by `start` (another click, if needed).
		if (target?.kind === 'folder' && !inside && !(await folderPermission(target.folder, true).catch(() => false))) {
			useBatch.setState({ notice: { key: 'batch.permission', values: { folder: target.folder.name } } });
			return 'started';
		}
		await this.model;
		await this.start({ confirmed: true });
		return 'started';
	}

	/**
	 * Carry on with a batch of files, chosen again (§2.7: "the user re-drops
	 * the remaining files"): those already saved are marked skipped, the rest
	 * wait for Export.
	 */
	async resumeWithFiles(saved: BatchRecord, files: readonly File[]): Promise<void> {
		const handles = saved.destination.kind === 'folder' ? await loadBatchHandles() : { input: null, output: null };
		const target: BatchDestination | null =
			saved.destination.kind === 'zip'
				? { kind: 'zip' }
				: handles.output
					? { kind: 'folder', folder: handles.output, inside: null }
					: null;
		this.restore(saved, { files: [...files], folder: null, folderName: saved.source.name, ignored: 0 }, target);
	}

	/** Rebuild a batch from its record: the same settings, the same output names, and what's done marked so. */
	private restore(saved: BatchRecord, selection: PhotoSelection, destination: BatchDestination | null): void {
		useEditor.setState({ params: { ...saved.params } });
		useEditor.setState((state) => ({ exportSettings: { ...state.exportSettings, ...saved.settings } }));
		this.open(selection, { destination });
		this.record = saved;
		const photos = useBatch.getState().photos.map((photo) => {
			const item = saved.items.find((candidate) => sameFile(candidate, photo.file));
			if (!item) return photo;
			return item.done
				? { ...photo, output: item.output, status: 'skipped' as const, fraction: 1 }
				: { ...photo, output: item.output };
		});
		useBatch.setState({ photos, resumedFrom: saved.source.name ?? null });
		if (saved.destination.kind === 'zip') this.zip = this.zipParts(saved.destination.nextPart);
	}

	/** For the drop zone: choose a folder of photos and start a batch from it (Chrome, Edge). */
	async chooseFolderOfPhotos(): Promise<boolean> {
		const selection = await chooseFolderOfPhotos();
		if (!selection) return false;
		this.open(selection);
		return true;
	}
}

function toReport(progress: BatchPhotoProgress): BatchProgressReport {
	switch (progress.stage) {
		case 'decoding':
			return { stage: 'decoding' };
		case 'encoding':
			return { stage: 'encoding' };
		case 'processing':
			return {
				stage: 'processing',
				within: progress.tileCount > 0 ? progress.tilesDone / progress.tileCount : 0,
				bands: { done: progress.bandsDone, total: progress.bandCount },
			};
	}
}

let session: BatchSession | null = null;

declare global {
	interface Window {
		/** End-to-end tests only: make the model slow or fail, to catch a batch partway. Not in production builds. */
		__hushBatchFaults?: (plan: { delayMs?: number; loseDeviceOnRun?: number }) => Promise<void>;
		/** End-to-end tests only: the ZIP part size, in bytes. */
		__hushZipPartBytes?: number;
	}
}

export function batchSession(): BatchSession {
	session ??= new BatchSession();
	if (import.meta.env.MODE !== 'production') {
		window.__hushBatchFaults = async (plan) => {
			const model = await editorSession().modelForBatch();
			await model.api.injectFaults(plan);
		};
	}
	return session;
}
