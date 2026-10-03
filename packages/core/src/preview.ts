// SPDX-License-Identifier: Apache-2.0
import { DeviceLostError, inferenceFailure } from './errors.ts';
import { compositeTiles, tileToRgb8, type PreviewGrid, type TileIndex } from './preview-grid.ts';
import { extractTile, MAX_RECOVERIES } from './tiled.ts';
import type { Clock, Image8, InferenceSession } from './types.ts';
import { intersectRects, type Point, type Rect } from './view.ts';

/**
 * Runs the preview (§5.3, §4.6): the model, one tile of the preview grid at a
 * time, on just the tiles the viewer needs — nearest the before/after divider
 * first — publishing each finished area as it lands, so the comparison is
 * clear within about one tile's time. A new request (the user panned, moved
 * the divider, resized the window) reorders the queue between tiles; finished
 * tiles stay cached, so going back costs nothing.
 *
 * The sliders never come here: they blend the original and these results on
 * the screen (§2.5). Exports don't either: they run the full-resolution
 * recipe, after `pause()` has let the tile in flight finish.
 */

export interface PreviewRequest {
	/** What the viewer shows, in stored coordinates. */
	visible: Rect;
	/** The part showing the denoised side. Tiles touching it come first; null treats all of `visible` alike. */
	after: Rect | null;
	/** The divider, in stored coordinates: tiles are computed outwards from here. */
	focus: Point;
	/**
	 * 'view': every tile the viewer shows. 'focus': only those near the
	 * divider — the processor path, where each tile takes seconds (§2.10:
	 * "the preview crop shrinks to about 512 × 512 on CPU").
	 */
	scope: 'view' | 'focus';
}

export interface PreviewUpdate {
	/** Whole pixels inside the photo, stored coordinates. */
	rect: Rect;
	/** RGBA over `rect`: the denoised preview, alpha 255 wherever a tile covers it. */
	pixels: Uint8Array;
	/** How long the tile behind this update took; absent when re-sent from the cache. */
	tileMs?: number;
}

export interface PreviewStatus {
	/** Tiles of the current request that are ready. */
	done: number;
	/** Tiles the current request needs. */
	planned: number;
	/** A tile is being computed. */
	running: boolean;
}

export interface PreviewSchedulerOptions {
	/**
	 * The photo, read at each tile. A getter, so the owner can let go of the
	 * pixels while it decodes the photo again (after an export wrote over
	 * them); the scheduler is paused meanwhile.
	 */
	image: () => Image8;
	session: InferenceSession;
	grid: PreviewGrid;
	onUpdate: (update: PreviewUpdate) => void;
	onStatus?: (status: PreviewStatus) => void;
	/** The loop stopped on an error it can't recover from (out of memory, invalid output, a device that stays lost). */
	onError?: (error: unknown) => void;
	now?: Clock;
	/** Bytes of finished tiles to keep, least recently used dropped first. */
	cacheBytes?: number;
	/** For the 'focus' scope: tiles within this many pixels of the divider. */
	focusRadius?: number;
	/** For the 'view' scope: the most tiles one request may plan. */
	maxTiles?: number;
}

/** Timings kept for the estimate: enough for a stable median, no more. */
const MAX_SAMPLES = 32;

export class PreviewScheduler {
	readonly grid: PreviewGrid;
	/** Model time per tile, oldest first, for `msPerPixel` (the export estimate). */
	readonly samples: { ms: number; pixels: number }[] = [];
	private readonly session: InferenceSession;
	private readonly options: PreviewSchedulerOptions;
	private readonly now: Clock;
	private readonly cache = new Map<number, Uint8Array>();
	private readonly capacity: number;
	private readonly input: Float32Array;
	private queue: TileIndex[] = [];
	private planned = new Set<number>();
	private running = false;
	private paused = false;
	private disposed = false;
	private idle: Array<() => void> = [];

	constructor(options: PreviewSchedulerOptions) {
		this.options = options;
		this.grid = options.grid;
		this.session = options.session;
		this.now = options.now ?? (() => 0);
		const tileBytes = 3 * options.grid.tileSize ** 2;
		this.capacity = Math.max(4, Math.floor((options.cacheBytes ?? 160 * 2 ** 20) / tileBytes));
		this.input = new Float32Array(3 * options.grid.tileSize ** 2);
	}

	get status(): PreviewStatus {
		let done = 0;
		for (const key of this.planned) if (this.cache.has(key)) done++;
		return { done, planned: this.planned.size, running: this.running };
	}

