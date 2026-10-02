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

declare global {
	interface Window {
		__hushPipeline?: PipelineHarness;
		__hushBench?: BenchHandle;
	}
}
