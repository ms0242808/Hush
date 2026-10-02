// SPDX-License-Identifier: Apache-2.0
import type { OutputSettings, PhotoProgress, PhotoStage } from '@hush/core';
import { Check, Download, FileImage, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Segmented } from '@/components/ui/segmented';
import { ACCEPT } from '@/lib/photo-input';
import { proxy, type Pipeline } from '@/lib/pipeline';
import { cn, formatBytes } from '@/lib/utils';
import type { ProcessResult } from '@/worker/pipeline.worker';
import { summarize, SUMMARY_ROWS, type MetadataSummary } from './metadata';

/**
 * The Phase 1 pipeline, end to end, on a photo of your choice: read the
 * container, decode, remove noise, encode, put the metadata back. The
 * before/after table reads both files with an independent EXIF reader, so it
 * shows what the file really says, not what Hush meant to write.
 */

const STAGES: Array<{ stage: PhotoStage; label: string }> = [
	{ stage: 'reading', label: 'Read' },
	{ stage: 'decoding', label: 'Decode' },
	{ stage: 'processing', label: 'Remove noise' },
	{ stage: 'encoding', label: 'Encode + metadata' },
	{ stage: 'saving', label: 'Save' },
];

const SLIDERS = [
	{ id: 'strength', label: 'Strength', initial: 1 },
	{ id: 'luma', label: 'Luminance', initial: 1 },
	{ id: 'colour', label: 'Colour', initial: 1 },
	{ id: 'detail', label: 'Detail', initial: 0 },
] as const;

type SliderId = (typeof SLIDERS)[number]['id'];

interface Outcome {
	result: ProcessResult;
	before: MetadataSummary;
	after: MetadataSummary;
	url: string;
}

interface PipelineCheckProps {
	/** A prepared pipeline for the bench's current backend and model. */
	prepare: () => Promise<Pipeline>;
	disabled: boolean;
	onBusy: (busy: boolean) => void;
}

