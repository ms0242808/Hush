// SPDX-License-Identifier: Apache-2.0
import { pickModel, pickVariant, type Backend, type Orientation } from '@hush/core';
import { Check, Download, ImagePlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CapabilityNotice } from '@/components/capability-notice';
import { CompareView, type CompareImages } from '@/components/compare-view';
import { DropZone } from '@/components/drop-zone';
import { LanguageSwitch } from '@/components/language-switch';
import { PrivacyNote } from '@/components/privacy-note';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Wordmark } from '@/components/wordmark';
import { detectCapabilities, type Capabilities } from '@/lib/capabilities';
import { isSaveData, modelOverride } from '@/lib/defaults';
import { sniffFile } from '@/lib/formats';
import { storedCropSize } from '@/lib/orientation';
import { useFilePicker, useWindowDrop } from '@/lib/photo-input';
import { proxy, startPipeline, type PipelineHandle } from '@/lib/pipeline';
import { formatMegabytes, formatSeconds } from '@/lib/utils';
import { describeError, isCancelled, isRetryable } from './errors';

type Working =
	| { step: 'opening' }
	| { step: 'model'; received: number; total: number; firstTime: boolean }
	| { step: 'denoise'; done: number; total: number; fraction: number };

type Stage =
	| { kind: 'empty'; message?: string }
	| { kind: 'confirm'; file: File; bytes: number }
	| { kind: 'working'; file: File; working: Working }
	| {
			kind: 'done';
			file: File;
			width: number;
			height: number;
			ms: number;
			backend: Backend;
			saved: string | null;
			exporting: boolean;
	  }
	| { kind: 'error'; file: File | null; message: string; retry: boolean };

