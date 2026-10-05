// SPDX-License-Identifier: Apache-2.0
import { AlertTriangle, Check, ImageOff, RotateCw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { describeError, isRetryable } from '@/app/errors';
import { cn } from '@/lib/utils';
import type { BatchSession } from './session';
import { isBusy, useBatch, type BatchPhoto } from './store';

/** The grid's scroll position, kept while a photo is open in the editor. */
let scrollTop = 0;

/**
 * The batch's photos as thumbnails (§5.4). Each shows its state; failed ones
 * say why and offer a retry; skipped ones say they were already exported.
 * Clicking one opens it in the editor to tune the batch's settings. Nothing
 * here animates the photos themselves (§5.7): only the small state marks over
 * them fade in, and the progress line moves like any progress does.
 */
export function Grid({ session }: { session: BatchSession }) {
	const { t } = useTranslation();
	const ids = useBatch(useShallow((state) => state.photos.map((photo) => photo.id)));
	const list = useRef<HTMLUListElement>(null);

	useLayoutEffect(() => {
		const element = list.current;
		if (!element) return;
		element.scrollTop = scrollTop;
		return () => {
			scrollTop = element.scrollTop;
		};
	}, []);

	return (
		<ul
			ref={list}
			aria-label={t('batch.region')}
			data-testid="batch-grid"
			className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] content-start gap-x-3 gap-y-4 overflow-y-auto overscroll-contain p-3 pb-40 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]"
		>
			{ids.map((id) => (
				<Cell key={id} id={id} session={session} />
			))}
		</ul>
	);
}

