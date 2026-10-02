// SPDX-License-Identifier: Apache-2.0
import type { AssetSource, ModelStorage, OutputAdapter, SavedFile, Zlib } from '@hush/core';

/**
 * The browser side of PlatformAdapters, apart from codecs and inference:
 * the app's own static files, the Cache API for models, SHA-256, zlib and
 * the clock. Everything here reads; nothing sends (§4.7).
 */

/** Same-origin static files, relative to the app root. */
export const browserAssets: AssetSource = {
	async json(path) {
		const response = await fetch(new URL(`/${path}`, self.location.origin).href, { cache: 'no-cache' });
		if (!response.ok) throw named('ModelError', `${path}: HTTP ${response.status}`);
		return response.json() as Promise<unknown>;
	},
	async bytes(path, onBytes) {
		const response = await fetch(new URL(`/${path}`, self.location.origin).href);
		if (!response.ok || !response.body) throw named('ModelError', `${path}: HTTP ${response.status}`);
		const chunks: Uint8Array[] = [];
		let received = 0;
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			received += value.byteLength;
			onBytes?.(received);
		}
		const bytes = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	},
};

const CACHE_NAME = 'hush-models-v1';
/** Cache API key for a model: content-addressed, so a new model never collides with an old one. */
const cacheKey = (sha256: string) => new URL(`/models/by-sha256/${sha256}`, self.location.origin).href;

async function openCache(): Promise<Cache | null> {
	try {
		return await caches.open(CACHE_NAME);
	} catch {
		return null; // private windows and blocked storage: still works, just downloads every time
	}
}

/** Models in the Cache API, keyed by hash (§6.5). Core re-verifies whatever comes back. */
export const browserStorage: ModelStorage & { has(sha256: string): Promise<boolean> } = {
	async getModel(sha256) {
		const cached = await (await openCache())?.match(cacheKey(sha256));
		return cached ? new Uint8Array(await cached.arrayBuffer()) : null;
	},
	async putModel(sha256, bytes) {
		const cache = await openCache();
		await cache?.put(
			cacheKey(sha256),
			new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream' } }),
		);
	},
	async has(sha256) {
		return ((await (await openCache())?.match(cacheKey(sha256))) ?? null) !== null;
	},
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function streamThrough(
	bytes: Uint8Array,
	transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** zlib via the Compression Streams API ("deflate" is the zlib format). */
export const browserZlib: Zlib = {
	inflate: (bytes) => streamThrough(bytes, new DecompressionStream('deflate')),
	deflate: (bytes) => streamThrough(bytes, new CompressionStream('deflate')),
};

/**
 * Keeps finished files for the page to save. In this worker a "save" is
 * handing the file back; the page downloads it and confirms. Saving straight
 * to a folder arrives with batches (§2.8, Phase 3).
 */
export function memoryOutput(
	location = 'Downloads',
): OutputAdapter & { take(): { name: string; bytes: Uint8Array; mimeType: string } | null } {
	let last: { name: string; bytes: Uint8Array; mimeType: string } | null = null;
	return {
		save(name, bytes, mimeType): Promise<SavedFile> {
			last = { name, bytes, mimeType };
			return Promise.resolve({ name, location });
		},
		take() {
			const file = last;
			last = null;
			return file;
		},
	};
}

export function named(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}
