// SPDX-License-Identifier: Apache-2.0
import { parseManifest, pickModel, type ModelEntry } from '@hush/core';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SOURCE_URL } from '@/components/privacy-note';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { COMMAND_KEY } from '@/lib/keys';
import { Modal } from '@/components/ui/modal';
import { useBatch } from '@/batch/store';
import { useEditor } from '@/editor/store';
import type { Capabilities } from '@/lib/capabilities';
import { modelOverride } from '@/lib/defaults';
import { browserName, diagnosticsText, platformName, type Diagnostics } from '@/lib/diagnostics';
import { formatMegabytes } from '@/lib/utils';

export type DialogName = 'about' | 'shortcuts';

export default function Dialogs({
	which,
	onClose,
	capabilities,
}: {
	which: DialogName;
	onClose: () => void;
	capabilities: Capabilities | null;
}) {
	return which === 'about' ? (
		<AboutDialog onClose={onClose} capabilities={capabilities} />
	) : (
		<ShortcutsDialog onClose={onClose} />
	);
}

/** The model this build ships, from the editor when it has loaded one, else from the manifest. */
function useModel(): { entry: ModelEntry | null; precision: string | null; bytes: number | null } {
	const info = useEditor((state) => state.modelInfo);
	const [entry, setEntry] = useState<ModelEntry | null>(null);
	useEffect(() => {
		if (info) return;
		let live = true;
		void fetch('/models/manifest.json', { cache: 'no-cache' })
			.then((response) => (response.ok ? response.json() : null))
			.then((json: unknown) => {
				if (live && json) setEntry(pickModel(parseManifest(json), 'denoise', modelOverride()));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [info]);
	if (info) {
		return {
			entry: {
				id: info.id,
				label: info.label,
				licence: info.licence,
				source: info.source,
			} as ModelEntry,
			precision: info.precision,
			bytes: info.bytes,
		};
	}
	return { entry, precision: null, bytes: null };
}

/** The batch on screen, counted (§4.7: no names). */
function batchDiagnostics(): Diagnostics['batch'] {
	const batch = useBatch.getState();
	if (!batch.active) return undefined;
	const count = (status: string) => batch.photos.filter((p) => p.status === status).length;
	const saved = count('saved');
	return {
		photos: batch.photos.length,
		megapixels: batch.photos.reduce((sum, p) => sum + (p.facts ? (p.facts.width * p.facts.height) / 1e6 : 0), 0),
		destination: batch.destination?.kind ?? 'none',
		saved,
		failed: count('failed') + batch.photos.filter((p) => p.refused).length,
		skipped: count('skipped'),
		secondsPerPhoto: batch.run && batch.run.saved > 0 ? batch.run.activeMs / batch.run.saved / 1000 : null,
	};
}

function collect(capabilities: Capabilities | null, language: string): Diagnostics {
	const state = useEditor.getState();
	const batch = batchDiagnostics();
	const probe = capabilities?.probe ?? null;
	const adapter = probe?.adapter
		? [probe.adapter.vendor, probe.adapter.architecture, probe.adapter.description].filter(Boolean).join(' · ') ||
			'details hidden'
		: (probe?.webgpu ?? 'unknown');
	const photo = state.photo;
	return {
		version: __HUSH_VERSION__,
		browser: browserName(),
		platform: platformName(),
		language,
		situation: capabilities?.assessment.situation ?? 'unknown',
		adapter,
		shaderF16: probe ? probe.shaderF16 : null,
		webglRenderer: capabilities?.facts.webglRenderer ?? null,
		crossOriginIsolated: globalThis.crossOriginIsolated === true,
		cores: navigator.hardwareConcurrency || 1,
		deviceMemory: probe?.deviceMemory ?? null,
		processing: {
			setting: state.processing,
			backend: state.backend,
			model: state.modelInfo?.id ?? null,
			precision: state.modelInfo?.precision ?? null,
			threads: state.modelInfo?.threads ?? null,
			exportTile: state.previewInfo?.exportTileSize ?? null,
			previewTile: state.previewInfo?.tileSize ?? null,
			modelFromCache: state.modelInfo?.fromCache ?? null,
		},
		photo: photo
			? {
					format: photo.format,
					megapixels: photo.megapixels,
					bitDepth: photo.bitDepth,
					colour: photo.colour,
					orientation: photo.orientation,
				}
			: null,
		...(batch && { batch }),
		timings: Object.entries(state.timings)
			.filter(([label]) => label !== 'tile ceiling')
			.map(([label, ms]) => ({ label, ms })),
		errors: state.errors,
	};
}

/** §5.3: version, model name, model and code licences, source; and Copy diagnostics (§4.7). */
function AboutDialog({ onClose, capabilities }: { onClose: () => void; capabilities: Capabilities | null }) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? 'en';
	const { entry, precision, bytes } = useModel();
	const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle');
	const [manual, setManual] = useState('');

	useEffect(() => {
		if (copied !== 'copied') return;
		const timer = window.setTimeout(() => setCopied('idle'), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);

	const copy = async () => {
		const text = diagnosticsText(collect(capabilities, language));
		try {
			await navigator.clipboard.writeText(text);
			setCopied('copied');
		} catch {
			setManual(text); // clipboard blocked: show it to copy by hand
			setCopied('manual');
		}
	};

	const label = entry ? (entry.label[language] ?? entry.label['en'] ?? entry.id) : null;
	return (
		<Modal open onClose={onClose} title={t('about.title')} testId="about">
			<div className="flex flex-col gap-1">
				<p className="text-[14px] font-medium text-fg">
					{t('about.name')} <span className="tabular font-normal text-fg-subtle">{__HUSH_VERSION__}</span>
				</p>
				<p className="text-[13px] leading-relaxed text-fg-muted">{t('about.what')}</p>
			</div>

			<section className="flex flex-col gap-2 border-t border-line pt-4" aria-labelledby="about-model">
				<h3 id="about-model" className="text-[12px] font-medium text-fg-subtle">
					{t('about.model')}
				</h3>
				{entry ? (
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
						<dt className="text-fg-subtle">{t('about.modelName')}</dt>
						<dd className="text-fg" data-testid="about-model-name">
							{label}
							{precision && <span className="text-fg-subtle"> · {precision}</span>}
							{bytes && <span className="text-fg-subtle"> · {formatMegabytes(bytes, language)}</span>}
						</dd>
						<dt className="text-fg-subtle">{t('about.code')}</dt>
						<dd className="text-fg-muted">{entry.licence.code}</dd>
						<dt className="text-fg-subtle">{t('about.weights')}</dt>
						<dd className="text-fg-muted">{entry.licence.weights}</dd>
						<dt className="text-fg-subtle">{t('about.data')}</dt>
						<dd className="text-fg-muted">{entry.licence.trainingData}</dd>
					</dl>
				) : (
					<p className="text-[13px] text-fg-subtle">{t('about.modelLoading')}</p>
				)}
			</section>

			<section className="flex flex-col gap-2 border-t border-line pt-4" aria-labelledby="about-hush">
				<h3 id="about-hush" className="text-[12px] font-medium text-fg-subtle">
					{t('about.licence')}
				</h3>
				<p className="text-[13px] text-fg-muted">{t('about.licenceText')}</p>
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					<a href={SOURCE_URL} target="_blank" rel="noreferrer" className="about-link">
						{t('privacy.source')}
						<ExternalLink aria-hidden="true" className="size-3.5" />
					</a>
					<a
						href={`${SOURCE_URL}/blob/main/THIRD_PARTY_NOTICES.md`}
						target="_blank"
						rel="noreferrer"
						className="about-link"
					>
						{t('about.notices')}
						<ExternalLink aria-hidden="true" className="size-3.5" />
					</a>
				</div>
			</section>

			<section className="flex flex-col gap-2.5 border-t border-line pt-4" aria-labelledby="about-bugs">
				<h3 id="about-bugs" className="text-[12px] font-medium text-fg-subtle">
					{t('about.bugs')}
				</h3>
				<p className="text-[13px] leading-relaxed text-fg-muted">{t('about.diagnosticsText')}</p>
				<Button className="self-start" onClick={() => void copy()} data-testid="copy-diagnostics">
					<span className="grid [&>*]:col-start-1 [&>*]:row-start-1">
						<span
							className="flex items-center gap-2 transition-[opacity,filter] duration-200 ease-out"
							style={{ opacity: copied === 'copied' ? 0 : 1, filter: copied === 'copied' ? 'blur(2px)' : 'none' }}
						>
							<Copy aria-hidden="true" />
							{t('about.copy')}
						</span>
						<span
							aria-hidden={copied !== 'copied'}
							className="flex items-center justify-center gap-2 transition-[opacity,filter] duration-200 ease-out"
							style={{ opacity: copied === 'copied' ? 1 : 0, filter: copied === 'copied' ? 'none' : 'blur(2px)' }}
						>
							<Check aria-hidden="true" />
							{t('about.copied')}
						</span>
					</span>
				</Button>
				<span className="sr-only" role="status">
					{copied === 'copied' ? t('about.copied') : ''}
				</span>
				{copied === 'manual' && (
					<textarea
						readOnly
						value={manual}
						rows={8}
						aria-label={t('about.copyManually')}
						onFocus={(event) => event.currentTarget.select()}
						className="w-full rounded-lg border border-line-strong bg-sunken p-2 font-mono text-[11px] text-fg-muted"
					/>
				)}
			</section>
		</Modal>
	);
}

const SHORTCUTS: { keys: string[]; label: string }[] = [
	{ keys: ['\\'], label: 'shortcuts.original' },
	{ keys: ['shortcuts.holdKey'], label: 'shortcuts.hold' },
	{ keys: ['Z'], label: 'shortcuts.zoom' },
	{ keys: ['shortcuts.spaceKey', 'shortcuts.dragKey'], label: 'shortcuts.pan' },
	{ keys: ['←', '↑', '→', '↓'], label: 'shortcuts.arrows' },
	{ keys: ['←', '→'], label: 'shortcuts.step' },
	{ keys: [COMMAND_KEY, 'O'], label: 'shortcuts.open' },
	{ keys: [COMMAND_KEY, 'E'], label: 'shortcuts.export' },
	{ keys: [COMMAND_KEY, 'Z'], label: 'shortcuts.reset' },
	{ keys: ['?'], label: 'shortcuts.list' },
];

/** §5.8's keys, in one list behind `?`. */
function ShortcutsDialog({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation();
	return (
		<Modal open onClose={onClose} title={t('shortcuts.title')} testId="shortcuts">
			<dl className="flex flex-col">
				{SHORTCUTS.map((shortcut) => (
					<div
						key={shortcut.label}
						className="flex items-center justify-between gap-4 border-t border-line py-2 first:border-t-0"
					>
						<dt className="text-[13px] text-fg-muted">{t(shortcut.label)}</dt>
						<dd className="flex shrink-0 gap-1">
							{shortcut.keys.map((key) => (
								<Kbd key={key}>{key.startsWith('shortcuts.') ? t(key) : key}</Kbd>
							))}
						</dd>
					</div>
				))}
			</dl>
		</Modal>
	);
}
