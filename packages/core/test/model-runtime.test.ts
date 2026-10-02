// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	chooseVariant,
	parseManifest,
	prepareModel,
	tileCeiling,
	type InferenceSession,
	type LoadedModel,
	type ModelManifest,
} from '../src/index.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fp16 = Uint8Array.from({ length: 64 }, (_, i) => i);
const fp32 = Uint8Array.from({ length: 128 }, (_, i) => 255 - i);

function manifest(): ModelManifest {
	const variant = (precision: 'fp16' | 'fp32', bytes: Uint8Array, backends: string[]) => ({
		precision,
		bytes: bytes.length,
		sha256: sha(bytes),
		parts: [`parts/m.${precision}.000`],
		backends,
	});
	return parseManifest({
		schema: 1,
		active: { denoise: 'nafnet-sidd-w32' },
		models: [
			{
				id: 'nafnet-sidd-w32',
				family: 'nafnet',
				task: 'denoise',
				label: { en: 'NAFNet' },
				variants: [variant('fp16', fp16, ['webgpu']), variant('fp32', fp32, ['webgpu', 'wasm'])],
				tile: { padMultiple: 16, overlap: 48, channels: 64 },
				input: { range: [0, 1], layout: 'NCHW', colour: 'RGB' },
				source: { repo: 'r', revision: 'v' },
				licence: { code: 'MIT', weights: 'MIT', trainingData: 'MIT' },
			},
		],
	});
}

function adapters(log: string[], maxBufferBytes: number | null = null) {
	let time = 0;
	return {
		clock: { now: () => (time += 10) },
		crypto: { sha256: (bytes: Uint8Array) => Promise.resolve(sha(bytes)) },
		storage: { getModel: () => Promise.resolve(null), putModel: () => Promise.resolve() },
		assets: {
			json: () => Promise.reject(new Error('unused')),
			bytes: (path: string) => {
				log.push(`fetch ${path}`);
				return Promise.resolve(path.includes('fp16') ? fp16 : fp32);
			},
		},
		inference: {
			warm: (backend: string) => {
				log.push(`warm ${backend}`);
				return Promise.resolve();
			},
			createSession: (model: LoadedModel): Promise<InferenceSession> => {
				log.push(`session ${model.backend} ${model.variant.precision} ${model.bytes.length}`);
				return Promise.resolve({
					backend: model.backend,
					maxBufferBytes,
					run: (input) => Promise.resolve(input),
					dispose: () => Promise.resolve(),
				});
			},
		},
	};
}

describe('preparing a model through the platform', () => {
	it('picks fp16 for a GPU with shader-f16, downloads it while the runtime warms, then opens a session', async () => {
		const log: string[] = [];
		const ready = await prepareModel(
			manifest(),
			{ task: 'denoise', backend: 'webgpu', shaderF16: true },
			adapters(log),
		);
		expect(ready.variant.precision).toBe('fp16');
		expect(ready.fromCache).toBe(false);
		// Download and runtime start together; the session comes once both are done.
		expect(log.slice(0, 2).sort()).toEqual(['fetch models/parts/m.fp16.000', 'warm webgpu']);
		expect(log[2]).toBe('session webgpu fp16 64');
	});

	it('picks fp32 on the processor, and when the GPU lacks shader-f16', () => {
		expect(chooseVariant(manifest(), { task: 'denoise', backend: 'wasm', shaderF16: false }).variant.precision).toBe(
			'fp32',
		);
		expect(chooseVariant(manifest(), { task: 'denoise', backend: 'webgpu', shaderF16: false }).variant.precision).toBe(
			'fp32',
		);
	});

	it('sizes tiles from the model’s widest tensor and the device’s buffer limit', async () => {
		const small = await prepareModel(
			manifest(),
			{ task: 'denoise', backend: 'webgpu', shaderF16: true },
			adapters([], 64 * 2 ** 20),
		);
		// 64 channels × 2 bytes (fp16) = 128 B/px; 64 MiB × 0.9 fits a 686-px tile → 672.
		expect(tileCeiling(small, 768)).toBe(672);
		expect(tileCeiling(small, 768, 384)).toBe(384);
		const roomy = await prepareModel(manifest(), { task: 'denoise', backend: 'wasm', shaderF16: false }, adapters([]));
		expect(tileCeiling(roomy, 512)).toBe(512);
	});
});
