// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface CompareImages {
	before: ImageBitmap;
	after: ImageBitmap;
}

interface CompareViewProps {
	/** Null until the first crop arrives: the stage still renders, so it can be measured. */
	images: CompareImages | null;
	/** Hold the original in full view (the `\` key). */
	showOriginal: boolean;
	/** The stage's size in device pixels changed: the caller fetches a matching crop. */
	onStageResize: (devicePixels: { width: number; height: number }) => void;
}

const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.1;

/**
 * Before/after at 100%: one photo pixel per device pixel. The comparison is a
 * clip on the "after" layer, so no pixels are ever resampled; the layers sit
 * on the device-pixel grid for the same reason. Dragging writes straight to
 * the DOM — no React render, no transition — so the divider stays glued to
 * the pointer.
 */
export function CompareView({ images, showOriginal, onStageResize }: CompareViewProps) {
	const { t } = useTranslation();
	const stage = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLDivElement>(null);
	const beforeCanvas = useRef<HTMLCanvasElement>(null);
	const afterCanvas = useRef<HTMLCanvasElement>(null);
	const afterLayer = useRef<HTMLDivElement>(null);
	const divider = useRef<HTMLDivElement>(null);
	const handle = useRef<HTMLDivElement>(null);
	const position = useRef(0.5);
	const dragging = useRef<number | null>(null);
	const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

	const apply = useCallback(
		(fraction: number) => {
			const clamped = Math.min(1, Math.max(0, fraction));
			position.current = clamped;
			const width = frame.current?.clientWidth ?? 0;
			const x = clamped * width;
			if (afterLayer.current) afterLayer.current.style.clipPath = `inset(0 0 0 ${x}px)`;
			if (divider.current) divider.current.style.transform = `translateX(${x}px)`;
			if (handle.current) {
				const percent = Math.round(clamped * 100);
				handle.current.setAttribute('aria-valuenow', String(percent));
				handle.current.setAttribute(
					'aria-valuetext',
					`${t('result.before')} ${percent}% · ${t('result.after')} ${100 - percent}%`,
				);
			}
		},
		[t],
	);

	// Draw the bitmaps whenever they change.
	useEffect(() => {
		if (!images) return;
		for (const [canvas, bitmap] of [
			[beforeCanvas.current, images.before],
			[afterCanvas.current, images.after],
		] as const) {
			if (!canvas) continue;
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext('2d');
			if (!context) continue;
			context.imageSmoothingEnabled = false;
			context.drawImage(bitmap, 0, 0);
		}
	}, [images, box]);

	// Place the image on the device-pixel grid, centred in the stage.
	const layout = useCallback(() => {
		const element = stage.current;
		if (!element || !images) return;
		const dpr = window.devicePixelRatio || 1;
		const rect = element.getBoundingClientRect();
		const width = images.before.width / dpr;
		const height = images.before.height / dpr;
		const snap = (value: number) => Math.round(value * dpr) / dpr;
		setBox({
			left: snap(rect.left + (rect.width - width) / 2),
			top: snap(rect.top + (rect.height - height) / 2),
			width,
			height,
		});
	}, [images]);

	useLayoutEffect(layout, [layout]);
	useLayoutEffect(() => apply(position.current), [apply, box]);

	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		let timer = 0;
		let first = true;
		const report = () => {
			const dpr = window.devicePixelRatio || 1;
			const rect = element.getBoundingClientRect();
			onStageResize({ width: Math.floor(rect.width * dpr), height: Math.floor(rect.height * dpr) });
		};
		const observer = new ResizeObserver(() => {
			layout();
			window.clearTimeout(timer);
			if (first) {
				first = false;
				report(); // the first crop shouldn't wait
			} else {
				timer = window.setTimeout(report, 150);
			}
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			window.clearTimeout(timer);
		};
	}, [layout, onStageResize]);

	const fractionAt = (clientX: number) => {
		const rect = frame.current?.getBoundingClientRect();
		return rect && rect.width > 0 ? (clientX - rect.left) / rect.width : position.current;
	};

	return (
		<div ref={stage} data-testid="compare-stage" className="relative min-h-0 flex-1 overflow-hidden">
			{images && box && (
				<div
					ref={frame}
					data-testid="compare-frame"
					className="fixed cursor-ew-resize touch-none select-none"
					style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
					onPointerDown={(event) => {
						// One pointer at a time: a second finger mid-drag must not make the divider jump.
						if (dragging.current !== null || event.button !== 0) return;
						dragging.current = event.pointerId;
						event.currentTarget.setPointerCapture(event.pointerId);
						apply(fractionAt(event.clientX));
						handle.current?.focus({ preventScroll: true });
					}}
					onPointerMove={(event) => {
						if (dragging.current === event.pointerId) apply(fractionAt(event.clientX));
					}}
					onPointerUp={(event) => {
						if (dragging.current === event.pointerId) dragging.current = null;
					}}
					onPointerCancel={() => {
						dragging.current = null;
					}}
				>
					<canvas ref={beforeCanvas} aria-label={t('result.before')} className="absolute inset-0 size-full" />
					<div
						ref={afterLayer}
						className="absolute inset-0"
						style={{ visibility: showOriginal ? 'hidden' : 'visible' }}
					>
						<canvas ref={afterCanvas} aria-label={t('result.after')} className="absolute inset-0 size-full" />
					</div>

					<span className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-white/90">
						{t('result.before')}
					</span>
					{!showOriginal && (
						<span className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-white/90">
							{t('result.after')}
						</span>
					)}

					<div
						ref={divider}
						className="pointer-events-none absolute inset-y-0 left-0 w-0"
						style={{ visibility: showOriginal ? 'hidden' : 'visible' }}
					>
						<div className="absolute inset-y-0 -left-px w-0.5 bg-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" />
						<div
							ref={handle}
							role="slider"
							tabIndex={0}
							aria-label={t('result.divider')}
							aria-orientation="horizontal"
							aria-valuemin={0}
							aria-valuemax={100}
							data-testid="compare-divider"
							onKeyDown={(event) => {
								const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
								const keys: Record<string, number> = {
									ArrowLeft: position.current - step,
									ArrowDown: position.current - step,
									ArrowRight: position.current + step,
									ArrowUp: position.current + step,
									Home: 0,
									End: 1,
								};
								const next = keys[event.key];
								if (next === undefined) return;
								event.preventDefault();
								apply(next);
							}}
							className="pointer-events-auto absolute top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-black/20 bg-white text-neutral-700 shadow-lg shadow-black/30 transition-transform duration-150 ease-out active:scale-95 motion-reduce:transition-none"
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
			)}
		</div>
	);
}
