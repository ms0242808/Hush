// SPDX-License-Identifier: Apache-2.0
import type { Backend, ModelManifest, TiledProgress } from '@hush/core';
import { ArrowLeft, ClipboardCopy, Play, ScanLine, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CompareView, type CompareImages } from '@/components/compare-view';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Segmented } from '@/components/ui/segmented';
import { Mark } from '@/components/wordmark';
import { DEFAULT_TILE_SIZE } from '@/lib/defaults';
import { proxy, startPipeline, type PipelineHandle } from '@/lib/pipeline';
import { cn } from '@/lib/utils';
import type { OpenResult } from '@/worker/pipeline.worker';
import { loadEnvironment } from './environment';
import {
	describeAdapter,
	toMarkdown,
	verdictFor,
	type BenchConfig,
	type BenchEnvironment,
	type BenchRow,
	type ImageChoice,
} from './report';

const TILE_SIZES = [256, 384, 512, 768, 1024];

const params = new URLSearchParams(window.location.search);
const ortLog = ((value) => (value === 'verbose' || value === 'info' || value === 'warning' ? value : null))(
	params.get('ortLog'),
);
/** `?ep=key:value,…` passes WebGPU execution-provider options, for A/B experiments. */
const webgpuOptions = Object.fromEntries(
	(params.get('ep') ?? '')
		.split(',')
		.filter(Boolean)
		.map((pair) => pair.split(':') as [string, string]),
);

interface Status {
	text: string;
	value: number | null;
}

interface BenchApi {
	ready: Promise<void>;
	run: (config: Partial<BenchConfig>, repeat?: number) => Promise<BenchRow[]>;
	seam: (config: Partial<BenchConfig>, size?: number) => Promise<BenchRow>;
	environment: () => BenchEnvironment;
	rows: () => BenchRow[];
	markdown: () => string;
}

declare global {
	interface Window {
		__hushBench?: BenchApi;
	}
}

function initialConfig(): BenchConfig {
	const params = new URLSearchParams(window.location.search);
	const backend = params.get('backend') === 'wasm' ? 'wasm' : 'webgpu';
	const precision = params.get('precision');
	const image = params.get('image');
	return {
		backend,
		modelId: params.get('model') ?? '',
		precision: precision === 'fp16' || precision === 'fp32' || precision === 'int8' ? precision : 'auto',
		tileSize: Number(params.get('tile')) || DEFAULT_TILE_SIZE[backend],
		image: image === '24mp' || image === '45mp' || image === 'file' ? image : '1mp',
		machine: backend === 'wasm' ? 'cpu' : 'integrated',
		threads: Number(params.get('threads')) || null,
	};
}

