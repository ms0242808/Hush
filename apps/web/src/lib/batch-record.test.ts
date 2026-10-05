// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseBatchRecord, remaining, sameFile, type BatchRecord } from './batch-record';

const record = (): BatchRecord => ({
	schema: 1,
	id: 'b1',
	updatedAt: 1_760_000_000_000,
	source: { kind: 'folder', name: 'Wedding' },
	destination: { kind: 'folder', name: 'Wedding/denoised', inside: 'denoised' },
	params: { strength: 0.7, luma: 0.8, colour: 1, detail: 0.3 },
	settings: { format: 'auto', quality: 95, suffix: '-denoised', removeLocation: false },
	items: [
		{ name: 'IMG_0001.JPG', size: 12_000_000, lastModified: 1, output: 'IMG_0001-denoised.JPG', done: true },
		{ name: 'IMG_0002.JPG', size: 11_000_000, lastModified: 2, output: 'IMG_0002-denoised.JPG', done: false },
	],
});

describe('the batch record (§2.7)', () => {
	it('reads back what it wrote, and counts what is left', () => {
		const parsed = parseBatchRecord(JSON.parse(JSON.stringify(record())));
		expect(parsed).toEqual(record());
		expect(remaining(parsed!)).toBe(1);
	});

	it('treats anything else as no record: another version, missing fields, broken items, an empty batch', () => {
		expect(parseBatchRecord(null)).toBeNull();
		expect(parseBatchRecord('batch')).toBeNull();
		expect(parseBatchRecord({ ...record(), schema: 2 })).toBeNull();
		expect(parseBatchRecord({ ...record(), params: undefined })).toBeNull();
		expect(parseBatchRecord({ ...record(), items: [] })).toBeNull();
		expect(parseBatchRecord({ ...record(), items: [{ name: 'a.jpg', size: 'big' }] })).toBeNull();
		expect(parseBatchRecord({ ...record(), source: { kind: 'cloud' } })).toBeNull();
	});

	it('knows a photo again by its name, size and time, not by name alone', () => {
		const item = record().items[0]!;
		const same = { name: 'IMG_0001.JPG', size: 12_000_000, lastModified: 1 } as File;
		expect(sameFile(item, same)).toBe(true);
		expect(sameFile(item, { ...same, size: 12_000_001 })).toBe(false);
		expect(sameFile(item, { ...same, lastModified: 9 })).toBe(false);
	});
});
