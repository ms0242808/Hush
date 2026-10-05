// SPDX-License-Identifier: Apache-2.0
import { ChevronDown, Download, FolderOpen, HardDriveDownload, ImagePlus, Info, X } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { describeError } from '@/app/errors';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Tooltip } from '@/components/ui/tooltip';
import { Advanced } from '@/editor/panel/ExportPanel';
import { Presets } from '@/editor/panel/Presets';
import { Sliders } from '@/editor/panel/Sliders';
import { useEditor } from '@/editor/store';
import { formatDuration } from '@/lib/duration';
import { COMMAND_KEY } from '@/lib/keys';
import { canSaveToFolder } from '@/lib/save';
import { formatBytes, formatMegabytes } from '@/lib/utils';
import { placeName } from './place';
import { INSIDE_FOLDER, type BatchSession } from './session';
import { exportable, isBusy, useBatch } from './store';

/** Shown on the button only when it's worth planning around (§5.12: "Export (about 6 min)"). */
const ESTIMATE_FROM_MS = 10_000;
/** §5.4: above this, Safari and Firefox are told why Chrome or Edge suit big batches better. */
const LARGE_BATCH = 50;

/**
 * The batch's one panel (§5.13: one screen): what's in it, the settings every
 * photo shares, where they go, and Export. Settings are locked while a run is
 * going, so every photo of a batch looks the same.
 */
export function Panel({
	session,
	onPick,
	onClose,
}: {
	session: BatchSession;
	onPick: () => void;
	onClose: () => void;
}) {
	const { t, i18n } = useTranslation();
	const busy = useBatch(isBusy);
	const count = useBatch((s) => s.photos.length);
	const bytes = useBatch((s) => s.photos.reduce((sum, p) => sum + p.file.size, 0));
	const source = useBatch((s) => s.source);
	const resumed = useBatch((s) => s.resumed);
	const locale = i18n.resolvedLanguage ?? 'en';

	return (
		<aside
			aria-label={t('batch.label')}
			data-testid="batch-panel"
			className="enter-up flex w-full shrink-0 flex-col gap-5 px-0.5 pb-2 md:w-[320px] md:overflow-y-auto md:overscroll-contain"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<h1 className="truncate text-[14px] font-medium text-fg" data-testid="batch-count">
						{t('batch.count', { count })}
					</h1>
					<span className="tabular truncate text-[12px] text-fg-subtle">
						{[source.name ? t('batch.from', { folder: source.name }) : null, formatBytes(bytes, locale)]
							.filter(Boolean)
							.join(' · ')}
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<Tooltip label={t('batch.add')} keys={[COMMAND_KEY, 'O']}>
						<Button variant="ghost" size="icon" aria-label={t('batch.add')} onClick={onPick}>
							<ImagePlus />
						</Button>
					</Tooltip>
					<Tooltip label={t('batch.close')}>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t('batch.close')}
							disabled={busy}
							onClick={() => {
								session.close();
								onClose();
							}}
						>
							<X />
						</Button>
					</Tooltip>
				</div>
			</div>
			{resumed !== null && resumed > 0 && (
				<p className="-mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-subtle" data-testid="resumed">
					<Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
					{t('batch.resumed', { count: resumed })}
				</p>
			)}
			{source.ignored > 0 && (
				<p className="-mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-subtle">
					<Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
					{t('batch.ignored', { count: source.ignored })}
				</p>
			)}
			<ModelStatus session={session} />
			<Presets disabled={busy} />
			<Sliders disabled={busy} />
			<p className="-mt-1 text-[12px] leading-relaxed text-fg-subtle">{t('batch.tuneHint')}</p>
			<BatchExport session={session} />
			<BatchAdvanced session={session} />
		</aside>
	);
}

