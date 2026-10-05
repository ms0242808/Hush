// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { diagnosticsText, recordError, type Diagnostics } from './diagnostics';
import { roundDuration } from './duration';

const base: Diagnostics = {
	version: '0.2.0',
	browser: 'Google Chrome 154',
	platform: 'macOS',
	language: 'zh-Hant',
	situation: 'webgpu',
	adapter: 'apple · metal-3',
	shaderF16: true,
	webglRenderer: null,
	crossOriginIsolated: true,
	cores: 10,
	deviceMemory: 8,
	processing: {
		setting: 'auto',
		backend: 'webgpu',
		model: 'nafnet-sidd-w32',
		precision: 'fp16',
		threads: 1,
		exportTile: 768,
		previewTile: 512,
		modelFromCache: true,
	},
	photo: { format: 'jpeg', megapixels: 45.44, bitDepth: 8, colour: 'icc', orientation: 6 },
	timings: [
		{ label: 'decode', ms: 1820 },
		{ label: 'export', ms: 87_012 },
	],
	errors: [],
};

describe('Copy diagnostics (§4.7, §5.12)', () => {
	it('explains the machine, the situation and the run', () => {
		const text = diagnosticsText(base);
		expect(text).toContain('Hush 0.2.0 · zh-Hant');
		expect(text).toContain('Graphics (§2.10 situation): webgpu · adapter: apple · metal-3 · shader-f16: yes');
		expect(text).toContain('Processing: auto → webgpu · nafnet-sidd-w32 fp16 · tiles: 768 (preview 512)');
		expect(text).toContain('Photo: jpeg · 45.4 MP · 8-bit · colour: icc · orientation 6');
		expect(text).toContain('Timings: decode 1.82 s · export 87.0 s');
		expect(text).toContain('Errors: none');
	});

	it('counts a batch, without a single file or folder name', () => {
		const text = diagnosticsText({
			...base,
			batch: {
				photos: 100,
				megapixels: 4544.2,
				destination: 'folder',
				saved: 47,
				failed: 1,
				skipped: 50,
				secondsPerPhoto: 92.84,
			},
		});
		expect(text).toContain(
			'Batch: 100 photos · 4544 MP · to folder · 47 saved, 1 failed, 50 skipped · 92.8 s per photo',
		);
	});

	it('records errors by name and code, never by message (messages can quote a file name)', () => {
		const tooLarge = Object.assign(new Error('IMG_2041.JPG is too large'), { name: 'PhotoTooLargeError' });
		const memory = Object.assign(new Error('out of memory at IMG_2041.JPG'), {
			name: 'InferenceError',
			kind: 'out-of-memory',
		});
		let errors = recordError([], tooLarge);
		errors = recordError(errors, memory);
		errors = recordError(errors, memory);
		const text = diagnosticsText({ ...base, errors });
		expect(text).toContain('Errors: PhotoTooLargeError ×1, InferenceError (out-of-memory) ×2');
		expect(text).not.toContain('IMG_2041');
	});

	it('says what it doesn’t know rather than guessing', () => {
		const text = diagnosticsText({
			...base,
			situation: 'unknown',
			shaderF16: null,
			deviceMemory: null,
			photo: null,
			timings: [],
			processing: {
				...base.processing,
				backend: null,
				model: null,
				precision: null,
				exportTile: null,
				modelFromCache: null,
			},
		});
		expect(text).toContain('shader-f16: unknown');
		expect(text).toContain('memory: unknown');
		expect(text).toContain('Processing: auto → not started · not loaded');
		expect(text).not.toContain('Photo:');
	});
});

describe('durations people can plan around (§2.7)', () => {
	it.each([
		[3_000, { unit: 'few' }],
		[12_000, { unit: 'seconds', count: 10 }],
		[47_000, { unit: 'seconds', count: 45 }],
		[58_000, { unit: 'minutes', count: 1 }],
		[6 * 60_000 + 20_000, { unit: 'minutes', count: 6 }],
		[23 * 60_000, { unit: 'minutes', count: 25 }],
		[58 * 60_000, { unit: 'hours', hours: 1, minutes: 0 }],
		[(3 * 60 + 38) * 60_000, { unit: 'hours', hours: 3, minutes: 40 }],
		[(13 * 60 + 56) * 60_000, { unit: 'hours', hours: 14, minutes: 0 }],
	])('%d ms → %o', (ms, expected) => {
		expect(roundDuration(ms)).toEqual(expected);
	});
});
