// SPDX-License-Identifier: Apache-2.0
/**
 * A deliberately simple TIFF/EXIF writer for tests, independent of the code
 * under test: it lays IFDs and their values out one after another, the way
 * cameras do, so tests can check that edits leave everything else in place.
 */

export const BYTE = 1;
export const ASCII = 2;
export const SHORT = 3;
export const LONG = 4;
export const RATIONAL = 5;
export const UNDEFINED = 7;

export interface TiffValue {
	tag: number;
	type: number;
	values: number[] | string | Uint8Array;
}

export interface TiffSpec {
	little?: boolean;
	ifd0: TiffValue[];
	exif?: TiffValue[];
	gps?: TiffValue[];
	/** IFD1 entries, e.g. thumbnail compression. */
	ifd1?: TiffValue[];
	thumbnail?: Uint8Array;
}

const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function count(value: TiffValue): number {
	if (value.type === ASCII) return (value.values as string).length + 1;
	if (value.type === RATIONAL) return (value.values as number[]).length / 2;
	return value.values.length;
}

function encode(value: TiffValue, little: boolean): Uint8Array {
	const bytes = new Uint8Array(SIZE[value.type]! * count(value));
	const view = new DataView(bytes.buffer);
	if (value.type === ASCII) {
		const text = value.values as string;
		for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
	} else if (value.type === BYTE || value.type === UNDEFINED) {
		bytes.set(value.values as Uint8Array | number[]);
	} else {
		const values = value.values as number[];
		values.forEach((v, i) => {
			if (value.type === SHORT) view.setUint16(i * 2, v, little);
			else view.setUint32(i * 4, v, little);
		});
	}
	return bytes;
}

interface Directory {
	entries: TiffValue[];
	at: number;
	valuesAt: number[];
	end: number;
}

export function buildTiff(spec: TiffSpec): Uint8Array {
	const little = spec.little ?? true;
	const sorted = (entries: TiffValue[]) => [...entries].sort((a, b) => a.tag - b.tag);
	const ifd0: TiffValue[] = [...spec.ifd0];
	if (spec.exif) ifd0.push({ tag: 0x8769, type: LONG, values: [0] });
	if (spec.gps) ifd0.push({ tag: 0x8825, type: LONG, values: [0] });
	const ifd1: TiffValue[] | null = spec.ifd1 || spec.thumbnail ? [...(spec.ifd1 ?? [])] : null;
	if (ifd1 && spec.thumbnail) {
		ifd1.push({ tag: 0x0201, type: LONG, values: [0] }, { tag: 0x0202, type: LONG, values: [spec.thumbnail.length] });
	}

	const lists = [
		sorted(ifd0),
		spec.exif ? sorted(spec.exif) : null,
		spec.gps ? sorted(spec.gps) : null,
		ifd1 ? sorted(ifd1) : null,
	];
	// Layout: header, then each directory followed by its out-of-line values, then the thumbnail.
	let offset = 8;
	const dirs: Array<Directory | null> = lists.map((entries) => {
		if (!entries) return null;
		const at = offset;
		offset += 2 + entries.length * 12 + 4;
		const valuesAt = entries.map((entry) => {
			const size = SIZE[entry.type]! * count(entry);
			if (size <= 4) return -1;
			const here = offset;
			offset += size + (size % 2);
			return here;
		});
		return { entries, at, valuesAt, end: offset };
	});
	const thumbnailAt = offset;
	if (spec.thumbnail) offset += spec.thumbnail.length;

	const [d0, dExif, dGps, d1] = dirs;
	const pointer = (tag: number) =>
		tag === 0x8769 ? dExif!.at : tag === 0x8825 ? dGps!.at : tag === 0x0201 ? thumbnailAt : null;

	const out = new Uint8Array(offset);
	const view = new DataView(out.buffer);
	out.set(little ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a]);
	view.setUint32(4, 8, little);
	for (const dir of dirs) {
		if (!dir) continue;
		view.setUint16(dir.at, dir.entries.length, little);
		dir.entries.forEach((entry, i) => {
			const e = dir.at + 2 + i * 12;
			const p = pointer(entry.tag);
			const value = p === null ? entry : { ...entry, values: [p] };
			view.setUint16(e, value.tag, little);
			view.setUint16(e + 2, value.type, little);
			view.setUint32(e + 4, count(value), little);
			const bytes = encode(value, little);
			if (dir.valuesAt[i]! >= 0) {
				view.setUint32(e + 8, dir.valuesAt[i]!, little);
				out.set(bytes, dir.valuesAt[i]!);
			} else {
				out.set(bytes, e + 8);
			}
		});
		const next = dir === d0 && d1 ? d1.at : 0;
		view.setUint32(dir.at + 2 + dir.entries.length * 12, next, little);
	}
	if (spec.thumbnail) out.set(spec.thumbnail, thumbnailAt);
	return out;
}

/** A typical camera block: make, model, software, orientation, dates, exposure, a maker note and GPS. */
export function cameraExif(options: { little?: boolean; orientation?: number; thumbnail?: Uint8Array } = {}) {
	const makerNote = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 0xff);
	return buildTiff({
		little: options.little ?? true,
		ifd0: [
			{ tag: 0x010f, type: ASCII, values: 'Canon' },
			{ tag: 0x0110, type: ASCII, values: 'Canon EOS R5' },
			{ tag: 0x0112, type: SHORT, values: [options.orientation ?? 1] },
			{ tag: 0x011a, type: RATIONAL, values: [300, 1] },
			{ tag: 0x0131, type: ASCII, values: 'Firmware Version 1.8.1' },
			{ tag: 0x0132, type: ASCII, values: '2026:09:12 21:14:03' },
		],
		exif: [
			{ tag: 0x829a, type: RATIONAL, values: [1, 125] },
			{ tag: 0x8827, type: SHORT, values: [6400] },
			{ tag: 0x9003, type: ASCII, values: '2026:09:12 21:14:03' },
			{ tag: 0x927c, type: UNDEFINED, values: makerNote },
			{ tag: 0xa002, type: LONG, values: [8192] },
			{ tag: 0xa003, type: LONG, values: [5464] },
			{ tag: 0xa434, type: ASCII, values: 'RF24-70mm F2.8 L IS USM' },
		],
		gps: [
			{ tag: 0x0000, type: BYTE, values: [2, 3, 0, 0] },
			{ tag: 0x0001, type: ASCII, values: 'N' },
			{ tag: 0x0002, type: RATIONAL, values: [25, 1, 2, 1, 1234, 100] },
			{ tag: 0x0003, type: ASCII, values: 'E' },
			{ tag: 0x0004, type: RATIONAL, values: [121, 1, 33, 1, 4567, 100] },
		],
		...(options.thumbnail && { ifd1: [{ tag: 0x0103, type: SHORT, values: [6] }], thumbnail: options.thumbnail }),
	});
}
