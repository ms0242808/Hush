// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readDataTransfer, type PhotoSelection } from './batch-input.ts';

export const ACCEPT =
	'image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,.jpg,.jpeg,.png,.webp,.heic,.heif,.avif';

/** Files as a selection: no folder behind them. */
export function filesSelection(files: readonly File[]): PhotoSelection {
	return { files: [...files], folder: null, folderName: null, ignored: 0 };
}

/** The hidden file input behind "Choose photos" and ⌘/Ctrl+O. One photo opens the editor; more make a batch. */
export function useFilePicker(onFiles: (files: File[]) => void) {
	const input = useRef<HTMLInputElement>(null);
	const element = (
		<input
			ref={input}
			type="file"
			accept={ACCEPT}
			multiple
			className="sr-only"
			tabIndex={-1}
			aria-hidden="true"
			data-testid="file-input"
			onChange={(event) => {
				const files = [...(event.currentTarget.files ?? [])];
				event.currentTarget.value = ''; // choosing the same files again still fires
				if (files.length > 0) onFiles(files);
			}}
		/>
	);
	return { open: () => input.current?.click(), element };
}

/**
 * The whole window accepts dropped or pasted photos — or a dropped folder —
 * and the drop zone only shows where. Drag state is counted, because
 * dragenter/dragleave fire for every child element the pointer crosses.
 */
export function useWindowDrop(onSelection: (selection: PhotoSelection) => void, enabled: boolean) {
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const latest = useRef(onSelection);
	useLayoutEffect(() => {
		latest.current = onSelection;
	});

	useEffect(() => {
		if (!enabled) return;
		const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
		const deliver = (data: DataTransfer | null) => {
			// Read now: the browser empties the DataTransfer once the handler returns.
			void readDataTransfer(data).then((selection) => {
				if (selection.files.length > 0 || selection.folder) latest.current(selection);
			});
		};
		const enter = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth.current += 1;
			setOver(true);
		};
		const overHandler = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		};
		const leave = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0) setOver(false);
		};
		const drop = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth.current = 0;
			setOver(false);
			deliver(event.dataTransfer);
		};
		const paste = (event: ClipboardEvent) => {
			if (!event.clipboardData || event.clipboardData.files.length === 0) return;
			event.preventDefault();
			deliver(event.clipboardData);
		};
		window.addEventListener('dragenter', enter);
		window.addEventListener('dragover', overHandler);
		window.addEventListener('dragleave', leave);
		window.addEventListener('drop', drop);
		window.addEventListener('paste', paste);
		return () => {
			window.removeEventListener('dragenter', enter);
			window.removeEventListener('dragover', overHandler);
			window.removeEventListener('dragleave', leave);
			window.removeEventListener('drop', drop);
			window.removeEventListener('paste', paste);
			depth.current = 0;
			setOver(false);
		};
	}, [enabled]);

	return over;
}
