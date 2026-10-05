// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, dosDateTime, utf8, ZIP_PART_BYTES, zipEntryBytes, ZipWriter } from '../src/index.ts';

const text = (value: string) => Uint8Array.from(Buffer.from(value, 'utf8'));

/** A part as the browser assembles it: header, file, header, file, …, central directory. */
function assemble(files: { name: string; bytes: Uint8Array }[], modified = new Date(2026, 9, 5, 14, 30, 22)) {
	const writer = new ZipWriter();
	const pieces: Uint8Array[] = [];
	for (const file of files) {
		pieces.push(writer.add({ name: file.name, size: file.bytes.length, crc32: crc32(file.bytes), modified }));
		pieces.push(file.bytes);
	}
	pieces.push(writer.finish());
	return { bytes: Buffer.concat(pieces), writer };
}

describe('CRC-32', () => {
	it('matches the standard check value and Node’s own zlib', () => {
		expect(crc32(text('123456789'))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
		const random = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 2654435761) >>> 24);
		expect(crc32(random)).toBe(nodeCrc32(random));
	});

	it('runs across chunks', () => {
		const whole = text('a photo, in two pieces');
		expect(crc32(whole.subarray(0, 8), whole.subarray(8))).toBe(crc32(whole));
	});
});

describe('ZIP parts (§2.8)', () => {
	it('names are UTF-8, so Traditional Chinese names survive', () => {
		expect(utf8('婚禮-denoised.jpg')).toEqual(text('婚禮-denoised.jpg'));
		expect(utf8('📷 é')).toEqual(text('📷 é'));
	});

	it('stores DOS time at two-second resolution, and clamps years ZIP can’t hold', () => {
		const { time, date } = dosDateTime(new Date(2026, 9, 5, 14, 30, 23));
		expect(time).toBe((14 << 11) | (30 << 5) | 11);
		expect(date).toBe((46 << 9) | (10 << 5) | 5);
		expect(dosDateTime(new Date(1975, 0, 1))).toEqual({ time: 0, date: 33 });
	});

	it('an independent reader (Python’s zipfile) opens it, checks every CRC and reads the files back', () => {
		const files = [
			{ name: 'IMG_2041-denoised.jpg', bytes: Uint8Array.from({ length: 5000 }, (_, i) => i % 251) },
			{ name: '婚禮 001-denoised.jpg', bytes: text('second photo') },
			{ name: 'empty.png', bytes: new Uint8Array(0) },
		];
		const { bytes, writer } = assemble(files);
		expect(bytes.length).toBe(writer.bytes);
		const dir = mkdtempSync(path.join(tmpdir(), 'hush-zip-'));
		try {
			const file = path.join(dir, 'part-1.zip');
			writeFileSync(file, bytes);
			const script = [
				'import json, sys, zipfile, hashlib',
				'z = zipfile.ZipFile(sys.argv[1])',
				'assert z.testzip() is None',
				'print(json.dumps([[i.filename, i.compress_type, i.file_size, i.date_time, hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()]))',
			].join('\n');
			const read = JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' })) as [
				string,
				number,
				number,
				number[],
				string,
			][];
			const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
			expect(read).toEqual(files.map((f) => [f.name, 0, f.bytes.length, [2026, 10, 5, 14, 30, 22], sha(f.bytes)]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('knows a part’s size before it is written, and when the next photo would take it past the limit', () => {
		const writer = new ZipWriter();
		expect(writer.bytes).toBe(22);
		writer.add({ name: 'a.jpg', size: 900, crc32: 0, modified: new Date(2026, 0, 1) });
		expect(writer.bytes).toBe(22 + zipEntryBytes('a.jpg', 900));
		expect(zipEntryBytes('a.jpg', 900)).toBe(30 + 5 + 900 + 46 + 5);
		expect(writer.wouldExceed('b.jpg', 100, writer.bytes + zipEntryBytes('b.jpg', 100))).toBe(false);
		expect(writer.wouldExceed('b.jpg', 101, writer.bytes + zipEntryBytes('b.jpg', 100))).toBe(true);
		expect(ZIP_PART_BYTES).toBe(1e9);
	});

	it('refuses to grow past what plain ZIP fields can describe', () => {
		const writer = new ZipWriter();
		writer.add({ name: 'big.jpg', size: 0xffff0000, crc32: 0, modified: new Date(2026, 0, 1) });
		expect(() => writer.add({ name: 'more.jpg', size: 0x10000, crc32: 0, modified: new Date(2026, 0, 1) })).toThrow(
			/4 GiB/,
		);
	});
});
