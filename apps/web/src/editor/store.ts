// SPDX-License-Identifier: Apache-2.0
import type { Backend, ModelEntry, Precision, PreviewStatus } from '@hush/core';
import { create } from 'zustand';
import type { Diagnostics } from '@/lib/diagnostics';
import {
	createPreset,
	defaultParams,
	loadPresets,
	paramsOf,
	sameParams,
	savePresets,
	uniqueName,
	type DenoiseParams,
	type Preset,
} from '@/lib/presets';
import type { ExportedFile, SaveFailure, SavedFile, SaveMethod } from '@/lib/save';
import {
	loadExportSettings,
	loadProcessing,
	loadSelectedPreset,
	saveExportSettings,
	saveProcessing,
	saveSelectedPreset,
	type ExportSettings,
	type Processing,
} from '@/lib/settings';
import type { EditorPhoto, PreviewInfo } from '@/worker/pipeline.worker';
import type { Zoom } from './viewer/view-model';

/** The photo, without its overview pixels (those go straight to the viewer). */
export type PhotoSummary = Omit<EditorPhoto, 'overview'>;

export type ModelState =
	| { status: 'idle' }
	/** §5.6: on a metered connection the model downloads only after the user agrees. */
	| { status: 'confirm'; bytes: number }
	| { status: 'downloading'; received: number; total: number }
	| { status: 'preparing' }
	| { status: 'ready' }
	| { status: 'failed'; error: Error; retry: boolean };

export interface ModelInfo {
	id: string;
	label: Record<string, string>;
	precision: Precision;
	bytes: number;
	fromCache: boolean;
	licence: ModelEntry['licence'];
	source: ModelEntry['source'];
	threads: number;
}

export type ExportProgress =
	| { stage: 'preparing' }
	| { stage: 'processing'; done: number; total: number; fraction: number; etaMs: number | null }
	| { stage: 'encoding' }
	| { stage: 'saving' };

export interface EditorState {
	phase: 'empty' | 'opening' | 'editing' | 'failed';
	/** Changes with every photo opened, so the viewer starts afresh (and not on a GPU fallback). */
	photoKey: number;
	file: File | null;
	photo: PhotoSummary | null;
	/** Why the photo couldn't be opened; worded at render time, in the current language (§5.11). */
	openError: { error: Error; retry: boolean } | null;

	backend: Backend | null;
	model: ModelState;
	modelInfo: ModelInfo | null;
	previewInfo: PreviewInfo | null;
	preview: PreviewStatus & { error: Error | null };
	/** Measured model speed on this machine: drives the export estimate (§2.10). */
	msPerModelPixel: number | null;

	params: DenoiseParams;
	presets: Preset[];
	/** The preset the sliders started from; null is the defaults. */
	presetId: string | null;

	zoom: Zoom;
	/** `\`: the original in full (§5.3). */
	showOriginal: boolean;
	/** The fit view shows the photo smaller than 100%: the overview, without the comparison. */
	reduced: boolean;

	exportSettings: ExportSettings;
	saveMethod: SaveMethod;
	folder: FileSystemDirectoryHandle | null;
	exporting: (ExportProgress & { startedAt: number }) | null;
	estimateMs: number | null;
	lastSaved: (SavedFile & { at: number }) | null;
	/** A finished export that couldn't be saved: kept so saving can be retried without processing again (§5.13). */
	unsaved: { file: ExportedFile; failure: SaveFailure } | null;
	exportError: Error | null;

	processing: Processing;
	errors: Diagnostics['errors'];
	timings: Record<string, number>;
}

function presetParams(presets: readonly Preset[], id: string | null): DenoiseParams {
	const preset = id ? presets.find((p) => p.id === id) : undefined;
	return preset ? paramsOf(preset.recipe) : defaultParams();
}

