// SPDX-License-Identifier: Apache-2.0
import { AlertTriangle, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { describeError } from '@/app/errors';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatDuration, roundDuration } from '@/lib/duration';
import { canSaveToFolder, SaveFailure } from '@/lib/save';
import { useThrottled } from '@/lib/use-throttled';
import { cn } from '@/lib/utils';
import type { BatchSession } from './session';
import { placeName } from './place';
import { useBatch, type BatchState } from './store';

/** "Keep this laptop plugged in" once the wait is long enough to drain a battery (§2.7). */
const PLUG_IN_FROM_MS = 15 * 60_000;

/**
 * The batch's progress, pinned under the grid (§5.4): "Exporting 3 of 12",
 * megapixel-weighted progress, and the time left from what this machine has
 * measured — hours if need be (§2.7). Pause, resume and cancel; afterwards,
 * what happened and what to do about anything that failed.
 */
export function Footer({ session }: { session: BatchSession }) {
	const { t } = useTranslation();
	const state = useBatch((s) => s.state);
	const run = useBatch((s) => s.run);
	const problem = useBatch((s) => s.problem);
	const destination = useBatch((s) => s.destination);
	const parts = useBatch((s) => s.parts);
	const current = useBatch((s) => s.photos.find((p) => p.status !== 'queued' && isWorking(p.status)) ?? null);
	const waiting = useBatch((s) =>
		s.destination?.kind === 'zip' ? s.photos.filter((p) => p.status === 'saved' && p.savedTo === null).length : 0,
	);
	const problemPhoto = useBatch((s) => (s.problem ? (s.photos.find((p) => p.id === s.problem!.id) ?? null) : null));
	// Found in the folder during this run, or known to be done when the batch was resumed.
	const already = useBatch((s) => s.photos.filter((p) => p.status === 'skipped').length);
	const place = placeName({ destination, parts }, t);

	const working = state === 'running' || state === 'checking' || state === 'paused';
	const total = run ? run.total - run.skipped : 0;
	const position = run ? Math.min(total, run.saved + run.failed + run.cancelled + (current ? 1 : 0)) : 0;
	const eta = run?.etaMs ?? null;

	let headline = '';
	if (state === 'checking') headline = t('batch.checking');
	else if (state === 'paused')
		headline = `${t('batch.paused')} · ${t('batch.position', { index: Math.max(1, position), count: total })}`;
	else if (state === 'running') headline = t('batch.exporting', { current: Math.max(1, position), total });
	const left =
		eta === null || state !== 'running'
			? ''
			: roundDuration(eta).unit === 'few'
				? t('batch.fewSeconds')
				: t('export.left', { time: formatDuration(eta, t) });
	const announced = useThrottled([headline, left].filter(Boolean).join(' · '), 5000);

	if (!run || state === 'idle') return null;

	return (
		<div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
			<div
				data-testid="batch-footer"
				data-state={state}
				className="enter-up pointer-events-auto flex w-full max-w-3xl flex-col gap-2.5 rounded-xl border border-line-strong bg-surface/95 p-3.5 shadow-xl shadow-black/30 backdrop-blur-md"
			>
				{working ? (
					<>
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
							<div className="flex min-w-0 flex-1 items-baseline gap-2 text-[13px]">
								<span className="shrink-0 font-medium text-fg" data-testid="batch-headline">
									{headline}
								</span>
								{current && (
									<span className="truncate text-fg-subtle" title={current.file.name}>
										{current.file.name}
										{current.status === 'processing' && current.bands
											? ` · ${t('process.band', { done: current.bands.done, total: current.bands.total })}`
											: ''}
									</span>
								)}
							</div>
							<div className="flex shrink-0 gap-2">
								{state === 'paused' ? (
									!problem && (
										<Button size="sm" variant="primary" onClick={() => session.resume()}>
											{t('batch.resume')}
										</Button>
									)
								) : (
									<Button size="sm" onClick={() => session.pause()} disabled={state === 'checking'}>
										{t('batch.pause')}
									</Button>
								)}
								<Button size="sm" variant="ghost" onClick={() => session.cancel()}>
									{t('process.cancel')}
								</Button>
							</div>
						</div>
						<Progress value={state === 'checking' ? null : run.progress} label={headline} />
						{problem ? (
							<Problem
								session={session}
								place={place}
								photoName={problemPhoto?.output ?? problemPhoto?.file.name ?? ''}
							/>
						) : (
							<p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-subtle">
								{left && (
									<span data-testid="batch-eta">
										{left}
										{eta !== null && eta >= PLUG_IN_FROM_MS ? ` ${t('batch.plugIn')}` : ''}
									</span>
								)}
								{already > 0 && <span>{t('batch.alreadyThere', { count: already })}</span>}
								{waiting > 0 && destination?.kind === 'zip' && (
									<span>{t('batch.zipWaiting', { count: waiting, file: session.zipPartName() })}</span>
								)}
							</p>
						)}
					</>
				) : (
					<Summary session={session} run={run} place={place} already={already} />
				)}
				<p className="sr-only" aria-live="polite">
					{announced}
				</p>
			</div>
		</div>
	);
}