function Cell({ id, session }: { id: string; session: BatchSession }) {
	const { t } = useTranslation();
	const photo = useBatch((state) => state.photos.find((p) => p.id === id));
	const busy = useBatch(isBusy);
	const paused = useBatch((state) => state.state === 'paused');
	const item = useRef<HTMLLIElement>(null);

	// A thumbnail is made once its cell is near the screen: a 400-photo folder doesn't decode 400 photos up front.
	useEffect(() => {
		const element = item.current;
		if (!element || photo?.thumbnail || photo?.refused) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					session.wantThumbnail(id);
					observer.disconnect();
				}
			},
			{ rootMargin: '600px 0px' },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [id, photo?.thumbnail, photo?.refused, session]);

	if (!photo) return null;
	const name = photo.file.name;
	const status = photo.refused ? 'refused' : photo.status;
	// Paused partway: say so, rather than spin as if work were going on.
	const statusText = paused && working(photo) ? t('batch.paused') : t(`batch.status.${status}`);
	const problem = photo.refused ?? (photo.status === 'failed' ? photo.error : null);
	const reason = problem ? describeError(problem, t, name) : null;
	const canRetry = photo.status === 'failed' && !photo.refused && isRetryable(photo.error) && !busy;
	const canRemove = !busy && !working(photo) && photo.status !== 'saved';

	return (
		<li
			ref={item}
			className="flex min-w-0 flex-col gap-1.5 [contain-intrinsic-size:auto_13rem] [content-visibility:auto]"
			data-testid="batch-photo"
			data-status={status}
			data-name={name}
		>
			<div className="group relative">
				<button
					type="button"
					onClick={() => session.edit(id)}
					disabled={busy || !!photo.refused}
					aria-label={
						busy || photo.refused
							? t('batch.photoLabel', { name, status: statusText })
							: status === 'queued'
								? t('batch.open', { name })
								: `${t('batch.open', { name })}. ${statusText}`
					}
					className={cn(
						'relative block aspect-[3/2] w-full overflow-hidden rounded-lg bg-black/25 outline-offset-2',
						'transition-[transform,box-shadow] duration-150 ease-out active:scale-[0.98] motion-reduce:active:scale-100',
						'disabled:cursor-default disabled:active:scale-100',
						working(photo) && 'shadow-[0_0_0_2px_rgb(255_255_255/0.85)]',
					)}
				>
					{photo.thumbnail ? (
						<img
							src={photo.thumbnail}
							alt=""
							draggable={false}
							className="size-full object-contain"
							data-testid="thumbnail"
						/>
					) : (
						<span className="flex size-full items-center justify-center text-white/35">
							{photo.refused ? <ImageOff aria-hidden="true" className="size-5" /> : null}
						</span>
					)}
					<Mark photo={photo} status={paused && working(photo) ? 'paused' : status} label={statusText} />
					{working(photo) && <Line fraction={photo.fraction} />}
				</button>
				{canRemove && (
					<button
						type="button"
						onClick={() => session.remove(id)}
						aria-label={`${t('batch.remove')}: ${name}`}
						className={cn(
							'viewer-glass absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full text-white/85',
							'opacity-0 transition-[opacity,transform] duration-150 ease-out hover:text-white active:scale-[0.94]',
							'focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
						)}
					>
						<X aria-hidden="true" className="size-3.5" />
					</button>
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-0.5 px-0.5">
				<span
					className="truncate text-[12px] text-fg-muted"
					// §5.13: where it went, by its actual name — "Saved IMG_2041-denoised.jpg to Wedding/denoised".
					title={
						photo.status === 'saved' && photo.output && photo.savedTo
							? t('save.savedToFolder', { file: photo.output, folder: photo.savedTo })
							: name
					}
				>
					{name}
				</span>
				{reason ? (
					<span
						className="line-clamp-3 text-[11px] leading-snug text-fg-subtle"
						title={reason}
						data-testid="batch-reason"
					>
						{reason}
					</span>
				) : photo.status === 'processing' && photo.bands ? (
					<span className="tabular text-[11px] text-fg-subtle">
						{t('process.band', { done: photo.bands.done, total: photo.bands.total })}
					</span>
				) : null}
				{canRetry && (
					<button
						type="button"
						onClick={() => void session.retry(['failed'])}
						className="flex items-center gap-1 self-start rounded text-[12px] font-medium text-accent transition-[color] duration-150 hover:text-accent-hover"
					>
						<RotateCw aria-hidden="true" className="size-3" />
						{t('batch.retry')}
					</button>
				)}
			</div>
		</li>
	);
}

function working(photo: BatchPhoto | undefined): boolean {
	return (
		!!photo &&
		(photo.status === 'decoding' ||
			photo.status === 'processing' ||
			photo.status === 'encoding' ||
			photo.status === 'saving')
	);
}

/**
 * The state over a thumbnail: neutral glass, so nothing near a photo carries
 * the accent colour (§5.1). Queued photos show nothing; the mark re-enters
 * (a short fade) only when the state changes.
 */
function Mark({ photo, status, label }: { photo: BatchPhoto; status: string; label: string }) {
	if (status === 'queued') return null;
	const icon =
		status === 'saved' ? (
			<Check aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
		) : status === 'failed' || status === 'refused' ? (
			<AlertTriangle aria-hidden="true" className="size-3.5 text-warning" />
		) : null;
	const busy = working(photo) && status !== 'paused';
	return (
		<span
			key={status}
			className="mark-in viewer-glass absolute bottom-1.5 left-1.5 flex h-6 max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-white/90"
		>
			{busy && (
				<span
					aria-hidden="true"
					className="spinner size-2.5 shrink-0 rounded-full border-[1.5px] border-white/30 border-t-white"
				/>
			)}
			{icon}
			<span className="truncate">{label}</span>
		</span>
	);
}

/** How far the photo being worked on is: a thin white line along the thumbnail's foot. */
function Line({ fraction }: { fraction: number }) {
	return (
		<span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40">
			<span
				className="block h-full origin-left bg-white/90 transition-transform duration-300 ease-linear motion-reduce:transition-none"
				style={{ transform: `scaleX(${Math.min(1, Math.max(0, fraction))})` }}
			/>
		</span>
	);
}
