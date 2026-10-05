// SPDX-License-Identifier: Apache-2.0
import { asDirectory, deleteValue, getValue, putValue } from './idb.ts';

/**
 * Where an export goes (§2.8) and how Hush makes sure it got there (§5.13:
 * the save location is always visible; no silent write failures).
 *
 *   download   everywhere: the browser saves it to Downloads
 *   folder     Chrome and Edge: written straight into a folder the user chose,
 *              confirmed when the write closes; the folder is remembered
 *   share      phones and tablets: the system share sheet ("Save to Photos")
 */
export type SaveMethod = 'download' | 'folder' | 'share';

export interface ExportedFile {
	name: string;
	bytes: Uint8Array;
	mimeType: string;
}

export interface SavedFile {
	/** The name it was saved under: a folder may already hold one of that name. */
	name: string;
	method: SaveMethod;
	/** The folder's name, for folder saves. */
	folder?: string;
}

export type SaveProblem = 'permission' | 'not-found' | 'no-space' | 'blocked' | 'cancelled' | 'unsupported' | 'unknown';

/** Saving failed. The interface says which photo, why and what to do; the file stays in memory for a retry. */
export class SaveFailure extends Error {
	readonly problem: SaveProblem;
	constructor(problem: SaveProblem, message: string) {
		super(message);
		this.name = 'SaveFailure';
		this.problem = problem;
	}
}

/** What a DOMException from the File System Access or Web Share API means for the user. */
export function classifySaveError(error: unknown): SaveProblem {
	const name = error instanceof Error ? error.name : '';
	switch (name) {
		case 'NotAllowedError':
		case 'SecurityError':
			return 'permission';
		case 'NotFoundError':
			return 'not-found';
		case 'QuotaExceededError':
			return 'no-space';
		case 'NoModificationAllowedError':
		case 'InvalidModificationError':
		case 'InvalidStateError':
			return 'blocked'; // e.g. Windows Controlled folder access, or a file open elsewhere
		case 'AbortError':
			return 'cancelled';
		case 'TypeError':
			return 'unsupported';
		default:
			return 'unknown';
	}
}

type DirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

interface PermissionHandle {
	queryPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
	requestPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
}

export function canSaveToFolder(): boolean {
	return typeof (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker === 'function';
}

/** The share sheet, offered where it's the natural way to save: touch devices that can share files. */
export function canShareFiles(): boolean {
	if (typeof navigator.canShare !== 'function' || !window.matchMedia('(pointer: coarse)').matches) return false;
	try {
		return navigator.canShare({ files: [new File([new Uint8Array(1)], 'photo.jpg', { type: 'image/jpeg' })] });
	} catch {
		return false;
	}
}

/** Ask for a folder. Null when the user closes the picker. */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | null> {
	const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
	if (!picker) throw new SaveFailure('unsupported', 'This browser can’t save to a folder');
	try {
		return await picker({ id: 'hush-export', mode: 'readwrite' });
	} catch (error) {
		if (classifySaveError(error) === 'cancelled') return null;
		throw new SaveFailure(classifySaveError(error), error instanceof Error ? error.message : String(error));
	}
}

/**
 * Make sure Hush may write to the folder. After a reload the browser asks
 * again, and only during a click: call this from the Export click, before
 * the photo is processed, not after.
 */
export async function folderPermission(handle: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
	const permissions = handle as unknown as PermissionHandle;
	if (!permissions.queryPermission) return true;
	const state = await permissions.queryPermission({ mode: 'readwrite' });
	if (state === 'granted') return true;
	if (!ask || !permissions.requestPermission) return false;
	return (await permissions.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** "IMG_2041-denoised.jpg" → "IMG_2041-denoised (2).jpg": a folder save never replaces a file. */
export function numberedName(name: string, n: number): string {
	if (n <= 1) return name;
	const dot = name.lastIndexOf('.');
	return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** Whether the folder already holds something called `name` (a file, or a folder: TypeMismatchError). */
export async function taken(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
	try {
		await folder.getFileHandle(name);
		return true;
	} catch (error) {
		const kind = error instanceof Error ? error.name : '';
		if (kind === 'NotFoundError') return false;
		if (kind === 'TypeMismatchError') return true;
		throw error;
	}
}

async function freeName(folder: FileSystemDirectoryHandle, name: string): Promise<string> {
	for (let n = 1; n < 1000; n++) {
		const candidate = numberedName(name, n);
		if (!(await taken(folder, candidate))) return candidate;
	}
	throw new SaveFailure('blocked', 'Too many files with this name');
}

async function writeToFolder(folder: FileSystemDirectoryHandle, file: ExportedFile): Promise<SavedFile> {
	const name = await freeName(folder, file.name);
	const handle = await folder.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	try {
		await writable.write(file.bytes as Uint8Array<ArrayBuffer>);
		await writable.close(); // resolves only once the file is really there
	} catch (error) {
		await writable.abort().catch(() => {});
		throw error;
	}
	return { name, method: 'folder', folder: folder.name };
}

/** Hand a file to the browser's downloads. */
export function downloadBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.rel = 'noopener';
	document.body.append(link);
	link.click();
	link.remove();
	// The browser reads the blob asynchronously; keep it long enough for a slow disk.
	window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function download(file: ExportedFile): SavedFile {
	downloadBlob(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mimeType }), file.name);
	return { name: file.name, method: 'download' };
}

async function share(file: ExportedFile): Promise<SavedFile> {
	const shared = new File([file.bytes as Uint8Array<ArrayBuffer>], file.name, { type: file.mimeType });
	await navigator.share({ files: [shared] });
	return { name: file.name, method: 'share' };
}

/** Save an exported photo. Resolves once the platform confirms it; throws a SaveFailure otherwise. */
export async function saveExport(
	file: ExportedFile,
	target: { method: 'download' } | { method: 'share' } | { method: 'folder'; folder: FileSystemDirectoryHandle },
): Promise<SavedFile> {
	try {
		switch (target.method) {
			case 'download':
				return download(file);
			case 'share':
				return await share(file);
			case 'folder':
				return await writeToFolder(target.folder, file);
		}
	} catch (error) {
		if (error instanceof SaveFailure) throw error;
		throw new SaveFailure(classifySaveError(error), error instanceof Error ? error.message : String(error));
	}
}

// ── The chosen folder, remembered across visits (§2.7: folder handles in IndexedDB) ──

const FOLDER_KEY = 'export-folder';

export async function rememberFolder(handle: FileSystemDirectoryHandle | null): Promise<void> {
	try {
		await (handle ? putValue('handles', FOLDER_KEY, handle) : deleteValue('handles', FOLDER_KEY));
	} catch {
		// Storage blocked: the folder still works for this visit.
	}
}

export async function recallFolder(): Promise<FileSystemDirectoryHandle | null> {
	try {
		return asDirectory(await getValue('handles', FOLDER_KEY));
	} catch {
		return null;
	}
}
