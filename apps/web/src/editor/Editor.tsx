// SPDX-License-Identifier: Apache-2.0
import { ChevronLeft, ImagePlus, Info } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { describeError } from '@/app/errors';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import type { PhotoSelection } from '@/lib/batch-input';
import { COMMAND_KEY } from '@/lib/keys';
import { useWindowDrop } from '@/lib/photo-input';
import { cn } from '@/lib/utils';
import { ExportPanel } from './panel/ExportPanel';
import { Presets } from './panel/Presets';
import { Sliders } from './panel/Sliders';
import { editorSession, type EditorSession } from './session';
import { resetParams, setZoom, toggleOriginal, useEditor } from './store';
import { Viewer } from './viewer/Viewer';
import { ViewerStatus, ViewerToolbar } from './viewer/ViewerOverlays';

/** A photo opened from a batch's grid (§5.4): its settings are the batch's. */
export interface EditorBatch {
	/** Where this photo is in the batch, from 1. */
	index: number;
	count: number;
	/** Back to the grid. */
	onBack: () => void;
	/** §5.8: ← → move to the previous or next photo. */
	onStep: (delta: -1 | 1) => void;
	/** ⌘/Ctrl+E: export the batch. */
	onExport: () => void;
	/** In place of the single photo's export: the batch's save location and Export button. */
	exportArea: ReactNode;
}

export interface EditorProps {
	file: File;
	/** Changes with every open request, so choosing the same file again opens it again. */
	request: number;
	/** Photos were dropped, pasted or chosen: one replaces this photo, more make a batch. */
	onSelection: (selection: PhotoSelection) => void;
	/** Open the file picker (⌘/Ctrl+O). */
	onPick: () => void;
	/** Back to the empty drop zone. */
	onClose: () => void;
	/** The shortcut list (?). */
	onShortcuts: () => void;
	batch?: EditorBatch;
}

/** The panel is this wide on desktop; the viewer gets the rest (§5.1: the photo gets the space). */
const PANEL_CSS_WIDTH = 320;

/** The viewer's size before it exists, for choosing where to open: what the layout will give it. */
function expectedViewport(): { width: number; height: number } {
	const ratio = window.devicePixelRatio || 1;
	const desktop = window.innerWidth >= 768;
	const width = desktop ? window.innerWidth - PANEL_CSS_WIDTH - 48 : window.innerWidth - 32;
	const height = desktop ? window.innerHeight - 120 : window.innerHeight * 0.55;
	return { width: Math.max(320, Math.round(width * ratio)), height: Math.max(240, Math.round(height * ratio)) };
}

const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * The single-photo editor (§5.3): one screen — the photo at 100% with the
 * before/after divider, four sliders, export (§5.13). Everything else sits
 * behind one Advanced disclosure.
 */
export default function Editor({ file, request, onSelection, onPick, onClose, onShortcuts, batch }: EditorProps) {
	const { t } = useTranslation();
	const session = editorSession();
	const phase = useEditor((state) => state.phase);
	const photo = useEditor((state) => state.photo);
	const photoKey = useEditor((state) => state.photoKey);
	const exporting = useEditor((state) => state.exporting !== null);
	const openError = useEditor((state) => state.openError);

	useEffect(() => {
		void session.open(file, expectedViewport());
	}, [file, request, session]);

	// Another photo dropped or pasted anywhere replaces this one (or joins the batch), except mid-export.
	const over = useWindowDrop(onSelection, !exporting);

	// §5.8. None of these animate: keyboard actions are repeated too often to wait for.
	const latest = useRef({ onPick, onShortcuts, session, batch });
	useLayoutEffect(() => {
		latest.current = { onPick, onShortcuts, session, batch };
	});
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (typing(event.target) || event.altKey) return;
			const command = event.metaKey || event.ctrlKey;
			const key = event.key.toLowerCase();
			const state = useEditor.getState();
			if (command && key === 'o') {
				event.preventDefault();
				if (!state.exporting) latest.current.onPick();
			} else if (command && key === 'e') {
				event.preventDefault();
				if (latest.current.batch) latest.current.batch.onExport();
				else void latest.current.session.export();
			} else if (command && key === 'z' && !event.shiftKey) {
				if (state.exporting) return;
				event.preventDefault();
				resetParams();
			} else if (command) {
				return;
			} else if (event.key === '\\') {
				event.preventDefault();
				toggleOriginal();
			} else if (key === 'z') {
				event.preventDefault();
				setZoom(state.zoom === 'fit' ? 1 : 'fit');
			} else if (event.key === '?') {
				event.preventDefault();
				latest.current.onShortcuts();
			} else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && latest.current.batch) {
				// The viewer, sliders and segmented controls use the arrows themselves, and say so.
				if (event.defaultPrevented || state.exporting) return;
				event.preventDefault();
				latest.current.batch.onStep(event.key === 'ArrowLeft' ? -1 : 1);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	if (phase === 'failed' && openError) {
		return (
			<OpenFailed
				message={describeError(openError.error, t, file.name)}
				retry={openError.retry}
				onRetry={() => void session.open(file, expectedViewport())}
				onClose={batch ? batch.onBack : onClose}
				closeLabel={batch ? t('batch.back') : t('result.another')}
			/>
		);
	}

	const busy = phase !== 'editing';
	return (
		<TooltipProvider>
			<div className="flex w-full flex-1 flex-col gap-3 md:min-h-0 md:flex-row" data-testid="editor">
				<section
					aria-label={t('viewer.region')}
					className="relative flex min-h-[52vh] flex-1 flex-col overflow-hidden rounded-xl bg-viewer md:min-h-0"
				>
					{photo ? (
						<>
							<Viewer key={photoKey} session={session} photo={photo} />
							<ViewerToolbar />
							<ViewerStatus session={session} />
						</>
					) : (
						<Opening name={file.name} />
					)}
					{over && (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45">
							<span className="viewer-glass rounded-xl px-4 py-2.5 text-[14px] font-medium text-white">
								{t('drop.replace')}
							</span>
						</div>
					)}
				</section>
				<Panel session={session} busy={busy} onPick={onPick} batch={batch} />
			</div>
		</TooltipProvider>
	);
}

