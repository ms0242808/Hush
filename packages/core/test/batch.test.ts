// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
	BatchRunner,
	CancelledError,
	estimateBatchMs,
	estimateExportMs,
	planOutputNames,
	stageFraction,
	type BatchHooks,
	type BatchProgressReport,
} from '../src/index.ts';

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle() {
	for (let i = 0; i < 10; i++) await tick();
}

const photoError = (name: string) => Object.assign(new Error(name), { name });

/**
 * A platform whose every step the test finishes by hand: what the batch is
 * doing at any moment is exactly what the test let it do.
 */
function harness(photos: { id: string; megapixels: number }[], options: { exported?: string[] } = {}) {
	let clock = 0;
	const calls: string[] = [];
	const processing = new Map<string, Deferred<string> & { report: (p: BatchProgressReport) => void }>();
	const saving = new Map<string, Deferred<void>>();
	const exported = new Set(options.exported ?? []);
	let exportedError: unknown = null;
	const hooks: BatchHooks<string> = {
		exported: (id) => {
			if (exportedError) return Promise.reject(exportedError);
			return Promise.resolve(exported.has(id));
		},
		process: (id, report) => {
			calls.push(`process ${id}`);
			const d = Object.assign(defer<string>(), { report });
			processing.set(id, d);
			return d.promise;
		},
		save: (id, result) => {
			calls.push(`save ${id} ${result}`);
			const d = defer<void>();
			saving.set(id, d);
			return d.promise;
		},
		abort: () => {
			calls.push('abort');
			for (const d of processing.values()) d.reject(new CancelledError());
		},
		hold: () => calls.push('hold'),
		release: () => calls.push('release'),
		aboutThePhoto: (error) => error instanceof Error && ['DecodeError', 'UnsupportedPhotoError'].includes(error.name),
	};
	const runner = new BatchRunner(photos, hooks, { now: () => clock });
	return {
		runner,
		calls,
		advance: (ms: number) => (clock += ms),
		status: () => Object.fromEntries(runner.snapshot().items.map((item) => [item.id, item.status])),
		/** Finish processing a photo and its save. */
		async finish(id: string, ms = 0) {
			await settle();
			clock += ms;
			processing.get(id)!.resolve(`${id}.out`);
			await settle();
			saving.get(id)!.resolve();
			await settle();
		},
		processing,
		saving,
		exported,
		failExported: (error: unknown) => (exportedError = error),
	};
}

