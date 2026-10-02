// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { adjustImage, NEUTRAL_ADJUST, RowAdjuster, type AdjustParams, type Image8 } from '../src/index.ts';

function randomImage(width: number, height: number, channels: 3 | 4, seed = 3): Image8 {
	const data = new Uint8Array(width * height * channels);
	let s = seed;
	for (let i = 0; i < data.length; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		data[i] = s >>> 24;
	}
	return { width, height, channels, data };
}

/** A "denoised" result: the original nudged by a smooth field plus a fine checker, as planar floats. */
function denoisedFor(image: Image8): Float32Array {
	const { width, height, channels, data } = image;
	const planes = new Float32Array(3 * width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const p = (y * width + x) * channels;
			const smooth = 20 * Math.sin(x / 7) * Math.cos(y / 5);
			const fine = (x + y) % 2 ? 6 : -6;
			for (let c = 0; c < 3; c++) {
				planes[c * width * height + y * width + x] = (data[p + c]! + smooth + fine + (c - 1) * 9) / 255;
			}
		}
	}
	return planes;
}

/** The adjust stage, straight from its definition, in float64, for comparison. */
function reference(image: Image8, denoised: Float32Array, params: AdjustParams): Image8 {
	const { width, height, channels, data } = image;
	const plane = width * height;
	const k = [1, 4, 6, 4, 1].map((v) => v / 16);
	const reflect = (i: number, n: number) => {
		if (n === 1) return 0;
		const period = 2 * (n - 1);
		let m = i % period;
		if (m < 0) m += period;
		return m < n ? m : period - m;
	};
	const delta = (c: number, x: number, y: number) =>
		denoised[c * plane + y * width + x]! * 255 - data[(y * width + x) * channels + c]!;
	const dY = (x: number, y: number) => 0.299 * delta(0, x, y) + 0.587 * delta(1, x, y) + 0.114 * delta(2, x, y);
	const out = new Uint8Array(data.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let blurred = 0;
			for (let j = -2; j <= 2; j++)
				for (let i = -2; i <= 2; i++)
					blurred += k[j + 2]! * k[i + 2]! * dY(reflect(x + i, width), reflect(y + j, height));
			const luminance = (1 - params.detail) * dY(x, y) + params.detail * blurred;
			const p = (y * width + x) * channels;
			for (let c = 0; c < 3; c++) {
				const v =
					data[p + c]! + params.strength * (params.luma * luminance + params.colour * (delta(c, x, y) - dY(x, y)));
				out[p + c] = Math.min(255, Math.max(0, Math.round(v)));
			}
			if (channels === 4) out[p + 3] = data[p + 3]!;
		}
	}
	return { width, height, channels, data: out };
}

const maxDifference = (a: Uint8Array, b: Uint8Array) =>
	a.reduce((worst, v, i) => Math.max(worst, Math.abs(v - b[i]!)), 0);

