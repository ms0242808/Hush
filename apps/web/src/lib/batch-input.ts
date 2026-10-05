// SPDX-License-Identifier: Apache-2.0

/**
 * Where a batch's photos come from (§5.2, §5.4): files chosen or dropped, or
 * a folder — chosen (Chrome, Edge) or dropped (everywhere). A chosen or
 * dropped folder in Chrome and Edge arrives as a handle, which can be kept in
 * IndexedDB so a batch resumes after a reload (§2.7); elsewhere a dropped
 * folder is read once, like a handful of files.
 */

/** What Hush opens, by extension. Folders also hold RAW files, sidecars and videos: those are left alone. */
const PHOTO_EXTENSION = /\.(jpe?g|jpe|jfif|png|webp|heic|heif|avif)$/i;

export function looksLikePhoto(name: string): boolean {
	return PHOTO_EXTENSION.test(name) && !name.startsWith('.');
}

/** File-name order as a person reads it: IMG_2 before IMG_10. */
export function byName(a: { name: string }, b: { name: string }): number {
	return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export interface PhotoSelection {
	files: File[];
	/** The folder, when the photos are one folder's and the browser gave a handle to it. */
	folder: FileSystemDirectoryHandle | null;
	/** The folder's name, also when no handle could be had (a dropped folder in Safari or Firefox). */
	folderName: string | null;
	/** Files in the folder that aren't photos Hush opens (RAW files, sidecars, videos). */
	ignored: number;
}

type DirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

export function canChooseFolder(): boolean {
	return typeof (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker === 'function';
}

/** The photos directly in a folder, in name order. Sub-folders are left alone (an export's own "denoised" among them). */
export async function photosInFolder(folder: FileSystemDirectoryHandle): Promise<{ files: File[]; ignored: number }> {
	const files: File[] = [];
	let ignored = 0;
	for await (const entry of folder.values()) {
		if (entry.kind !== 'file' || entry.name.startsWith('.')) continue;
		if (!looksLikePhoto(entry.name)) {
			ignored++;
			continue;
		}
		files.push(await entry.getFile());
	}
	return { files: files.sort(byName), ignored };
}

/** Ask for a folder of photos (Chrome, Edge). Null when the picker is closed. */
export async function chooseFolderOfPhotos(): Promise<PhotoSelection | null> {
	const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
	if (!picker) return null;
	let folder: FileSystemDirectoryHandle;
	try {
		folder = await picker({ id: 'hush-photos', mode: 'read' });
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') return null;
		throw error;
	}
	const { files, ignored } = await photosInFolder(folder);
	return { files, folder, folderName: folder.name, ignored };
}

type Entry = FileSystemEntry;

function readEntries(reader: FileSystemDirectoryReader): Promise<Entry[]> {
	return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** A dropped folder's photos, through the older entries API (Safari, Firefox). */
async function photosInEntry(directory: FileSystemDirectoryEntry): Promise<{ files: File[]; ignored: number }> {
	const reader = directory.createReader();
	const entries: Entry[] = [];
	// readEntries hands them over in chunks of up to 100.
	for (let chunk = await readEntries(reader); chunk.length > 0; chunk = await readEntries(reader))
		entries.push(...chunk);
	const files: File[] = [];
	let ignored = 0;
	for (const entry of entries) {
		if (!entry.isFile || entry.name.startsWith('.')) continue;
		if (!looksLikePhoto(entry.name)) {
			ignored++;
			continue;
		}
		files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
	}
	return { files, ignored };
}

type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };

/**
 * What was dropped or pasted. Must be called during the event: the browser
 * empties the DataTransfer once the handler returns, so everything is asked
 * for at once and awaited afterwards.
 */
export function readDataTransfer(data: DataTransfer | null): Promise<PhotoSelection> {
	const items = data ? [...data.items].filter((item) => item.kind === 'file') : [];
	const asked = items.map((item) => ({
		file: item.getAsFile(),
		entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
		handle:
			typeof (item as HandleItem).getAsFileSystemHandle === 'function'
				? (item as HandleItem).getAsFileSystemHandle!().catch(() => null)
				: Promise.resolve(null),
	}));
	const loose = data && items.length === 0 ? [...data.files] : [];
	return (async () => {
		const folders = asked.filter((a) => a.entry?.isDirectory);
		// One folder, and a handle to it: a batch that can resume after a reload.
		if (folders.length === 1 && asked.length === 1) {
			const handle = await folders[0]!.handle;
			if (handle?.kind === 'directory') {
				const folder = handle as FileSystemDirectoryHandle;
				return { ...(await photosInFolder(folder)), folder, folderName: folder.name };
			}
			const read = await photosInEntry(folders[0]!.entry as FileSystemDirectoryEntry);
			return {
				files: read.files.sort(byName),
				folder: null,
				folderName: folders[0]!.entry!.name,
				ignored: read.ignored,
			};
		}
		const files: File[] = [...loose];
		let ignored = 0;
		for (const a of asked) {
			if (a.entry?.isDirectory) {
				const read = await photosInEntry(a.entry as FileSystemDirectoryEntry);
				files.push(...read.files);
				ignored += read.ignored;
			} else if (a.file) {
				files.push(a.file);
			}
		}
		return { files, folder: null, folderName: null, ignored };
	})();
}