describe('the batch queue (§2.7)', () => {
	it('works one photo at a time, in order, and weighs progress by megapixels', async () => {
		const h = harness([
			{ id: 'a', megapixels: 10 },
			{ id: 'b', megapixels: 30 },
		]);
		const done = h.runner.start();
		await settle();
		expect(h.status()).toEqual({ a: 'decoding', b: 'queued' });
		expect(h.calls).toEqual(['process a']);

		h.processing.get('a')!.report({ stage: 'processing', within: 0.5, bands: { done: 3, total: 6 } });
		const mid = h.runner.snapshot();
		expect(mid.items[0]).toMatchObject({ status: 'processing', bands: { done: 3, total: 6 } });
		expect(mid.items[0]!.fraction).toBeCloseTo(stageFraction('processing', 0.5));
		expect(mid.run.progress).toBeCloseTo((10 * stageFraction('processing', 0.5)) / 40);

		await h.finish('a');
		expect(h.status()).toEqual({ a: 'saved', b: 'decoding' });
		expect(h.runner.snapshot().run.progress).toBeCloseTo(0.25);
		await h.finish('b');
		await done;
		const end = h.runner.snapshot();
		expect(end.state).toBe('finished');
		expect(end.run).toMatchObject({ total: 2, finished: 2, saved: 2, progress: 1 });
		expect(h.calls).toEqual(['process a', 'save a a.out', 'process b', 'save b b.out']);
	});

	it('skips photos already in the destination, checked before the run and again before each photo', async () => {
		const h = harness(
			[
				{ id: 'a', megapixels: 20 },
				{ id: 'b', megapixels: 20 },
				{ id: 'c', megapixels: 20 },
			],
			{ exported: ['a'] },
		);
		const done = h.runner.start();
		await settle();
		expect(h.status()).toEqual({ a: 'skipped', b: 'decoding', c: 'queued' });
		// Exported elsewhere while the batch ran.
		h.exported.add('c');
		await h.finish('b');
		await done;
		expect(h.status()).toEqual({ a: 'skipped', b: 'saved', c: 'skipped' });
		const run = h.runner.snapshot().run;
		expect(run).toMatchObject({ total: 3, saved: 1, skipped: 2, progress: 1 });
		expect(h.calls).toEqual(['process b', 'save b b.out']);
	});

	it('a photo that can’t be read fails alone; a failure that isn’t the photo’s also pauses the batch', async () => {
		const h = harness([
			{ id: 'a', megapixels: 1 },
			{ id: 'b', megapixels: 1 },
			{ id: 'c', megapixels: 1 },
		]);
		const done = h.runner.start();
		await settle();
		h.processing.get('a')!.reject(photoError('DecodeError'));
		await settle();
		expect(h.status()).toMatchObject({ a: 'failed', b: 'decoding' });
		expect(h.runner.snapshot().state).toBe('running');

		h.processing.get('b')!.reject(photoError('DeviceLostError'));
		await settle();
		const paused = h.runner.snapshot();
		expect(paused.state).toBe('paused');
		expect(paused.problem).toMatchObject({ kind: 'stopped', id: 'b' });
		expect(h.status()).toMatchObject({ b: 'failed', c: 'queued' });
		expect(paused.items.find((item) => item.id === 'b')!.error).toMatchObject({ name: 'DeviceLostError' });

		h.runner.resume();
		await h.finish('c');
		await done;
		expect(h.status()).toEqual({ a: 'failed', b: 'failed', c: 'saved' });

		// Retry failed: just those two, in their places, as a run of their own.
		const again = h.runner.retry();
		await settle();
		expect(h.runner.snapshot().run.total).toBe(2);
		await h.finish('a');
		await h.finish('b');
		await again;
		expect(h.status()).toEqual({ a: 'saved', b: 'saved', c: 'saved' });
	});

	it('a save that fails keeps the result and pauses; resuming saves it without processing again (§5.13)', async () => {
		const h = harness([
			{ id: 'a', megapixels: 1 },
			{ id: 'b', megapixels: 1 },
		]);
		const done = h.runner.start();
		await settle();
		h.processing.get('a')!.resolve('a.out');
		await settle();
		h.saving.get('a')!.reject(Object.assign(new Error('disk full'), { name: 'SaveFailure', problem: 'no-space' }));
		await settle();
		const stuck = h.runner.snapshot();
		expect(stuck.state).toBe('paused');
		expect(stuck.problem).toMatchObject({ kind: 'save', id: 'a' });
		expect(h.status()).toEqual({ a: 'saving', b: 'queued' });

		h.runner.resume();
		await settle();
		h.saving.get('a')!.resolve();
		await settle();
		expect(h.status()).toEqual({ a: 'saved', b: 'decoding' });
		expect(h.calls.filter((call) => call === 'process a')).toHaveLength(1);
		expect(h.calls.filter((call) => call.startsWith('save a'))).toHaveLength(2);
		await h.finish('b');
		await done;
	});

	it('a destination that can’t be read pauses before any work, and is checked again on resume', async () => {
		const h = harness([{ id: 'a', megapixels: 1 }]);
		h.failExported(Object.assign(new Error('gone'), { name: 'SaveFailure', problem: 'permission' }));
		const done = h.runner.start();
		await settle();
		expect(h.runner.snapshot()).toMatchObject({ state: 'paused', problem: { kind: 'save', id: 'a' } });
		expect(h.calls).toEqual(['hold']);
		h.failExported(null);
		h.runner.resume();
		await h.finish('a');
		await done;
		expect(h.status()).toEqual({ a: 'saved' });
	});

	it('pauses mid-photo at the next tile, starts nothing new while paused, and doesn’t count the pause', async () => {
		const h = harness([
			{ id: 'a', megapixels: 10 },
			{ id: 'b', megapixels: 10 },
		]);
		h.runner.setPrior(1000);
		const done = h.runner.start();
		await settle();
		h.advance(5_000);
		h.runner.pause();
		expect(h.calls).toEqual(['process a', 'hold']);
		h.advance(3_600_000); // an hour away from the laptop
		h.processing.get('a')!.resolve('a.out');
		await settle();
		h.saving.get('a')!.resolve();
		await settle();
		expect(h.status()).toEqual({ a: 'saved', b: 'queued' });
		expect(h.calls).not.toContain('process b');
		expect(h.runner.snapshot().run.activeMs).toBe(5_000);

		h.runner.resume();
		await settle();
		expect(h.calls).toContain('release');
		expect(h.calls).toContain('process b');
		// Measured: 5 s for 10 MP, so the next 10 MP should take about 5 s.
		expect(h.runner.snapshot().run.etaMs).toBeCloseTo(5_000);
		await h.finish('b');
		await done;
	});

	it('cancelling stops the photo in progress and everything queued; carrying on picks them up again', async () => {
		const h = harness([
			{ id: 'a', megapixels: 1 },
			{ id: 'b', megapixels: 1 },
			{ id: 'c', megapixels: 1 },
		]);
		const done = h.runner.start();
		await h.finish('a');
		h.runner.cancel();
		await done;
		expect(h.calls).toContain('abort');
		expect(h.status()).toEqual({ a: 'saved', b: 'cancelled', c: 'cancelled' });
		expect(h.runner.snapshot().run).toMatchObject({ saved: 1, cancelled: 2 });

		const again = h.runner.retry(['cancelled']);
		await h.finish('b');
		await h.finish('c');
		await again;
		expect(h.status()).toEqual({ a: 'saved', b: 'saved', c: 'saved' });
	});

	it('cancelling while paused on a failed save drops that photo, and nothing else is saved', async () => {
		const h = harness([
			{ id: 'a', megapixels: 1 },
			{ id: 'b', megapixels: 1 },
		]);
		const done = h.runner.start();
		await settle();
		h.processing.get('a')!.resolve('a.out');
		await settle();
		h.saving.get('a')!.reject(new Error('blocked'));
		await settle();
		h.runner.cancel();
		await done;
		expect(h.status()).toEqual({ a: 'cancelled', b: 'cancelled' });
	});

	it('the time left: a prior estimate at first, then this batch’s own measured speed', async () => {
		const h = harness([
			{ id: 'a', megapixels: 20 },
			{ id: 'b', megapixels: 40 },
			{ id: 'c', megapixels: 0 }, // size not known yet: counts as the average
		]);
		expect(h.runner.snapshot().run.etaMs).toBeNull(); // not running
		h.runner.setPrior(2_000);
		const done = h.runner.start();
		await settle();
		expect(h.runner.snapshot().run.etaMs).toBeCloseTo((20 + 40 + 30) * 2_000);
		// Halfway through the first photo's model, its own pace takes over from the prior.
		h.advance(30_000);
		h.processing.get('a')!.report({ stage: 'processing', within: 0.5 });
		const pace = 30_000 / (20 * stageFraction('processing', 0.5));
		const leftMp = 20 * (1 - stageFraction('processing', 0.5)) + 40 + 30;
		expect(h.runner.snapshot().run.etaMs).toBeCloseTo(leftMp * pace);
		await h.finish('a', 30_000); // 60 s for 20 MP: 3 s per MP
		expect(h.runner.snapshot().run.etaMs).toBeCloseTo((40 + 30) * 3_000);
		await h.finish('b', 120_000);
		await h.finish('c', 90_000);
		await done;
		expect(h.runner.snapshot().run.etaMs).toBeNull();
	});

	it('photos added during a run join it; queued photos can be taken out', async () => {
		const h = harness([{ id: 'a', megapixels: 1 }]);
		const done = h.runner.start();
		await settle();
		h.runner.add([
			{ id: 'b', megapixels: 1 },
			{ id: 'c', megapixels: 1 },
		]);
		expect(h.runner.remove('a')).toBe(false); // being worked on
		expect(h.runner.remove('c')).toBe(true);
		await h.finish('a');
		await h.finish('b');
		await done;
		expect(h.status()).toEqual({ a: 'saved', b: 'saved' });
		expect(h.runner.snapshot().run.total).toBe(2);
	});

	it('resuming a ZIP batch: photos already in a downloaded part are marked skipped up front', async () => {
		const h = harness([
			{ id: 'a', megapixels: 1 },
			{ id: 'b', megapixels: 1 },
		]);
		h.runner.markSkipped(['a']);
		const done = h.runner.start();
		await h.finish('b');
		await done;
		expect(h.status()).toEqual({ a: 'skipped', b: 'saved' });
		expect(h.calls).toEqual(['process b', 'save b b.out']);
	});
});