export function BenchApp() {
	const [config, setConfig] = useState<BenchConfig>(initialConfig);
	const [environment, setEnvironment] = useState<BenchEnvironment | null>(null);
	const [manifest, setManifest] = useState<ModelManifest | null>(null);
	const [rows, setRows] = useState<BenchRow[]>([]);
	const [status, setStatus] = useState<Status | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [file, setFile] = useState<File | null>(null);
	const [images, setImages] = useState<CompareImages | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	const handles = useRef<Partial<Record<Backend, PipelineHandle>>>({});
	const opened = useRef<Partial<Record<Backend, { key: string; open: OpenResult }>>>({});
	const lastSize = useRef<{ width: number; height: number } | null>(null);
	const warmth = useRef(new Map<string, number>());
	const rowsRef = useRef<BenchRow[]>([]);
	const environmentRef = useRef<BenchEnvironment | null>(null);
	const nextId = useRef(1);
	const stageSize = useRef({ width: 1024, height: 640 });
	const lastBackend = useRef<Backend | null>(null);

	const pipelineFor = useCallback((backend: Backend): PipelineHandle => {
		// One runtime per worker: switching backend replaces the other worker and frees its memory.
		for (const other of ['webgpu', 'wasm'] as const) {
			if (other !== backend && handles.current[other]) {
				handles.current[other]?.terminate();
				delete handles.current[other];
				delete opened.current[other];
				for (const key of warmth.current.keys()) if (key.startsWith(other)) warmth.current.delete(key);
			}
		}
		handles.current[backend] ??= startPipeline();
		return handles.current[backend];
	}, []);

	// Environment: what the main thread and a worker each see.
	useEffect(() => {
		let live = true;
		loadEnvironment().then(
			({ environment: env, manifest: loaded }) => {
				if (!live) return;
				environmentRef.current = env;
				setEnvironment(env);
				setManifest(loaded);
				if (loaded) {
					setConfig((current) => ({
						...current,
						modelId: current.modelId || loaded.active['denoise'] || loaded.models[0]!.id,
						backend: current.backend === 'webgpu' && env.worker?.webgpu !== 'adapter' ? 'wasm' : current.backend,
					}));
				}
			},
			(reason: unknown) => {
				if (live) setError(reason instanceof Error ? reason.message : String(reason));
			},
		);
		const workers = handles.current;
		return () => {
			live = false;
			for (const handle of Object.values(workers)) handle?.terminate();
		};
	}, []);

	const addRow = useCallback((row: BenchRow) => {
		rowsRef.current = [...rowsRef.current, row];
		setRows(rowsRef.current);
	}, []);

	const prepareAndOpen = useCallback(
		async (cfg: BenchConfig) => {
			const { api } = pipelineFor(cfg.backend);
			setStatus({ text: 'Loading runtime and model', value: null });
			const prepared = await api.prepare(
				{
					backend: cfg.backend,
					modelId: cfg.modelId || null,
					...(cfg.precision !== 'auto' && { precision: cfg.precision }),
					...(cfg.threads && { threads: cfg.threads }),
					...(ortLog && { logLevel: ortLog }),
					...(Object.keys(webgpuOptions).length > 0 && { webgpuOptions }),
				},
				proxy((received: number, total: number) =>
					setStatus({
						text: `Downloading model · ${(received / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`,
						value: received / total,
					}),
				),
			);
			const sourceKey = cfg.image === 'file' ? `file:${file?.name ?? ''}:${file?.size ?? 0}` : cfg.image;
			const cached = opened.current[cfg.backend];
			let open: OpenResult;
			if (cached?.key === sourceKey) {
				open = { ...cached.open, openMs: 0 }; // already open in this worker
			} else {
				setStatus({
					text: cfg.image === 'file' ? 'Decoding photo' : `Generating ${cfg.image} test photo`,
					value: null,
				});
				if (cfg.image === 'file') {
					if (!file) throw new Error('Choose a photo first');
					open = await api.openFile(file);
				} else {
					open = await api.openSynthetic(cfg.image);
				}
				opened.current[cfg.backend] = { key: sourceKey, open };
			}
			return { api, prepared, open };
		},
		[file, pipelineFor],
	);

	/** Show the centre of the last result at 100%: a stage-sized crop, never the whole photo. */
	const showPreview = useCallback(async (backend: Backend) => {
		const api = handles.current[backend]?.api;
		const size = lastSize.current;
		if (!api || !size) return;
		try {
			const width = Math.min(stageSize.current.width, size.width);
			const height = Math.min(stageSize.current.height, size.height);
			const crop = await api.crop({ x: (size.width - width) / 2, y: (size.height - height) / 2, width, height });
			lastBackend.current = backend;
			setImages((previous) => {
				previous?.before.close();
				previous?.after.close();
				return crop.after ? { before: crop.before, after: crop.after } : null;
			});
		} catch (reason) {
			setError(`Preview: ${reason instanceof Error ? reason.message : String(reason)}`);
		}
	}, []);

	const run = useCallback(
		async (partial: Partial<BenchConfig> = {}, repeat = 1): Promise<BenchRow[]> => {
			await loadEnvironment();
			const cfg = { ...config, ...partial };
			const produced: BenchRow[] = [];
			const { api, prepared, open } = await prepareAndOpen(cfg);
			// Tile shapes depend on the photo as well as the ceiling; a new shape means new GPU pipelines.
			const key = `${cfg.backend}|${prepared.modelId}|${prepared.precision}|${cfg.tileSize}|${cfg.image}`;
			for (let i = 0; i < repeat; i++) {
				const warm = warmth.current.get(key) ?? 0;
				setStatus({ text: `Removing noise (${warm === 0 ? 'cold' : `warm ${warm}`})`, value: 0 });
				const result = await api.run(
					{ tileSize: cfg.tileSize },
					proxy((p: TiledProgress) =>
						setStatus({
							text: `Tile ${p.tilesDone} of ${p.tileCount} · band ${p.bandsDone} of ${p.bandCount}`,
							value: p.tilesDone / p.tileCount,
						}),
					),
				);
				warmth.current.set(key, warm + 1);
				lastSize.current = { width: result.width, height: result.height };
				const row: BenchRow = {
					id: nextId.current++,
					kind: 'run',
					config: cfg,
					prepare: prepared,
					open,
					run: result,
					warm,
				};
				const verdict = verdictFor(row);
				if (verdict) row.verdict = verdict;
				addRow(row);
				produced.push(row);
			}
			await showPreview(cfg.backend);
			setStatus(null);
			return produced;
		},
		[addRow, config, prepareAndOpen, showPreview],
	);

	const seam = useCallback(
		async (partial: Partial<BenchConfig> = {}, size = 1024): Promise<BenchRow> => {
			await loadEnvironment();
			const cfg = { ...config, ...partial };
			const { api, prepared, open } = await prepareAndOpen(cfg);
			setStatus({ text: `Seam check: ${size}² crop, whole vs ${cfg.tileSize}-px tiles`, value: null });
			const result = await api.seamCheck(cfg.tileSize, size);
			const row: BenchRow = {
				id: nextId.current++,
				kind: 'seam',
				config: cfg,
				prepare: prepared,
				open,
				seam: result,
				warm: 0,
			};
			addRow(row);
			setStatus(null);
			return row;
		},
		[addRow, config, prepareAndOpen],
	);

	const guarded = useCallback(async (task: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await task();
			setStatus(null);
		} catch (reason) {
			const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
			setError(message);
			setStatus(null);
		} finally {
			setBusy(false);
		}
	}, []);

	const suite = useCallback(async () => {
		if (config.backend === 'webgpu') {
			await run({ image: '1mp' }, 3);
			await run({ image: '24mp' }, 2);
			await run({ image: '45mp' }, 2);
			await seam({ image: '24mp' });
		} else {
			await run({ image: '1mp' }, 2);
			await seam({ image: '1mp' }, 512);
		}
	}, [config.backend, run, seam]);

	// The same API, for scripted measurement runs (tools/bench/measure.ts).
	useEffect(() => {
		window.__hushBench = {
			ready: loadEnvironment().then(({ environment: env }) => {
				environmentRef.current = env;
			}),
			run,
			seam,
			environment: () => environmentRef.current!,
			rows: () => rowsRef.current,
			markdown: () => toMarkdown(environmentRef.current!, rowsRef.current),
		};
	}, [run, seam]);

	const copy = async (kind: 'markdown' | 'json') => {
		if (!environment) return;
		const text =
			kind === 'markdown' ? toMarkdown(environment, rows) : JSON.stringify({ environment, rows }, null, '\t');
		try {
			await navigator.clipboard.writeText(text);
			setCopied(kind);
			window.setTimeout(() => setCopied(null), 1600);
		} catch {
			setError('The browser blocked clipboard access. Use the JSON download below instead.');
		}
	};

	const models = manifest?.models ?? [];
	const model = models.find((m) => m.id === config.modelId);
	const precisions = (['auto', 'fp16', 'fp32', 'int8'] as const).map((p) => ({
		value: p,
		label: p,
		disabled: p !== 'auto' && !model?.variants.some((v) => v.precision === p && v.backends.includes(config.backend)),
	}));
	const set = <K extends keyof BenchConfig>(key: K, value: BenchConfig[K]) =>
		setConfig((current) => ({ ...current, [key]: value }));
	const workerHasGpu = environment?.worker?.webgpu === 'adapter';

	return (
		<div className="min-h-dvh">
			<header className="flex h-14 items-center justify-between border-b border-line px-4 sm:px-6">
				<div className="flex items-center gap-3">
					<Mark className="size-7" />
					<h1 className="text-[15px] font-semibold tracking-[-0.01em]">Hush benchmark</h1>
					<span className="rounded-md bg-raised px-1.5 py-0.5 text-[11px] font-medium text-fg-subtle">Phase 0</span>
				</div>
				<Button variant="ghost" size="sm" asChild>
					<a href="/">
						<ArrowLeft aria-hidden="true" />
						Back to Hush
					</a>
				</Button>
			</header>

			<main className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[340px_minmax(0,1fr)]">
				<aside className="flex flex-col gap-4">
					<Panel title="This browser">
						{environment ? (
							<dl
								data-testid="bench-environment"
								className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]"
							>
								<Fact label="Browser" value={environment.brands || environment.userAgent} />
								<Fact label="GPU (main)" value={describeAdapter(environment.main?.probe)} />
								<Fact label="GPU (worker)" value={describeAdapter(environment.worker)} testId="worker-webgpu" />
								<Fact label="shader-f16" value={environment.worker?.shaderF16 ? 'yes' : 'no'} />
								<Fact label="WebGL" value={environment.main?.facts.webglRenderer ?? 'unavailable'} />
								<Fact
									label="Situation"
									value={`${environment.main?.assessment.situation} → ${environment.main?.assessment.notice}`}
									testId="situation"
								/>
								<Fact label="Cores" value={String(environment.worker?.hardwareConcurrency ?? '?')} />
								<Fact
									label="Memory"
									value={environment.worker?.deviceMemory ? `≥ ${environment.worker.deviceMemory} GB` : 'not reported'}
								/>
								<Fact
									label="Isolated"
									value={environment.worker?.crossOriginIsolated ? 'yes (threads on)' : 'no (single thread)'}
									testId="isolated"
								/>
								<Fact
									label="ORT"
									value={`${environment.ort.version} · WASM ${(environment.ort.webgpuWasmBytes / 1e6).toFixed(1)} / ${(environment.ort.wasmWasmBytes / 1e6).toFixed(1)} MB`}
								/>
							</dl>
						) : (
							<p className="text-[12px] text-fg-subtle">Detecting…</p>
						)}
					</Panel>

					<Panel title="Configuration">
						<div className="flex flex-col gap-3">
							<Segmented
								label="Backend"
								value={config.backend}
								testId="backend"
								onChange={(backend) =>
									setConfig((c) => ({
										...c,
										backend,
										machine: backend === 'wasm' ? 'cpu' : c.machine === 'cpu' ? 'integrated' : c.machine,
									}))
								}
								options={[
									{ value: 'webgpu', label: 'Graphics chip', disabled: !workerHasGpu },
									{ value: 'wasm', label: 'Processor' },
								]}
								disabled={busy}
							/>
							<Segmented
								label="Model"
								value={config.modelId}
								onChange={(id) => set('modelId', id)}
								options={models.map((m) => ({ value: m.id, label: m.id.replace(/^nafnet-sidd-/, 'NAFNet ') }))}
								disabled={busy}
							/>
							<Segmented
								label="Precision"
								value={config.precision}
								onChange={(p) => set('precision', p)}
								options={precisions}
								disabled={busy}
							/>
							<Segmented
								label="Tile size (px)"
								value={config.tileSize}
								onChange={(size) => set('tileSize', size)}
								options={TILE_SIZES.map((size) => ({ value: size, label: String(size) }))}
								disabled={busy}
							/>
							<Segmented<ImageChoice>
								label="Photo"
								value={config.image}
								onChange={(image) => set('image', image)}
								options={[
									{ value: '1mp', label: '1 MP' },
									{ value: '24mp', label: '24 MP' },
									{ value: '45mp', label: '45 MP' },
									{ value: 'file', label: 'Your photo' },
								]}
								disabled={busy}
							/>
							{config.image === 'file' && (
								<input
									type="file"
									accept="image/jpeg,image/png,image/webp"
									aria-label="Photo to benchmark"
									className="text-[12px] text-fg-muted file:mr-3 file:rounded-md file:border-0 file:bg-raised file:px-2.5 file:py-1.5 file:text-fg"
									onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
								/>
							)}
							<Segmented
								label="Compare against (§4.6)"
								value={config.machine}
								onChange={(machine) => set('machine', machine)}
								options={[
									{ value: 'integrated', label: 'Integrated GPU', disabled: config.backend === 'wasm' },
									{ value: 'strong', label: 'Strong machine', disabled: config.backend === 'wasm' },
									{ value: 'cpu', label: 'CPU only', disabled: config.backend === 'webgpu' },
								]}
								disabled={busy}
							/>
						</div>
					</Panel>

					<div className="flex flex-wrap gap-2">
						<Button
							variant="primary"
							disabled={busy || !manifest}
							onClick={() => void guarded(() => run())}
							data-testid="bench-run"
						>
							<Play aria-hidden="true" />
							Run
						</Button>
						<Button disabled={busy || !manifest} onClick={() => void guarded(suite)}>
							Run standard suite
						</Button>
						<Button disabled={busy || !manifest} onClick={() => void guarded(() => seam())}>
							<ScanLine aria-hidden="true" />
							Seam check
						</Button>
						{busy && (
							<Button variant="ghost" onClick={() => void handles.current[config.backend]?.api.cancel()}>
								<Square aria-hidden="true" />
								Cancel
							</Button>
						)}
					</div>
				</aside>

				<section className="flex min-w-0 flex-col gap-4">
					<Panel title="Results">
						<div className="flex flex-col gap-3">
							<div className="min-h-9" aria-live="polite">
								{status && (
									<div className="flex flex-col gap-2">
										<span className="tabular text-[12px] text-fg-muted">{status.text}</span>
										<Progress value={status.value} label={status.text} />
									</div>
								)}
								{error && (
									<p role="alert" className="text-[12px] text-danger">
										{error}
									</p>
								)}
								{!status && !error && rows.length === 0 && (
									<p className="text-[12px] text-fg-subtle">
										Run the standard suite, then copy the results into docs/phase-0-results.md. Synthetic photos measure
										speed as well as real ones: throughput doesn't depend on what's in the picture.
									</p>
								)}
							</div>
							{rows.length > 0 && <ResultsTable rows={rows} />}
							<div className="flex flex-wrap gap-2">
								<Button size="sm" disabled={rows.length === 0} onClick={() => void copy('markdown')}>
									<ClipboardCopy aria-hidden="true" />
									{copied === 'markdown' ? 'Copied' : 'Copy as Markdown'}
								</Button>
								<Button size="sm" disabled={rows.length === 0} onClick={() => void copy('json')}>
									<ClipboardCopy aria-hidden="true" />
									{copied === 'json' ? 'Copied' : 'Copy as JSON'}
								</Button>
							</div>
						</div>
					</Panel>

					<Panel title="Last result at 100%">
						<div className="relative flex h-[min(60vh,560px)] flex-col overflow-hidden rounded-lg bg-sunken">
							{!images && (
								<p className="absolute inset-0 flex items-center justify-center text-[12px] text-fg-subtle">
									Run a photo to compare it here, one photo pixel per screen pixel.
								</p>
							)}
							<CompareView
								images={images}
								showOriginal={false}
								onStageResize={(size) => {
									stageSize.current = size;
									if (lastBackend.current) void showPreview(lastBackend.current);
								}}
							/>
						</div>
					</Panel>
				</section>
			</main>
		</div>
	);
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
			<h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">{title}</h2>
			{children}
		</section>
	);
}

