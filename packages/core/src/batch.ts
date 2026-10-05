// SPDX-License-Identifier: Apache-2.0
import { outputName, type OutputFormat } from './formats.ts';
import { CancelledError, type Clock } from './types.ts';

/**
 * The batch queue (§2.7), platform-free: one photo at a time through
 * whatever the platform supplies to check, process and save it.
 *
 *   queued → decoding → processing (band n / m) → encoding → saving → saved
 *                                                                ↘ failed (reason, retry)
 *                                                                ↘ skipped (already exported)
 *                                                                ↘ cancelled
 *
 * Progress is weighted by megapixels, and the time left comes from what this
 * machine has measured on this batch — so it can honestly say hours. A run
 * can pause and resume (mid-photo, at the next tile, if the platform can
 * hold one), be cancelled, and retry what failed. A photo that couldn't be
 * saved keeps its result and pauses the batch until saving works again
 * (§5.13), so nothing is processed twice.
 */

export type BatchItemStatus =
	'queued' | 'decoding' | 'processing' | 'encoding' | 'saving' | 'saved' | 'failed' | 'skipped' | 'cancelled';

/** The stages a photo is worked through, in order. */
export type BatchStage = 'decoding' | 'processing' | 'encoding' | 'saving';

const WORKING: ReadonlySet<BatchItemStatus> = new Set(['decoding', 'processing', 'encoding', 'saving']);
const FINISHED: ReadonlySet<BatchItemStatus> = new Set(['saved', 'failed', 'skipped', 'cancelled']);

export const isWorking = (status: BatchItemStatus) => WORKING.has(status);
export const isFinished = (status: BatchItemStatus) => FINISHED.has(status);

/**
 * Share of one photo's time each stage takes, for a smooth bar. Measured on a
 * 45 MP JPEG: decoding ~1 s, the model ~90 s, encoding ~15 s, saving < 1 s.
 */
const STAGE_SPAN: Record<BatchStage, [number, number]> = {
	decoding: [0, 0.02],
	processing: [0.02, 0.85],
	encoding: [0.85, 0.99],
	saving: [0.99, 1],
};

export function stageFraction(stage: BatchStage, within = 0): number {
	const [from, to] = STAGE_SPAN[stage];
	return from + (to - from) * Math.min(1, Math.max(0, within));
}

export interface BatchItem {
	id: string;
	/** The photo's size: progress and the time left are weighted by it. 0 when unknown. */
	megapixels: number;
	status: BatchItemStatus;
	/** Within this photo, 0–1. */
	fraction: number;
	/** While processing: bands finished, as the export shows them. */
	bands: { done: number; total: number } | null;
	/** Why it failed, or why saving it is stuck. */
	error: unknown;
}

export interface BatchProgressReport {
	stage: Exclude<BatchStage, 'saving'>;
	/** Within the stage, 0–1. */
	within?: number;
	bands?: { done: number; total: number };
}

export interface BatchHooks<Result> {
	/** Whether this photo's output already exists where it's being saved (§2.7: skipped, already exported). */
	exported(id: string): Promise<boolean>;
	/** Decode, process and encode one photo. Rejects with CancelledError after `abort`. */
	process(id: string, report: (progress: BatchProgressReport) => void): Promise<Result>;
	/** Save a processed photo. Resolves only once the platform confirms it (§5.13). */
	save(id: string, result: Result): Promise<void>;
	/** Stop the photo in progress. */
	abort(): void;
	/** Hold the photo in progress at its next tile; let it go on. Optional: without them, pausing waits for the photo. */
	hold?(): void;
	release?(): void;
	/** Errors about the photo itself fail just that photo; anything else (the GPU, the model) also pauses the batch. */
	aboutThePhoto(error: unknown): boolean;
	/** Something changed: read `snapshot()`. */
	onChange?(): void;
}

export type BatchState = 'idle' | 'checking' | 'running' | 'paused' | 'finished';

/** Why a paused batch stopped by itself, and which photo it concerns. */
export interface BatchProblem {
	/** `save`: a processed photo couldn't be saved (or the destination couldn't be read); its result is kept. */
	kind: 'save' | 'stopped';
	id: string;
	error: unknown;
}

export interface BatchSnapshot {
	state: BatchState;
	items: readonly BatchItem[];
	/** The photo being worked on. */
	current: string | null;
	problem: BatchProblem | null;
	/** This run's photos: the ones still to do when it started, and any added since. */
	run: {
		total: number;
		finished: number;
		saved: number;
		failed: number;
		skipped: number;
		cancelled: number;
		/** 0–1, weighted by megapixels. */
		progress: number;
		/** Time left, from measured throughput; null until there's something to go on. */
		etaMs: number | null;
		/** Time spent working, pauses excluded. */
		activeMs: number;
	};
}

