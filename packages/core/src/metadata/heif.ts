// SPDX-License-Identifier: Apache-2.0
import { hasPrefix, latin1String, u16be, u32be } from '../bytes.ts';
import type { Bytes } from '../types.ts';
import type { Nclx } from './icc.ts';

/**
 * HEIC and AVIF are both HEIF: ISO base media file format boxes, with the
 * photo described as "items" inside the `meta` box. This reads what the
 * pipeline needs about the primary item — size, rotation, mirroring, colour,
 * bit depth — and the EXIF and XMP items attached to it. Pixels are left to
 * the codec.
 */

export interface HeifInfo {
	brands: string[];
	/** The primary item's size before rotation (its `ispe`). */
	width: number;
	height: number;
	/** `irot`: anticlockwise quarter turns. */
	rotation: number;
	/** `imir`: 0 exchanges top and bottom, 1 left and right; null when absent. */
	mirror: 0 | 1 | null;
	/** `colr`: an embedded profile, or CICP code points. */
	icc: Bytes | null;
	nclx: Nclx | null;
	/** Bits per channel (`pixi`), when declared. */
	bitDepth: number | null;
	exif: Bytes | null;
	xmp: Bytes | null;
	/** More than one top-level image, or an image sequence. */
	sequence: boolean;
}

export class HeifFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HeifFormatError';
	}
}

interface Box {
	type: string;
	/** Payload start and end (after the header). */
	start: number;
	end: number;
}

function* boxes(bytes: Bytes, start: number, end: number): Generator<Box> {
	let at = start;
	while (at + 8 <= end) {
		let size = u32be(bytes, at);
		const type = latin1String(bytes, at + 4, at + 8);
		let header = 8;
		if (size === 1) {
			if (at + 16 > end) throw new HeifFormatError(`Truncated ${type} box`);
			const high = u32be(bytes, at + 8);
			const low = u32be(bytes, at + 12);
			size = high * 2 ** 32 + low;
			header = 16;
		} else if (size === 0) {
			size = end - at;
		}
		if (size < header || at + size > end) throw new HeifFormatError(`${type} box overruns its parent`);
		yield { type, start: at + header, end: at + size };
		at += size;
	}
}

const child = (bytes: Bytes, parent: Box, type: string) => {
	for (const box of boxes(bytes, parent.start, parent.end)) if (box.type === type) return box;
	return null;
};

/** Read an unsigned big-endian integer of 0, 4 or 8 bytes. */
function readSized(bytes: Bytes, at: number, size: number): number {
	if (size === 0) return 0;
	if (size === 4) return u32be(bytes, at);
	if (size === 8) return u32be(bytes, at) * 2 ** 32 + u32be(bytes, at + 4);
	if (size === 2) return u16be(bytes, at);
	throw new HeifFormatError(`Unsupported field size ${size}`);
}

interface Location {
	method: number;
	baseOffset: number;
	extents: Array<{ offset: number; length: number }>;
}

function parseIloc(bytes: Bytes, box: Box): Map<number, Location> {
	const version = bytes[box.start]!;
	let at = box.start + 4;
	const sizes = u16be(bytes, at);
	at += 2;
	const offsetSize = sizes >>> 12;
	const lengthSize = (sizes >>> 8) & 0xf;
	const baseOffsetSize = (sizes >>> 4) & 0xf;
	const indexSize = version >= 1 ? sizes & 0xf : 0;
	const count = version < 2 ? u16be(bytes, at) : u32be(bytes, at);
	at += version < 2 ? 2 : 4;
	const items = new Map<number, Location>();
	for (let i = 0; i < count; i++) {
		const id = version < 2 ? u16be(bytes, at) : u32be(bytes, at);
		at += version < 2 ? 2 : 4;
		let method = 0;
		if (version >= 1) {
			method = u16be(bytes, at) & 0xf;
			at += 2;
		}
		at += 2; // data_reference_index
		const baseOffset = readSized(bytes, at, baseOffsetSize);
		at += baseOffsetSize;
		const extentCount = u16be(bytes, at);
		at += 2;
		const extents: Location['extents'] = [];
		for (let e = 0; e < extentCount; e++) {
			at += indexSize;
			const offset = readSized(bytes, at, offsetSize);
			at += offsetSize;
			const length = readSized(bytes, at, lengthSize);
			at += lengthSize;
			extents.push({ offset, length });
		}
		items.set(id, { method, baseOffset, extents });
	}
	return items;
}