/** Where the photos go, and Export N photos (§5.11: the verb keeps its name). Also shown in the editor. */
export function BatchExport({ session, beforeStart }: { session: BatchSession; beforeStart?: () => void }) {
	const { t } = useTranslation();
	const busy = useBatch(isBusy);
	const ready = useBatch((s) => s.modelReady);
	const estimateMs = useBatch((s) => s.estimateMs);
	const notice = useBatch((s) => s.notice);
	const destination = useBatch((s) => s.destination);
	const total = useBatch((s) => exportable(s.photos).length);
	const todo = useBatch(
		(s) => exportable(s.photos).filter((p) => p.status !== 'saved' && p.status !== 'skipped').length,
	);
	const run = useBatch((s) => s.run);
	const state = useBatch((s) => s.state);
	const modelStatus = useEditor((s) => s.model.status);
	// Sizes and names come from each photo's header: the export waits until all are read.
	const reading = useBatch((s) => s.photos.filter((p) => !p.facts && !p.refused).length);

	let label: string;
	if (busy && run) {
		const count = run.total - run.skipped;
		const position = Math.min(count, run.saved + run.failed + run.cancelled + 1);
		label =
			state === 'checking'
				? t('batch.checking')
				: state === 'paused'
					? `${t('batch.paused')} · ${t('batch.position', { index: Math.max(1, position), count })}`
					: t('batch.exporting', { current: position, total: count });
	} else if (total > 0 && todo === 0) {
		label = t('batch.allExported');
	} else {
		label = t('batch.export', { count: todo });
	}
	const measuring = ready && estimateMs === null && todo > 0 && !busy;

	return (
		<div className="flex flex-col gap-3">
			<Destination session={session} disabled={busy} />
			{destination?.kind === 'zip' && (
				<p className="-mt-1 text-[12px] leading-relaxed text-fg-subtle">{t('batch.zipNote')}</p>
			)}
			{!canSaveToFolder() && total > LARGE_BATCH && (
				<p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-muted" data-testid="prefer-chrome">
					<Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
					{t('batch.preferChrome')}
				</p>
			)}
			<Tooltip label={t('result.export')} keys={[COMMAND_KEY, 'E']} side="top">
				<Button
					variant="primary"
					size="lg"
					className="w-full"
					disabled={busy || !ready || reading > 0 || estimateMs === null || todo === 0}
					onClick={() => {
						beforeStart?.();
						void session.start();
					}}
					data-testid="batch-export"
					aria-keyshortcuts="Control+E Meta+E"
				>
					<Download aria-hidden="true" />
					{label}
					{!busy && todo > 0 && estimateMs !== null && estimateMs >= ESTIMATE_FROM_MS && (
						<span className="font-normal opacity-75">
							{t('export.estimate', { time: formatDuration(estimateMs, t) })}
						</span>
					)}
				</Button>
			</Tooltip>
			{reading > 0 && !busy && (
				<p className="-mt-1 flex items-center gap-2 text-[12px] text-fg-subtle" role="status">
					<span
						aria-hidden="true"
						className="spinner size-3 rounded-full border-[1.5px] border-fg-subtle/30 border-t-fg-subtle"
					/>
					{t('batch.reading', { count: reading })}
				</p>
			)}
			{reading === 0 && measuring && modelStatus === 'ready' && (
				<p className="-mt-1 flex items-center gap-2 text-[12px] text-fg-subtle" role="status">
					<span
						aria-hidden="true"
						className="spinner size-3 rounded-full border-[1.5px] border-fg-subtle/30 border-t-fg-subtle"
					/>
					{t('batch.measuring')}
				</p>
			)}
			{notice && (
				<p role="alert" className="enter-up text-[13px] leading-relaxed text-fg">
					{t(notice.key, notice.values ?? {})}
				</p>
			)}
		</div>
	);
}

