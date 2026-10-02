// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
	displayP3Profile,
	displaySize,
	displayTransform,
	iccDescription,
	interpretNclx,
	orientationFromHeif,
	rgbToD50,
	stripXmpLocation,
	xmpHasLocation,
	type Orientation,
} from '../src/index.ts';

describe('ICC', () => {
	it('builds a Display P3 profile matching Apple’s published colorants', () => {
		const icc = displayP3Profile();
		const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
		expect(view.getUint32(0)).toBe(icc.length);
		expect(String.fromCharCode(...icc.subarray(36, 40))).toBe('acsp');
		expect(String.fromCharCode(...icc.subarray(12, 24))).toBe('mntrRGB XYZ ');
		expect(iccDescription(icc)).toBe('Display P3');

		const tag = (signature: string) => {
			const count = view.getUint32(128);
			for (let i = 0; i < count; i++) {
				const at = 132 + i * 12;
				if (String.fromCharCode(...icc.subarray(at, at + 4)) === signature) return view.getUint32(at + 4);
			}
			throw new Error(`no ${signature}`);
		};
		const xyz = (signature: string) => [0, 1, 2].map((i) => view.getInt32(tag(signature) + 8 + i * 4) / 65536);
		// Apple's Display P3.icc colorants (D50-adapted).
		const close = (actual: number[], expected: number[]) =>
			actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 3));
		close(xyz('rXYZ'), [0.515121, 0.241196, -0.001053]);
		close(xyz('gXYZ'), [0.291977, 0.692245, 0.041885]);
		close(xyz('bXYZ'), [0.157104, 0.066574, 0.784073]);
		// The three curves share one block.
		expect(tag('rTRC')).toBe(tag('gTRC'));
	});

	it('is deterministic, so exports are reproducible', () => {
		expect(displayP3Profile()).toEqual(displayP3Profile());
	});

	it('maps primaries to D50 so white stays white', () => {
		const { toD50 } = rgbToD50(
			[
				[0.64, 0.33],
				[0.3, 0.6],
				[0.15, 0.06],
			],
			[0.3127, 0.329],
		);
		const white = [0, 1, 2].map((r) => toD50[r]![0]! + toD50[r]![1]! + toD50[r]![2]!);
		expect(white[0]).toBeCloseTo(0.9642, 3);
		expect(white[1]).toBeCloseTo(1, 3);
		expect(white[2]).toBeCloseTo(0.8249, 3);
	});

	it('interprets nclx: sRGB needs nothing, P3 needs a profile, PQ and HLG are HDR', () => {
		expect(interpretNclx({ primaries: 1, transfer: 13, matrix: 6, fullRange: true })).toEqual({ kind: 'srgb' });
		expect(interpretNclx({ primaries: 12, transfer: 13, matrix: 6, fullRange: true })).toMatchObject({
			kind: 'profile',
			name: 'Display P3',
		});
		expect(interpretNclx({ primaries: 9, transfer: 16, matrix: 9, fullRange: false })).toEqual({ kind: 'hdr' });
		expect(interpretNclx({ primaries: 12, transfer: 18, matrix: 6, fullRange: false })).toEqual({ kind: 'hdr' });
		expect(interpretNclx({ primaries: 9, transfer: 1, matrix: 9, fullRange: false })).toEqual({ kind: 'unknown' });
	});
});

describe('orientation', () => {
	/** Apply a transform to a small labelled grid the slow, obvious way. */
	const grid = [
		[1, 2, 3],
		[4, 5, 6],
	];
	const flip = (g: number[][]) => g.map((row) => [...row].reverse());
	const rotateClockwise = (g: number[][]) => g[0]!.map((_, x) => g.map((row) => row[x]!).reverse());
	const rotateAnticlockwise = (g: number[][]) => rotateClockwise(rotateClockwise(rotateClockwise(g)));
	const flipVertical = (g: number[][]) => [...g].reverse();
	const viaExif = (o: Orientation) => {
		const { flip: f, rotate } = displayTransform(o);
		let g = f ? flip(grid) : grid;
		for (let r = 0; r < rotate; r += 90) g = rotateClockwise(g);
		return g;
	};

	it('EXIF orientations are the eight distinct flips and rotations', () => {
		const seen = new Set(([1, 2, 3, 4, 5, 6, 7, 8] as const).map((o) => JSON.stringify(viaExif(o))));
		expect(seen.size).toBe(8);
		expect(viaExif(6)).toEqual(rotateClockwise(grid)); // the classic portrait phone photo
		expect(viaExif(2)).toEqual(flip(grid));
		expect(viaExif(4)).toEqual(flipVertical(grid));
	});

	it('maps every HEIF irot/imir combination to the EXIF orientation that draws the same thing', () => {
		for (const angle of [0, 1, 2, 3]) {
			for (const mirror of [null, 0, 1] as const) {
				// HEIF: rotate anticlockwise, then mirror (0: top↔bottom, 1: left↔right).
				let g = grid;
				for (let i = 0; i < angle; i++) g = rotateAnticlockwise(g);
				if (mirror === 0) g = flipVertical(g);
				if (mirror === 1) g = flip(g);
				expect(viaExif(orientationFromHeif(angle, mirror)), `irot ${angle}, imir ${mirror}`).toEqual(g);
			}
		}
		expect(orientationFromHeif(3, null)).toBe(6); // an iPhone portrait
	});

	it('swaps width and height for orientations that turn the photo on its side', () => {
		expect(displaySize(6000, 4000, 1)).toEqual({ width: 6000, height: 4000 });
		expect(displaySize(6000, 4000, 6)).toEqual({ width: 4000, height: 6000 });
	});
});

describe('XMP location', () => {
	const enc = (text: string) => Uint8Array.from(Buffer.from(text, 'utf8'));
	const dec = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

	it('removes GPS attributes and elements, and keeps everything else, non-ASCII included', () => {
		const xmp = enc(
			`<x:xmpmeta><rdf:RDF><rdf:Description exif:GPSLatitude="25,2.0N" exif:GPSLongitude='121,33.0E' dc:format="image/jpeg">` +
				`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">婚禮 · 台北</rdf:li></rdf:Alt></dc:title>` +
				`<exif:GPSAltitude>12/1</exif:GPSAltitude><exif:GPSVersionID/>` +
				`<Iptc4xmpExt:LocationCreated><rdf:Bag><rdf:li Iptc4xmpExt:City="Taipei" Iptc4xmpExt:GPSLatitude="25.03"/></rdf:Bag></Iptc4xmpExt:LocationCreated>` +
				`</rdf:Description></rdf:RDF></x:xmpmeta>`,
		);
		expect(xmpHasLocation(xmp)).toBe(true);
		const stripped = stripXmpLocation(xmp);
		expect(xmpHasLocation(stripped)).toBe(false);
		const text = dec(stripped);
		expect(text).toContain('dc:format="image/jpeg"');
		expect(text).toContain('婚禮 · 台北');
		expect(text).toContain('Iptc4xmpExt:City="Taipei"');
		expect(text).not.toContain('GPS');
	});

	it('returns the same bytes when there is no location', () => {
		const xmp = enc('<x:xmpmeta><rdf:Description dc:format="image/png"/></x:xmpmeta>');
		expect(stripXmpLocation(xmp)).toBe(xmp);
	});
});