function initialState(): EditorState {
	const presets = loadPresets();
	const stored = loadSelectedPreset();
	const presetId = stored && presets.some((p) => p.id === stored) ? stored : null;
	return {
		phase: 'empty',
		photoKey: 0,
		file: null,
		photo: null,
		openError: null,
		backend: null,
		model: { status: 'idle' },
		modelInfo: null,
		previewInfo: null,
		preview: { done: 0, planned: 0, running: false, error: null },
		msPerModelPixel: null,
		params: presetParams(presets, presetId),
		presets,
		presetId,
		zoom: 1,
		showOriginal: false,
		reduced: false,
		exportSettings: loadExportSettings(),
		saveMethod: 'download',
		folder: null,
		exporting: null,
		estimateMs: null,
		lastSaved: null,
		unsaved: null,
		exportError: null,
		processing: loadProcessing(),
		errors: [],
		timings: {},
	};
}

export const useEditor = create<EditorState>()(() => initialState());

declare global {
	interface Window {
		/** The editor's state, for end-to-end tests and diagnosis. Not in production builds. */
		__hushEditor?: typeof useEditor;
	}
}
if (import.meta.env.MODE !== 'production') window.__hushEditor = useEditor;

const set = useEditor.setState;
const get = useEditor.getState;

// ── Sliders and presets ──────────────────────────────────────────────────────

export function setParam(id: keyof DenoiseParams, value: number): void {
	set((state) => ({ params: { ...state.params, [id]: value } }));
}

/** ⌘/Ctrl+Z (§5.8): back to where the sliders started — the chosen preset, or the defaults. */
export function resetParams(): void {
	const { presets, presetId } = get();
	set({ params: presetParams(presets, presetId) });
}

export function isEdited(state: EditorState = get()): boolean {
	return !sameParams(state.params, presetParams(state.presets, state.presetId));
}

export function applyPreset(id: string | null): void {
	const { presets } = get();
	const presetId = id && presets.some((p) => p.id === id) ? id : null;
	saveSelectedPreset(presetId);
	set({ presetId, params: presetParams(presets, presetId) });
}

function storePresets(presets: Preset[], presetId: string | null): boolean {
	const saved = savePresets(presets);
	saveSelectedPreset(presetId);
	set({ presets, presetId });
	return saved;
}

/** Save the sliders as a preset. A name already in use replaces that preset's settings. */
export function savePreset(name: string, model?: string): Preset {
	const { presets, params } = get();
	const trimmed = name.trim();
	const existing = presets.find((p) => p.recipe.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
	const made = createPreset(existing?.recipe.name ?? trimmed, params, model);
	const preset = existing ? { ...made, id: existing.id } : made;
	const next = existing ? presets.map((p) => (p.id === existing.id ? preset : p)) : [...presets, preset];
	storePresets(next, preset.id);
	return preset;
}

export function renamePreset(id: string, name: string): void {
	const { presets, presetId } = get();
	const others = presets.filter((p) => p.id !== id).map((p) => p.recipe.name);
	const unique = uniqueName(name, others);
	storePresets(
		presets.map((p) => (p.id === id ? { ...p, recipe: { ...p.recipe, name: unique } } : p)),
		presetId,
	);
}

export function deletePreset(id: string): void {
	const { presets, presetId } = get();
	storePresets(
		presets.filter((p) => p.id !== id),
		presetId === id ? null : presetId,
	);
}

export function addPresets(imported: readonly Preset[]): void {
	if (imported.length === 0) return;
	const { presets } = get();
	storePresets([...presets, ...imported], imported.at(-1)!.id);
	set({ params: paramsOf(imported.at(-1)!.recipe) });
}

// ── View ─────────────────────────────────────────────────────────────────────

export function setZoom(zoom: Zoom): void {
	set({ zoom });
}

export function toggleOriginal(): void {
	set((state) => ({ showOriginal: !state.showOriginal }));
}

// ── Export settings ──────────────────────────────────────────────────────────

export function updateExportSettings(patch: Partial<ExportSettings>): void {
	const exportSettings = { ...get().exportSettings, ...patch };
	saveExportSettings(exportSettings);
	set({ exportSettings });
}

export function setProcessing(processing: Processing): void {
	saveProcessing(processing);
	set({ processing });
}

export function recordTiming(label: string, ms: number): void {
	set((state) => ({ timings: { ...state.timings, [label]: ms } }));
}
