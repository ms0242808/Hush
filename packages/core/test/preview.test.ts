// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
	InferenceError,
	ModelOutputError,
	PreviewGrid,
	PreviewScheduler,
	type Image8,
	type InferenceSession,
	type PreviewUpdate,
	type Rect,
} from '../src/index.ts';

function photo(width: number, height: number): Image8 {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const p = (y * width + x) * 4;
			data[p] = (x * 7 + y) % 256;
			data[p + 1] = (x + y * 3) % 256;
			data[p + 2] = (x * y) % 256;
			data[p + 3] = 255;
		}
	}
	return { width, height, channels: 4, data };
}

/** A session that inverts colours, optionally failing on chosen runs and pausing on a gate. */
function fakeSession(options: { fail?: (run: number) => unknown; gate?: () => Promise<void> } = {}) {
	const state = { runs: 0, recoveries: 0 };
	const session: InferenceSession = {
		backend: 'wasm',
		async run(input) {
			state.runs++;
			await options.gate?.();
			const failure = options.fail?.(state.runs);
			if (failure) throw failure;
			return input.map((v) => 1 - v);
		},
		recover() {
			state.recoveries++;
			return Promise.resolve();
		},
		dispose: () => Promise.resolve(),
	};
	return { session, state };
}

/** Collects published areas into a full-size RGBA canvas, as the viewer's texture would. */
function canvas(width: number, height: number) {
	const pixels = new Uint8Array(width * height * 4);
	const updates: PreviewUpdate[] = [];
	return {
		pixels,
		updates,
		onUpdate(update: PreviewUpdate) {
			updates.push(update);
			const { rect } = update;
			for (let y = 0; y < rect.height; y++) {
				pixels.set(
					update.pixels.subarray(y * rect.width * 4, (y + 1) * rect.width * 4),
					((rect.y + y) * width + rect.x) * 4,
				);
			}
		},
	};
}