/** §5.13: where the photos will go is always visible, and changeable in one place. */
function Destination({ session, disabled }: { session: BatchSession; disabled: boolean }) {
	const { t } = useTranslation();
	const destination = useBatch((s) => s.destination);
	const parts = useBatch(useShallow((s) => s.parts));
	const source = useBatch((s) => s.source.folder);
	const remembered = useEditor((s) => s.folder);
	const folders = useMemo(() => canSaveToFolder(), []);
	const where = destination ? placeName({ destination, parts }, t) : t('save.chooseFolder');
	const Icon = destination?.kind === 'zip' ? HardDriveDownload : FolderOpen;

	// Without folder access (Safari, Firefox) there's one way: ZIP files. Say so; there's nothing to choose.
	if (!folders) {
		return (
			<span className="flex h-8 items-center gap-2 px-1 text-[13px] text-fg-muted" data-testid="save-location">
				<HardDriveDownload aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
				<span className="truncate">{t('save.savingTo', { place: t('batch.toZip') })}</span>
			</span>
		);
	}

	const value = destination?.kind === 'zip' ? 'zip' : destination?.inside ? 'inside' : destination ? 'folder' : '';
	const otherFolder = destination?.kind === 'folder' && !destination.inside ? destination.folder : remembered;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={disabled}>
				<button
					type="button"
					data-testid="save-location"
					className="group flex h-8 items-center gap-2 self-start rounded-lg px-1 text-[13px] text-fg-muted transition-[color] duration-150 hover:text-fg disabled:opacity-50"
				>
					<Icon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
					<span className="truncate">{destination ? t('save.savingTo', { place: where }) : where}</span>
					<ChevronDown
						aria-hidden="true"
						className="size-3.5 shrink-0 text-fg-subtle transition-transform duration-200 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
					/>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-[17rem]">
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(next) => {
						if (next === 'zip') session.setDestination({ kind: 'zip' });
						else if (next === 'inside' && source)
							session.setDestination({ kind: 'folder', folder: source, inside: INSIDE_FOLDER });
						else if (next === 'folder' && otherFolder)
							session.setDestination({ kind: 'folder', folder: otherFolder, inside: null });
					}}
				>
					{source && (
						<DropdownMenuRadioItem value="inside">
							<span className="truncate">{t('batch.toInside', { folder: source.name })}</span>
						</DropdownMenuRadioItem>
					)}
					{otherFolder && (
						<DropdownMenuRadioItem value="folder">
							<span className="truncate">{t('save.toFolder', { folder: otherFolder.name })}</span>
						</DropdownMenuRadioItem>
					)}
					<DropdownMenuRadioItem value="zip">{t('batch.toZip')}</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => void session.chooseDestination()}>
					<FolderOpen aria-hidden="true" />
					{otherFolder ? t('save.chooseAnother') : t('save.chooseFolder')}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Format, quality, suffix, location and processing — for every photo of the batch. */
export function BatchAdvanced({ session }: { session: BatchSession }) {
	const { t } = useTranslation();
	const busy = useBatch(isBusy);
	const sample = useBatch((s) => exportable(s.photos).find((p) => p.facts) ?? null);
	const located = useBatch((s) => s.photos.filter((p) => p.facts?.hadLocation).length);
	return (
		<Advanced
			disabled={busy}
			sample={sample?.facts ? { name: sample.file.name, format: sample.facts.format } : null}
			locationNote={located > 0 ? t('batch.locationSome', { count: located }) : t('batch.locationNone')}
			onProcessingChange={() => session.retryModel()}
		/>
	);
}

/** The first-use model download with real bytes (§5.6), its preparation, or why it failed. */
function ModelStatus({ session }: { session: BatchSession }) {
	const { t, i18n } = useTranslation();
	const locale = i18n.resolvedLanguage ?? 'en';
	const model = useEditor((s) => s.model);
	const ready = useBatch((s) => s.modelReady);

	if (model.status === 'confirm') {
		return (
			<Card>
				<p className="text-[13px] leading-relaxed text-fg">
					{t('model.metered', { size: formatMegabytes(model.bytes, locale) })}
				</p>
				<div className="flex justify-end">
					<Button size="sm" variant="primary" onClick={() => session.acceptDownload()}>
						{t('model.downloadNow')}
					</Button>
				</div>
			</Card>
		);
	}
	if (model.status === 'downloading') {
		return (
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
				<Progress value={model.total > 0 ? model.received / model.total : null} label={t('model.downloading')} />
				<span className="text-[12px] text-fg-subtle">
					{t('model.size', { size: formatMegabytes(model.total, locale) })}
				</span>
			</Card>
		);
	}
	if (model.status === 'failed') {
		return (
			<Card role="alert">
				<p className="text-[13px] leading-relaxed text-fg">{describeError(model.error, t, '')}</p>
				{model.retry && (
					<div className="flex justify-end">
						<Button size="sm" variant="primary" onClick={() => session.retryModel()}>
							{t('error.retry')}
						</Button>
					</div>
				)}
			</Card>
		);
	}
	if (!ready) {
		return (
			<p className="flex items-center gap-2 text-[12px] text-fg-subtle" role="status">
				<span
					aria-hidden="true"
					className="spinner size-3 rounded-full border-[1.5px] border-fg-subtle/30 border-t-fg-subtle"
				/>
				{t('model.preparing')}
			</p>
		);
	}
	return null;
}

function Card({ children, role, testId }: { children: React.ReactNode; role?: string; testId?: string }) {
	return (
		<div
			role={role}
			data-testid={testId}
			className="enter-up flex flex-col gap-2.5 rounded-xl border border-line-strong bg-sunken/60 p-3"
		>
			{children}
		</div>
	);
}
