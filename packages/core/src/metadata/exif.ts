// SPDX-License-Identifier: Apache-2.0
import {
	concatBytes,
	latin1,
	latin1String,
	setU16be,
	setU16le,
	setU32be,
	setU32le,
	u16be,
	u16le,
	u32be,
	u32le,
} from '../bytes.ts';
import type { Bytes } from '../types.ts';
import type { MetadataWarning } from './warnings.ts';

/**
 * EXIF is a TIFF structure: a header, then IFDs (tag directories) whose
 * entries hold small values inline and point at larger ones by offset from
 * the start of the block.
 *
 * Hush edits it without ever moving an existing byte. Maker notes — where
 * cameras keep lens, focus and shutter-count data — often contain their own
 * offsets relative to the block, and any tool that rebuilds the structure
 * breaks them. So values change in place, new data is appended, and when
 * IFD0 needs another entry it is copied to the end and the header repointed.
 */

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const EXIF_TAG = {
	orientation: 0x0112,
	software: 0x0131,
	subIfds: 0x014a,
	exifIfd: 0x8769,
	gpsIfd: 0x8825,
	interopIfd: 0xa005,
	pixelXDimension: 0xa002,
	pixelYDimension: 0xa003,
} as const;

/** The largest TIFF block a JPEG APP1 segment holds: 65535 − 2 (length) − 6 ("Exif\0\0"). */
export const JPEG_EXIF_MAX_BYTES = 65527;

const TYPE_BYTES: Record<number, number> = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	6: 1,
	7: 1,
	8: 2,
	9: 4,
	10: 8,
	11: 4,
	12: 8,
	13: 4,
};
const SHORT = 3;
const LONG = 4;
const ASCII = 2;
const IFD_TYPE = 13;
/** No real IFD has more entries than this; a bigger count means a corrupt block. */
const MAX_ENTRIES = 1024;

export class ExifError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ExifError';
	}
}

interface Entry {
	tag: number;
	type: number;
	count: number;
	/** The 4-byte value field: the value itself when it fits, otherwise its offset. */
	field: Bytes;
	/** Where the value lives in the block. */
	valueAt: number;
	byteLength: number;
}

interface Ifd {
	at: number;
	entries: Entry[];
	/** Offset of the next-IFD pointer, and its value (0 when there is none). */
	nextAt: number;
	next: number;
}

class Tiff {
	readonly bytes: Bytes;
	readonly little: boolean;
	constructor(bytes: Bytes) {
		this.bytes = bytes;
		if (bytes.byteLength < 8) throw new ExifError('EXIF block is shorter than a TIFF header');
		const order = latin1String(bytes, 0, 2);
		if (order !== 'II' && order !== 'MM') throw new ExifError(`Unknown byte order "${order}"`);
		this.little = order === 'II';
		if (this.u16(2) !== 42) throw new ExifError('Not a TIFF header');
	}

	private check(at: number, length: number): void {
		if (at < 0 || at + length > this.bytes.byteLength) {
			throw new ExifError(`Offset ${at} + ${length} is outside the ${this.bytes.byteLength}-byte block`);
		}
	}

	u16(at: number): number {
		this.check(at, 2);
		return this.little ? u16le(this.bytes, at) : u16be(this.bytes, at);
	}

	u32(at: number): number {
		this.check(at, 4);
		return this.little ? u32le(this.bytes, at) : u32be(this.bytes, at);
	}

	get ifd0(): number {
		return this.u32(4);
	}

	readIfd(at: number): Ifd {
		if (at < 8) throw new ExifError(`IFD offset ${at} points into the header`);
		const count = this.u16(at);
		if (count > MAX_ENTRIES) throw new ExifError(`IFD at ${at} claims ${count} entries`);
		this.check(at + 2, count * 12);
		const entries: Entry[] = [];
		for (let i = 0; i < count; i++) {
			const e = at + 2 + i * 12;
			const type = this.u16(e + 2);
			const valueCount = this.u32(e + 4);
			const byteLength = (TYPE_BYTES[type] ?? 0) * valueCount;
			const field = this.bytes.slice(e + 8, e + 12);
			entries.push({
				tag: this.u16(e),
				type,
				count: valueCount,
				field,
				valueAt: byteLength <= 4 ? e + 8 : this.u32(e + 8),
				byteLength,
			});
		}
		const nextAt = at + 2 + count * 12;
		// Some writers end the block right after the last IFD's entries; treat that as "no next IFD".
		const next = nextAt + 4 <= this.bytes.byteLength ? this.u32(nextAt) : 0;
		return { at, entries, nextAt, next };
	}

	/** The value of a SHORT or LONG entry with count 1. */
	uint(entry: Entry): number | null {
		if (entry.count !== 1) return null;
		if (entry.type === SHORT) return this.little ? u16le(entry.field, 0) : u16be(entry.field, 0);
		if (entry.type === LONG || entry.type === IFD_TYPE)
			return this.little ? u32le(entry.field, 0) : u32be(entry.field, 0);
		return null;
	}

