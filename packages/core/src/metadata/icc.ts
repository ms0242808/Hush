// SPDX-License-Identifier: Apache-2.0
import { concatBytes, latin1, latin1String, setU16be, setU32be, u16be, u32be } from '../bytes.ts';
import type { Bytes } from '../types.ts';

/**
 * ICC profiles travel byte for byte (§2.6). This module only reads a
 * profile's description (for diagnostics), and writes one profile itself:
 * when a HEIC or AVIF declares its colours with CICP code points (an `nclx`
 * box) rather than an embedded profile, a JPEG needs a real profile to say
 * the same thing, or Display P3 photos lose their saturation.
 */

/** HEIF `nclx` colour description (ITU-T H.273 code points). */
export interface Nclx {
	primaries: number;
	transfer: number;
	matrix: number;
	fullRange: boolean;
}

/** What an `nclx` box means for an 8-bit output. */
export type NclxColour =
	{ kind: 'srgb' } | { kind: 'profile'; name: 'Display P3'; icc: Bytes } | { kind: 'hdr' } | { kind: 'unknown' };

const PRIMARIES_BT709 = 1;
const PRIMARIES_UNSPECIFIED = 2;
const PRIMARIES_P3_D65 = 12;
/** Transfer characteristics that are SDR and close enough to sRGB's curve to describe with it. */
const SDR_TRANSFERS = new Set([1, 2, 4, 5, 6, 7, 8, 11, 13, 14, 15]);
/** PQ (SMPTE ST 2084) and HLG: HDR, which an 8-bit pipeline can't carry. */
const HDR_TRANSFERS = new Set([16, 18]);

export function interpretNclx(nclx: Nclx): NclxColour {
	if (HDR_TRANSFERS.has(nclx.transfer)) return { kind: 'hdr' };
	if (!SDR_TRANSFERS.has(nclx.transfer)) return { kind: 'unknown' };
	if (nclx.primaries === PRIMARIES_BT709 || nclx.primaries === PRIMARIES_UNSPECIFIED) return { kind: 'srgb' };
	if (nclx.primaries === PRIMARIES_P3_D65) return { kind: 'profile', name: 'Display P3', icc: displayP3Profile() };
	return { kind: 'unknown' };
}

/** The profile's description tag ('desc'), v2 or v4. */
export function iccDescription(icc: Bytes): string | null {
	if (icc.byteLength < 132 || latin1String(icc, 36, 40) !== 'acsp') return null;
	const count = u32be(icc, 128);
	for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.byteLength; i++) {
		const entry = 132 + i * 12;
		if (latin1String(icc, entry, entry + 4) !== 'desc') continue;
		const at = u32be(icc, entry + 4);
		const size = u32be(icc, entry + 8);
		if (at + size > icc.byteLength || size < 12) return null;
		const type = latin1String(icc, at, at + 4);
		if (type === 'desc') {
			const length = u32be(icc, at + 8);
			return latin1String(icc, at + 12, at + 12 + Math.max(0, length - 1));
		}
		if (type === 'mluc' && size >= 28) {
			const length = u32be(icc, at + 20);
			const offset = u32be(icc, at + 24);
			let text = '';
			for (let o = at + offset; o + 1 < at + offset + length && o + 1 < icc.byteLength; o += 2) {
				text += String.fromCharCode(u16be(icc, o));
			}
			return text;
		}
		return null;
	}
	return null;
}

// --- Profile synthesis -------------------------------------------------------

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

const D50: Vec3 = [0.9642, 1, 0.8249];
const BRADFORD: Mat3 = [
	[0.8951, 0.2664, -0.1614],
	[-0.7502, 1.7135, 0.0367],
	[0.0389, -0.0685, 1.0296],
];

const multiply = (a: Mat3, b: Mat3): Mat3 =>
	a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j]! + row[1] * b[1][j]! + row[2] * b[2][j]!)) as Mat3;
const apply = (m: Mat3, v: Vec3): Vec3 => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as Vec3;

