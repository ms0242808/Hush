// SPDX-License-Identifier: Apache-2.0
import { containsRect, type Size } from '@hush/core';
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { EditorSession } from '../session';
import { setZoom, useEditor, type PhotoSummary } from '../store';
import { CanvasRenderer } from './renderer-2d';
import { GlRenderer } from './renderer-gl';
import type { Frame, PixelsRGBA, Renderer } from './renderer';
import {
	afterStoredRect,
	clampCentre,
	deviceToStored,
	displayed,
	focusPoint,
	originOf,
	panBy,
	regionAround,
	scaleOf,
	storedToDisplay,
	visibleStoredRect,
	zoomAt,
	type Photo,
	type View,
	type Zoom,
} from './view-model';

/** Hold this long without moving to see the original (§5.3: press-and-hold shows the original). */
const HOLD_MS = 280;
/** Movement that turns a press into a pan, in CSS pixels. */
const DRAG_SLOP = 4;
/** The divider's grab area on each side of the line, in CSS pixels. */
const DIVIDER_REACH = 12;
const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.1;

interface ViewerHook {
	/** The frame as drawn, top row first. */
	read(): PixelsRGBA | null;
	/**
	 * The photo's on-screen pixels as the original, or entirely as the result
	 * (the divider at the left edge), cropped to where the photo is drawn.
	 */
	readPhoto(
		mode: 'original' | 'result',
	): (PixelsRGBA & { rect: { x: number; y: number; width: number; height: number } }) | null;
	state(): {
		zoom: Zoom;
		viewport: Size;
		region: unknown;
		divider: number;
		renderer: string;
		draws: number;
		/** Where the photo is drawn, in device pixels. */
		photo: { x: number; y: number; width: number; height: number };
	};
	draws: number;
}

declare global {
	interface Window {
		__hushViewer?: ViewerHook;
	}
}

type Gesture =
	| { kind: 'divider'; pointer: number }
	| { kind: 'press'; pointer: number; x: number; y: number; timer: number }
	| { kind: 'pan'; pointer: number; x: number; y: number }
	| { kind: 'hold'; pointer: number }
	| { kind: 'click-zoom'; pointer: number; x: number; y: number };