export interface BatchOptions {
	now: Clock;
	/**
	 * What one megapixel is expected to cost on this machine before any photo
	 * of the batch has finished, e.g. from a measured tile (§2.10).
	 */
	msPerMegapixel?: number | null;
}

/** Photos weigh their megapixels; one whose size isn't known yet weighs the average. */
function weights(items: readonly BatchItem[]): Map<string, number> {
	const known = items.filter((item) => item.megapixels > 0);
	const average = known.length > 0 ? known.reduce((sum, item) => sum + item.megapixels, 0) / known.length : 1;
	return new Map(items.map((item) => [item.id, item.megapixels > 0 ? item.megapixels : average]));
}

export class BatchRunner<Result> {
	private readonly items: BatchItem[] = [];
	private readonly hooks: BatchHooks<Result>;
	private readonly now: Clock;
	private state: BatchState = 'idle';
	private problem: BatchProblem | null = null;
	private current: string | null = null;
	private loop: Promise<void> | null = null;
	private cancelled = false;
	private wake: (() => void) | null = null;
	/** The ids this run covers. */
	private runIds = new Set<string>();
	private prior: number | null;
	/** Measured photos of this batch: megapixels and active milliseconds, for the time left. */
	private measured: { megapixels: number; ms: number }[] = [];
	private activeMs = 0;
	/** When the clock last started counting active time; null while paused or idle. */
	private activeSince: number | null = null;
	/** Active time spent on the current photo before the last pause. */
	private currentActive = 0;
	private currentSince: number | null = null;

	constructor(
		items: readonly Pick<BatchItem, 'id' | 'megapixels'>[],
		hooks: BatchHooks<Result>,
		options: BatchOptions,
	) {
		this.hooks = hooks;
		this.now = options.now;
		this.prior = options.msPerMegapixel ?? null;
		this.add(items);
	}

	// ── The queue ────────────────────────────────────────────────────────────

	/** Add photos to the end of the queue. While running, they join this run. */
	add(items: readonly (Pick<BatchItem, 'id' | 'megapixels'> & { status?: 'queued' | 'skipped' })[]): void {
		for (const item of items) {
			if (this.items.some((existing) => existing.id === item.id)) continue;
			this.items.push({
				id: item.id,
				megapixels: item.megapixels,
				status: item.status ?? 'queued',
				fraction: item.status === 'skipped' ? 1 : 0,
				bands: null,
				error: null,
			});
			if (this.loop && (item.status ?? 'queued') === 'queued') this.runIds.add(item.id);
		}
		this.changed();
	}

	/** Take a photo out of the queue. The one being worked on stays. */
	remove(id: string): boolean {
		const index = this.items.findIndex((item) => item.id === id);
		if (index < 0 || this.items[index]!.id === this.current) return false;
		this.items.splice(index, 1);
		this.runIds.delete(id);
		this.changed();
		return true;
	}

	/** A photo's size became known (its header was read after it was queued). */
	setMegapixels(id: string, megapixels: number): void {
		const item = this.find(id);
		if (item) item.megapixels = megapixels;
	}

	/** A measured estimate arrived (e.g. a timed tile) before any photo finished. */
	setPrior(msPerMegapixel: number | null): void {
		this.prior = msPerMegapixel;
		this.changed();
	}

	/** Mark photos as already exported without checking, e.g. when resuming a ZIP batch (§2.7). */
	markSkipped(ids: readonly string[]): void {
		for (const id of ids) {
			const item = this.find(id);
			if (item && (item.status === 'queued' || item.status === 'cancelled' || item.status === 'failed')) {
				Object.assign(item, { status: 'skipped', fraction: 1, error: null });
			}
		}
		this.changed();
	}

	// ── Running ──────────────────────────────────────────────────────────────

	/**
	 * Work through the queue: first mark what's already exported, then one
	 * photo at a time. Resolves when the queue is empty or the run is cancelled.
	 * Calling it again while running joins the same run.
	 */
	start(): Promise<void> {
		if (this.loop) return this.loop;
		this.cancelled = false;
		this.problem = null;
		this.runIds = new Set(this.items.filter((item) => item.status === 'queued').map((item) => item.id));
		this.measured = [];
		this.activeMs = 0;
		this.loop = this.work().finally(() => {
			this.loop = null;
			this.stopClock();
			this.state = 'finished';
			this.current = null;
			this.changed();
		});
		return this.loop;
	}