function invert(m: Mat3): Mat3 {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [
		[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
		[B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
		[C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
	];
}

const xyToXyz = (x: number, y: number): Vec3 => [x / y, 1, (1 - x - y) / y];

/** RGB → XYZ (D50) for given primaries and white point, Bradford-adapted, plus the adaptation matrix. */
export function rgbToD50(primaries: [[number, number], [number, number], [number, number]], white: [number, number]) {
	const [r, g, b] = primaries.map(([x, y]) => xyToXyz(x, y)) as [Vec3, Vec3, Vec3];
	const columns: Mat3 = [
		[r[0], g[0], b[0]],
		[r[1], g[1], b[1]],
		[r[2], g[2], b[2]],
	];
	const whiteXyz = xyToXyz(white[0], white[1]);
	const scale = apply(invert(columns), whiteXyz);
	const toXyz = columns.map((row) => [row[0] * scale[0], row[1] * scale[1], row[2] * scale[2]]) as Mat3;
	const source = apply(BRADFORD, whiteXyz);
	const target = apply(BRADFORD, D50);
	const diagonal: Mat3 = [
		[target[0] / source[0], 0, 0],
		[0, target[1] / source[1], 0],
		[0, 0, target[2] / source[2]],
	];
	const adapt = multiply(invert(BRADFORD), multiply(diagonal, BRADFORD));
	return { toD50: multiply(adapt, toXyz), adapt };
}

const s15Fixed16 = (value: number): Bytes => {
	const out = new Uint8Array(4);
	setU32be(out, 0, Math.round(value * 65536) >>> 0);
	return out;
};

function tag(type: string, body: Bytes): Bytes {
	const data = concatBytes([latin1(type), new Uint8Array(4), body]);
	const padded = new Uint8Array(Math.ceil(data.byteLength / 4) * 4);
	padded.set(data);
	return padded;
}

const xyzTag = (v: Vec3) => tag('XYZ ', concatBytes(v.map(s15Fixed16)));

function mlucTag(text: string): Bytes {
	const header = new Uint8Array(20);
	setU32be(header, 0, 1); // one record
	setU32be(header, 4, 12); // record size
	header.set(latin1('enUS'), 8);
	setU32be(header, 12, text.length * 2);
	setU32be(header, 16, 28); // string offset from the tag start
	const utf16 = new Uint8Array(text.length * 2);
	for (let i = 0; i < text.length; i++) setU16be(utf16, i * 2, text.charCodeAt(i));
	return tag('mluc', concatBytes([header, utf16]));
}

/** The sRGB transfer curve as an ICC v4 parametric curve (type 3). */
function srgbCurveTag(): Bytes {
	const body = new Uint8Array(4);
	setU16be(body, 0, 3);
	return tag('para', concatBytes([body, ...[2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].map(s15Fixed16)]));
}

function matrixProfile(
	description: string,
	primaries: [[number, number], [number, number], [number, number]],
	white: [number, number],
): Bytes {
	const { toD50, adapt } = rgbToD50(primaries, white);
	const column = (j: number): Vec3 => [toD50[0][j]!, toD50[1][j]!, toD50[2][j]!];
	const curve = srgbCurveTag();
	const tags: Array<[string, Bytes]> = [
		['desc', mlucTag(description)],
		['cprt', mlucTag('No copyright, use freely')],
		['wtpt', xyzTag(D50)],
		['chad', tag('sf32', concatBytes(adapt.flat().map(s15Fixed16)))],
		['rXYZ', xyzTag(column(0))],
		['gXYZ', xyzTag(column(1))],
		['bXYZ', xyzTag(column(2))],
		['rTRC', curve],
		['gTRC', curve],
		['bTRC', curve],
	];

	// Tag table, with the three curves sharing one block of data.
	const table = new Uint8Array(4 + tags.length * 12);
	setU32be(table, 0, tags.length);
	const blocks: Bytes[] = [];
	let offset = 128 + table.byteLength;
	let curveAt = 0;
	tags.forEach(([signature, data], i) => {
		let at: number;
		if (data === curve && curveAt !== 0) at = curveAt;
		else {
			at = offset;
			blocks.push(data);
			offset += data.byteLength;
			if (data === curve) curveAt = at;
		}
		table.set(latin1(signature), 4 + i * 12);
		setU32be(table, 8 + i * 12, at);
		setU32be(table, 12 + i * 12, data.byteLength);
	});

	const header = new Uint8Array(128);
	setU32be(header, 0, offset);
	setU32be(header, 8, 0x04300000); // version 4.3
	header.set(latin1('mntrRGB XYZ '), 12);
	// Date: a fixed one, so the profile is byte-for-byte reproducible.
	[2026, 1, 1, 0, 0, 0].forEach((value, i) => setU16be(header, 24 + i * 2, value));
	header.set(latin1('acsp'), 36);
	header.set(concatBytes(D50.map(s15Fixed16)), 68);
	return concatBytes([header, table, ...blocks]);
}

let displayP3: Bytes | null = null;

/** Display P3: P3 primaries, D65 white, the sRGB curve. */
export function displayP3Profile(): Bytes {
	displayP3 ??= matrixProfile(
		'Display P3',
		[
			[0.68, 0.32],
			[0.265, 0.69],
			[0.15, 0.06],
		],
		[0.3127, 0.329],
	);
	return displayP3.slice();
}