interface ItemInfo {
	id: number;
	type: string;
	contentType: string | null;
}

function parseIinf(bytes: Bytes, box: Box): ItemInfo[] {
	const version = bytes[box.start]!;
	const start = box.start + 4 + (version === 0 ? 2 : 4);
	const items: ItemInfo[] = [];
	for (const infe of boxes(bytes, start, box.end)) {
		if (infe.type !== 'infe') continue;
		const infeVersion = bytes[infe.start]!;
		if (infeVersion < 2) continue;
		let at = infe.start + 4;
		const id = infeVersion === 2 ? u16be(bytes, at) : u32be(bytes, at);
		at += (infeVersion === 2 ? 2 : 4) + 2; // item_protection_index
		const type = latin1String(bytes, at, at + 4);
		at += 4;
		const nameEnd = bytes.indexOf(0, at);
		let contentType: string | null = null;
		if (type === 'mime' && nameEnd >= 0 && nameEnd < infe.end) {
			const typeEnd = bytes.indexOf(0, nameEnd + 1);
			contentType = latin1String(bytes, nameEnd + 1, typeEnd >= 0 && typeEnd < infe.end ? typeEnd : infe.end);
		}
		items.push({ id, type, contentType });
	}
	return items;
}

/** Item references of one kind: from → [to]. */
function parseIref(bytes: Bytes, box: Box, kind: string): Map<number, number[]> {
	const version = bytes[box.start]!;
	const idSize = version === 0 ? 2 : 4;
	const refs = new Map<number, number[]>();
	for (const ref of boxes(bytes, box.start + 4, box.end)) {
		if (ref.type !== kind) continue;
		let at = ref.start;
		const from = idSize === 2 ? u16be(bytes, at) : u32be(bytes, at);
		at += idSize;
		const count = u16be(bytes, at);
		at += 2;
		const to: number[] = [];
		for (let i = 0; i < count; i++, at += idSize) to.push(idSize === 2 ? u16be(bytes, at) : u32be(bytes, at));
		refs.set(from, to);
	}
	return refs;
}

/** Properties (`ipco`, 1-based) associated with an item (`ipma`). */
function itemProperties(bytes: Bytes, iprp: Box, itemId: number): Box[] {
	const ipco = child(bytes, iprp, 'ipco');
	if (!ipco) return [];
	const properties = [...boxes(bytes, ipco.start, ipco.end)];
	const found: Box[] = [];
	for (const ipma of boxes(bytes, iprp.start, iprp.end)) {
		if (ipma.type !== 'ipma') continue;
		const version = bytes[ipma.start]!;
		const flags = u32be(bytes, ipma.start) & 0xffffff;
		let at = ipma.start + 4;
		const count = u32be(bytes, at);
		at += 4;
		for (let i = 0; i < count; i++) {
			const id = version < 1 ? u16be(bytes, at) : u32be(bytes, at);
			at += version < 1 ? 2 : 4;
			const associations = bytes[at]!;
			at += 1;
			for (let a = 0; a < associations; a++) {
				const index = flags & 1 ? u16be(bytes, at) & 0x7fff : bytes[at]! & 0x7f;
				at += flags & 1 ? 2 : 1;
				if (id === itemId && index > 0 && properties[index - 1]) found.push(properties[index - 1]!);
			}
		}
	}
	return found;
}

function itemData(bytes: Bytes, location: Location | undefined, idat: Box | null): Bytes | null {
	if (!location) return null;
	const parts: Bytes[] = [];
	for (const { offset, length } of location.extents) {
		let start: number;
		let limit: number;
		if (location.method === 0) {
			start = location.baseOffset + offset;
			limit = bytes.byteLength;
		} else if (location.method === 1 && idat) {
			start = idat.start + location.baseOffset + offset;
			limit = idat.end;
		} else return null;
		const size = length === 0 ? limit - start : length;
		if (start < 0 || start + size > limit) return null;
		parts.push(bytes.subarray(start, start + size));
	}
	if (parts.length === 1) return parts[0]!.slice();
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let o = 0;
	for (const part of parts) {
		out.set(part, o);
		o += part.byteLength;
	}
	return out;
}