export function App() {
	const { t, i18n } = useTranslation();
	const [stage, setStage] = useState<Stage>({ kind: 'empty' });
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [images, setImages] = useState<CompareImages | null>(null);
	const [showOriginal, setShowOriginal] = useState(false);
	const capabilitiesPromise = useRef<Promise<Capabilities> | null>(null);
	const pipeline = useRef<PipelineHandle | null>(null);
	const run = useRef(0);
	const imageSize = useRef<{ width: number; height: number; orientation: Orientation } | null>(null);
	const locale = i18n.resolvedLanguage ?? 'en';

	useEffect(() => {
		capabilitiesPromise.current ??= detectCapabilities();
		void capabilitiesPromise.current.then(setCapabilities);
		return () => pipeline.current?.terminate();
	}, []);

	const replaceImages = useCallback((next: CompareImages | null) => {
		setImages((previous) => {
			previous?.before.close();
			previous?.after.close();
			return next;
		});
	}, []);

	const process = useCallback(
		async (file: File, confirmed = false) => {
			const id = ++run.current;
			// Once a run has failed, finished or been replaced, nothing it started may touch the
			// screen: a model download still streaming progress must not hide an error.
			let settled = false;
			const live = () => run.current === id && !settled;
			replaceImages(null);
			setShowOriginal(false);
			setStage({ kind: 'working', file, working: { step: 'opening' } });
			try {
				// Not a photo? Say so before downloading anything.
				if (!(await sniffFile(file))) {
					settled = true;
					setStage({ kind: 'error', file, message: t('error.unsupported', { name: file.name }), retry: false });
					return;
				}
				const caps = await (capabilitiesPromise.current ??= detectCapabilities());

				// WebGPU first when the browser has it; the processor if it isn't usable here (§2.10).
				const open = async (backend: Backend, confirmedDownload: boolean): Promise<'confirm' | 'ready' | null> => {
					pipeline.current ??= startPipeline();
					const { api } = pipeline.current;
					const manifest = await api.manifest();
					const model = pickModel(manifest, 'denoise', modelOverride());
					const probe = backend === 'webgpu' ? await api.probe() : null;
					if (backend === 'webgpu' && probe?.webgpu !== 'adapter') return null; // no WebGPU inside workers here
					const variant = pickVariant(model, { backend, shaderF16: probe?.shaderF16 ?? false });
					const cached = await api.isCached(variant.sha256);
					if (!live()) return 'ready';
					if (!cached && !confirmedDownload && isSaveData()) {
						setStage({ kind: 'confirm', file, bytes: variant.bytes });
						return 'confirm';
					}
					if (!cached) {
						setStage({
							kind: 'working',
							file,
							working: { step: 'model', received: 0, total: variant.bytes, firstTime: true },
						});
					}
					const [, opened] = await Promise.all([
						api.prepare(
							{ backend, modelId: model.id },
							proxy((received: number, total: number) => {
								if (live() && !cached) {
									setStage({ kind: 'working', file, working: { step: 'model', received, total, firstTime: true } });
								}
							}),
						),
						api.openFile(file),
					]);
					imageSize.current = { width: opened.width, height: opened.height, orientation: opened.orientation };
					return 'ready';
				};

				let state: 'confirm' | 'ready' | null = null;
				if (caps.assessment.backend === 'webgpu') {
					try {
						state = await open('webgpu', confirmed);
					} catch (error) {
						if (!usableElsewhere(error)) throw error;
						console.warn('WebGPU failed; using the processor instead.', error);
						pipeline.current?.terminate();
						pipeline.current = null;
					}
				}
				state ??= await open('wasm', confirmed);
				if (!live() || state === 'confirm') return;

				setStage({ kind: 'working', file, working: { step: 'denoise', done: 0, total: 0, fraction: 0 } });
				const { api } = pipeline.current!;
				const result = await api.run(
					{},
					proxy((progress: { tilesDone: number; tileCount: number; bandsDone: number; bandCount: number }) => {
						if (!live()) return;
						setStage({
							kind: 'working',
							file,
							working: {
								step: 'denoise',
								done: progress.bandsDone,
								total: progress.bandCount,
								fraction: progress.tilesDone / progress.tileCount,
							},
						});
					}),
				);
				if (!live()) return;
				settled = true;
				setStage({
					kind: 'done',
					file,
					width: result.width,
					height: result.height,
					ms: result.ms,
					backend: result.backend,
					saved: null,
					exporting: false,
				});
			} catch (error) {
				if (!live()) return;
				settled = true;
				if (isCancelled(error)) {
					setStage({ kind: 'empty', message: t('process.cancelled') });
					return;
				}
				console.error(error);
				setStage({ kind: 'error', file, message: describeError(error, t, file.name), retry: isRetryable(error) });
			}
		},
		[replaceImages, t],
	);

	const picker = useFilePicker((file) => void process(file));
	const acceptingFiles = stage.kind !== 'working';
	const over = useWindowDrop((file) => void process(file), acceptingFiles);

	const requestCrop = useCallback(
		async (device: { width: number; height: number }) => {
			const size = imageSize.current;
			const api = pipeline.current?.api;
			if (!size || !api) return;
			const { width, height } = storedCropSize(device, size, size.orientation);
			try {
				const crop = await api.crop({ x: (size.width - width) / 2, y: (size.height - height) / 2, width, height });
				if (crop.after) replaceImages({ before: crop.before, after: crop.after, orientation: crop.orientation });
				else crop.before.close();
			} catch (error) {
				console.error(error);
				setStage((current) =>
					current.kind === 'done'
						? {
								kind: 'error',
								file: current.file,
								message: describeError(error, t, current.file.name),
								retry: isRetryable(error),
							}
						: current,
				);
			}
		},
		[replaceImages, t],
	);

	const exportPhoto = useCallback(async () => {
		if (stage.kind !== 'done' || stage.exporting || !pipeline.current) return;
		const done = stage;
		setStage({ ...done, exporting: true });
		try {
			const { bytes, name, mimeType } = await pipeline.current.api.exportPhoto();
			const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }));
			const link = document.createElement('a');
			link.href = url;
			link.download = name;
			link.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
			setStage({ ...done, exporting: false, saved: name });
		} catch (error) {
			setStage({
				kind: 'error',
				file: done.file,
				message: describeError(error, t, done.file.name),
				retry: isRetryable(error),
			});
		}
	}, [stage, t]);

	// Keyboard (§5.8). None of these animate: they are repeated too often.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const command = event.metaKey || event.ctrlKey;
			if (command && event.key.toLowerCase() === 'o') {
				event.preventDefault();
				if (stage.kind !== 'working') picker.open();
			} else if (command && event.key.toLowerCase() === 'e' && stage.kind === 'done') {
				event.preventDefault();
				void exportPhoto();
			} else if (event.key === '\\' && stage.kind === 'done' && !command) {
				event.preventDefault();
				setShowOriginal((value) => !value);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [exportPhoto, picker, stage.kind]);

	return (
		<div className="flex h-dvh flex-col">
			<header className="flex h-14 shrink-0 items-center justify-between px-4 sm:px-6">
				<Wordmark />
				<LanguageSwitch />
			</header>

			<main className="flex min-h-0 flex-1 flex-col items-center gap-3 px-4 sm:px-6">
				{stage.kind === 'empty' && (
					<>
						{capabilities && <CapabilityNotice assessment={capabilities.assessment} />}
						<div className="flex w-full flex-1 flex-col">
							<DropZone over={over} onChoose={picker.open} />
						</div>
						{stage.message && (
							<p role="status" className="enter-up text-[13px] text-fg-muted">
								{stage.message}
							</p>
						)}
						<p className="text-center text-[13px] text-fg-subtle md:hidden">{t('drop.desktopOnly')}</p>
					</>
				)}

				{stage.kind === 'confirm' && (
					<Card>
						<p className="text-[14px] leading-relaxed text-fg">
							{t('model.metered', { size: formatMegabytes(stage.bytes, locale) })}
						</p>
						<div className="flex justify-end gap-2">
							<Button onClick={() => setStage({ kind: 'empty' })}>{t('process.cancel')}</Button>
							<Button variant="primary" onClick={() => void process(stage.file, true)}>
								{t('model.downloadNow')}
							</Button>
						</div>
					</Card>
				)}

				{stage.kind === 'working' && (
					<WorkingCard
						file={stage.file}
						working={stage.working}
						locale={locale}
						onCancel={() => {
							void pipeline.current?.api.cancel();
						}}
					/>
				)}

				{stage.kind === 'done' && (
					<div className="flex w-full min-h-0 flex-1 flex-col gap-3">
						<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-sunken">
							<CompareView
								images={images}
								showOriginal={showOriginal}
								onStageResize={(size) => void requestCrop(size)}
							/>
						</div>
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
							<div className="flex min-w-0 flex-col">
								<span className="truncate text-[14px] font-medium text-fg">{stage.file.name}</span>
								<span className="tabular text-[12px] text-fg-subtle">
									{stage.width} × {stage.height} ·{' '}
									{t('result.time', {
										seconds: formatSeconds(stage.ms, locale),
										backend: t(`backend.${stage.backend}`),
									})}
								</span>
							</div>
							<p className="hidden text-[12px] text-fg-subtle lg:block">{t('result.actualPixels')}</p>
							<div className="flex items-center gap-3">
								{stage.saved ? (
									<span role="status" className="enter-up flex items-center gap-1.5 text-[13px] text-success">
										<Check aria-hidden="true" className="size-4" />
										{t('result.saved', { file: stage.saved })}
									</span>
								) : (
									<span className="text-[13px] text-fg-subtle">{t('result.savingTo')}</span>
								)}
								<Button onClick={picker.open}>
									<ImagePlus aria-hidden="true" />
									{t('result.another')}
								</Button>
								<Button variant="primary" disabled={stage.exporting} onClick={() => void exportPhoto()}>
									<Download aria-hidden="true" />
									{stage.exporting ? t('result.exporting') : t('result.export')}
								</Button>
							</div>
						</div>
					</div>
				)}

				{stage.kind === 'error' && (
					<Card>
						<p role="alert" className="text-[14px] leading-relaxed text-fg">
							{stage.message}
						</p>
						<div className="flex justify-end gap-2">
							{/* Retrying only helps when the photo wasn't the problem. */}
							<Button
								variant={stage.retry && stage.file ? 'secondary' : 'primary'}
								onClick={() => setStage({ kind: 'empty' })}
							>
								{t('result.another')}
							</Button>
							{stage.retry && stage.file && (
								<Button variant="primary" onClick={() => stage.file && void process(stage.file)}>
									{t('error.retry')}
								</Button>
							)}
						</div>
					</Card>
				)}
			</main>

			<footer className="shrink-0 px-4 py-3">
				<PrivacyNote />
			</footer>
			{picker.element}
		</div>
	);
}

