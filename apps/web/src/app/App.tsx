// SPDX-License-Identifier: Apache-2.0
import { Info, Keyboard, Moon, Sun } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CapabilityNotice } from '@/components/capability-notice';
import { DropZone } from '@/components/drop-zone';
import { LanguageSwitch } from '@/components/language-switch';
import { PrivacyNote } from '@/components/privacy-note';
import { ResumeBatch } from '@/components/resume-batch';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Wordmark } from '@/components/wordmark';
import { canChooseFolder, chooseFolderOfPhotos, type PhotoSelection } from '@/lib/batch-input';
import type { BatchRecord } from '@/lib/batch-record';
import { detectCapabilities, type Capabilities } from '@/lib/capabilities';
import { filesSelection, useFilePicker, useWindowDrop } from '@/lib/photo-input';
import { loadTheme, saveTheme, type Theme } from '@/lib/settings';
import { checkSupport } from '@/lib/support';
import type { DialogName } from './Dialogs';

// The first paint is the drop zone (§5.10: initial JS ≤ 150 KB). The editor, the batch,
// their renderer and the UI kit load when photos are chosen — or earlier, when the page is idle.
const loadEditor = () => import('@/editor/Editor');
const Editor = lazy(loadEditor);
const Batch = lazy(() => import('@/batch/Batch'));
const loadBatchSession = () => import('@/batch/session').then((m) => m.batchSession());
const Dialogs = lazy(() => import('./Dialogs'));

type View = { kind: 'drop' } | { kind: 'single'; file: File; id: number } | { kind: 'batch' };