	private async work(): Promise<void> {
		this.state = 'checking';
		this.changed();
		for (const item of this.items) {
			if (this.cancelled) break;
			if (item.status !== 'queued') continue;
			try {
				if (await this.hooks.exported(item.id)) this.skip(item);
			} catch {
				break; // the destination can't be read: the photo's own turn says why, and waits
			}
		}
		if (this.state === 'checking') {
			this.state = 'running';
			this.startClock();
			this.changed();
		}
		for (;;) {
			await this.whilePaused();
			if (this.cancelled) break;
			const item = this.items.find((candidate) => candidate.status === 'queued');
			if (!item) break;
			await this.runItem(item);
		}
		if (this.cancelled) {
			for (const item of this.items) {
				if (item.status === 'queued' && this.runIds.has(item.id)) item.status = 'cancelled';
			}
		}
	}

	private skip(item: BatchItem): void {
		Object.assign(item, { status: 'skipped', fraction: 1, bands: null, error: null });
		this.changed();
	}

	private async runItem(item: BatchItem): Promise<void> {
		this.current = item.id;
		this.currentActive = 0;
		this.currentSince = this.now();
		Object.assign(item, { status: 'decoding', fraction: 0, bands: null, error: null });
		this.changed();
		try {
			// Checked again just before: the photo may have been exported since the run began.
			if (await this.destinationHas(item)) {
				this.skip(item);
				return;
			}
			const result = await this.hooks.process(item.id, (progress) => {
				if (this.current !== item.id || this.cancelled) return;
				item.status = progress.stage;
				item.fraction = stageFraction(progress.stage, progress.within ?? 0);
				item.bands = progress.bands ?? (progress.stage === 'processing' ? item.bands : null);
				this.changed();
			});
			if (this.cancelled) throw new CancelledError();
			Object.assign(item, { status: 'saving', fraction: stageFraction('saving'), bands: null });
			this.changed();
			await this.saveHeld(item, result);
			Object.assign(item, { status: 'saved', fraction: 1, error: null });
			this.measured.push({ megapixels: weights(this.items).get(item.id) ?? 1, ms: this.currentActiveMs() });
		} catch (error) {
			if (this.cancelled || isCancelled(error)) {
				Object.assign(item, { status: 'cancelled', fraction: 0, bands: null, error: null });
			} else {
				Object.assign(item, { status: 'failed', fraction: 0, bands: null, error });
				if (!this.hooks.aboutThePhoto(error)) this.stopFor({ kind: 'stopped', id: item.id, error });
			}
		} finally {
			this.current = null;
			this.currentSince = null;
			this.changed();
		}
	}

	/** Whether the output exists. If the destination can't be read, the batch waits until it can. */
	private async destinationHas(item: BatchItem): Promise<boolean> {
		for (;;) {
			try {
				return await this.hooks.exported(item.id);
			} catch (error) {
				this.stopFor({ kind: 'save', id: item.id, error });
				await this.whilePaused();
				if (this.cancelled) throw new CancelledError();
			}
		}
	}

	/** Save, and if that fails, keep the result and wait: resuming tries again (§5.13). */
	private async saveHeld(item: BatchItem, result: Result): Promise<void> {
		for (;;) {
			try {
				await this.hooks.save(item.id, result);
				return;
			} catch (error) {
				if (this.cancelled) throw new CancelledError();
				item.error = error;
				this.stopFor({ kind: 'save', id: item.id, error });
				await this.whilePaused();
				if (this.cancelled) throw new CancelledError();
				item.error = null;
			}
		}
	}

	private stopFor(problem: BatchProblem): void {
		this.problem = problem;
		this.pause();
	}

	/** Pause: the photo in progress holds at its next tile (or finishes, if it can't), then nothing starts. */
	pause(): void {
		if (this.state !== 'running' && this.state !== 'checking') return;
		this.state = 'paused';
		this.stopClock();
		this.hooks.hold?.();
		this.changed();
	}

	/** Carry on from where it paused; a photo whose save failed is saved again first. */
	resume(): void {
		if (this.state !== 'paused') return;
		this.state = 'running';
		this.problem = null;
		this.startClock();
		this.hooks.release?.();
		this.wake?.();
		this.wake = null;
		this.changed();
	}

	/** Stop: the photo in progress is abandoned, and what was queued is marked cancelled. */
	cancel(): void {
		if (!this.loop) return;
		this.cancelled = true;
		this.problem = null;
		this.hooks.abort();
		this.hooks.release?.();
		this.wake?.();
		this.wake = null;
		this.changed();
	}

