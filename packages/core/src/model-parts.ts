// SPDX-License-Identifier: Apache-2.0
import type { ModelVariant } from './manifest.ts';
import type { Bytes } from './types.ts';

export class ModelIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelIntegrityError';
	}
}

export interface AssembleOptions {
	variant: ModelVariant;
	/** Fetch one part (a path relative to the manifest), reporting bytes as they arrive. */
	fetchPart: (path: string, onBytes: (received: number) => void) => Promise<Bytes>;
	sha256: (bytes: Bytes) => Promise<string>;
	/** Total bytes received across all parts so far, out of `variant.bytes`. */
	onProgress?: (received: number, total: number) => void;
}

/**
 * Download a variant's parts in parallel, join them in order and check the
 * whole file against the manifest's size and sha256 before anyone runs it.
 * Parts exist because static hosts cap file size (Cloudflare: 25 MiB).
 */
export async function assembleVariant(options: AssembleOptions): Promise<Bytes> {
	const { variant, fetchPart, sha256, onProgress } = options;
	const received = new Array<number>(variant.parts.length).fill(0);
	const report = () =>
		onProgress?.(
			received.reduce((sum, n) => sum + n, 0),
			variant.bytes,
		);

	const parts = await Promise.all(
		variant.parts.map((path, i) =>
			fetchPart(path, (bytes) => {
				received[i] = bytes;
				report();
			}),
		),
	);

	const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
	if (length !== variant.bytes) {
		throw new ModelIntegrityError(`Model download is ${length} bytes; the manifest says ${variant.bytes}`);
	}
	const whole = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		whole.set(part, offset);
		offset += part.byteLength;
	}

	const digest = await sha256(whole);
	if (digest !== variant.sha256) {
		throw new ModelIntegrityError(`Model download hashes to ${digest}; the manifest says ${variant.sha256}`);
	}
	return whole;
}
