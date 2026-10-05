// SPDX-License-Identifier: Apache-2.0
import { asDirectory, deleteValue, getValue, putValue } from './idb.ts';

/**
 * A batch in progress, written to IndexedDB as it goes, so a crash, a reload
 * or a closed tab loses at most the photo being worked on (§2.7):
 *
 *   folder → folder   the folders' handles are kept too: after a reload the
 *                     user grants permission once and the batch carries on;
 *                     whatever is already in the destination is skipped
 *   files  → anything the photos are chosen again, and those already saved —
 *                     in the folder, or in a ZIP part that finished
 *                     downloading — are skipped
 *
 * The record holds names, sizes and settings, never pixels. Handles live in
 * another store and are read only when the user chooses to continue.
 */
export interface BatchRecordItem {
	name: string;
	size: number;
	lastModified: number;
	/** The name its export is saved under. */
	output: string;
	/** Saved (in the folder, or in a ZIP part that has downloaded), or found already there. */
	done: boolean;
}

export type BatchRecordDestination =
	/** `inside`: a folder made inside the source folder ("denoised"), reached through the source's handle. */
	{ kind: 'folder'; name: string; inside: string | null } | { kind: 'zip'; base: string; nextPart: number };

export interface BatchRecord {
	schema: 1;
	id: string;
	updatedAt: number;
	source: { kind: 'folder'; name: string } | { kind: 'files'; name: string | null };
	destination: BatchRecordDestination;
	/** The sliders the batch runs with: a resumed batch looks like the rest of it. */
	params: { strength: number; luma: number; colour: number; detail: number };
	settings: { format: 'auto' | 'jpeg' | 'png' | 'webp'; quality: number; suffix: string; removeLocation: boolean };
	items: BatchRecordItem[];
}

const RECORD_KEY = 'current';
const INPUT_KEY = 'batch-input';
const OUTPUT_KEY = 'batch-output';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Accept only a record this version wrote; anything else is treated as no record. */
export function parseBatchRecord(value: unknown): BatchRecord | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Partial<BatchRecord>;
	if (r.schema !== 1 || typeof r.id !== 'string' || !Array.isArray(r.items) || !r.source || !r.destination) return null;
	if (!r.params || !r.settings || !isNumber(r.updatedAt)) return null;
	const items = r.items.filter(
		(item): item is BatchRecordItem =>
			!!item &&
			typeof item.name === 'string' &&
			typeof item.output === 'string' &&
			isNumber(item.size) &&
			isNumber(item.lastModified) &&
			typeof item.done === 'boolean',
	);
	if (items.length !== r.items.length || items.length === 0) return null;
	const kinds = ['folder', 'files'];
	if (!kinds.includes(r.source.kind) || !['folder', 'zip'].includes(r.destination.kind)) return null;
	return r as BatchRecord;
}

/** Photos the record still has to do. */
export function remaining(record: BatchRecord): number {
	return record.items.filter((item) => !item.done).length;
}

export async function loadBatchRecord(): Promise<BatchRecord | null> {
	try {
		const record = parseBatchRecord(await getValue('batches', RECORD_KEY));
		return record && remaining(record) > 0 ? record : null;
	} catch {
		return null;
	}
}

export async function saveBatchRecord(record: BatchRecord): Promise<void> {
	try {
		await putValue('batches', RECORD_KEY, { ...record, updatedAt: Date.now() });
	} catch {
		// Storage blocked or full: the batch still runs; it just can't resume after a reload.
	}
}

export async function clearBatchRecord(): Promise<void> {
	try {
		await Promise.all([
			deleteValue('batches', RECORD_KEY),
			deleteValue('handles', INPUT_KEY),
			deleteValue('handles', OUTPUT_KEY),
		]);
	} catch {
		// Nothing to clear, or storage blocked.
	}
}

export async function saveBatchHandles(handles: {
	input: FileSystemDirectoryHandle | null;
	output: FileSystemDirectoryHandle | null;
}): Promise<void> {
	try {
		await Promise.all([
			putValue('handles', INPUT_KEY, handles.input ?? undefined),
			putValue('handles', OUTPUT_KEY, handles.output ?? undefined),
		]);
	} catch {
		// As above: the batch runs; resuming will ask for the folders again.
	}
}

/** The batch's folders. Read only when the user chooses to continue: deserialising a handle is the costly part. */
export async function loadBatchHandles(): Promise<{
	input: FileSystemDirectoryHandle | null;
	output: FileSystemDirectoryHandle | null;
}> {
	try {
		const [input, output] = await Promise.all([getValue('handles', INPUT_KEY), getValue('handles', OUTPUT_KEY)]);
		return { input: asDirectory(input), output: asDirectory(output) };
	} catch {
		return { input: null, output: null };
	}
}

/** The same photo: name, size and modification time all match. */
export function sameFile(item: Pick<BatchRecordItem, 'name' | 'size' | 'lastModified'>, file: File): boolean {
	return item.name === file.name && item.size === file.size && item.lastModified === file.lastModified;
}