	/**
	 * Queue photos again: by default the failed ones ("Retry failed"); pass
	 * statuses to include others, e.g. cancelled ones to carry on after a
	 * cancel. Starts a run if none is going.
	 */
	retry(statuses: readonly BatchItemStatus[] = ['failed'], ids?: readonly string[]): Promise<void> | null {
		let any = false;
		for (const item of this.items) {
			if (!statuses.includes(item.status) || (ids && !ids.includes(item.id))) continue;
			Object.assign(item, { status: 'queued', fraction: 0, bands: null, error: null });
			if (this.loop) this.runIds.add(item.id);
			any = true;
		}
		this.changed();
		if (!any) return null;
		return this.start();
	}

	private whilePaused(): Promise<void> {
		if (this.state !== 'paused' || this.cancelled) return Promise.resolve();
		return new Promise((resolve) => {
			const previous = this.wake;
			this.wake = () => {
				previous?.();
				resolve();
			};
		});
	}

	// ── Time ─────────────────────────────────────────────────────────────────

	private startClock(): void {
		const t = this.now();
		this.activeSince = t;
		if (this.current !== null) this.currentSince = t;
	}

	private stopClock(): void {
		const t = this.now();
		if (this.activeSince !== null) this.activeMs += t - this.activeSince;
		if (this.currentSince !== null) this.currentActive += t - this.currentSince;
		this.activeSince = null;
		this.currentSince = null;
	}

	private currentActiveMs(): number {
		return this.currentActive + (this.currentSince !== null ? this.now() - this.currentSince : 0);
	}

	/** Measured milliseconds per megapixel: finished photos of this batch, else the photo in progress, else the prior. */
	msPerMegapixel(weight: Map<string, number> = weights(this.items)): number | null {
		// The last photos count most: the GPU warms up, other tabs come and go.
		const recent = this.measured.slice(-8);
		if (recent.length > 0) {
			const megapixels = recent.reduce((sum, m) => sum + m.megapixels, 0);
			const ms = recent.reduce((sum, m) => sum + m.ms, 0);
			if (megapixels > 0) return ms / megapixels;
		}
		const current = this.current ? this.find(this.current) : undefined;
		if (current && current.fraction >= 0.1) {
			return this.currentActiveMs() / ((weight.get(current.id) ?? 1) * current.fraction);
		}
		return this.prior;
	}

	// ── Reading ──────────────────────────────────────────────────────────────

	snapshot(): BatchSnapshot {
		const weight = weights(this.items);
		const inRun = this.items.filter((item) => this.runIds.has(item.id));
		const count = (status: BatchItemStatus) => inRun.filter((item) => item.status === status).length;
		let total = 0;
		let done = 0;
		let left = 0;
		for (const item of inRun) {
			const w = weight.get(item.id) ?? 1;
			// Skipped photos cost nothing: they leave the work this run does.
			if (item.status === 'skipped') continue;
			total += w;
			const fraction = isFinished(item.status) ? 1 : item.fraction;
			done += w * fraction;
			left += w * (1 - fraction);
		}
		const rate = this.msPerMegapixel(weight);
		const running = this.state === 'running' || this.state === 'paused' || this.state === 'checking';
		return {
			state: this.state,
			items: this.items.map((item) => ({ ...item, bands: item.bands && { ...item.bands } })),
			current: this.current,
			problem: this.problem,
			run: {
				total: inRun.length,
				finished: inRun.filter((item) => isFinished(item.status)).length,
				saved: count('saved'),
				failed: count('failed'),
				skipped: count('skipped'),
				cancelled: count('cancelled'),
				progress: total > 0 ? Math.min(1, done / total) : inRun.length > 0 ? 1 : 0,
				etaMs: running && rate !== null ? left * rate : null,
				activeMs: this.activeMs + (this.activeSince !== null ? this.now() - this.activeSince : 0),
			},
		};
	}

	get running(): boolean {
		return this.loop !== null;
	}

	private find(id: string): BatchItem | undefined {
		return this.items.find((item) => item.id === id);
	}

	private changed(): void {
		this.hooks.onChange?.();
	}
}

function isCancelled(error: unknown): boolean {
	return error instanceof Error && error.name === 'CancelledError';
}

/**
 * Output names for a batch, decided before it starts (§2.6): `name-denoised.ext`,
 * and a number when two photos would land on the same name — compared without
 * case, because Windows and macOS folders ignore it. Deterministic, so a batch
 * that resumes after a reload looks for the same files.
 */
export function planOutputNames(
	photos: readonly { name: string; format: OutputFormat }[],
	suffix: string,
	taken: readonly string[] = [],
): string[] {
	const used = new Set(taken.map((name) => name.toLowerCase()));
	return photos.map(({ name, format }) => {
		const base = outputName(name, format, suffix);
		let candidate = base;
		for (let n = 2; used.has(candidate.toLowerCase()); n++) {
			const dot = base.lastIndexOf('.');
			candidate = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
		}
		used.add(candidate.toLowerCase());
		return candidate;
	});
}