	/** The 4-byte value field for a SHORT or LONG. */
	field(type: number, value: number): Bytes {
		const field = new Uint8Array(4);
		if (type === SHORT) (this.little ? setU16le : setU16be)(field, 0, value);
		else (this.little ? setU32le : setU32be)(field, 0, value);
		return field;
	}
}

function tryRead(bytes: Bytes): { tiff: Tiff; ifd0: Ifd } | null {
	try {
		const tiff = new Tiff(bytes);
		return { tiff, ifd0: tiff.readIfd(tiff.ifd0) };
	} catch {
		return null;
	}
}

/** The EXIF orientation (1–8), or null when absent, invalid or unreadable. */
export function readOrientation(exif: Bytes): Orientation | null {
	const read = tryRead(exif);
	const entry = read?.ifd0.entries.find((e) => e.tag === EXIF_TAG.orientation);
	const value = entry ? read!.tiff.uint(entry) : null;
	return value !== null && value >= 1 && value <= 8 ? (value as Orientation) : null;
}

/** Whether IFD0 points at a GPS directory. */
export function hasGps(exif: Bytes): boolean {
	return tryRead(exif)?.ifd0.entries.some((e) => e.tag === EXIF_TAG.gpsIfd) ?? false;
}

/** The ASCII value of an IFD0 tag, for tests and diagnostics. */
export function readAscii(exif: Bytes, tag: number): string | null {
	const read = tryRead(exif);
	const entry = read?.ifd0.entries.find((e) => e.tag === tag && e.type === ASCII);
	if (!entry || entry.valueAt + entry.byteLength > exif.byteLength) return null;
	return latin1String(exif, entry.valueAt, entry.valueAt + entry.byteLength).replace(/\0+$/, '');
}

/**
 * The end of everything still referenced once IFD1 (the thumbnail) is
 * unlinked: IFD0, the EXIF, GPS and interoperability directories and every
 * value they point at, maker notes included.
 */
function liveEnd(tiff: Tiff, ifd0: Ifd, skipGps: boolean): number {
	let end = 8;
	const seen = new Set<number>();
	const visit = (ifd: Ifd, depth: number) => {
		end = Math.max(end, ifd.nextAt + 4);
		for (const entry of ifd.entries) {
			if (entry.byteLength > 4) end = Math.max(end, entry.valueAt + entry.byteLength);
			const pointer =
				entry.tag === EXIF_TAG.exifIfd ||
				entry.tag === EXIF_TAG.interopIfd ||
				(entry.tag === EXIF_TAG.gpsIfd && !skipGps);
			if (pointer && depth < 3) {
				const at = tiff.uint(entry);
				if (at !== null && !seen.has(at)) {
					seen.add(at);
					try {
						visit(tiff.readIfd(at), depth + 1);
					} catch {
						// A broken sub-directory: nothing of it to keep alive.
					}
				}
			}
		}
	};
	visit(ifd0, 0);
	return Math.min(end, tiff.bytes.byteLength);
}

/** Zero a directory and every value it points at, so the data is gone, not just unlinked. */
function wipeIfd(tiff: Tiff, at: number): void {
	let ifd: Ifd;
	try {
		ifd = tiff.readIfd(at);
	} catch {
		return;
	}
	for (const entry of ifd.entries) {
		if (entry.byteLength > 4 && entry.valueAt >= 8 && entry.valueAt + entry.byteLength <= tiff.bytes.byteLength) {
			tiff.bytes.fill(0, entry.valueAt, entry.valueAt + entry.byteLength);
		}
	}
	tiff.bytes.fill(0, at, Math.min(tiff.bytes.byteLength, ifd.nextAt + 4));
}

export interface ExifEdit {
	/** The `Software` tag (§2.6: APP_NAME). */
	software?: string;
	/** Set Orientation (added when missing). */
	orientation?: Orientation;
	/** Remove the GPS directory and wipe its data. */
	removeLocation?: boolean;
	/** Correct PixelXDimension/PixelYDimension when they're present. */
	dimensions?: { width: number; height: number };
	/** Fit within this many bytes (a JPEG segment), dropping the thumbnail if that's what it takes. */
	maxBytes?: number;
}

export interface ExifEditResult {
	/** The edited block, or null when it had to be left out. */
	exif: Bytes | null;
	warnings: MetadataWarning[];
}

/** Apply `edit` to an EXIF (TIFF) block. The input is never modified. */
export function editExif(source: Bytes, edit: ExifEdit): ExifEditResult {
	const first = applyEdit(source, edit, false);
	if (first.exif === null || edit.maxBytes === undefined || first.exif.byteLength <= edit.maxBytes) return first;
	const smaller = applyEdit(source, edit, true);
	if (smaller.exif !== null && smaller.exif.byteLength <= edit.maxBytes) return smaller;
	return { exif: null, warnings: [...first.warnings, 'exif-too-large'] };
}