function Opening({ name }: { name: string }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6" role="status">
			<span className="max-w-full truncate text-[14px] text-white/80">{t('process.opening', { name })}</span>
			<Progress value={null} label={t('process.opening', { name })} className="w-48 bg-white/15" />
		</div>
	);
}

function Panel({
	session,
	busy,
	onPick,
	batch,
}: {
	session: EditorSession;
	busy: boolean;
	onPick: () => void;
	batch: EditorBatch | undefined;
}) {
	const { t, i18n } = useTranslation();
	const photo = useEditor((state) => state.photo);
	const file = useEditor((state) => state.file);
	const exporting = useEditor((state) => state.exporting !== null);
	const previewFailed = useEditor((state) => state.preview.error !== null);
	const name = photo?.name ?? file?.name ?? '';
	const notes: string[] = [];
	if (photo && photo.bitDepth > 8) notes.push(t('photo.deep', { bits: photo.bitDepth }));
	if (photo?.profile && photo.previewColour === 'srgb' && !/srgb/i.test(photo.profile)) {
		notes.push(t('photo.profile', { profile: photo.profile }));
	}

	return (
		<aside
			aria-label={t('panel.label')}
			className={cn(
				'enter-up flex w-full shrink-0 flex-col gap-5 px-0.5 pb-2 md:w-[320px] md:overflow-y-auto md:overscroll-contain',
			)}
		>
			{batch && (
				<div className="-mb-2 flex items-center justify-between gap-3">
					<Button
						variant="ghost"
						size="sm"
						className="-ml-2 gap-1 px-2"
						onClick={batch.onBack}
						data-testid="batch-back"
					>
						<ChevronLeft aria-hidden="true" />
						{t('batch.back')}
					</Button>
					<span className="tabular text-[12px] text-fg-subtle" data-testid="batch-position">
						{t('batch.position', { index: batch.index, count: batch.count })}
					</span>
				</div>
			)}
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<h1 className="truncate text-[14px] font-medium text-fg" title={name}>
						{name}
					</h1>
					<span className="tabular text-[12px] text-fg-subtle" data-testid="photo-size">
						{photo
							? t('photo.size', {
									width: photo.orientation >= 5 ? photo.height : photo.width,
									height: photo.orientation >= 5 ? photo.width : photo.height,
									// 45.4 MP, but 0.05 MP for a small photo rather than a misleading "0".
									mp: new Intl.NumberFormat(i18n.resolvedLanguage, {
										maximumFractionDigits: photo.megapixels < 1 ? 2 : 1,
									}).format(photo.megapixels),
								})
							: ' '}
					</span>
				</div>
				<Tooltip label={batch ? t('batch.add') : t('result.another')} keys={[COMMAND_KEY, 'O']}>
					<Button
						variant="ghost"
						size="icon"
						aria-label={batch ? t('batch.add') : t('result.another')}
						onClick={onPick}
						disabled={exporting}
					>
						<ImagePlus />
					</Button>
				</Tooltip>
			</div>
			{notes.map((note) => (
				<p key={note} className="-mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-subtle">
					<Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
					{note}
				</p>
			))}
			<Presets disabled={busy || exporting} />
			<Sliders disabled={busy || exporting} />
			{batch ? batch.exportArea : <ExportPanel session={session} disabled={busy || previewFailed} />}
		</aside>
	);
}

function OpenFailed({
	message,
	retry,
	onRetry,
	onClose,
	closeLabel,
}: {
	message: string;
	retry: boolean;
	onRetry: () => void;
	onClose: () => void;
	closeLabel: string;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-1 items-center justify-center p-4">
			<div className="enter-up flex w-full max-w-md flex-col gap-5 rounded-2xl border border-line bg-surface p-6 shadow-xl shadow-black/20">
				<p role="alert" className="text-[14px] leading-relaxed text-fg">
					{message}
				</p>
				<div className="flex justify-end gap-2">
					{/* Retrying only helps when the photo wasn't the problem. */}
					<Button variant={retry ? 'secondary' : 'primary'} onClick={onClose}>
						{closeLabel}
					</Button>
					{retry && (
						<Button variant="primary" onClick={onRetry}>
							{t('error.retry')}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
