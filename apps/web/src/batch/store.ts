// SPDX-License-Identifier: Apache-2.0
import type { BatchItemStatus, BatchProblem, BatchSnapshot } from '@hush/core';
import { create } from 'zustand';
import type { PhotoFacts } from '@/worker/photos.worker';

/**
 * The batch on screen (§5.4): its photos, where they're saved, and the run's
 * progress. The settings — sliders, preset, export options — are the
 * editor's own (`useEditor`): one set, shared by the whole batch and by any
 * photo opened from it. The batch session writes here; components only read.
 */

export interface BatchPhoto {
	id: string;
	file: File;
	/** Its header was read: size, orientation, format. Null until then. */
	facts: PhotoFacts | null;
	/** Hush can't process it (CMYK, HDR, animated, too large, not a photo): it stays out of the queue. */
	refused: Error | null;
	/** An object URL for the grid; null until made. */
	thumbnail: string | null;
	/** The name its export is saved under, decided when the batch starts. */
	output: string | null;
	status: BatchItemStatus;
	/** Within this photo, 0–1. */
	fraction: number;
	bands: { done: number; total: number } | null;
	error: Error | null;
	/** Where it went: the folder, or the ZIP part it's in. */
	savedTo: string | null;
}

export type BatchDestination =
	/** A folder. `inside` names a folder made inside the source folder ("denoised"). */
	| { kind: 'folder'; folder: FileSystemDirectoryHandle; inside: string | null }
	/** ZIP files in parts, to Downloads (§2.8: Safari, Firefox; or by choice). */
	| { kind: 'zip' };

export interface BatchSource {
	/** The folder's handle, when the photos are one folder's and the browser gave one (Chrome, Edge). */
	folder: FileSystemDirectoryHandle | null;
	/** Its name, for "from Wedding" and the ZIP's name. */
	name: string | null;
	/** Files in the folder Hush leaves alone (RAW files, sidecars, videos). */
	ignored: number;
}

export type RunState = BatchSnapshot['state'];

export interface BatchState {
	active: boolean;
	photos: BatchPhoto[];
	source: BatchSource;
	destination: BatchDestination | null;
	state: RunState;
	problem: BatchProblem | null;
	run: BatchSnapshot['run'] | null;
	/** The photo opened in the editor from the grid. */
	editing: string | null;
	/** The model is loaded and the batch can start. */
	modelReady: boolean;
	/** The whole batch, on this machine, before it starts (§5.12). Null until measured. */
	estimateMs: number | null;
	/** ZIP parts already handed to Downloads in this batch. */
	parts: { name: string; count: number }[];
	/** §5.12: a batch on the processor that would take hours asks first. */
	confirmLong: { estimateMs: number } | null;
	/** A message about the batch as a whole, worded at render time: what happened, and what to do. */
	notice: { key: string; values?: Record<string, unknown> } | null;
	/** Photos whose result was saved earlier and found again on resume. */
	resumedFrom: string | null;
}

export function initialBatchState(): BatchState {
	return {
		active: false,
		photos: [],
		source: { folder: null, name: null, ignored: 0 },
		destination: null,
		state: 'idle',
		problem: null,
		run: null,
		editing: null,
		modelReady: false,
		estimateMs: null,
		parts: [],
		confirmLong: null,
		notice: null,
		resumedFrom: null,
	};
}

export const useBatch = create<BatchState>()(() => initialBatchState());

declare global {
	interface Window {
		/** The batch's state, for end-to-end tests and diagnosis. Not in production builds. */
		__hushBatch?: typeof useBatch;
	}
}
if (import.meta.env.MODE !== 'production') window.__hushBatch = useBatch;

/** Running, or paused partway: the settings and the queue's order are fixed until it ends. */
export function isBusy(state: Pick<BatchState, 'state'>): boolean {
	return state.state === 'running' || state.state === 'paused' || state.state === 'checking';
}

/** Photos that will be exported: everything not refused. */
export function exportable(photos: readonly BatchPhoto[]): BatchPhoto[] {
	return photos.filter((photo) => !photo.refused);
}
