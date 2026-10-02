// SPDX-License-Identifier: Apache-2.0

/** The machine classes in the §4.6 performance table. */
export type MachineClass = 'integrated' | 'strong' | 'cpu';

export type Verdict = 'go' | 'borderline' | 'no-go';

/** Megapixels per second needed for each band. Below `borderline` is no-go. */
export const THROUGHPUT_TARGETS: Record<MachineClass, { go: number; borderline: number }> = {
	integrated: { go: 0.8, borderline: 0.4 },
	strong: { go: 2.4, borderline: 1.2 },
	cpu: { go: 0.08, borderline: 0.04 },
};

/** Preview crop (~1 MP, model cached, WebGPU), in seconds. Above `borderline` is no-go. */
export const PREVIEW_TARGET_SECONDS = { go: 1.5, borderline: 3 };

export function megapixelsPerSecond(width: number, height: number, milliseconds: number): number {
	return milliseconds > 0 ? (width * height) / 1e6 / (milliseconds / 1000) : 0;
}

export function throughputVerdict(mpPerSecond: number, machine: MachineClass): Verdict {
	const target = THROUGHPUT_TARGETS[machine];
	if (mpPerSecond >= target.go) return 'go';
	if (mpPerSecond >= target.borderline) return 'borderline';
	return 'no-go';
}

export function previewVerdict(seconds: number): Verdict {
	if (seconds <= PREVIEW_TARGET_SECONDS.go) return 'go';
	if (seconds <= PREVIEW_TARGET_SECONDS.borderline) return 'borderline';
	return 'no-go';
}
