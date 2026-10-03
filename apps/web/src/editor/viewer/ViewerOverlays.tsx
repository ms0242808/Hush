// SPDX-License-Identifier: Apache-2.0
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeError } from '@/app/errors';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip } from '@/components/ui/tooltip';
import { formatMegabytes } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { EditorSession } from '../session';
import { setZoom, toggleOriginal, useEditor } from '../store';
import type { Zoom } from './view-model';

const ZOOMS: { value: Zoom; label: string; keys?: string[] }[] = [
	{ value: 'fit', label: 'viewer.fit', keys: ['Z'] },
	{ value: 1, label: '100%' },
	{ value: 2, label: '200%' },
];

/** Fit · 100% · 200%, and the original on/off. Changes are instant: they're frequent (§5.7). */
export function ViewerToolbar() {
	const { t } = useTranslation();
	const zoom = useEditor((state) => state.zoom);
	const showOriginal = useEditor((state) => state.showOriginal);
	const reduced = useEditor((state) => state.reduced);
	return (
		<div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2">
			<div
				role="radiogroup"
				aria-label={t('viewer.zoom')}
				className="viewer-glass pointer-events-auto flex items-center gap-0.5 rounded-lg p-0.5"
			>
				{ZOOMS.map((option) => {
					const checked = zoom === option.value;
					const label = option.value === 'fit' ? t(option.label) : option.label;
					return (
						<Tooltip
							key={String(option.value)}
							label={option.value === 1 ? t('result.actualPixels') : label}
							keys={option.keys}
							side="top"
						>
							<button
								type="button"
								role="radio"
								aria-checked={checked}
								onClick={() => setZoom(option.value)}
								className={cn(
									'h-7 rounded-md px-2.5 text-[12px] font-medium tabular transition-[background-color,color] duration-150',
									checked ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white',
								)}
							>
								{label}
							</button>
						</Tooltip>
					);
				})}
			</div>
			{!reduced && (
				<Tooltip label={showOriginal ? t('viewer.showComparison') : t('viewer.showOriginal')} keys={['\\']} side="top">
					<button
						type="button"
						aria-pressed={showOriginal}
						aria-label={t('viewer.showOriginal')}
						onClick={toggleOriginal}
						className="viewer-glass pointer-events-auto flex size-8 items-center justify-center rounded-lg text-white/80 transition-[color,transform] duration-150 ease-out hover:text-white active:scale-[0.97]"
					>
						{showOriginal ? (
							<EyeOff className="size-4" aria-hidden="true" />
						) : (
							<Eye className="size-4" aria-hidden="true" />
						)}
					</button>
				</Tooltip>
			)}
		</div>
	);
}

/** A status message read out at most every few seconds: progress must not chatter (§5.10). */
function useThrottled(text: string, ms = 4000): string {
	const [spoken, setSpoken] = useState(text);
	const last = useRef(0);
	useEffect(() => {
		const wait = Math.max(0, last.current + ms - Date.now());
		const timer = window.setTimeout(() => {
			last.current = Date.now();
			setSpoken(text);
		}, wait);
		return () => window.clearTimeout(timer);
	}, [text, ms]);
	return spoken;
}

/**
 * What the viewer is waiting for, in one place at the bottom of the photo:
 * the first-use model download with real bytes (§5.6), the preview filling
 * in, or what went wrong — never more than one at a time.
 */