export function PipelineCheck({ prepare, disabled, onBusy }: PipelineCheckProps) {
	const [file, setFile] = useState<File | null>(null);
	const [params, setParams] = useState<Record<SliderId, number>>(
		() => Object.fromEntries(SLIDERS.map((s) => [s.id, s.initial])) as Record<SliderId, number>,
	);
	const [format, setFormat] = useState<OutputSettings['format']>('auto');
	const [removeLocation, setRemoveLocation] = useState(false);
	const [progress, setProgress] = useState<PhotoProgress | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	// Revoke the previous download link whenever a new one replaces it.
	useEffect(() => () => void (outcome && URL.revokeObjectURL(outcome.url)), [outcome]);

	const run = useCallback(async () => {
		if (!file) return;
		setRunning(true);
		onBusy(true);
		setError(null);
		setOutcome(null);
		setProgress({ stage: 'reading', fraction: 0 });
		try {
			const api = await prepare();
			const recipe = { schema: 1 as const, ops: [{ op: 'denoise', params: { ...params } }] };
			const result = await api.process(
				file,
				recipe,
				{ format, removeLocation },
				proxy((p: PhotoProgress) => setProgress(p)),
			);
			const [before, after] = await Promise.all([
				summarize(new Uint8Array(await file.arrayBuffer())),
				summarize(result.bytes),
			]);
			const url = URL.createObjectURL(new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: result.mimeType }));
			setOutcome({ result, before: before.summary, after: after.summary, url });
		} catch (reason) {
			setError(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
		} finally {
			setProgress(null);
			setRunning(false);
			onBusy(false);
		}
	}, [file, format, onBusy, params, prepare, removeLocation]);

	const activeIndex = progress ? STAGES.findIndex((s) => s.stage === progress.stage) : -1;
	const stageMs = outcome && stageDurations(outcome.result);

	return (
		<div className="flex flex-col gap-4" data-testid="pipeline-check">
			<p className="max-w-prose text-[12px] leading-relaxed text-fg-subtle">
				Run one photo through the whole pipeline — read, decode, remove noise, encode, restore metadata — and compare
				the file that comes out with the one that went in. Nothing leaves this device.
			</p>

			<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<Button size="sm" onClick={() => input.current?.click()} disabled={running}>
							<FileImage aria-hidden="true" />
							{file ? 'Choose another' : 'Choose photo'}
						</Button>
						<span className="min-w-0 truncate text-[12px] text-fg-muted" data-testid="pipeline-file">
							{file ? `${file.name} · ${formatBytes(file.size, 'en')}` : 'JPEG, PNG, WebP, HEIC or AVIF'}
						</span>
						<input
							ref={input}
							type="file"
							accept={ACCEPT}
							className="sr-only"
							tabIndex={-1}
							aria-label="Photo for the pipeline check"
							onChange={(event) => {
								const chosen = event.currentTarget.files?.[0] ?? null;
								event.currentTarget.value = '';
								if (chosen) setFile(chosen);
							}}
						/>
					</div>
					<Segmented<OutputSettings['format']>
						label="Save as"
						value={format}
						onChange={setFormat}
						disabled={running}
						options={[
							{ value: 'auto', label: 'Same as input' },
							{ value: 'jpeg', label: 'JPEG' },
							{ value: 'png', label: 'PNG' },
							{ value: 'webp', label: 'WebP' },
						]}
					/>
					<label className="flex cursor-pointer select-none items-center gap-2.5 text-[12px] text-fg-muted">
						<input
							type="checkbox"
							checked={removeLocation}
							disabled={running}
							onChange={(event) => setRemoveLocation(event.currentTarget.checked)}
							className="size-3.5 accent-[var(--accent)]"
						/>
						Remove location
					</label>
				</div>

				<div className="grid grid-cols-[auto_minmax(0,1fr)_2.75rem] items-center gap-x-3 gap-y-2">
					{SLIDERS.map((slider) => (
						<label key={slider.id} className="contents text-[12px]">
							<span className="text-fg-subtle">{slider.label}</span>
							<input
								type="range"
								min={0}
								max={1}
								step={0.01}
								value={params[slider.id]}
								disabled={running}
								onChange={(event) => {
									const value = Number(event.currentTarget.value);
									setParams((current) => ({ ...current, [slider.id]: value }));
								}}
								className="w-full accent-[var(--accent)]"
							/>
							<span className="tabular text-right text-fg-muted">{params[slider.id].toFixed(2)}</span>
						</label>
					))}
				</div>
			</div>

			<div className="flex items-center gap-3">
				<Button variant="primary" size="sm" disabled={!file || running || disabled} onClick={() => void run()}>
					<Play aria-hidden="true" />
					Run pipeline
				</Button>
				{outcome && (
					<Button size="sm" asChild>
						<a href={outcome.url} download={outcome.result.name}>
							<Download aria-hidden="true" />
							Download {outcome.result.name}
						</a>
					</Button>
				)}
			</div>

			<ol className="grid grid-cols-5 gap-2" aria-label="Pipeline stages" data-testid="pipeline-stages">
				{STAGES.map(({ stage, label }, i) => {
					const done = outcome !== null || (activeIndex >= 0 && i < activeIndex);
					const active = i === activeIndex;
					return (
						<li
							key={stage}
							className="flex min-w-0 flex-col gap-1.5"
							data-state={done ? 'done' : active ? 'active' : 'idle'}
						>
							<div className="flex items-center gap-1.5">
								<span
									aria-hidden="true"
									className={cn(
										'flex size-3.5 shrink-0 items-center justify-center rounded-full border',
										'transition-[background-color,border-color,transform] duration-150 ease-out motion-reduce:transition-none',
										done
											? 'scale-100 border-accent bg-accent text-accent-fg'
											: active
												? 'scale-110 border-accent'
												: 'scale-100 border-line-strong',
									)}
								>
									<Check
										className={cn(
											'size-2.5 transition-opacity duration-150 ease-out motion-reduce:transition-none',
											done ? 'opacity-100' : 'opacity-0',
										)}
										strokeWidth={3}
									/>
								</span>
								<span className={cn('truncate text-[12px]', done || active ? 'text-fg' : 'text-fg-subtle')}>
									{label}
								</span>
							</div>
							<span className="tabular h-4 text-[11px] text-fg-subtle">
								{stageMs
									? formatMs(stageMs[i]!)
									: active && progress?.tiles
										? `band ${progress.tiles.bandsDone} of ${progress.tiles.bandCount}`
										: ''}
							</span>
						</li>
					);
				})}
			</ol>
			<div className="min-h-1" aria-live="polite">
				{progress && <Progress value={progress.fraction} label="Pipeline progress" />}
			</div>

			{error && (
				<p role="alert" className="text-[12px] text-danger">
					{error}
				</p>
			)}

			{outcome && <OutcomeView outcome={outcome} />}
		</div>
	);
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
	const { result, before, after } = outcome;
	const peakMiB = result.stats.peakFloatBytes / 2 ** 20;
	return (
		<div className="enter-up flex flex-col gap-3" data-testid="pipeline-outcome">
			<dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-4">
				<Fact label="Saved" value={`${result.name} · ${formatBytes(result.bytes.byteLength, 'en')}`} />
				<Fact label="Backend" value={result.backend === 'webgpu' ? 'Graphics chip' : 'Processor'} />
				<Fact label="Throughput" value={`${result.stats.mpPerSecond.toFixed(2)} MP/s`} />
				<Fact label="Peak float memory" value={`${peakMiB.toFixed(0)} MiB · one band`} />
			</dl>
			{result.warnings.length > 0 && (
				<ul className="flex flex-wrap gap-1.5" aria-label="Warnings">
					{result.warnings.map((warning) => (
						<li key={warning} className="rounded-md bg-warning/12 px-2 py-0.5 text-[11px] font-medium text-warning">
							{warning}
						</li>
					))}
				</ul>
			)}
			<div className="overflow-x-auto rounded-lg border border-line">
				<table data-testid="pipeline-metadata" className="w-full text-left text-[12px]">
					<thead className="bg-raised/50 text-fg-subtle">
						<tr>
							<th scope="col" className="px-3 py-2 font-medium">
								Field
							</th>
							<th scope="col" className="px-3 py-2 font-medium">
								Went in
							</th>
							<th scope="col" className="px-3 py-2 font-medium">
								Came out
							</th>
						</tr>
					</thead>
					<tbody>
						{SUMMARY_ROWS.map(({ field, label }) => {
							const changed = before[field] !== after[field];
							return (
								<tr key={field} className="border-t border-line" data-field={field} data-changed={changed}>
									<th scope="row" className="whitespace-nowrap px-3 py-1.5 font-normal text-fg-subtle">
										{label}
									</th>
									<td className="px-3 py-1.5 text-fg-muted">{before[field] ?? <Empty />}</td>
									<td className={cn('px-3 py-1.5', changed ? 'text-fg' : 'text-fg-muted')}>
										<span className="inline-flex items-center gap-1.5">
											{changed && <span aria-label="changed" className="size-1.5 shrink-0 rounded-full bg-fg-muted" />}
											{after[field] ?? <Empty />}
										</span>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function Empty() {
	return <span className="text-fg-subtle/70">—</span>;
}

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col">
			<dt className="text-fg-subtle">{label}</dt>
			<dd className="tabular truncate text-fg">{value}</dd>
		</div>
	);
}

function stageDurations(result: ProcessResult): number[] {
	const { stats } = result;
	return [stats.readMs, stats.decodeMs, stats.processMs, result.encodeMs + result.metadataMs, stats.saveMs];
}

function formatMs(ms: number): string {
	if (ms < 1) return '< 1 ms';
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