describe('the adjust stage (§2.5)', () => {
	const image = randomImage(53, 41, 4);
	const denoised = denoisedFor(image);

	const cases: AdjustParams[] = [
		NEUTRAL_ADJUST,
		{ strength: 0.7, luma: 0.8, colour: 1, detail: 0.3 },
		{ strength: 1, luma: 0, colour: 1, detail: 0 },
		{ strength: 1, luma: 1, colour: 0, detail: 1 },
		{ strength: 0.4, luma: 0.5, colour: 0.25, detail: 0.6 },
	];
	for (const params of cases) {
		it(`matches the definition to within rounding: ${JSON.stringify(params)}`, () => {
			expect(
				maxDifference(adjustImage(image, denoised, params).data, reference(image, denoised, params).data),
			).toBeLessThanOrEqual(1);
		});
	}

	it('neutral settings give the model’s output exactly', () => {
		const out = adjustImage(image, denoised, NEUTRAL_ADJUST);
		for (let i = 0; i < image.width * image.height; i++) {
			for (let c = 0; c < 3; c++) {
				expect(out.data[i * 4 + c]).toBe(
					Math.min(255, Math.max(0, Math.round(denoised[c * image.width * image.height + i]! * 255))),
				);
			}
		}
	});

	it('strength 0 keeps the original exactly, alpha included, whatever the other sliders say', () => {
		const out = adjustImage(image, denoised, { strength: 0, luma: 0.3, colour: 0.9, detail: 0.8 });
		expect(out.data).toEqual(image.data);
	});

	it('luminance 0 leaves brightness alone; colour 0 leaves colour alone', () => {
		// Mid-tones only, so no channel clips at 0 or 255.
		const image: Image8 = {
			...randomImage(53, 41, 4, 9),
			data: randomImage(53, 41, 4, 9).data.map((v) => 70 + (v % 110)),
		};
		const denoised = denoisedFor(image);
		const luma = (d: Uint8Array, p: number) => 0.299 * d[p]! + 0.587 * d[p + 1]! + 0.114 * d[p + 2]!;
		const noLuma = adjustImage(image, denoised, { strength: 1, luma: 0, colour: 1, detail: 0 });
		const noColour = adjustImage(image, denoised, { strength: 1, luma: 1, colour: 0, detail: 0 });
		for (let p = 0; p < image.data.length; p += 4) {
			expect(Math.abs(luma(noLuma.data, p) - luma(image.data, p))).toBeLessThan(1);
			// With colour off, every channel moves by the same amount: the pixel's colour differences stay put.
			const shift = noColour.data[p]! - image.data[p]!;
			expect(Math.abs(noColour.data[p + 1]! - image.data[p + 1]! - shift)).toBeLessThanOrEqual(1);
			expect(Math.abs(noColour.data[p + 2]! - image.data[p + 2]! - shift)).toBeLessThanOrEqual(1);
		}
	});

	it('detail brings fine texture back without touching the coarse correction', () => {
		// The model's change here is a smooth field plus a one-pixel checker; detail 1 keeps
		// mostly the smooth part, so the fine checker the model "removed" comes back.
		const fineEnergy = (out: Image8) => {
			let sum = 0;
			for (let p = 4; p < out.data.length; p += 4)
				sum += Math.abs(out.data[p]! - out.data[p - 4]! - (image.data[p]! - image.data[p - 4]!));
			return sum;
		};
		const none = adjustImage(image, denoised, NEUTRAL_ADJUST);
		const full = adjustImage(image, denoised, { ...NEUTRAL_ADJUST, detail: 1 });
		expect(fineEnergy(full)).toBeLessThan(fineEnergy(none) * 0.6);
	});

	it('streams: any split of the rows gives identical output', () => {
		const params = { strength: 0.8, luma: 0.9, colour: 0.6, detail: 0.5 };
		const whole = adjustImage(image, denoised, params);
		for (const chunk of [1, 2, 3, 7, 40]) {
			const out: Image8 = { ...image, data: new Uint8Array(image.data.length) };
			const adjuster = new RowAdjuster(image, out, params);
			const plane = image.width * image.height;
			for (let y0 = 0; y0 < image.height; y0 += chunk) {
				const y1 = Math.min(image.height, y0 + chunk);
				const planes = new Float32Array(3 * chunk * image.width);
				for (let c = 0; c < 3; c++) {
					planes.set(
						denoised.subarray(c * plane + y0 * image.width, c * plane + y1 * image.width),
						c * chunk * image.width,
					);
				}
				adjuster.push({ y0, y1, width: image.width, planes, planeStride: chunk * image.width });
			}
			adjuster.finish();
			expect(out.data, `chunks of ${chunk}`).toEqual(whole.data);
		}
	});

	it('can write over the original: in place equals a separate output', () => {
		const params = { strength: 0.9, luma: 1, colour: 0.7, detail: 0.4 };
		const separate = adjustImage(image, denoised, params);
		const copy: Image8 = { ...image, data: image.data.slice() };
		adjustImage(copy, denoised, params, copy);
		expect(copy.data).toEqual(separate.data);
	});

	it('handles one-pixel-high and one-pixel-wide photos, RGB as well as RGBA', () => {
		for (const [w, h] of [
			[1, 1],
			[9, 1],
			[1, 9],
			[2, 2],
		] as const) {
			const small = randomImage(w, h, 3, w * 10 + h);
			const result = adjustImage(small, denoisedFor(small), { strength: 1, luma: 1, colour: 1, detail: 0.5 });
			expect(
				maxDifference(
					result.data,
					reference(small, denoisedFor(small), { strength: 1, luma: 1, colour: 1, detail: 0.5 }).data,
				),
			).toBeLessThanOrEqual(1);
		}
	});

	it('refuses rows out of order and an early finish', () => {
		const adjuster = new RowAdjuster(image, { ...image, data: new Uint8Array(image.data.length) }, NEUTRAL_ADJUST);
		expect(() =>
			adjuster.push({
				y0: 2,
				y1: 3,
				width: image.width,
				planes: new Float32Array(3 * image.width),
				planeStride: image.width,
			}),
		).toThrow(RangeError);
		expect(() => adjuster.finish()).toThrow(RangeError);
	});
});
