// SPDX-License-Identifier: Apache-2.0
import { Info, Keyboard, Moon, Sun } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CapabilityNotice } from '@/components/capability-notice';
import { DropZone } from '@/components/drop-zone';
import { LanguageSwitch } from '@/components/language-switch';
import { PrivacyNote } from '@/components/privacy-note';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Wordmark } from '@/components/wordmark';
import { detectCapabilities, type Capabilities } from '@/lib/capabilities';
import { useFilePicker, useWindowDrop } from '@/lib/photo-input';
import { loadTheme, saveTheme, type Theme } from '@/lib/settings';
import { checkSupport } from '@/lib/support';
import type { DialogName } from './Dialogs';

// The first paint is the drop zone (§5.10: initial JS ≤ 150 KB). The editor, its
// renderer and the UI kit load when a photo is chosen — or earlier, when the page is idle.
const loadEditor = () => import('@/editor/Editor');
const Editor = lazy(loadEditor);
const Dialogs = lazy(() => import('./Dialogs'));

interface OpenRequest {
	file: File;
	id: number;
}

export function App() {
	const { t } = useTranslation();
	const [request, setRequest] = useState<OpenRequest | null>(null);
	const [dialog, setDialog] = useState<DialogName | null>(null);
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [theme, setTheme] = useState<Theme>(loadTheme);
	const [support] = useState(checkSupport);
	const requests = useRef(0);

	useEffect(() => {
		void detectCapabilities().then(setCapabilities);
		// Warm the editor's code while nothing else is happening, so a dropped photo opens at once.
		const warm = () => void loadEditor().catch(() => {});
		if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warm);
		else window.setTimeout(warm, 1200);
	}, []);

	const open = useCallback((file: File) => setRequest({ file, id: ++requests.current }), []);
	const picker = useFilePicker(open);
	const over = useWindowDrop(open, request === null && support.ok);

	// On the drop zone: ⌘/Ctrl+O and ?. The editor handles its own keys.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o' && request === null) {
				event.preventDefault();
				picker.open();
			} else if (event.key === '?' && request === null && !event.metaKey && !event.ctrlKey) {
				event.preventDefault();
				setDialog('shortcuts');
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [picker, request]);

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
				) : request ? (
					<Suspense fallback={<Loading name={request.file.name} />}>
						<Editor
							file={request.file}
							request={request.id}
							onFile={open}
							onPick={picker.open}
							onClose={() => setRequest(null)}
							onShortcuts={() => setDialog('shortcuts')}
						/>
					</Suspense>
				) : (
					<>
						{capabilities && <CapabilityNotice assessment={capabilities.assessment} />}
						<div className="flex w-full flex-1 flex-col">
							<DropZone over={over} onChoose={picker.open} />
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
	return (
		<div
			className="flex w-full flex-1 flex-col items-center justify-center gap-3 rounded-xl bg-viewer p-6"
			role="status"
		>
			<span className="max-w-full truncate text-[14px] text-white/80">{t('process.opening', { name })}</span>
			<Progress value={null} label={t('process.opening', { name })} className="w-48 bg-white/15" />
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
