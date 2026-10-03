// SPDX-License-Identifier: Apache-2.0
import { cleanSuffix, defaultOutputFormat, outputName, type OutputFormat } from '@hush/core';
import { AlertTriangle, Check, ChevronDown, Download, FolderOpen, HardDriveDownload, Share } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { COMMAND_KEY } from '@/lib/keys';
import { Progress } from '@/components/ui/progress';
import { Segmented } from '@/components/ui/segmented';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import { formatDuration } from '@/lib/duration';
import { canSaveToFolder, canShareFiles, type SaveMethod } from '@/lib/save';
import { QUALITY_RANGE, type ExportSettings, type Processing } from '@/lib/settings';
import { cn } from '@/lib/utils';
import type { EditorSession } from '../session';
import { setProcessing, updateExportSettings, useEditor } from '../store';

/** Shown on the button only when it's worth planning around (§5.12: "Export (about 6 min)"). */
const ESTIMATE_FROM_MS = 10_000;

export function ExportPanel({ session, disabled }: { session: EditorSession; disabled: boolean }) {
	const { t } = useTranslation();
	const exporting = useEditor((state) => state.exporting);
	const estimateMs = useEditor((state) => state.estimateMs);
	const modelReady = useEditor((state) => state.model.status === 'ready');
	const photoReady = useEditor((state) => state.phase === 'editing');
	const canExport = !disabled && modelReady && photoReady && !exporting;

	return (
		<div className="flex flex-col gap-3">
			<SaveLocation session={session} disabled={!!exporting} />
			{exporting ? (
				<ExportProgress session={session} />
			) : (
				<Tooltip label={t('result.export')} keys={[COMMAND_KEY, 'E']} side="top">
					<Button
						variant="primary"
						size="lg"
						className="w-full"
						disabled={!canExport}
						onClick={() => void session.export()}
						data-testid="export-button"
						aria-keyshortcuts="Control+E Meta+E"
					>
						<Download aria-hidden="true" />
						{t('result.export')}
						{estimateMs !== null && estimateMs >= ESTIMATE_FROM_MS && (
							<span className="font-normal opacity-75">
								{t('export.estimate', { time: formatDuration(estimateMs, t) })}
							</span>
						)}
					</Button>
				</Tooltip>
			)}
			<SaveStatus session={session} />
			<Advanced session={session} disabled={!!exporting} />
		</div>
	);
}

function MethodIcon({ method }: { method: SaveMethod }) {
	const className = 'size-4 shrink-0 text-fg-subtle';
	if (method === 'folder') return <FolderOpen aria-hidden="true" className={className} />;
	if (method === 'share') return <Share aria-hidden="true" className={className} />;
	return <HardDriveDownload aria-hidden="true" className={className} />;
}