describe('output names for a batch (§2.6)', () => {
	it('`name-denoised.ext`, keeping the camera’s spelling of the extension', () => {
		expect(
			planOutputNames(
				[
					{ name: 'IMG_2041.JPG', format: 'jpeg' },
					{ name: 'phone.heic', format: 'jpeg' },
				],
				'-denoised',
			),
		).toEqual(['IMG_2041-denoised.JPG', 'phone-denoised.jpg']);
	});

	it('numbers photos that would land on the same name, ignoring case like Windows and macOS do', () => {
		expect(
			planOutputNames(
				[
					{ name: 'IMG_0001.jpg', format: 'jpeg' },
					{ name: 'img_0001.JPG', format: 'jpeg' },
					{ name: 'IMG_0001.jpg', format: 'jpeg' },
				],
				'-denoised',
			),
		).toEqual(['IMG_0001-denoised.jpg', 'img_0001-denoised (2).JPG', 'IMG_0001-denoised (3).jpg']);
	});

	it('steers clear of names that are taken', () => {
		expect(planOutputNames([{ name: 'a.png', format: 'png' }], '-x', ['A-x.png'])).toEqual(['a-x (2).png']);
	});
});

describe('batch estimate (§5.12)', () => {
	const tile = { size: 512, overlap: 48, padMultiple: 16 };

	it('sums the photos, counting unknown sizes as the average', () => {
		const photo = { width: 6000, height: 4000, format: 'jpeg' as const };
		const one = estimateExportMs({ ...photo, tile, msPerModelPixel: 0.01 }) + 24 * 18;
		expect(estimateBatchMs([photo, photo, null], tile, 0.01)).toBeCloseTo(3 * one);
		expect(estimateBatchMs([], tile, 0.01)).toBe(0);
	});
});
