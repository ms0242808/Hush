// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { TooltipProvider } from '@/components/ui/tooltip';
import Editor from '@/editor/Editor';
import { formatDuration } from '@/lib/duration';
import { useWindowDrop } from '@/lib/photo-input';
import { Footer } from './Footer';
import { Grid } from './Grid';
import { BatchAdvanced, BatchExport, Panel } from './Panel';
import { batchSession } from './session';
import { exportable, isBusy, useBatch } from './store';

const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * A batch (§5.4): the photos as a grid, the settings they share, Export, and
 * a footer with the run's progress. Clicking a photo opens it in the editor
 * — same settings, ← → to move through the batch, back to the grid after.
 */
export default function Batch({
	onPick,
	onClose,
	onShortcuts,
}: {
	onPick: () => void;
	onClose: () => void;
	onShortcuts: () => void;
}) {
	const { t } = useTranslation();
	const session = batchSession();
	const editing = useBatch((s) => s.editing);
	const busy = useBatch(isBusy);
	const photo = useBatch((s) => (s.editing ? (s.photos.find((p) => p.id === s.editing) ?? null) : null));
	const position = useBatch(
		useShallow((s) => {
			const list = exportable(s.photos);
			return { index: list.findIndex((p) => p.id === s.editing) + 1, count: list.length };
		}),
	);

	// More photos dropped or pasted onto the grid join the batch, even mid-run.
	const over = useWindowDrop((selection) => session.add(selection.files), !editing);

	// On the grid: ⌘/Ctrl+O adds photos, ⌘/Ctrl+E exports, ? lists the shortcuts. Never animated (§5.8).
	const latest = useRef({ onPick, onShortcuts });
	useLayoutEffect(() => {
		latest.current = { onPick, onShortcuts };
	});
	useEffect(() => {
		if (editing) return;
		const onKey = (event: KeyboardEvent) => {
			if (typing(event.target) || event.altKey) return;
			const command = event.metaKey || event.ctrlKey;
			const key = event.key.toLowerCase();
			if (command && key === 'o') {
				event.preventDefault();
				latest.current.onPick();
			} else if (command && key === 'e') {
				event.preventDefault();
				void session.start();
			} else if (!command && event.key === '?') {
				event.preventDefault();
				latest.current.onShortcuts();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [editing, session]);

	if (editing && photo && !busy) {
		const back = () => session.edit(null);
		return (
			<Editor
				file={photo.file}
				request={position.index}
				onSelection={(selection) => session.add(selection.files)}
				onPick={onPick}
				onClose={back}
				onShortcuts={onShortcuts}
				batch={{
					index: position.index,
					count: position.count,
					onBack: back,
					onStep: (delta) => session.step(delta),
					onExport: () => {
						back();
						void session.start();
					},
					exportArea: (
						<>
							<BatchExport session={session} beforeStart={back} />
							<BatchAdvanced session={session} />
						</>
					),
				}}
			/>
		);
	}

	return (
		<TooltipProvider>
			<div className="flex w-full flex-1 flex-col gap-3 md:min-h-0 md:flex-row" data-testid="batch">
				<section
					aria-label={t('batch.region')}
					className="relative flex min-h-[52vh] flex-1 flex-col overflow-hidden rounded-xl bg-viewer md:min-h-0"
				>
					<Grid session={session} />
					<Footer session={session} />
					{over && (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45">
							<span className="viewer-glass rounded-xl px-4 py-2.5 text-[14px] font-medium text-white">
								{t('drop.addToBatch')}
							</span>
						</div>
					)}
				</section>
				<Panel session={session} onPick={onPick} onClose={onClose} />
			</div>
			<LongBatch />
		</TooltipProvider>
	);
}

/** §5.12: before hours of work on the processor, the estimate and a choice — never a block. */
function LongBatch() {
	const { t } = useTranslation();
	const confirm = useBatch((s) => s.confirmLong);
	const session = batchSession();
	if (!confirm) return null;
	const close = () => useBatch.setState({ confirmLong: null });
	return (
		<Modal open onClose={close} title={t('batch.longTitle')} testId="long-batch">
			<p className="text-[14px] leading-relaxed text-fg-muted">
				{t('batch.longBody', { time: formatDuration(confirm.estimateMs, t) })}
			</p>
			<div className="flex justify-end gap-2">
				<Button onClick={close}>{t('common.cancel')}</Button>
				<Button variant="primary" onClick={() => void session.start({ confirmed: true })}>
					{t('batch.startAnyway')}
				</Button>
			</div>
		</Modal>
	);
}