export function App() {
	const { t } = useTranslation();
	const [view, setView] = useState<View>({ kind: 'drop' });
	const [dialog, setDialog] = useState<DialogName | null>(null);
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [theme, setTheme] = useState<Theme>(loadTheme);
	const [support] = useState(checkSupport);
	/** A batch that stopped partway, from IndexedDB (§2.7). */
	const [stopped, setStopped] = useState<BatchRecord | null>(null);
	const [dropProblem, setDropProblem] = useState<{ key: string; values?: Record<string, unknown> } | null>(null);
	const requests = useRef(0);
	/** What the file picker's photos are for: opening, or picking a stopped batch back up. */
	const pickingFor = useRef<'open' | 'resume'>('open');

	const findStopped = useCallback(() => {
		void import('@/lib/batch-record')
			.then((m) => m.loadBatchRecord())
			.then((record) => {
				setStopped(record);
				if (record) void loadBatchSession().catch(() => {}); // ready before the click that resumes it
			});
	}, []);

	useEffect(() => {
		void detectCapabilities().then(setCapabilities);
		// Warm the editor's code while nothing else is happening, so a dropped photo opens at once.
		const warm = () => {
			void loadEditor().catch(() => {});
			findStopped();
		};
		if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warm);
		else window.setTimeout(warm, 1200);
	}, [findStopped]);

	/** One photo opens the editor; several, or a folder, make a batch (§5.4). */
	const openSelection = useCallback((selection: PhotoSelection) => {
		setDropProblem(null);
		if (!selection.folder && selection.files.length === 1) {
			setView({ kind: 'single', file: selection.files[0]!, id: ++requests.current });
			return;
		}
		if (selection.files.length === 0) {
			setDropProblem({ key: 'drop.empty', values: { folder: selection.folderName ?? '' } });
			return;
		}
		setView({ kind: 'batch' });
		void loadBatchSession().then((session) => session.open(selection));
	}, []);

	const onPicked = useCallback(
		(files: File[]) => {
			if (pickingFor.current === 'resume' && stopped) {
				pickingFor.current = 'open';
				const record = stopped;
				setStopped(null);
				setView({ kind: 'batch' });
				void loadBatchSession().then((session) => session.resumeWithFiles(record, files));
				return;
			}
			if (view.kind === 'batch') void loadBatchSession().then((session) => session.add(files));
			else openSelection(filesSelection(files));
		},
		[openSelection, stopped, view.kind],
	);
	const picker = useFilePicker(onPicked);
	const over = useWindowDrop(openSelection, view.kind === 'drop' && support.ok);
	const pick = useCallback(() => {
		pickingFor.current = 'open';
		picker.open();
	}, [picker]);

	const chooseFolder = useCallback(async () => {
		try {
			const selection = await chooseFolderOfPhotos();
			if (selection) openSelection(selection);
		} catch (error) {
			console.error(error);
			setDropProblem({ key: 'batch.folderFailed' });
		}
	}, [openSelection]);

	const resume = useCallback(async () => {
		const record = stopped;
		if (!record) return;
		if (record.source.kind === 'files') {
			pickingFor.current = 'resume';
			picker.open();
			return;
		}
		const session = await loadBatchSession();
		const outcome = await session.resumeFromFolder(record);
		if (outcome === 'started') {
			setStopped(null);
			setView({ kind: 'batch' });
		} else {
			setDropProblem(
				outcome === 'denied'
					? { key: 'resume.denied', values: { folder: record.source.name ?? '' } }
					: { key: 'resume.missing' },
			);
		}
	}, [picker, stopped]);

	const discard = useCallback(() => {
		setStopped(null);
		void import('@/lib/batch-record').then((m) => m.clearBatchRecord());
	}, []);

	const backToStart = useCallback(() => {
		setView({ kind: 'drop' });
		findStopped();
	}, [findStopped]);

	// On the drop zone: ⌘/Ctrl+O and ?. The editor and the batch handle their own keys.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
			if (view.kind !== 'drop') return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
				event.preventDefault();
				pick();
			} else if (event.key === '?' && !event.metaKey && !event.ctrlKey) {
				event.preventDefault();
				setDialog('shortcuts');
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [pick, view.kind]);

	const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
	return (
		<div className="flex h-dvh flex-col">
			<header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
				<Wordmark />
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						aria-label={t('shortcuts.title')}
						title={`${t('shortcuts.title')} (?)`}
						className="hidden md:inline-flex"
						onClick={() => setDialog('shortcuts')}
					>
						<Keyboard />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label={t('about.title')}
						title={t('about.title')}
						onClick={() => setDialog('about')}
					>
						<Info />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label={t(`theme.${nextTheme}`)}
						title={t(`theme.${nextTheme}`)}
						onClick={() => {
							saveTheme(nextTheme);
							setTheme(nextTheme);
						}}
					>
						{theme === 'dark' ? <Sun /> : <Moon />}
					</Button>
					<span className="ml-1">
						<LanguageSwitch />
					</span>
				</div>
			</header>

			<main className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-4 sm:px-6 md:overflow-visible">
				{!support.ok ? (
					<Unsupported reason={support.reason} />
				) : view.kind === 'single' ? (
					<Suspense fallback={<Loading name={view.file.name} />}>
						<Editor
							file={view.file}
							request={view.id}
							onSelection={openSelection}
							onPick={pick}
							onClose={backToStart}
							onShortcuts={() => setDialog('shortcuts')}
						/>
					</Suspense>
				) : view.kind === 'batch' ? (
					<Suspense fallback={<Loading name="" />}>
						<Batch onPick={pick} onClose={backToStart} onShortcuts={() => setDialog('shortcuts')} />
					</Suspense>
				) : (
					<>
						{capabilities && <CapabilityNotice assessment={capabilities.assessment} />}
						{stopped && <ResumeBatch record={stopped} onResume={() => void resume()} onDiscard={discard} />}
						{dropProblem && (
							<p role="alert" className="enter-up w-full max-w-2xl text-center text-[13px] leading-relaxed text-fg">
								{t(dropProblem.key, dropProblem.values ?? {})}
							</p>
						)}
						<div className="flex w-full flex-1 flex-col">
							<DropZone
								over={over}
								onChoose={pick}
								onChooseFolder={canChooseFolder() ? () => void chooseFolder() : null}
							/>
						</div>
						<p className="text-center text-[13px] text-fg-subtle md:hidden">{t('drop.desktopOnly')}</p>
					</>
				)}
			</main>

			<footer className="shrink-0 px-4 py-3">
				<PrivacyNote />
			</footer>
			{picker.element}
			{dialog && (
				<Suspense fallback={null}>
					<Dialogs which={dialog} onClose={() => setDialog(null)} capabilities={capabilities} />
				</Suspense>
			)}
		</div>
	);
}

function Loading({ name }: { name: string }) {
	const { t } = useTranslation();
	const label = name ? t('process.opening', { name }) : t('drop.reading');
	return (
		<div
			className="flex w-full flex-1 flex-col items-center justify-center gap-3 rounded-xl bg-viewer p-6"
			role="status"
		>
			<span className="max-w-full truncate text-[14px] text-white/80">{label}</span>
			<Progress value={null} label={label} className="w-48 bg-white/15" />
		</div>
	);
}

/** Every state has a designed screen (§5.10), including a browser that can't run Hush at all. */
function Unsupported({ reason }: { reason: 'insecure' | 'old-browser' }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-1 items-center justify-center p-4">
			<div
				role="alert"
				data-testid="unsupported"
				className="enter-up flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line bg-surface p-6 shadow-xl shadow-black/20"
			>
				<h1 className="text-[16px] font-semibold tracking-[-0.01em] text-fg">{t('unsupported.title')}</h1>
				<p className="text-[14px] leading-relaxed text-fg-muted">
					{reason === 'insecure' ? t('unsupported.insecure') : t('unsupported.oldBrowser')}
				</p>
			</div>
		</div>
	);
}