function applyEdit(source: Bytes, edit: ExifEdit, dropThumbnail: boolean): ExifEditResult {
	const read = tryRead(source.slice());
	if (!read) {
		// Can't be edited safely. Location has to go, so the block goes; otherwise it travels untouched.
		if (edit.removeLocation) return { exif: null, warnings: ['exif-unreadable'] };
		return { exif: source, warnings: ['exif-unreadable'] };
	}
	const warnings: MetadataWarning[] = [];
	let { tiff, ifd0 } = read;

	if (dropThumbnail && ifd0.next !== 0) {
		tiff.bytes.fill(0, ifd0.nextAt, ifd0.nextAt + 4);
		const end = liveEnd(tiff, ifd0, edit.removeLocation === true);
		tiff = new Tiff(tiff.bytes.slice(0, Math.max(end, ifd0.nextAt + 4)));
		ifd0 = tiff.readIfd(tiff.ifd0);
		warnings.push('exif-thumbnail-dropped');
	}

	const appended: Bytes[] = [];
	let length = tiff.bytes.byteLength;
	/** Append data on a word boundary (TIFF offsets must be even) and return its offset. */
	const append = (data: Bytes): number => {
		if (length % 2 === 1) {
			appended.push(new Uint8Array(1));
			length++;
		}
		const at = length;
		appended.push(data);
		length += data.byteLength;
		return at;
	};

	let entries = ifd0.entries.map((e) => ({ ...e }));

	if (edit.removeLocation) {
		const gps = entries.find((e) => e.tag === EXIF_TAG.gpsIfd);
		const at = gps ? tiff.uint(gps) : null;
		if (at !== null) wipeIfd(tiff, at);
		entries = entries.filter((e) => e.tag !== EXIF_TAG.gpsIfd);
	}

	if (edit.dimensions) {
		const exifEntry = entries.find((e) => e.tag === EXIF_TAG.exifIfd);
		const at = exifEntry ? tiff.uint(exifEntry) : null;
		if (at !== null) {
			try {
				const exifIfd = tiff.readIfd(at);
				for (const [tag, value] of [
					[EXIF_TAG.pixelXDimension, edit.dimensions.width],
					[EXIF_TAG.pixelYDimension, edit.dimensions.height],
				] as const) {
					const index = exifIfd.entries.findIndex((e) => e.tag === tag);
					const entry = exifIfd.entries[index];
					if (!entry || entry.count !== 1 || (entry.type !== SHORT && entry.type !== LONG)) continue;
					if (entry.type === SHORT && value > 0xffff) continue;
					tiff.bytes.set(tiff.field(entry.type, value), at + 2 + index * 12 + 8);
				}
			} catch {
				// An unreadable EXIF directory keeps whatever it says.
			}
		}
	}

	const upsert = (tag: number, type: number, count: number, field: Bytes) => {
		const entry = { tag, type, count, field, valueAt: 0, byteLength: 0 };
		const index = entries.findIndex((e) => e.tag === tag);
		if (index >= 0) entries[index] = entry;
		else entries.push(entry);
	};

	if (edit.orientation !== undefined) {
		upsert(EXIF_TAG.orientation, SHORT, 1, tiff.field(SHORT, edit.orientation));
	}

	if (edit.software !== undefined) {
		const value = latin1(`${edit.software}\0`);
		const field = new Uint8Array(4);
		if (value.byteLength <= 4) field.set(value);
		else field.set(tiff.field(LONG, append(value)));
		upsert(EXIF_TAG.software, ASCII, value.byteLength, field);
	}

	entries.sort((a, b) => a.tag - b.tag);
	const directory = new Uint8Array(2 + entries.length * 12 + 4);
	const put16 = tiff.little ? setU16le : setU16be;
	const put32 = tiff.little ? setU32le : setU32be;
	put16(directory, 0, entries.length);
	entries.forEach((entry, i) => {
		const e = 2 + i * 12;
		put16(directory, e, entry.tag);
		put16(directory, e + 2, entry.type);
		put32(directory, e + 4, entry.count);
		directory.set(entry.field, e + 8);
	});
	put32(directory, directory.byteLength - 4, dropThumbnail ? 0 : ifd0.next);

	const oldSize = ifd0.nextAt + 4 - ifd0.at;
	if (directory.byteLength <= oldSize) {
		tiff.bytes.fill(0, ifd0.at, ifd0.at + oldSize);
		tiff.bytes.set(directory, ifd0.at);
	} else {
		tiff.bytes.fill(0, ifd0.at, Math.min(tiff.bytes.byteLength, ifd0.at + oldSize));
		put32(tiff.bytes, 4, append(directory));
	}

	return { exif: appended.length > 0 ? concatBytes([tiff.bytes, ...appended]) : tiff.bytes, warnings };
}

/** A minimal EXIF block for a photo that had none: IFD0 with Orientation and Software. */
export function createExif(options: { orientation?: Orientation; software?: string }): Bytes {
	const header = latin1('II*\0\x08\0\0\0');
	const empty = concatBytes([header, new Uint8Array([0, 0, 0, 0, 0, 0])]); // IFD0 with no entries, no next IFD
	return editExif(empty, {
		...(options.orientation !== undefined && { orientation: options.orientation }),
		...(options.software !== undefined && { software: options.software }),
	}).exif!;
}
