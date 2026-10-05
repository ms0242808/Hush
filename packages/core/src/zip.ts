// SPDX-License-Identifier: Apache-2.0

/**
 * ZIP archives for batches in browsers that can't save to a folder (§2.8:
 * Safari, Firefox). Photos are already compressed, so entries are stored, not
 * deflated: the archive is the files themselves between small headers. That
 * lets the browser assemble a part from references to the encoded photos
 * (a Blob of headers and photos) without ever copying a gigabyte into one
 * buffer, and it keeps every offset predictable before a byte is written.
 *
 * Parts stay under 4 GiB, so plain ZIP fields suffice (no ZIP64). Names are
 * UTF-8, flagged as such, so 婚禮.jpg survives on every unzip tool.
 */

/** §2.8 🟡: each part at most 1 GB, downloaded as soon as it's complete. */
export const ZIP_PART_BYTES = 1_000_000_000;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** 2.0: what an archive of stored files needs to be read. */
const VERSION = 20;
/** General-purpose flag bit 11: the name is UTF-8. */
const UTF8_NAMES = 0x0800;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;

export interface ZipEntry {
	/** The name inside the archive; '/' separates folders. */
	name: string;
	size: number;
	crc32: number;
	/** When the file was made, as local wall-clock time (ZIP has no time zone). */
	modified: Date;
}

/** MS-DOS date and time, as ZIP stores them: two-second resolution, 1980–2107. */
export function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.min(2107, Math.max(1980, date.getFullYear()));
	if (year !== date.getFullYear()) return { time: 0, date: (1 << 5) | 1 }; // out of range: 1980-01-01
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/** UTF-8 bytes of a string (core has no TextEncoder: it is a platform API). */
export function utf8(text: string): Uint8Array {
	const out: number[] = [];
	for (const character of text) {
		const code = character.codePointAt(0)!;
		if (code < 0x80) out.push(code);
		else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
	}
	return Uint8Array.from(out);
}

function header(size: number, write: (view: DataView, bytes: Uint8Array) => void): Uint8Array {
	const bytes = new Uint8Array(size);
	write(new DataView(bytes.buffer), bytes);
	return bytes;
}

/** The bytes that go before an entry's data. */
export function localFileHeader(entry: ZipEntry): Uint8Array {
	const name = utf8(entry.name);
	const { time, date } = dosDateTime(entry.modified);
	return header(LOCAL_HEADER_BYTES + name.length, (view, bytes) => {
		view.setUint32(0, LOCAL_HEADER, true);
		view.setUint16(4, VERSION, true);
		view.setUint16(6, UTF8_NAMES, true);
		view.setUint16(8, 0, true); // stored
		view.setUint16(10, time, true);
		view.setUint16(12, date, true);
		view.setUint32(14, entry.crc32, true);
		view.setUint32(18, entry.size, true);
		view.setUint32(22, entry.size, true);
		view.setUint16(26, name.length, true);
		view.setUint16(28, 0, true);
		bytes.set(name, LOCAL_HEADER_BYTES);
	});
}

function centralHeader(entry: ZipEntry, offset: number): Uint8Array {
	const name = utf8(entry.name);
	const { time, date } = dosDateTime(entry.modified);
	return header(CENTRAL_HEADER_BYTES + name.length, (view, bytes) => {
		view.setUint32(0, CENTRAL_HEADER, true);
		view.setUint16(4, VERSION, true); // made by: MS-DOS attributes, version 2.0
		view.setUint16(6, VERSION, true);
		view.setUint16(8, UTF8_NAMES, true);
		view.setUint16(10, 0, true);
		view.setUint16(12, time, true);
		view.setUint16(14, date, true);
		view.setUint32(16, entry.crc32, true);
		view.setUint32(20, entry.size, true);
		view.setUint32(24, entry.size, true);
		view.setUint16(28, name.length, true);
		// extra, comment, disk, internal and external attributes: all zero
		view.setUint32(42, offset, true);
		bytes.set(name, CENTRAL_HEADER_BYTES);
	});
}

/** How many bytes an entry adds to an archive: its local header, data and central record. */
export function zipEntryBytes(name: string, size: number): number {
	const nameBytes = utf8(name).length;
	return LOCAL_HEADER_BYTES + nameBytes + size + CENTRAL_HEADER_BYTES + nameBytes;
}

/**
 * One ZIP part, written front to back: `add` returns the header to put
 * before each file's bytes, `finish` the central directory that ends the
 * archive. The caller keeps the file bytes; the writer only keeps offsets.
 */
export class ZipWriter {
	private readonly entries: { entry: ZipEntry; offset: number }[] = [];
	private offset = 0;

	/** Entries so far. */
	get count(): number {
		return this.entries.length;
	}

	/** The archive's size if it were finished now. */
	get bytes(): number {
		return this.entries.reduce((sum, { entry }) => sum + zipEntryBytes(entry.name, entry.size), END_BYTES);
	}

	/** Whether adding a file of this size would take the finished archive past `limit` bytes. */
	wouldExceed(name: string, size: number, limit: number): boolean {
		return this.bytes + zipEntryBytes(name, size) > limit;
	}

	add(entry: ZipEntry): Uint8Array {
		if (this.entries.length >= MAX_ENTRIES) throw new RangeError('A ZIP part holds at most 65,535 files');
		const local = localFileHeader(entry);
		if (this.offset + local.length + entry.size > MAX_OFFSET) throw new RangeError('A ZIP part must stay under 4 GiB');
		this.entries.push({ entry, offset: this.offset });
		this.offset += local.length + entry.size;
		return local;
	}

	/** The central directory and end record: the archive's last bytes. */
	finish(): Uint8Array {
		const records = this.entries.map(({ entry, offset }) => centralHeader(entry, offset));
		const size = records.reduce((sum, record) => sum + record.length, 0);
		const out = new Uint8Array(size + END_BYTES);
		let at = 0;
		for (const record of records) {
			out.set(record, at);
			at += record.length;
		}
		const view = new DataView(out.buffer);
		view.setUint32(at, END_OF_CENTRAL_DIRECTORY, true);
		// this disk and the directory's disk: 0
		view.setUint16(at + 8, this.entries.length, true);
		view.setUint16(at + 10, this.entries.length, true);
		view.setUint32(at + 12, size, true);
		view.setUint32(at + 16, this.offset, true);
		return out;
	}
}
