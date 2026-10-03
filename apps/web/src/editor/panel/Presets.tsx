// SPDX-License-Identifier: Apache-2.0
import { ChevronsUpDown, Download, FilePlus2, PencilLine, Save, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Modal } from '@/components/ui/modal';
import { importPresets, presetFile, type Preset } from '@/lib/presets';
import { cn } from '@/lib/utils';
import { addPresets, applyPreset, deletePreset, isEdited, renamePreset, savePreset, useEditor } from '../store';

type Dialog = { kind: 'save' } | { kind: 'rename'; preset: Preset } | { kind: 'delete'; preset: Preset } | null;

const DEFAULT_ID = '__default__';

function downloadText(name: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Presets are recipes (§4.5, §5.3): save the sliders under a name, apply,
 * rename, delete, and move them between computers as JSON files.
 */
export function Presets({ disabled }: { disabled: boolean }) {
	const { t } = useTranslation();
	const presets = useEditor((state) => state.presets);
	const presetId = useEditor((state) => state.presetId);
	const edited = useEditor(isEdited);
	const modelId = useEditor((state) => state.modelInfo?.id);
	const [dialog, setDialog] = useState<Dialog>(null);
	/** What the last action did, as translation keys: it rewords itself if the language changes. */
	const [message, setMessage] = useState<{ parts: [string, Record<string, unknown>][]; tone: 'ok' | 'problem' } | null>(
		null,
	);
	const fileInput = useRef<HTMLInputElement>(null);
	const current = presets.find((p) => p.id === presetId) ?? null;

	const onImport = async (files: File[]) => {
		const result = await importPresets(
			files,
			presets.map((p) => p.recipe.name),
		);
		addPresets(result.imported);
		const problems = result.problems.map(({ file, error }): [string, Record<string, unknown>] => {
			switch (error.code) {
				case 'newer-schema':
					return ['presets.newer', { file }];
				case 'unknown-op':
					return ['presets.unknownOp', { file, op: error.subject }];
				default:
					return ['presets.notAPreset', { file }];
			}
		});
		const imported: [string, Record<string, unknown>][] =
			result.imported.length > 0 ? [['presets.imported', { count: result.imported.length }]] : [];
		setMessage({ parts: [...imported, ...problems], tone: problems.length > 0 ? 'problem' : 'ok' });
	};

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[12px] font-medium text-fg-subtle" id="preset-label">
				{t('presets.label')}
			</span>
			<DropdownMenu>
				<DropdownMenuTrigger asChild disabled={disabled}>
					<Button
						variant="secondary"
						className="h-9 w-full justify-between px-3 text-[13px] font-normal"
						aria-labelledby="preset-label preset-value"
						data-testid="preset-menu"
					>
						<span id="preset-value" className="flex min-w-0 items-center gap-2">
							<span className="truncate">{current ? current.recipe.name : t('presets.default')}</span>
							{edited && (
								<span className="shrink-0 rounded-md bg-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted">
									{t('presets.edited')}
								</span>
							)}
						</span>
						<ChevronsUpDown aria-hidden="true" className="text-fg-subtle" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[15rem]">
					<DropdownMenuLabel>{t('presets.label')}</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={presetId ?? DEFAULT_ID}
						onValueChange={(value) => applyPreset(value === DEFAULT_ID ? null : value)}
					>
						<DropdownMenuRadioItem value={DEFAULT_ID}>{t('presets.default')}</DropdownMenuRadioItem>
						{presets.map((preset) => (
							<DropdownMenuRadioItem key={preset.id} value={preset.id}>
								<span className="truncate">{preset.recipe.name}</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => setDialog({ kind: 'save' })}>
						<FilePlus2 aria-hidden="true" />
						{t('presets.saveAs')}
					</DropdownMenuItem>
					{current && (
						<>
							<DropdownMenuItem
								disabled={!edited}
								onSelect={() => {
									savePreset(current.recipe.name, modelId);
									setMessage({ parts: [['presets.updated', { name: current.recipe.name }]], tone: 'ok' });
								}}
							>
								<Save aria-hidden="true" />
								{t('presets.update', { name: current.recipe.name })}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => setDialog({ kind: 'rename', preset: current })}>
								<PencilLine aria-hidden="true" />
								{t('presets.rename')}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => setDialog({ kind: 'delete', preset: current })}>
								<Trash2 aria-hidden="true" />
								{t('presets.delete')}
							</DropdownMenuItem>
						</>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => fileInput.current?.click()}>
						<Upload aria-hidden="true" />
						{t('presets.import')}
					</DropdownMenuItem>
					{current && (
						<DropdownMenuItem
							onSelect={() => {
								const file = presetFile(current);
								downloadText(file.name, file.text);
								setMessage({ parts: [['presets.exported', { file: file.name }]], tone: 'ok' });
							}}
						>
							<Download aria-hidden="true" />
							{t('presets.export')}
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<input
				ref={fileInput}
				type="file"
				accept=".json,application/json"
				multiple
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				data-testid="preset-file-input"
				onChange={(event) => {
					const files = [...(event.currentTarget.files ?? [])];
					event.currentTarget.value = '';
					if (files.length > 0) void onImport(files);
				}}
			/>
			{message && (
				<p
					role="status"
					className={cn(
						'enter-up text-[12px] leading-relaxed',
						message.tone === 'ok' ? 'text-fg-subtle' : 'text-warning',
					)}
				>
					{message.parts.map(([key, values]) => t(key, values)).join(' ')}
				</p>
			)}

			<NameDialog
				open={dialog?.kind === 'save' || dialog?.kind === 'rename'}
				title={dialog?.kind === 'rename' ? t('presets.renameTitle') : t('presets.saveTitle')}
				initial={dialog?.kind === 'rename' ? dialog.preset.recipe.name : ''}
				taken={presets.filter((p) => dialog?.kind !== 'rename' || p.id !== dialog.preset.id).map((p) => p.recipe.name)}
				submit={dialog?.kind === 'rename' ? t('presets.renameAction') : t('presets.saveAction')}
				onClose={() => setDialog(null)}
				onSubmit={(name) => {
					if (dialog?.kind === 'rename') renamePreset(dialog.preset.id, name);
					else {
						const preset = savePreset(name, modelId);
						setMessage({ parts: [['presets.saved', { name: preset.recipe.name }]], tone: 'ok' });
					}
					setDialog(null);
				}}
			/>
			<Modal
				open={dialog?.kind === 'delete'}
				onClose={() => setDialog(null)}
				title={t('presets.deleteTitle', { name: dialog?.kind === 'delete' ? dialog.preset.recipe.name : '' })}
			>
				<p className="text-[14px] leading-relaxed text-fg-muted">{t('presets.deleteBody')}</p>
				<div className="flex justify-end gap-2">
					<Button onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
					<Button
						variant="danger"
						onClick={() => {
							if (dialog?.kind === 'delete') deletePreset(dialog.preset.id);
							setDialog(null);
						}}
					>
						{t('presets.deleteAction')}
					</Button>
				</div>
			</Modal>
		</div>
	);
}

function NameDialog({
	open,
	title,
	initial,
	taken,
	submit,
	onClose,
	onSubmit,
}: {
	open: boolean;
	title: string;
	initial: string;
	taken: string[];
	submit: string;
	onClose: () => void;
	onSubmit: (name: string) => void;
}) {
	return (
		<Modal open={open} onClose={onClose} title={title}>
			{open && <NameForm initial={initial} taken={taken} submit={submit} onCancel={onClose} onSubmit={onSubmit} />}
		</Modal>
	);
}

function NameForm({
	initial,
	taken,
	submit,
	onCancel,
	onSubmit,
}: {
	initial: string;
	taken: string[];
	submit: string;
	onCancel: () => void;
	onSubmit: (name: string) => void;
}) {
	const { t } = useTranslation();
	const [name, setName] = useState(initial);
	const trimmed = name.trim();
	const replaces = taken.some((n) => n.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (trimmed) onSubmit(trimmed);
			}}
		>
			<label className="flex flex-col gap-1.5 text-[13px] text-fg-muted">
				{t('presets.nameLabel')}
				<input
					autoFocus // the dialog exists to type this
					value={name}
					maxLength={60}
					onChange={(event) => setName(event.currentTarget.value)}
					placeholder={t('presets.namePlaceholder')}
					className="h-9 rounded-lg border border-line-strong bg-sunken px-3 text-[14px] text-fg outline-none placeholder:text-fg-subtle focus-visible:border-accent"
				/>
			</label>
			{replaces && <p className="text-[12px] text-fg-subtle">{t('presets.replaces', { name: trimmed })}</p>}
			<div className="flex justify-end gap-2">
				<Button onClick={onCancel}>{t('common.cancel')}</Button>
				<Button type="submit" variant="primary" disabled={!trimmed}>
					{submit}
				</Button>
			</div>
		</form>
	);
}
