// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from '@hush/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const downloaded: { name: string; blob: Blob }[] = [];
vi.mock('./save.ts', () => ({ downloadBlob: (blob: Blob, name: string) => downloaded.push({ name, blob }) }));
const { BATCH_ZIP_PART_BYTES, ZipParts } = await import('./zip-parts');

const photo = (id: string, size: number) => {
	const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 7 + id.charCodeAt(0)) & 255);
	return { id, name: `${id}-denoised.jpg`, bytes, crc32: crc32(bytes), modified: new Date(2026, 9, 5, 12, 0, 0) };
};

describe('ZIP files in parts (§2.8)', () => {
	beforeEach(() => {
		downloaded.length = 0;
	});

	it('closes a part when the next photo wouldn’t fit, and downloads each as it’s done', () => {
		const parts: { name: string; ids: string[] }[] = [];
		// Each entry is 504 bytes with its headers: two fit in 1,100 with the end record; three don't.
		const zip = new ZipParts('Wedding-denoised', 1, (part) => parts.push(part), 1100);
		for (const id of ['a', 'b', 'c', 'd', 'e']) zip.add(photo(id, 400));
		expect(parts.map((p) => p.ids)).toEqual([
			['a', 'b'],
			['c', 'd'],
		]);
		expect(zip.pending).toEqual(['e']);
		expect(zip.partName).toBe('Wedding-denoised-3.zip');
		zip.flush();
		expect(parts.map((p) => p.name)).toEqual([
			'Wedding-denoised-1.zip',
			'Wedding-denoised-2.zip',
			'Wedding-denoised-3.zip',
		]);
		expect(downloaded.map((d) => d.name)).toEqual(parts.map((p) => p.name));
		expect(zip.flush()).toBeNull(); // nothing pending: nothing to download
		expect(zip.nextPart).toBe(4);
	});

	it('a photo larger than a part still gets a part of its own', () => {
		const parts: string[][] = [];
		const zip = new ZipParts('x', 1, (part) => parts.push(part.ids), 100);
		zip.add(photo('a', 500));
		zip.add(photo('b', 500));
		zip.flush();
		expect(parts).toEqual([['a'], ['b']]);
	});

	it('numbering carries on after a resume, and each part opens in an independent reader', async () => {
		const zip = new ZipParts('Shoot-denoised', 3, () => {}, 10_000);
		zip.add(photo('p', 3000));
		zip.add(photo('q', 2000));
		zip.flush();
		expect(downloaded.map((d) => d.name)).toEqual(['Shoot-denoised-3.zip']);
		const dir = mkdtempSync(path.join(tmpdir(), 'hush-parts-'));
		try {
			const file = path.join(dir, 'part.zip');
			writeFileSync(file, new Uint8Array(await downloaded[0]!.blob.arrayBuffer()));
			const script =
				'import json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps([[i.filename, i.file_size] for i in z.infolist()]))';
			expect(JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }))).toEqual([
				['p-denoised.jpg', 3000],
				['q-denoised.jpg', 2000],
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('parts stay under §2.8’s 1 GB', () => {
		expect(BATCH_ZIP_PART_BYTES).toBeLessThanOrEqual(1e9);
	});
});