const settle = async (scheduler: PreviewScheduler) => {
	for (let i = 0; i < 200 && (scheduler.status.running || scheduler.status.done < scheduler.status.planned); i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

describe('the preview scheduler', () => {
	const image = photo(600, 400);
	const grid = () =>
		new PreviewGrid({ width: 600, height: 400, tileSize: 192, overlap: 32, anchor: { x: 300, y: 200 } });
	const everything: Rect = { x: 0, y: 0, width: 600, height: 400 };

	it('fills the view seamlessly: the composite is exactly what the model made', async () => {
		const { session } = fakeSession();
		const out = canvas(600, 400);
		const scheduler = new PreviewScheduler({ image: () => image, session, grid: grid(), onUpdate: out.onUpdate });
		scheduler.request({ visible: everything, after: null, focus: { x: 300, y: 200 }, scope: 'view' });
		await settle(scheduler);
		expect(scheduler.status).toEqual({
			done: scheduler.status.planned,
			planned: scheduler.status.planned,
			running: false,
		});
		for (let p = 0; p < out.pixels.length; p += 4) {
			expect(out.pixels[p]).toBe(255 - image.data[p]!);
			expect(out.pixels[p + 1]).toBe(255 - image.data[p + 1]!);
			expect(out.pixels[p + 2]).toBe(255 - image.data[p + 2]!);
			expect(out.pixels[p + 3]).toBe(255);
		}
	});

	it('starts with the tile under the divider, on the side that shows the result', async () => {
		const { session } = fakeSession();
		const out = canvas(600, 400);
		const scheduler = new PreviewScheduler({ image: () => image, session, grid: grid(), onUpdate: out.onUpdate });
		scheduler.request({
			visible: everything,
			after: { x: 300, y: 0, width: 300, height: 400 },
			focus: { x: 300, y: 200 },
			scope: 'view',
		});
		await settle(scheduler);
		const first = out.updates[0]!.rect;
		expect(first.x).toBeLessThan(300);
		expect(first.x + first.width).toBeGreaterThan(300);
		const firstBeforeOnly = out.updates.findIndex((u) => u.rect.x + u.rect.width <= 300);
		const lastAfter = out.updates.findLastIndex((u) => u.rect.x + u.rect.width > 300);
		expect(firstBeforeOnly).toBeGreaterThan(lastAfter);
		expect(out.updates.every((u) => typeof u.tileMs === 'number')).toBe(true);
	});

	it('never computes a tile twice, and re-sends cached ones for a new region', async () => {
		const { session, state } = fakeSession();
		const out = canvas(600, 400);
		const scheduler = new PreviewScheduler({ image: () => image, session, grid: grid(), onUpdate: out.onUpdate });
		const request = { visible: everything, after: null, focus: { x: 300, y: 200 }, scope: 'view' as const };
		scheduler.request(request);
		await settle(scheduler);
		const runs = state.runs;
		scheduler.request({ ...request, focus: { x: 100, y: 100 } });
		await settle(scheduler);
		expect(state.runs).toBe(runs);

		out.updates.length = 0;
		scheduler.resend({ x: 0, y: 0, width: 200, height: 150 });
		expect(out.updates.length).toBeGreaterThan(0);
		expect(out.updates.every((u) => u.tileMs === undefined && u.rect.x + u.rect.width <= 200)).toBe(true);
	});

	it('pauses after the tile in flight, and resumes where it stopped', async () => {
		let open: () => void = () => {};
		const gate = () => new Promise<void>((resolve) => (open = resolve));
		const { session, state } = fakeSession({ gate });
		const scheduler = new PreviewScheduler({ image: () => image, session, grid: grid(), onUpdate: () => {} });
		scheduler.request({ visible: everything, after: null, focus: { x: 300, y: 200 }, scope: 'view' });
		await Promise.resolve();
		expect(state.runs).toBe(1);
		let paused = false;
		const pausing = scheduler.pause().then(() => (paused = true));
		await Promise.resolve();
		expect(paused).toBe(false); // the tile in flight finishes first
		open();
		await pausing;
		expect(scheduler.status.done).toBe(1);
		expect(scheduler.status.running).toBe(false);

		scheduler.resume();
		for (let i = 0; i < 40; i++) {
			open();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(scheduler.status.done).toBe(scheduler.status.planned);
	});

	it('recreates a lost device and carries on (§2.3)', async () => {
		const { session, state } = fakeSession({
			fail: (run) => (run === 2 ? new InferenceError('device-lost', 'lost') : null),
		});
		const errors: unknown[] = [];
		const scheduler = new PreviewScheduler({
			image: () => image,
			session,
			grid: grid(),
			onUpdate: () => {},
			onError: (e) => errors.push(e),
		});
		scheduler.request({ visible: everything, after: null, focus: { x: 300, y: 200 }, scope: 'view' });
		await settle(scheduler);
		expect(state.recoveries).toBe(1);
		expect(errors).toEqual([]);
		expect(scheduler.status.done).toBe(scheduler.status.planned);
	});

	it('stops and reports what it cannot fix: invalid output, out of memory', async () => {
		for (const failure of [new ModelOutputError(), new InferenceError('out-of-memory', 'oom')]) {
			const { session } = fakeSession({ fail: () => failure });
			const errors: unknown[] = [];
			const scheduler = new PreviewScheduler({
				image: () => image,
				session,
				grid: grid(),
				onUpdate: () => {},
				onError: (e) => errors.push(e),
			});
			scheduler.request({ visible: everything, after: null, focus: { x: 300, y: 200 }, scope: 'view' });
			await settle(scheduler);
			expect(errors).toEqual([failure]);
			expect(scheduler.status.running).toBe(false);
		}
	});

	it('on the processor, computes only the tiles near the divider (§2.10)', async () => {
		const { session, state } = fakeSession();
		const scheduler = new PreviewScheduler({
			image: () => image,
			session,
			grid: grid(),
			onUpdate: () => {},
			focusRadius: 40,
		});
		scheduler.request({ visible: everything, after: null, focus: { x: 300, y: 200 }, scope: 'focus' });
		await settle(scheduler);
		expect(state.runs).toBe(1); // the anchored tile alone covers the divider's neighbourhood
	});

	it('keeps its cache within budget, dropping tiles the view no longer needs first', async () => {
		const { session } = fakeSession();
		const small = new PreviewScheduler({
			image: () => image,
			session,
			grid: grid(),
			onUpdate: () => {},
			cacheBytes: 3 * 192 * 192 * 5,
		});
		small.request({ visible: everything, after: null, focus: { x: 300, y: 200 }, scope: 'view' });
		await settle(small);
		expect(small.cachedTiles).toBe(5);
	});
});
