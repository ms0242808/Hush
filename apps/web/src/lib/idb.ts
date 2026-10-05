// SPDX-License-Identifier: Apache-2.0

/**
 * Hush's one IndexedDB database (§4.2: history and folder handles live in
 * IndexedDB; nothing is server-side). Two stores:
 *
 *   handles  folder and file handles: the export folder, a batch's folders
 *   batches  the batch in progress, so it can resume after a reload (§2.7)
 *
 * Handles and records are kept apart on purpose: reading a record back never
 * deserialises a handle, so the page can say "a batch stopped here" before the
 * user has clicked anything.
 */
const DATABASE = 'hush';
const VERSION = 2;
export type StoreName = 'handles' | 'batches';

function database(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
			if (!db.objectStoreNames.contains('batches')) db.createObjectStore('batches');
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable'));
		request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
	});
}

export async function transact<T>(
	store: StoreName,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const db = await database();
	try {
		return await new Promise<T>((resolve, reject) => {
			const transaction = db.transaction(store, mode);
			const request = run(transaction.objectStore(store));
			let value: T;
			request.onsuccess = () => (value = request.result);
			// A write counts once it is committed, not when the request succeeds.
			transaction.oncomplete = () => resolve(value);
			transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDB request failed'));
			transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
		});
	} finally {
		db.close();
	}
}

export async function getValue(store: StoreName, key: string): Promise<unknown> {
	return transact<unknown>(store, 'readonly', (s) => s.get(key));
}

export async function putValue(store: StoreName, key: string, value: unknown): Promise<void> {
	await transact<unknown>(store, 'readwrite', (s) =>
		value === undefined ? (s.delete(key) as IDBRequest<unknown>) : (s.put(value, key) as IDBRequest<unknown>),
	);
}

export async function deleteValue(store: StoreName, key: string): Promise<void> {
	await transact<unknown>(store, 'readwrite', (s) => s.delete(key) as IDBRequest<unknown>);
}

/** A stored folder handle, or null for anything else. */
export function asDirectory(value: unknown): FileSystemDirectoryHandle | null {
	return value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'directory'
		? (value as FileSystemDirectoryHandle)
		: null;
}
