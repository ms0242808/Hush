// SPDX-License-Identifier: Apache-2.0
/**
 * What the bench page exposes for scripted runs (src/bench/BenchApp.tsx), as
 * the end-to-end tests and scripts/measure.ts see it. Files travel as base64.
 */

export interface PipelineHarness {
	process(
		name: string,
		base64: string,
		settings?: Record<string, unknown>,
		params?: Record<string, number>,
	): Promise<unknown>;
	processSynthetic(width: number, height: number): Promise<unknown>;
	decode(base64: string): Promise<{ width: number; height: number; data: string }>;
	injectFaults(plan: { outOfMemoryAbove?: number; loseDeviceOnRun?: number }): Promise<void>;
	sessionState(): Promise<{ tileSize: number | null; recoveries: number }>;
}

export interface BenchRunRow {
	run?: { mpPerSecond: number; ms: number; tileSize: number };
	seam?: { psnr: number; maxDiff: number; tileSize: number };
}

export interface BenchHandle {
	ready: Promise<void>;
	run(config: Record<string, unknown>, repeat?: number): Promise<BenchRunRow[]>;
	seam(config: Record<string, unknown>, size?: number): Promise<BenchRunRow>;
	environment(): unknown;
	markdown(): string;
}

/** What the editor's viewer exposes in non-production builds (src/editor/viewer/Viewer.tsx). */
export interface ViewerHarness {
	read(): { width: number; height: number; data: Uint8Array } | null;
	readPhoto(mode: 'original' | 'result'): {
		width: number;
		height: number;
		data: Uint8Array;
		rect: { x: number; y: number; width: number; height: number };
	} | null;
	state(): {
		zoom: 'fit' | 1 | 2;
		viewport: { width: number; height: number };
		region: { x: number; y: number; width: number; height: number } | null;
		divider: number;
		renderer: string;
		draws: number;
		photo: { x: number; y: number; width: number; height: number };
	};
	draws: number;
}

/** The editor store's surface the tests read and nudge (src/editor/store.ts). */
export interface EditorHarness {
	getState(): {
		model: { status: string };
		preview: { done: number; planned: number; running: boolean; error: { name: string } | null };
		backend: string | null;
		params: { strength: number; luma: number; colour: number; detail: number };
		estimateMs: number | null;
		timings: Record<string, number>;
		zoom: 'fit' | 1 | 2;
		showOriginal: boolean;
		[key: string]: unknown;
	};
	setState(patch: Record<string, unknown>): void;
}

/** The batch store's surface the tests read and nudge (src/batch/store.ts). */
export interface BatchHarness {
	getState(): {
		photos: { id: string; status: string; fraction: number; file: File; output: string | null }[];
		state: string;
		estimateMs: number | null;
		[key: string]: unknown;
	};
	setState(patch: Record<string, unknown>): void;
	subscribe?(listener: (state: never) => void): () => void;
}

declare global {
	interface Window {
		__hushPipeline?: PipelineHarness;
		__hushBench?: BenchHandle;
		__hushViewer?: ViewerHarness;
		__hushEditor?: EditorHarness;
		__hushBatch?: BatchHarness;
		/** Make the model slow or fail (src/batch/session.ts). */
		__hushBatchFaults?: (plan: { delayMs?: number; loseDeviceOnRun?: number }) => Promise<void>;
		/** The ZIP part size (src/batch/session.ts). */
		__hushZipPartBytes?: number;
	}
}
