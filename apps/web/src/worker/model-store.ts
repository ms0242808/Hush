// SPDX-License-Identifier: Apache-2.0
import { assembleVariant, type ModelVariant } from '@hush/core';

const CACHE_NAME = 'hush-models-v1';

/** Cache API key for a model: content-addressed, so a new model never collides with an old one. */
const cacheKey = (sha256: string) => new URL(`/models/by-sha256/${sha256}`, self.location.origin).href;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function openCache(): Promise<Cache | null> {
	try {
		return await caches.open(CACHE_NAME);
	} catch {
		return null; // private windows and blocked storage: still works, just downloads every time
	}
}

export async function isModelCached(sha256: string): Promise<boolean> {
	const cache = await openCache();
	return cache ? (await cache.match(cacheKey(sha256))) !== undefined : false;
}

/** Stream one part, reporting bytes as they arrive. */
async function fetchPart(url: string, onBytes: (received: number) => void): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
	const chunks: Uint8Array[] = [];
	let received = 0;
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		onBytes(received);
	}
	const bytes = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export interface LoadedModel {
	bytes: Uint8Array;
	fromCache: boolean;
	ms: number;
}

/**
 * The model file for a variant: from the Cache API when this browser already
 * has it (re-verified, since storage can be tampered with or truncated),
 * otherwise downloaded in parts, verified and cached.
 */
export async function loadModel(
	variant: ModelVariant,
	manifestUrl: string,
	onProgress: (received: number, total: number) => void,
	now: () => number,
): Promise<LoadedModel> {
	const start = now();
	const cache = await openCache();
	const cached = await cache?.match(cacheKey(variant.sha256));
	if (cached) {
		const bytes = new Uint8Array(await cached.arrayBuffer());
		if (bytes.byteLength === variant.bytes && (await sha256Hex(bytes)) === variant.sha256) {
			onProgress(variant.bytes, variant.bytes);
			return { bytes, fromCache: true, ms: now() - start };
		}
		await cache?.delete(cacheKey(variant.sha256));
	}

	const bytes = await assembleVariant({
		variant,
		fetchPart: (path, onBytes) => fetchPart(new URL(path, manifestUrl).href, onBytes),
		sha256: sha256Hex,
		onProgress,
	});
	try {
		await cache?.put(
			cacheKey(variant.sha256),
			new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream' } }),
		);
	} catch {
		// Quota exceeded: the model still works for this visit.
	}
	return { bytes, fromCache: false, ms: now() - start };
}
