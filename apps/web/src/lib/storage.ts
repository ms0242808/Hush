// SPDX-License-Identifier: Apache-2.0

/**
 * localStorage that never throws: storage can be blocked (private windows,
 * site settings) or full, and Hush must still work for the visit (§4.2:
 * settings and recipes live in localStorage; nothing is server-side).
 */
export function readStored<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		return parse(JSON.parse(raw));
	} catch {
		return fallback;
	}
}

export function writeStored(key: string, value: unknown): boolean {
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}