/** Failures the processor path would share: the model, the photo, or the user stopping. */
const NOT_THE_GPU = [
	'ModelError',
	'ModelIntegrityError',
	'ManifestError',
	'UnsupportedPhotoError',
	'DecodeError',
	'PhotoTooLargeError',
	'CancelledError',
];

/** A WebGPU failure worth retrying on the processor (§2.10): anything that isn't about the model or the photo. */
function usableElsewhere(error: unknown): boolean {
	return !(error instanceof Error && NOT_THE_GPU.includes(error.name));
}

function Card({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-1 items-center justify-center p-4">
			<div className="enter-up flex w-full max-w-md flex-col gap-5 rounded-2xl border border-line bg-surface p-6 shadow-xl shadow-black/20">
				{children}
			</div>
		</div>
	);
}

function WorkingCard({
	file,
	working,
	locale,
	onCancel,
}: {
	file: File;
	working: Working;
	locale: string;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	let label: string;
	let detail = '';
	let value: number | null = null;
	switch (working.step) {
		case 'opening':
			label = t('process.opening', { name: file.name });
			break;
		case 'model':
			label = t('model.downloading');
			detail = t('model.progress', {
				received: formatMegabytes(working.received, locale),
				total: formatMegabytes(working.total, locale),
			});
			value = working.total > 0 ? working.received / working.total : null;
			break;
		case 'denoise':
			label = t('process.removing');
			detail = working.total > 0 ? t('process.band', { done: working.done, total: working.total }) : '';
			value = working.fraction;
			break;
	}
	return (
		<Card>
			<div className="flex flex-col gap-1">
				<span className="truncate text-[14px] font-medium text-fg">{file.name}</span>
				{working.step === 'model' && working.firstTime && (
					<span className="text-[13px] text-fg-subtle">
						{t('model.size', { size: formatMegabytes(working.total, locale) })}
					</span>
				)}
			</div>
			<div className="flex flex-col gap-2.5">
				<div className="flex items-baseline justify-between gap-4 text-[13px]">
					<span className="text-fg-muted">{label}</span>
					<span className="tabular text-fg-subtle" aria-live="polite">
						{detail}
					</span>
				</div>
				<Progress value={value} label={label} />
			</div>
			<Button className="self-end" onClick={onCancel}>
				{t('process.cancel')}
			</Button>
		</Card>
	);
}