export function parseHeif(bytes: Bytes): HeifInfo {
	const top = [...boxes(bytes, 0, bytes.byteLength)];
	const ftyp = top.find((b) => b.type === 'ftyp');
	if (!ftyp) throw new HeifFormatError('Missing ftyp box');
	const brands = [latin1String(bytes, ftyp.start, ftyp.start + 4)];
	for (let o = ftyp.start + 8; o + 4 <= ftyp.end; o += 4) brands.push(latin1String(bytes, o, o + 4));
	const meta = top.find((b) => b.type === 'meta');
	if (!meta) throw new HeifFormatError('Missing meta box');
	const metaBox: Box = { type: 'meta', start: meta.start + 4, end: meta.end }; // full box

	const pitm = child(bytes, metaBox, 'pitm');
	if (!pitm) throw new HeifFormatError('No primary item');
	const primary = bytes[pitm.start]! === 0 ? u16be(bytes, pitm.start + 4) : u32be(bytes, pitm.start + 4);
	const iinf = child(bytes, metaBox, 'iinf');
	const iloc = child(bytes, metaBox, 'iloc');
	const iprp = child(bytes, metaBox, 'iprp');
	const iref = child(bytes, metaBox, 'iref');
	const idat = child(bytes, metaBox, 'idat');
	const items = iinf ? parseIinf(bytes, iinf) : [];
	const locations = iloc ? parseIloc(bytes, iloc) : new Map<number, Location>();

	const info: HeifInfo = {
		brands,
		width: 0,
		height: 0,
		rotation: 0,
		mirror: null,
		icc: null,
		nclx: null,
		bitDepth: null,
		exif: null,
		xmp: null,
		sequence: top.some((b) => b.type === 'moov') || brands.includes('msf1') || brands.includes('avis'),
	};

	for (const property of iprp ? itemProperties(bytes, iprp, primary) : []) {
		const at = property.start;
		switch (property.type) {
			case 'ispe':
				info.width = u32be(bytes, at + 4);
				info.height = u32be(bytes, at + 8);
				break;
			case 'irot':
				info.rotation = bytes[at]! & 3;
				break;
			case 'imir':
				info.mirror = (bytes[at]! & 1) as 0 | 1;
				break;
			case 'pixi': {
				const channels = bytes[at + 4]!;
				if (channels > 0) info.bitDepth = Math.max(...bytes.subarray(at + 5, at + 5 + channels));
				break;
			}
			case 'colr': {
				const kind = latin1String(bytes, at, at + 4);
				if (kind === 'nclx' && property.end - at >= 11) {
					info.nclx ??= {
						primaries: u16be(bytes, at + 4),
						transfer: u16be(bytes, at + 6),
						matrix: u16be(bytes, at + 8),
						fullRange: (bytes[at + 10]! & 0x80) !== 0,
					};
				} else if ((kind === 'prof' || kind === 'rICC') && info.icc === null) {
					info.icc = bytes.slice(at + 4, property.end);
				}
				break;
			}
		}
	}

	// EXIF and XMP: prefer the items that describe ("cdsc") the primary image.
	const describes = iref ? parseIref(bytes, iref, 'cdsc') : new Map<number, number[]>();
	const forPrimary = (item: ItemInfo) => describes.get(item.id)?.includes(primary) ?? false;
	const pick = (match: (item: ItemInfo) => boolean) =>
		items.filter(match).sort((a, b) => Number(forPrimary(b)) - Number(forPrimary(a)))[0];

	const exifItem = pick((item) => item.type === 'Exif');
	const exif = exifItem ? itemData(bytes, locations.get(exifItem.id), idat) : null;
	if (exif && exif.byteLength > 4) {
		const start = 4 + u32be(exif, 0);
		if (start < exif.byteLength && (hasPrefix(exif, 'II*\0', start) || hasPrefix(exif, 'MM\0*', start))) {
			info.exif = exif.slice(start);
		}
	}
	const xmpItem = pick((item) => item.type === 'mime' && item.contentType === 'application/rdf+xml');
	if (xmpItem) info.xmp = itemData(bytes, locations.get(xmpItem.id), idat);

	if (info.width === 0 || info.height === 0) throw new HeifFormatError('The primary image has no size');
	return info;
}
