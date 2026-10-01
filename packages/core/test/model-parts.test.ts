// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleVariant, ModelIntegrityError, type ModelVariant } from '../src/index.ts';

const sha256 = (bytes: Uint8Array) => Promise.resolve(createHash('sha256').update(bytes).digest('hex'));

const whole = Uint8Array.from({ length: 100 }, (_, i) => i);
const parts: Record<string, Uint8Array> = {
	'parts/m.000': whole.subarray(0, 40),
	'parts/m.001': whole.subarray(40, 80),
	'parts/m.002': whole.subarray(80),
};

async function variant(overrides: Partial<ModelVariant> = {}): Promise<ModelVariant> {
	return {
		precision: 'fp32',
		bytes: 100,
		sha256: await sha256(whole),
		parts: Object.keys(parts),
		backends: ['wasm'],
		...overrides,
	};
}

const fetchPart = async (path: string, onBytes: (n: number) => void) => {
	// Resolve out of order to prove assembly follows the manifest, not arrival.
	await new Promise((resolve) => setTimeout(resolve, path.endsWith('0') ? 5 : 0));
	const bytes = parts[path]!;
	onBytes(bytes.byteLength);
	return bytes;
};

describe('assembleVariant', () => {
	it('joins parts in manifest order and verifies the hash', async () => {
		const progress: number[] = [];
		const bytes = await assembleVariant({
			variant: await variant(),
			fetchPart,
			sha256,
			onProgress: (received, total) => {
				expect(total).toBe(100);
				progress.push(received);
			},
		});
		expect(bytes).toEqual(whole);
		expect(progress.at(-1)).toBe(100);
	});

	it('rejects a download of the wrong size', async () => {
		await expect(assembleVariant({ variant: await variant({ bytes: 99 }), fetchPart, sha256 })).rejects.toThrow(
			ModelIntegrityError,
		);
	});

	it('rejects a download with the wrong hash', async () => {
		await expect(
			assembleVariant({ variant: await variant({ sha256: '0'.repeat(64) }), fetchPart, sha256 }),
		).rejects.toThrow('hashes to');
	});
});
