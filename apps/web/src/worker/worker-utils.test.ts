// SPDX-License-Identifier: Apache-2.0
import type { Image8 } from '@hush/core';
import { describe, expect, it } from 'vitest';
import { sniffFormat } from './codecs';
import { clampRect, cropImage, MAX_PREVIEW_SIDE, psnr } from './pixels';
import { isFinitePrefix } from './validate';

describe('sniffFormat: by content, never by name', () => {
	const bytes = (...values: number[]) => Uint8Array.from(values);
	const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

	it('recognises JPEG, PNG and WebP', () => {
		expect(sniffFormat(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
		expect(sniffFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe('png');
		expect(sniffFormat(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
	});

	it('rejects anything else, and short files', () => {
		expect(sniffFormat(ascii('This is text'))).toBeNull();
		expect(sniffFormat(ascii('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
		expect(sniffFormat(bytes(0xff))).toBeNull();
	});
});

describe('isFinitePrefix', () => {
	it('accepts finite output and refuses NaN or infinity', () => {
		expect(isFinitePrefix(new Float32Array(5000).fill(0.5))).toBe(true);
		expect(isFinitePrefix(new Float32Array(5000).fill(Number.NaN))).toBe(false);
		const last = new Float32Array(5000).fill(0.5);
		last[4999] = Infinity;
		expect(isFinitePrefix(last)).toBe(false);
		expect(isFinitePrefix(new Float32Array(0))).toBe(true);
	});
});

describe('preview crops', () => {
	const image = (width: number, height: number): Image8 => ({
		width,
		height,
		channels: 4,
		data: Uint8Array.from({ length: width * height * 4 }, (_, i) => i % 256),
	});

	it('clamps to the image and never exceeds the preview limit', () => {
		expect(clampRect(image(100, 50), { x: -10, y: 40, width: 500, height: 30 })).toEqual({
			x: 0,
			y: 20,
			width: 100,
			height: 30,
		});
		const huge = { width: 10_000, height: 10, channels: 4 as const, data: new Uint8Array(0) };
		expect(clampRect(huge, { x: 0, y: 0, width: 10_000, height: 10 }).width).toBe(MAX_PREVIEW_SIDE);
	});

	it('copies exactly the requested region', () => {
		const source = image(4, 3);
		const crop = cropImage(source, { x: 1, y: 1, width: 2, height: 2 });
		expect(Array.from(crop.data.subarray(0, 4))).toEqual(Array.from(source.data.subarray(20, 24)));
		expect(psnr(source, source)).toEqual({ psnr: Infinity, maxDiff: 0 });
	});
});