	get cachedTiles(): number {
		return this.cache.size;
	}

	/** Replace what the viewer needs. Takes effect between tiles. */
	request(request: PreviewRequest): void {
		if (this.disposed) return;
		const { grid } = this;
		let area: Rect | null = request.visible;
		if (request.scope === 'focus') {
			const radius = this.options.focusRadius ?? grid.tileSize / 2 - grid.overlap;
			area = intersectRects(request.visible, {
				x: request.focus.x - radius,
				y: request.focus.y - radius,
				width: 2 * radius,
				height: 2 * radius,
			});
		}
		let tiles = area ? grid.order(grid.tilesIn(area), request.focus, request.after) : [];
		if (request.scope === 'view') tiles = tiles.slice(0, this.options.maxTiles ?? 96);
		this.planned = new Set(tiles.map(({ i, j }) => grid.key(i, j)));
		this.queue = tiles.filter(({ i, j }) => !this.cache.has(grid.key(i, j)));
		for (const key of this.planned) this.touch(key);
		this.report();
		if (!this.paused) void this.loop();
	}

	/** Publish everything already computed over `rect`: after the viewer loads a new region. */
	resend(rect: Rect): void {
		for (const { i, j } of this.grid.tilesIn(rect)) {
			if (!this.cache.has(this.grid.key(i, j))) continue;
			const area = intersectRects(this.grid.tileArea(i, j)!, rect);
			if (area) this.publish(area);
		}
	}

	/** Stop after the tile in flight; resolves once nothing is running. */
	pause(): Promise<void> {
		this.paused = true;
		if (!this.running) return Promise.resolve();
		return new Promise((resolve) => this.idle.push(resolve));
	}

	resume(): void {
		if (this.disposed) return;
		this.paused = false;
		void this.loop();
	}

	dispose(): void {
		this.disposed = true;
		this.paused = true;
		this.queue = [];
		this.cache.clear();
	}

	private async loop(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (!this.paused && !this.disposed) {
				const next = this.queue.shift();
				if (!next) break;
				const key = this.grid.key(next.i, next.j);
				if (this.cache.has(key)) continue;
				this.report();
				const rect = this.grid.tileRect(next.i, next.j);
				const size = this.grid.tileSize;
				extractTile(this.options.image(), rect.x, rect.y, size, size, this.input);
				const started = this.now();
				const output = await this.infer(size);
				const ms = this.now() - started;
				if (this.disposed) return;
				this.samples.push({ ms, pixels: size * size });
				if (this.samples.length > MAX_SAMPLES) this.samples.splice(1, 1); // keep the first: it marks the warm-up
				this.store(key, tileToRgb8(output, size));
				this.publish(this.grid.tileArea(next.i, next.j)!, ms);
			}
		} catch (error) {
			this.queue = [];
			if (!this.disposed) this.options.onError?.(error);
		} finally {
			this.running = false;
			this.report();
			for (const resolve of this.idle.splice(0)) resolve();
		}
	}

	/** One tile through the model, recreating a lost device like an export would (§2.3). */
	private async infer(size: number): Promise<Float32Array> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.session.run(this.input, size, size);
			} catch (error) {
				if (inferenceFailure(error) !== 'device-lost') throw error;
				if (!this.session.recover || attempt >= MAX_RECOVERIES) {
					throw new DeviceLostError(error instanceof Error ? error.message : 'The GPU device was lost');
				}
				await this.session.recover();
			}
		}
	}

	private publish(area: Rect, tileMs?: number): void {
		const pixels = new Uint8Array(area.width * area.height * 4);
		compositeTiles(this.grid, area, (i, j) => this.cache.get(this.grid.key(i, j)), pixels);
		this.options.onUpdate({ rect: area, pixels, ...(tileMs !== undefined && { tileMs }) });
	}

	private store(key: number, tile: Uint8Array): void {
		this.cache.set(key, tile);
		while (this.cache.size > this.capacity) {
			// Least recently used first, sparing what the current view needs when possible.
			let victim: number | undefined;
			for (const candidate of this.cache.keys()) {
				if (!this.planned.has(candidate)) {
					victim = candidate;
					break;
				}
			}
			this.cache.delete(victim ?? this.cache.keys().next().value!);
		}
	}

	private touch(key: number): void {
		const tile = this.cache.get(key);
		if (!tile) return;
		this.cache.delete(key);
		this.cache.set(key, tile);
	}

	private report(): void {
		this.options.onStatus?.(this.status);
	}
}
