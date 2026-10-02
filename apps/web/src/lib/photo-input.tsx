// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const ACCEPT =
	'image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,.jpg,.jpeg,.png,.webp,.heic,.heif,.avif';

function firstFile(list: FileList | null | undefined): File | null {
	return list && list.length > 0 ? list[0]! : null;
}

/** The hidden file input behind "Choose photo" and ⌘/Ctrl+O. */
export function useFilePicker(onFile: (file: File) => void) {
	const input = useRef<HTMLInputElement>(null);
	const element = (
		<input
			ref={input}
			type="file"
			accept={ACCEPT}
			className="sr-only"
			tabIndex={-1}
			aria-hidden="true"
			data-testid="file-input"
			onChange={(event) => {
				const file = firstFile(event.currentTarget.files);
				event.currentTarget.value = ''; // choosing the same file again still fires
				if (file) onFile(file);
			}}
		/>
	);
	return { open: () => input.current?.click(), element };
}

/**
 * The whole window accepts a dropped or pasted photo; the drop zone only shows
 * where. Drag state is counted, because dragenter/dragleave fire for every
 * child element the pointer crosses.
 */
export function useWindowDrop(onFile: (file: File) => void, enabled: boolean) {
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const latest = useRef(onFile);
	useLayoutEffect(() => {
		latest.current = onFile;
	});

	useEffect(() => {
		if (!enabled) return;
		const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
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
			const file = firstFile(event.dataTransfer?.files);
			if (file) latest.current(file);
		};
		const paste = (event: ClipboardEvent) => {
			const file = firstFile(event.clipboardData?.files);
			if (file) {
				event.preventDefault();
				latest.current(file);
			}
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
