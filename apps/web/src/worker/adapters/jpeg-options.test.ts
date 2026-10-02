// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { FULL_CHROMA_MAX_MEGAPIXELS, jpegOptions } from './jpeg-options';

describe('JPEG encoder settings', () => {
	it('baseline with optimised Huffman tables, like camera and Lightroom files', () => {
		expect(jpegOptions(95, 24)).toMatchObject({
			quality: 95,
			progressive: false,
			optimize_coding: true,
			auto_subsample: false,
		});
	});

	it('keeps full-resolution colour at quality 90 and up, while the encoder has room for it', () => {
		expect(jpegOptions(95, 45).chroma_subsample).toBe(1);
		expect(jpegOptions(90, FULL_CHROMA_MAX_MEGAPIXELS).chroma_subsample).toBe(1);
		expect(jpegOptions(89, 24).chroma_subsample).toBe(2);
	});

	it('falls back to 4:2:0 for photos too big for 4:4:4 in a 2 GiB heap, or when asked to', () => {
		expect(jpegOptions(95, 102).chroma_subsample).toBe(2);
		expect(jpegOptions(95, 24, false).chroma_subsample).toBe(2);
	});
});
