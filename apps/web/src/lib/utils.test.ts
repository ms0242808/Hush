// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { formatMegabytes, outputName } from './utils';

describe('outputName (§2.6: name-denoised.ext)', () => {
	it.each([
		['IMG_2041.JPG', 'IMG_2041-denoised.jpg'],
		['wedding.reception.png', 'wedding.reception-denoised.jpg'],
		['photo', 'photo-denoised.jpg'],
		['.hidden', '.hidden-denoised.jpg'],
	])('%s → %s', (input, expected) => {
		expect(outputName(input)).toBe(expected);
	});
});

describe('formatMegabytes', () => {
	it('quotes download sizes in whole decimal megabytes', () => {
		expect(formatMegabytes(59_264_286, 'en')).toBe('59 MB');
		expect(formatMegabytes(2_500_000, 'en')).toBe('2.5 MB');
	});
});