function readBackground(): [number, number, number] {
	const value = getComputedStyle(document.documentElement).getPropertyValue('--viewer-bg').trim();
	const match = /^#?([0-9a-f]{6})$/i.exec(value);
	if (!match) return [0.16, 0.16, 0.16];
	const hex = parseInt(match[1]!, 16);
	return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/**
 * The photo at 100% with the before/after divider — the signature element
 * (§5.1). The divider stays glued to the pointer: drags write to the DOM and
 * the GPU directly, never through React, and nothing about the photo ever
 * animates (§5.7).
 */
export function Viewer({ session, photo }: { session: EditorSession; photo: PhotoSummary }) {
	const { t } = useTranslation();
	const stage = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const line = useRef<HTMLDivElement>(null);
	const handle = useRef<HTMLDivElement>(null);
	const beforeLabel = useRef<HTMLSpanElement>(null);
	const afterLabel = useRef<HTMLSpanElement>(null);

	// The viewer is keyed by photo, so its geometry never changes while it's mounted.
	const [geometry] = useState<Photo>(() => ({
		stored: { width: photo.width, height: photo.height },
		orientation: photo.orientation,
	}));
	const [opening] = useState(() => storedToDisplay(photo.noisiest, geometry));
	const view = useRef<View>({ zoom: 1, centre: opening });
	/** Where 100% was last, for coming back from fit. */
	const lastActual = useRef(opening);
	const viewport = useRef<Size>({ width: 0, height: 0 });
	const dpr = useRef(1);
	const divider = useRef(0.5);
	const renderer = useRef<Renderer | null>(null);
	const background = useRef<[number, number, number]>([0.16, 0.16, 0.16]);
	const regionTicket = useRef(0);
	const loadingRegion = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
	const gesture = useRef<Gesture | null>(null);
	const spaceHeld = useRef(false);
	const scheduled = useRef(0);
	const viewDirty = useRef(true);
	const draws = useRef(0);

	const zoom = useEditor((state) => state.zoom);
	const showOriginal = useEditor((state) => state.showOriginal);
	const [holding, setHolding] = useState(false);
	const [cursor, setCursor] = useState<'zoom-in' | 'grab' | 'grabbing' | 'ew-resize'>('grab');
	const [ready, setReady] = useState(false);

	const reduced = useEditor((state) => state.reduced);
	const comparing = !reduced && !showOriginal && !holding;

	/** Fit only becomes the overview when it shrinks the photo; a photo that fits at 100% stays at 100%. */
	const isReduced = useCallback(
		() => view.current.zoom === 'fit' && viewport.current.width > 0 && scaleOf('fit', viewport.current, geometry) < 1,
		[geometry],
	);

	/** Tell the overlays whether the overview is showing, and set the matching cursor. */
	const refreshMode = useCallback(() => {
		const next = isReduced();
		if (useEditor.getState().reduced !== next) useEditor.setState({ reduced: next });
		setCursor(next ? 'zoom-in' : 'grab');
	}, [isReduced]);

	// ── Drawing ────────────────────────────────────────────────────────────────

	const frameNow = useCallback((): Frame | null => {
		const { width, height } = viewport.current;
		if (width === 0 || height === 0) return null;
		const state = useEditor.getState();
		const overview = isReduced();
		const compare = !overview && !state.showOriginal && gesture.current?.kind !== 'hold';
		return {
			viewport: { width, height },
			toStored: deviceToStored(view.current, viewport.current, geometry),
			fit: overview,
			divider: compare ? Math.round(divider.current * width) : null,
			params: state.params,
			background: background.current,
		};
	}, [geometry, isReduced]);

	/**
	 * Keep the divider and the labels on the photo itself: when the photo is
	 * smaller than the viewer, they stop at its edges instead of running into
	 * the backdrop. Written straight to the DOM, every frame, like the divider.
	 */
	const placeOverlays = useCallback(() => {
		const ratio = dpr.current;
		const { width, height } = viewport.current;
		const scale = scaleOf(view.current.zoom, viewport.current, geometry);
		const origin = originOf(view.current, viewport.current, geometry);
		const shown = displayed(geometry);
		const left = Math.max(0, origin.x) / ratio;
		const top = Math.max(0, origin.y) / ratio;
		const right = Math.min(width, origin.x + shown.width * scale) / ratio;
		const bottom = Math.min(height, origin.y + shown.height * scale) / ratio;
		const x = Math.round(divider.current * width) / ratio;
		if (line.current) {
			line.current.style.transform = `translate3d(${x}px, 0, 0)`;
			line.current.style.top = `${top}px`;
			line.current.style.height = `${Math.max(0, bottom - top)}px`;
		}
		if (beforeLabel.current) {
			beforeLabel.current.style.left = `${left + 12}px`;
			beforeLabel.current.style.top = `${top + 12}px`;
		}
		if (afterLabel.current) {
			afterLabel.current.style.right = `${width / ratio - right + 12}px`;
			afterLabel.current.style.top = `${top + 12}px`;
		}
		const roomy = right - left >= 240 && bottom - top >= 64;
		for (const label of [beforeLabel.current, afterLabel.current]) {
			if (label) label.style.visibility = roomy ? 'visible' : 'hidden';
		}
		if (handle.current) {
			const percent = Math.round(divider.current * 100);
			handle.current.setAttribute('aria-valuenow', String(percent));
			handle.current.setAttribute(
				'aria-valuetext',
				t('viewer.dividerValue', { before: percent, after: 100 - percent }),
			);
		}
	}, [t, geometry]);

	/** The latest frame function; `invalidate` stays the same function for the component's life. */
	const renderLatest = useRef<() => void>(() => {});

	/** Redraw on the next frame; `moved` when what's visible changed. */
	const invalidate = useCallback((moved = false) => {
		if (moved) viewDirty.current = true;
		if (!scheduled.current) {
			scheduled.current = requestAnimationFrame(() => {
				scheduled.current = 0;
				renderLatest.current();
			});
		}
	}, []);

	/** Ask for what the view needs: original pixels around it, and preview tiles nearest the divider. */
	const syncView = useCallback(() => {
		const r = renderer.current;
		const { width, height } = viewport.current;
		if (!r || width === 0 || height === 0 || isReduced()) return;
		const visible = visibleStoredRect(view.current, viewport.current, geometry);
		if (!visible) return;
		const current = r.region;
		const pending = loadingRegion.current;
		if ((!current || !containsRect(current, visible)) && (!pending || !containsRect(pending, visible))) {
			const rect = regionAround(visible, geometry);
			const ticket = ++regionTicket.current;
			loadingRegion.current = rect;
			void session.region(rect).then((region) => {
				if (ticket !== regionTicket.current) return;
				loadingRegion.current = null;
				if (!region || !renderer.current) return; // exporting: keep what's on screen
				renderer.current.setRegion(region.rect, region.data);
				session.resendPreview(region.rect);
				invalidate(true);
			});
		}
		const state = useEditor.getState();
		if (!state.previewInfo) return;
		const dividerX = Math.round(divider.current * width);
		session.requestPreview({
			visible,
			after: afterStoredRect(view.current, viewport.current, geometry, dividerX),
			focus: focusPoint(view.current, viewport.current, geometry, dividerX),
			scope: state.backend === 'wasm' ? 'focus' : 'view',
		});
	}, [session, invalidate, geometry, isReduced]);

	useLayoutEffect(() => {
		renderLatest.current = () => {
			const r = renderer.current;
			const frame = frameNow();
			if (!r || !frame) return;
			if (viewDirty.current) {
				viewDirty.current = false;
				syncView();
			}
			r.draw(frame);
			draws.current++;
			placeOverlays();
		};
	});

	// ── Renderer lifecycle ─────────────────────────────────────────────────────

	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		background.current = readBackground();
		const create = () => {
			const colour = photo.previewColour;
			const made = GlRenderer.create(element, colour) ?? CanvasRenderer.create(element, colour);
			if (!made) return;
			if (session.overview) made.setOverview(session.overview, geometry.stored);
			renderer.current = made;
			setReady(true);
			invalidate(true);
		};
		create();
		// The light-grey theme changes the backdrop around the photo.
		const themeWatcher = new MutationObserver(() => {
			background.current = readBackground();
			invalidate();
		});
		themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		const onLost = (event: Event) => {
			event.preventDefault(); // allow a restore
			renderer.current = null;
		};
		const onRestored = () => create();
		element.addEventListener('webglcontextlost', onLost);
		element.addEventListener('webglcontextrestored', onRestored);
		const unsubscribe = session.onPreview((update) => {
			renderer.current?.updateDenoised(update.rect, update.pixels);
			invalidate();
		});
		return () => {
			unsubscribe();
			themeWatcher.disconnect();
			element.removeEventListener('webglcontextlost', onLost);
			element.removeEventListener('webglcontextrestored', onRestored);
			cancelAnimationFrame(scheduled.current);
			scheduled.current = 0;
			renderer.current?.dispose();
			renderer.current = null;
		};
	}, [session, photo.previewColour, invalidate, geometry]);

	// Sliders, the original toggle and new preview tiles redraw; zoom and the preview starting re-sync.
	useEffect(
		() =>
			useEditor.subscribe((state, previous) => {
				if (state.params !== previous.params || state.showOriginal !== previous.showOriginal) invalidate();
				if (state.previewInfo !== previous.previewInfo || state.backend !== previous.backend) invalidate(true);
			}),
		[invalidate],
	);

	// Zoom changes from anywhere (the toolbar, Z): fit keeps 100%'s place to come back to.
	useLayoutEffect(() => {
		const current = view.current;
		if (current.zoom === zoom) return;
		if (current.zoom !== 'fit') lastActual.current = current.centre;
		view.current = { zoom, centre: zoom === 'fit' ? current.centre : lastActual.current };
		refreshMode();
		invalidate(true);
	}, [zoom, invalidate, refreshMode]);

	// Size the canvas to exact device pixels: 100% must mean one photo pixel per device pixel.
	useEffect(() => {
		const element = stage.current;
		const target = canvas.current;
		if (!element || !target) return;
		const apply = (device: Size, css: Size) => {
			if (device.width === viewport.current.width && device.height === viewport.current.height) return;
			viewport.current = device;
			dpr.current = css.width > 0 ? device.width / css.width : window.devicePixelRatio || 1;
			target.width = device.width;
			target.height = device.height;
			target.style.width = `${css.width}px`;
			target.style.height = `${css.height}px`;
			view.current = {
				...view.current,
				centre: clampCentre(view.current.centre, scaleOf(view.current.zoom, device, geometry), device, geometry),
			};
			refreshMode();
			invalidate(true);
		};
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return;
			const css = { width: entry.contentRect.width, height: entry.contentRect.height };
			const ratio = window.devicePixelRatio || 1;
			const estimate = { width: Math.round(css.width * ratio), height: Math.round(css.height * ratio) };
			// The device-pixel box is exact where it's real (it includes the browser's pixel snapping),
			// but emulated scale factors report CSS pixels there: trust it only when it agrees.
			const exact = entry.devicePixelContentBoxSize?.[0];
			const trusted =
				exact && Math.abs(exact.inlineSize - estimate.width) <= 2 && Math.abs(exact.blockSize - estimate.height) <= 2;
			apply(trusted ? { width: exact.inlineSize, height: exact.blockSize } : estimate, css);
		});
		try {
			observer.observe(element, { box: 'device-pixel-content-box' });
		} catch {
			observer.observe(element);
		}
		return () => observer.disconnect();
	}, [invalidate, geometry, refreshMode]);

	// Space held: drag anywhere pans, the divider included (§5.8).
	useEffect(() => {
		const typing = (event: KeyboardEvent) =>
			event.target instanceof HTMLElement &&
			(event.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName));
		const down = (event: KeyboardEvent) => {
			if (event.code !== 'Space' || typing(event) || event.repeat) return;
			if (
				event.target instanceof HTMLButtonElement ||
				(event.target as HTMLElement).getAttribute?.('role') === 'slider'
			)
				return;
			event.preventDefault();
			spaceHeld.current = true;
			if (!isReduced()) setCursor('grab');
		};
		const up = (event: KeyboardEvent) => {
			if (event.code === 'Space') spaceHeld.current = false;
		};
		window.addEventListener('keydown', down);
		window.addEventListener('keyup', up);
		return () => {
			window.removeEventListener('keydown', down);
			window.removeEventListener('keyup', up);
		};
	}, [isReduced]);

	// The test hook: pixels exactly as drawn, and how often the viewer drew.
	useEffect(() => {
		if (import.meta.env.MODE === 'production') return;
		const photoRect = () => {
			const scale = scaleOf(view.current.zoom, viewport.current, geometry);
			const origin = originOf(view.current, viewport.current, geometry);
			const shown = displayed(geometry);
			const x = Math.max(0, Math.round(origin.x));
			const y = Math.max(0, Math.round(origin.y));
			return {
				x,
				y,
				width: Math.min(viewport.current.width, Math.round(origin.x + shown.width * scale)) - x,
				height: Math.min(viewport.current.height, Math.round(origin.y + shown.height * scale)) - y,
			};
		};
		window.__hushViewer = {
			read: () => {
				const frame = frameNow();
				return frame && renderer.current ? renderer.current.read(frame) : null;
			},
			readPhoto: (mode) => {
				const frame = frameNow();
				if (!frame || !renderer.current) return null;
				const full = renderer.current.read({ ...frame, divider: mode === 'result' ? 0 : null });
				const rect = photoRect();
				const data = new Uint8Array(rect.width * rect.height * 4);
				for (let row = 0; row < rect.height; row++) {
					const from = ((rect.y + row) * full.width + rect.x) * 4;
					data.set(full.data.subarray(from, from + rect.width * 4), row * rect.width * 4);
				}
				return { width: rect.width, height: rect.height, data, rect };
			},
			state: () => ({
				zoom: view.current.zoom,
				viewport: viewport.current,
				region: renderer.current?.region ?? null,
				divider: divider.current,
				renderer: renderer.current?.kind ?? 'none',
				draws: draws.current,
				photo: photoRect(),
			}),
			get draws() {
				return draws.current;
			},
		};
		return () => {
			delete window.__hushViewer;
		};
	}, [frameNow, geometry]);

	// ── Input ──────────────────────────────────────────────────────────────────

	const deviceAt = (event: { clientX: number; clientY: number }) => {
		const rect = stage.current!.getBoundingClientRect();
		return { x: (event.clientX - rect.left) * dpr.current, y: (event.clientY - rect.top) * dpr.current };
	};

	const setDivider = (fraction: number) => {
		divider.current = Math.min(1, Math.max(0, fraction));
		invalidate(true);
	};

	const nearDivider = (event: { clientX: number }) => {
		const rect = stage.current!.getBoundingClientRect();
		return Math.abs(event.clientX - rect.left - divider.current * rect.width) <= DIVIDER_REACH;
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (gesture.current || (event.pointerType === 'mouse' && event.button !== 0)) return; // one pointer at a time
		const element = event.currentTarget;
		element.setPointerCapture(event.pointerId);
		const pointer = event.pointerId;
		if (isReduced()) {
			gesture.current = { kind: 'click-zoom', pointer, x: event.clientX, y: event.clientY };
			return;
		}
		if (spaceHeld.current) {
			gesture.current = { kind: 'pan', pointer, x: event.clientX, y: event.clientY };
			setCursor('grabbing');
			return;
		}
		if (comparing && (event.target === handle.current || nearDivider(event))) {
			gesture.current = { kind: 'divider', pointer };
			setCursor('ew-resize');
			setDivider((event.clientX - element.getBoundingClientRect().left) / element.getBoundingClientRect().width);
			handle.current?.focus({ preventScroll: true });
			return;
		}
		const timer = window.setTimeout(() => {
			if (gesture.current?.kind !== 'press') return;
			gesture.current = { kind: 'hold', pointer };
			setHolding(true);
			invalidate();
		}, HOLD_MS);
		gesture.current = { kind: 'press', pointer, x: event.clientX, y: event.clientY, timer };
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current;
		if (!current) {
			if (!isReduced() && !spaceHeld.current) setCursor(comparing && nearDivider(event) ? 'ew-resize' : 'grab');
			return;
		}
		if (current.pointer !== event.pointerId) return;
		switch (current.kind) {
			case 'divider': {
				const rect = event.currentTarget.getBoundingClientRect();
				setDivider((event.clientX - rect.left) / rect.width);
				break;
			}
			case 'press':
				if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > DRAG_SLOP) {
					window.clearTimeout(current.timer);
					gesture.current = { kind: 'pan', pointer: current.pointer, x: current.x, y: current.y };
					setCursor('grabbing');
					onPointerMove(event);
				}
				break;
			case 'pan': {
				const dx = (event.clientX - current.x) * dpr.current;
				const dy = (event.clientY - current.y) * dpr.current;
				// Whole device pixels, so 100% stays pixel-exact while moving.
				const ix = Math.round(dx);
				const iy = Math.round(dy);
				if (ix === 0 && iy === 0) break;
				view.current = panBy(view.current, ix, iy, viewport.current, geometry);
				gesture.current = { ...current, x: current.x + ix / dpr.current, y: current.y + iy / dpr.current };
				invalidate(true);
				break;
			}
			default:
				break;
		}
	};

	const endGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
		const current = gesture.current;
		if (!current || current.pointer !== event.pointerId) return;
		gesture.current = null;
		if (current.kind === 'press') window.clearTimeout(current.timer);
		if (current.kind === 'hold') {
			setHolding(false);
			invalidate();
		}
		if (
			current.kind === 'click-zoom' &&
			!cancelled &&
			Math.hypot(event.clientX - current.x, event.clientY - current.y) <= DRAG_SLOP
		) {
			// Click on the fitted photo: 100% right there.
			view.current = zoomAt(view.current, 1, deviceAt(event), viewport.current, geometry);
			lastActual.current = view.current.centre;
			setZoom(1);
			invalidate(true);
		}
		setCursor(isReduced() ? 'zoom-in' : 'grab');
	};

	const onWheel = useCallback(
		(event: WheelEvent) => {
			event.preventDefault(); // the photo scrolls, not the page; pinches don't zoom the page
			if (isReduced()) return;
			if (event.ctrlKey) return; // pinch-zoom: Fit and 100% are a key or a click away
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.current.height : 1;
			view.current = panBy(
				view.current,
				-Math.round(event.deltaX * unit * dpr.current),
				-Math.round(event.deltaY * unit * dpr.current),
				viewport.current,
				geometry,
			);
			invalidate(true);
		},
		[invalidate, geometry, isReduced],
	);

	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		element.addEventListener('wheel', onWheel, { passive: false });
		return () => element.removeEventListener('wheel', onWheel);
	}, [onWheel]);

	const onStageKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget || isReduced()) return;
		const step = (event.shiftKey ? 0.5 : 0.1) * Math.min(viewport.current.width, viewport.current.height);
		const moves: Record<string, [number, number]> = {
			ArrowLeft: [step, 0],
			ArrowRight: [-step, 0],
			ArrowUp: [0, step],
			ArrowDown: [0, -step],
		};
		const move = moves[event.key];
		if (!move) return;
		event.preventDefault();
		view.current = panBy(view.current, Math.round(move[0]), Math.round(move[1]), viewport.current, geometry);
		invalidate(true);
	};

	const onDividerKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
		const keys: Record<string, number> = {
			ArrowLeft: divider.current - step,
			ArrowDown: divider.current - step,
			ArrowRight: divider.current + step,
			ArrowUp: divider.current + step,
			PageDown: divider.current - KEY_STEP_LARGE,
			PageUp: divider.current + KEY_STEP_LARGE,
			Home: 0,
			End: 1,
		};
		const next = keys[event.key];
		if (next === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		setDivider(next);
	};

	return (
		<div
			ref={stage}
			tabIndex={0}
			role="group"
			aria-roledescription={t('viewer.role')}
			aria-label={t('viewer.label', { name: photo.name })}
			data-testid="viewer"
			data-zoom={String(zoom)}
			data-comparing={comparing}
			data-ready={ready}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={(event) => endGesture(event, false)}
			onPointerCancel={(event) => endGesture(event, true)}
			onLostPointerCapture={(event) => endGesture(event, true)}
			onKeyDown={onStageKey}
			onContextMenu={(event) => event.preventDefault()} // press-and-hold on a touch screen isn't a right-click
			className={cn(
				'relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-viewer outline-none [-webkit-touch-callout:none]',
				'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
				{
					'zoom-in': 'cursor-zoom-in',
					grab: 'cursor-grab',
					grabbing: 'cursor-grabbing',
					'ew-resize': 'cursor-ew-resize',
				}[cursor],
			)}
		>
			<canvas ref={canvas} aria-hidden="true" className="absolute left-0 top-0 block" />

			{comparing && (
				<>
					<span ref={beforeLabel} className="viewer-chip pointer-events-none absolute left-3 top-3">
						{t('result.before')}
					</span>
					<span ref={afterLabel} className="viewer-chip pointer-events-none absolute right-3 top-3">
						{t('result.after')}
					</span>
				</>
			)}
			{(showOriginal || holding) && !reduced && (
				<span ref={beforeLabel} className="viewer-chip pointer-events-none absolute left-3 top-3" role="status">
					{t('viewer.original')}
				</span>
			)}

			<div
				ref={line}
				className="pointer-events-none absolute left-0 top-0 h-full w-0"
				style={{ visibility: comparing ? 'visible' : 'hidden' }}
			>
				<div className="absolute inset-y-0 -left-px w-0.5 bg-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" />
				<div
					ref={handle}
					role="slider"
					tabIndex={comparing ? 0 : -1}
					aria-label={t('result.divider')}
					aria-orientation="horizontal"
					aria-valuemin={0}
					aria-valuemax={100}
					data-testid="compare-divider"
					onKeyDown={onDividerKey}
					className="pointer-events-auto absolute top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-black/20 bg-white text-neutral-700 shadow-lg shadow-black/30 transition-transform duration-150 ease-out active:scale-95 motion-reduce:transition-none"
				>
					<svg viewBox="0 0 20 20" aria-hidden="true" className="size-4">
						<path
							d="M7.5 5 3 10l4.5 5M12.5 5 17 10l-4.5 5"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.75"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</div>
			</div>
		</div>
	);
}