export function ViewerStatus({ session }: { session: EditorSession }) {
	const { t, i18n } = useTranslation();
	const locale = i18n.resolvedLanguage ?? 'en';
	const model = useEditor((state) => state.model);
	const preview = useEditor((state) => state.preview);
	const reduced = useEditor((state) => state.reduced);
	const backend = useEditor((state) => state.backend);
	const photoName = useEditor((state) => state.photo?.name ?? '');
	const exporting = useEditor((state) => state.exporting !== null);

	let content: React.ReactNode = null;
	let spoken = '';
	if (model.status === 'confirm') {
		spoken = t('model.metered', { size: formatMegabytes(model.bytes, locale) });
		content = (
			<Card>
				<p className="text-[13px] leading-relaxed text-fg">{spoken}</p>
				<div className="flex justify-end">
					<Button size="sm" variant="primary" onClick={() => session.acceptDownload()}>
						{t('model.downloadNow')}
					</Button>
				</div>
			</Card>
		);
	} else if (model.status === 'downloading') {
		const value = model.total > 0 ? model.received / model.total : null;
		spoken = t('model.downloading');
		content = (
			<Card testId="model-download">
				<div className="flex items-baseline justify-between gap-4 text-[13px]">
					<span className="text-fg">{t('model.downloading')}</span>
					<span className="tabular text-fg-subtle">
						{t('model.progress', {
							received: formatMegabytes(model.received, locale),
							total: formatMegabytes(model.total, locale),
						})}
					</span>
				</div>
				<Progress value={value} label={t('model.downloading')} />
				<span className="text-[12px] text-fg-subtle">
					{t('model.size', { size: formatMegabytes(model.total, locale) })}
				</span>
			</Card>
		);
	} else if (model.status === 'failed') {
		spoken = describeError(model.error, t, photoName);
		content = (
			<Card role="alert">
				<p className="text-[13px] leading-relaxed text-fg">{spoken}</p>
				{model.retry && (
					<div className="flex justify-end">
						<Button size="sm" variant="primary" onClick={() => void session.retryModel()}>
							{t('error.retry')}
						</Button>
					</div>
				)}
			</Card>
		);
	} else if (preview.error) {
		spoken = describeError(preview.error, t, photoName);
		content = (
			<Card role="alert">
				<p className="text-[13px] leading-relaxed text-fg">{spoken}</p>
				<div className="flex justify-end">
					<Button size="sm" variant="primary" onClick={() => void session.retryModel()}>
						{t('error.retry')}
					</Button>
				</div>
			</Card>
		);
	} else if (reduced) {
		content = <Pill>{t('viewer.fitHint')}</Pill>;
	} else if (exporting) {
		content = null;
	} else if (model.status === 'preparing' || model.status === 'idle') {
		spoken = t('model.preparing');
		content = <Pill busy>{t('model.preparing')}</Pill>;
	} else if (preview.planned > 0 && preview.done < preview.planned) {
		spoken = t('viewer.previewing');
		content = (
			<Pill busy testId="preview-progress">
				{t('viewer.previewProgress', { done: preview.done, total: preview.planned })}
			</Pill>
		);
	} else if (backend === 'wasm' && preview.planned > 0) {
		content = <Pill>{t('viewer.cpuPreview')}</Pill>;
	}

	const announced = useThrottled(spoken);
	return (
		<>
			<div className="pointer-events-none absolute inset-x-3 bottom-14 flex justify-center md:bottom-3 md:inset-x-48">
				{content && (
					<div key={model.status + String(Boolean(preview.error))} className="pointer-events-auto enter-up max-w-full">
						{content}
					</div>
				)}
			</div>
			<p className="sr-only" aria-live="polite">
				{announced}
			</p>
		</>
	);
}

function Card({ children, role, testId }: { children: React.ReactNode; role?: string; testId?: string }) {
	return (
		<div
			role={role}
			data-testid={testId}
			className="flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2.5 rounded-xl border border-line-strong bg-surface/95 p-3.5 shadow-xl shadow-black/30 backdrop-blur-md"
		>
			{children}
		</div>
	);
}

function Pill({ children, busy, testId }: { children: React.ReactNode; busy?: boolean; testId?: string }) {
	return (
		<span
			data-testid={testId}
			className="viewer-glass flex h-8 items-center gap-2 rounded-full px-3 text-[12px] font-medium text-white/90"
		>
			{busy && (
				<span
					aria-hidden="true"
					className="spinner size-3 rounded-full border-[1.5px] border-white/30 border-t-white"
				/>
			)}
			{children}
		</span>
	);
}