function isWorking(status: string): boolean {
	return status === 'decoding' || status === 'processing' || status === 'encoding' || status === 'saving';
}

/** The batch paused itself: a save that failed (its photo kept, §5.13), or the GPU or model giving up. */
function Problem({ session, place, photoName }: { session: BatchSession; place: string; photoName: string }) {
	const { t } = useTranslation();
	const problem = useBatch((s) => s.problem)!;
	const save = problem.kind === 'save';
	const failure =
		problem.error instanceof SaveFailure || (problem.error as { name?: string } | null)?.name === 'SaveFailure';
	const kind = failure ? ((problem.error as { problem?: string }).problem ?? 'unknown') : 'unknown';
	const message = save
		? t(`save.problem.${kind}`, { file: photoName, folder: place })
		: t('batch.stoppedBy', { reason: describeError(problem.error, t, photoName) });
	return (
		<div role="alert" className="flex flex-col gap-2.5" data-testid="batch-problem">
			<p className="flex items-start gap-2 text-[13px] leading-relaxed text-fg">
				<AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
				<span>{message}</span>
			</p>
			<div className="flex flex-wrap justify-end gap-2">
				{save && canSaveToFolder() && (
					<Button size="sm" onClick={() => void session.changeFolderAndResume()}>
						{t('save.chooseAnother')}
					</Button>
				)}
				<Button size="sm" variant="primary" onClick={() => void (save ? session.unlockAndResume() : session.resume())}>
					{save ? t('error.retry') : t('batch.resume')}
				</Button>
			</div>
		</div>
	);
}

/** After the run (§5.11): "12 photos exported to Wedding/denoised", and what to do about the rest. */
function Summary({
	session,
	run,
	place,
	already,
}: {
	session: BatchSession;
	run: NonNullable<BatchState['run']>;
	place: string;
	already: number;
}) {
	const { t } = useTranslation();
	return (
		<div
			role="status"
			className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
			data-testid="batch-summary"
		>
			<div className="flex min-w-0 flex-col gap-1 text-[13px]">
				{run.saved > 0 && (
					<span className="flex items-start gap-1.5 text-success">
						<Check aria-hidden="true" className="mt-px size-4 shrink-0" />
						<span className="min-w-0 break-words">{t('batch.doneTo', { count: run.saved, place })}</span>
					</span>
				)}
				{already > 0 && <span className="text-fg-muted">{t('batch.alreadyThere', { count: already })}</span>}
				{run.failed > 0 && (
					<span className="flex items-center gap-1.5 text-fg">
						<AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-warning" />
						{t('batch.failedCount', { count: run.failed })}
					</span>
				)}
				{run.cancelled > 0 && (
					<span className={cn('text-fg-muted')}>{t('batch.stopped', { count: run.cancelled })}</span>
				)}
			</div>
			<div className="flex shrink-0 gap-2">
				{run.cancelled > 0 && (
					<Button size="sm" onClick={() => void session.retry(['cancelled'])}>
						{t('batch.continue')}
					</Button>
				)}
				{run.failed > 0 && (
					<Button size="sm" variant="primary" onClick={() => void session.retry(['failed'])}>
						{t('batch.retryFailed')}
					</Button>
				)}
			</div>
		</div>
	);
}
