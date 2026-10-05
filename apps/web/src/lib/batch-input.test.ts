// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { byName, looksLikePhoto } from './batch-input';

describe('photos from a folder (§5.4)', () => {
	it('takes the formats Hush opens, whatever the case, and leaves RAW files, sidecars and hidden files', () => {
		for (const name of ['IMG_2041.JPG', 'a.jpeg', 'b.jpe', 'c.jfif', 'd.png', 'e.webp', 'f.HEIC', 'g.heif', 'h.avif']) {
			expect(looksLikePhoto(name), name).toBe(true);
		}
		for (const name of [
			'IMG_2041.CR3',
			'IMG_2041.xmp',
			'DSC_0001.NEF',
			'clip.mp4',
			'.IMG_2041.JPG',
			'notes.txt',
			'jpg',
		]) {
			expect(looksLikePhoto(name), name).toBe(false);
		}
	});

	it('orders photos as people read file names: IMG_2 before IMG_10, case aside', () => {
		const names = ['IMG_10.jpg', 'img_2.jpg', 'IMG_1.jpg', 'DSC_0100.jpg', 'dsc_0099.jpg'];
		expect(
			names
				.map((name) => ({ name }))
				.sort(byName)
				.map((f) => f.name),
		).toEqual(['dsc_0099.jpg', 'DSC_0100.jpg', 'IMG_1.jpg', 'img_2.jpg', 'IMG_10.jpg']);
	});
});