function Fact({ label, value, testId }: { label: string; value: string; testId?: string }) {
	return (
		<>
			<dt className="text-fg-subtle">{label}</dt>
			<dd data-testid={testId} className="min-w-0 break-words text-fg-muted">
				{value}
			</dd>
		</>
	);
}

const VERDICT_STYLE = {
	go: 'text-success',
	borderline: 'text-warning',
	'no-go': 'text-danger',
} as const;

function ResultsTable({ rows }: { rows: BenchRow[] }) {
	return (
		<div className="overflow-x-auto rounded-lg border border-line">
			<table data-testid="bench-results" className="tabular w-full text-left text-[12px]">
				<thead className="bg-raised/50 text-fg-subtle">
					<tr>
						{['Backend', 'Model', 'Prec.', 'Photo', 'Tile', 'Run', 'Time', 'MP/s', 'First tile', 'Band', 'Verdict'].map(
							(h) => (
								<th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
									{h}
								</th>
							),
						)}
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id} className="border-t border-line text-fg-muted">
							<td className="px-3 py-2">{row.config.backend}</td>
							<td className="whitespace-nowrap px-3 py-2">{row.prepare.modelId}</td>
							<td className="px-3 py-2">{row.prepare.precision}</td>
							{row.kind === 'seam' && row.seam ? (
								<>
									<td className="whitespace-nowrap px-3 py-2">seam {row.seam.size}²</td>
									<td className="px-3 py-2">{row.seam.tileSize}</td>
									<td className="px-3 py-2" colSpan={6}>
										tiled vs whole: {row.seam.psnr.toFixed(1)} dB · max diff {row.seam.maxDiff}
									</td>
								</>
							) : row.run ? (
								<>
									<td className="whitespace-nowrap px-3 py-2">
										{row.run.width}×{row.run.height}
									</td>
									<td className="px-3 py-2">{row.run.tileSize}</td>
									<td className="px-3 py-2">{row.warm === 0 ? 'cold' : `warm ${row.warm}`}</td>
									<td className="px-3 py-2 text-fg">{(row.run.ms / 1000).toFixed(2)} s</td>
									<td className="px-3 py-2 text-fg">{row.run.mpPerSecond.toFixed(2)}</td>
									<td className="px-3 py-2">{(row.run.stats.firstTileMs / 1000).toFixed(2)} s</td>
									<td className="px-3 py-2">{(row.run.stats.bandFloatBytes / 1048576).toFixed(0)} MiB</td>
									<td className={cn('px-3 py-2 font-medium', row.verdict && VERDICT_STYLE[row.verdict])}>
										{row.verdict}
									</td>
								</>
							) : (
								<td className="px-3 py-2" colSpan={8}>
									{row.error}
								</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