/** §5.13: where the photo will go is always visible, and changeable in one place. */
function SaveLocation({ session, disabled }: { session: EditorSession; disabled: boolean }) {
	const { t } = useTranslation();
	const method = useEditor((state) => state.saveMethod);
	const folder = useEditor((state) => state.folder);
	const folders = useMemo(() => canSaveToFolder(), []);
	const share = useMemo(() => canShareFiles(), []);
	const where =
		method === 'folder' && folder ? folder.name : method === 'share' ? t('save.shareSheet') : t('save.downloads');

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={disabled}>
				<button
					type="button"
					data-testid="save-location"
					className="group flex h-8 items-center gap-2 self-start rounded-lg px-1 text-[13px] text-fg-muted transition-[color] duration-150 hover:text-fg disabled:opacity-50"
				>
					<MethodIcon method={method} />
					<span className="truncate">{t('save.savingTo', { place: where })}</span>
					<ChevronDown
						aria-hidden="true"
						className="size-3.5 shrink-0 text-fg-subtle transition-transform duration-200 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
					/>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-[16rem]">
				<DropdownMenuRadioGroup
					value={method === 'folder' && !folder ? 'download' : method}
					onValueChange={(value) => session.setSaveMethod(value as SaveMethod)}
				>
					<DropdownMenuRadioItem value="download">{t('save.toDownloads')}</DropdownMenuRadioItem>
					{folders && folder && (
						<DropdownMenuRadioItem value="folder">
							<span className="truncate">{t('save.toFolder', { folder: folder.name })}</span>
						</DropdownMenuRadioItem>
					)}
					{share && <DropdownMenuRadioItem value="share">{t('save.toShare')}</DropdownMenuRadioItem>}
				</DropdownMenuRadioGroup>
				{folders && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => void session.pickFolder()}>
							<FolderOpen aria-hidden="true" />
							{folder ? t('save.chooseAnother') : t('save.chooseFolder')}
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ExportProgress({ session }: { session: EditorSession }) {
	const { t } = useTranslation();
	const exporting = useEditor((state) => state.exporting)!;
	let label: string;
	let detail = '';
	let value: number | null = null;
	switch (exporting.stage) {
		case 'preparing':
			label = t('export.preparing');
			break;
		case 'processing':
			label = t('export.removing');
			detail = exporting.total > 0 ? t('process.band', { done: exporting.done, total: exporting.total }) : '';
			value = exporting.fraction;
			break;
		case 'encoding':
			label = t('export.encoding');
			break;
		case 'saving':
			label = t('export.saving');
			break;
	}
	const eta = exporting.stage === 'processing' && exporting.etaMs !== null ? exporting.etaMs : null;
	return (
		<div
			className="enter-up flex flex-col gap-2.5 rounded-xl border border-line bg-sunken/60 p-3"
			data-testid="export-progress"
		>
			<div className="flex items-baseline justify-between gap-3 text-[13px]">
				<span className="text-fg">{label}</span>
				<span className="tabular text-fg-subtle">{detail}</span>
			</div>
			<Progress value={value} label={label} />
			<div className="flex items-center justify-between gap-3">
				<span className="text-[12px] text-fg-subtle">
					{eta !== null ? t('export.left', { time: formatDuration(eta, t) }) : ' '}
				</span>
				<Button size="sm" onClick={() => session.cancelExport()} disabled={exporting.stage === 'saving'}>
					{t('process.cancel')}
				</Button>
			</div>
		</div>
	);
}

/** §5.13: after export, the file name and where it went — or exactly why it didn't, with the file kept. */
function SaveStatus({ session }: { session: EditorSession }) {
	const { t } = useTranslation();
	const lastSaved = useEditor((state) => state.lastSaved);
	const unsaved = useEditor((state) => state.unsaved);
	const exportError = useEditor((state) => state.exportError);
	const photoName = useEditor((state) => state.photo?.name ?? '');
	const folder = useEditor((state) => state.folder);
	const folders = useMemo(() => canSaveToFolder(), []);

	if (lastSaved) {
		const message =
			lastSaved.method === 'folder'
				? t('save.savedToFolder', { file: lastSaved.name, folder: lastSaved.folder })
				: lastSaved.method === 'share'
					? t('save.shared', { file: lastSaved.name })
					: t('result.saved', { file: lastSaved.name });
		return (
			<p
				role="status"
				key={lastSaved.at}
				className="enter-up flex items-start gap-1.5 text-[13px] leading-snug text-success"
			>
				<Check aria-hidden="true" className="mt-px size-4 shrink-0" />
				<span className="min-w-0 break-words">{message}</span>
			</p>
		);
	}

	if (unsaved) {
		const { failure, file } = unsaved;
		const cancelled = failure.problem === 'cancelled';
		const where = folder?.name ?? t('save.downloads');
		return (
			<div
				role="alert"
				className="enter-up flex flex-col gap-2.5 rounded-xl border border-line-strong bg-sunken/60 p-3"
			>
				<p className="flex items-start gap-2 text-[13px] leading-relaxed text-fg">
					{!cancelled && <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />}
					<span>
						{cancelled
							? t('save.notShared', { file: file.name })
							: t(`save.problem.${failure.problem}`, { file: file.name, folder: where })}
					</span>
				</p>
				<div className="flex flex-wrap justify-end gap-2">
					{folders &&
						(failure.problem === 'not-found' || failure.problem === 'permission' || failure.problem === 'blocked') && (
							<Button
								size="sm"
								onClick={() =>
									void session.pickFolder().then(async (picked) => {
										if (picked) await session.retrySave('folder');
									})
								}
							>
								{t('save.chooseAnother')}
							</Button>
						)}
					<Button size="sm" onClick={() => void session.retrySave('download')}>
						{t('save.downloadInstead')}
					</Button>
					<Button size="sm" variant="primary" onClick={() => void session.retrySave()}>
						{t('error.retry')}
					</Button>
				</div>
			</div>
		);
	}

	if (exportError) {
		const cancelled = exportError.name === 'CancelledError';
		const message = cancelled
			? t('process.cancelled')
			: exportError.name === 'SaveFailure'
				? t('save.permission', { folder: folder?.name ?? t('save.downloads') })
				: describeError(exportError, t, photoName);
		return (
			<p
				role={cancelled ? 'status' : 'alert'}
				className={cn('enter-up text-[13px] leading-relaxed', cancelled ? 'text-fg-muted' : 'text-fg')}
			>
				{message}
			</p>
		);
	}
	return null;
}

/** Everything that isn't the one job, behind one disclosure (§5.13). */
function Advanced({ session, disabled }: { session: EditorSession; disabled: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const id = useId();
	const settings = useEditor((state) => state.exportSettings);
	const photo = useEditor((state) => state.photo);
	const processing = useEditor((state) => state.processing);
	const backend = useEditor((state) => state.backend);

	const source = photo && photo.format !== 'synthetic' ? photo.format : 'jpeg';
	const format: OutputFormat = settings.format === 'auto' ? defaultOutputFormat(source) : settings.format;
	const lossy = format === 'jpeg' || format === 'webp';
	const preview = photo ? outputName(photo.name, format, settings.suffix) : null;
	const update = (patch: Partial<ExportSettings>) => updateExportSettings(patch);

	return (
		<div className="flex flex-col border-t border-line pt-1">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen((value) => !value)}
				className="flex h-9 items-center justify-between rounded-lg text-[13px] font-medium text-fg-muted transition-[color] duration-150 hover:text-fg"
			>
				{t('advanced.title')}
				<ChevronDown
					aria-hidden="true"
					className={cn(
						'size-4 text-fg-subtle transition-transform duration-200 ease-out motion-reduce:transition-none',
						open && 'rotate-180',
					)}
				/>
			</button>
			{open && (
				<div id={id} className="enter-up flex flex-col gap-4 pb-2 pt-1">
					<Segmented
						label={t('advanced.format')}
						value={settings.format}
						disabled={disabled}
						testId="format"
						options={[
							{ value: 'auto', label: t('advanced.formatAuto') },
							{ value: 'jpeg', label: 'JPEG' },
							{ value: 'png', label: 'PNG' },
							{ value: 'webp', label: 'WebP' },
						]}
						onChange={(value) => update({ format: value })}
					/>
					{lossy && (
						<div className="flex flex-col gap-2">
							<div className="flex items-baseline justify-between">
								<span id={`${id}-quality`} className="text-[12px] font-medium text-fg-subtle">
									{t('advanced.quality')}
								</span>
								<span className="tabular text-[13px] text-fg">{settings.quality}</span>
							</div>
							<Slider
								value={[settings.quality]}
								min={QUALITY_RANGE.min}
								max={QUALITY_RANGE.max}
								step={1}
								disabled={disabled}
								thumbLabel={t('advanced.quality')}
								aria-labelledby={`${id}-quality`}
								onValueChange={([value]) => value !== undefined && update({ quality: value })}
							/>
						</div>
					)}
					<label className="flex flex-col gap-1.5">
						<span className="text-[12px] font-medium text-fg-subtle">{t('advanced.suffix')}</span>
						<input
							value={settings.suffix}
							disabled={disabled}
							maxLength={64}
							spellCheck={false}
							onChange={(event) => update({ suffix: event.currentTarget.value })}
							onBlur={(event) => update({ suffix: cleanSuffix(event.currentTarget.value) })}
							className="h-8 rounded-lg border border-line-strong bg-sunken px-2.5 text-[13px] text-fg outline-none focus-visible:border-accent disabled:opacity-50"
						/>
						{preview && (
							<span className="truncate text-[12px] text-fg-subtle" data-testid="output-name">
								{t('advanced.savesAs', { file: preview })}
							</span>
						)}
					</label>
					<label className="flex items-start justify-between gap-3">
						<span className="flex flex-col gap-0.5">
							<span className="text-[13px] text-fg-muted">{t('advanced.removeLocation')}</span>
							<span className="text-[12px] text-fg-subtle">
								{photo?.hadLocation ? t('advanced.hasLocation') : t('advanced.noLocation')}
							</span>
						</span>
						<Switch
							checked={settings.removeLocation}
							disabled={disabled}
							onCheckedChange={(checked) => update({ removeLocation: checked })}
							aria-label={t('advanced.removeLocation')}
						/>
					</label>
					<div className="flex flex-col gap-1.5">
						<Segmented<Processing>
							label={t('advanced.processing')}
							value={processing}
							disabled={disabled}
							testId="processing"
							options={[
								{ value: 'auto', label: t('advanced.processingAuto') },
								{ value: 'webgpu', label: t('backend.webgpuShort') },
								{ value: 'wasm', label: t('backend.wasmShort') },
							]}
							onChange={(value) => {
								setProcessing(value);
								void session.reopen(); // one runtime per worker: another backend means opening the photo again
							}}
						/>
						{backend && (
							<span className="text-[12px] text-fg-subtle">
								{t('advanced.runningOn', { backend: t(`backend.${backend}`) })}
							</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
