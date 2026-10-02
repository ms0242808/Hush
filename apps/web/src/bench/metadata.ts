// SPDX-License-Identifier: Apache-2.0
import { iccDescription, readPhoto, type Orientation, type PhotoInfo, type Zlib } from '@hush/core';

/**
 * A photo's metadata in a few comparable lines, for the pipeline check. The
 * container is read by Hush's own reader, but every EXIF value is read by
 * exifr — an independent implementation — so the comparison doesn't take
 * Hush's word for what it wrote.
 */
export interface MetadataSummary {
	format: string;
	size: string;
	orientation: string;
	software: string | null;
	camera: string | null;
	lens: string | null;
	taken: string | null;
	exposure: string | null;
	location: string | null;
	profile: string | null;
	xmp: string | null;
	iptc: string | null;
}

export type SummaryField = keyof MetadataSummary;

const ORIENTATIONS: Record<Orientation, string> = {
	1: 'Upright',
	2: 'Mirrored',
	3: 'Upside down',
	4: 'Mirrored, upside down',
	5: 'Mirrored, turned left',
	6: 'Turn right to view',
	7: 'Mirrored, turned right',
	8: 'Turn left to view',
};

function zlib(): Zlib {
	const through = async (bytes: Uint8Array, transform: CompressionStream | DecompressionStream) =>
		new Uint8Array(
			await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform)).arrayBuffer(),
		);
	return {
		inflate: (bytes) => through(bytes, new DecompressionStream('deflate')),
		deflate: (bytes) => through(bytes, new CompressionStream('deflate')),
	};
}

const coordinate = (value: number, positive: string, negative: string) =>
	`${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;

export async function summarize(bytes: Uint8Array): Promise<{ summary: MetadataSummary; info: PhotoInfo }> {
	const info = await readPhoto(bytes, zlib());
	const { default: exifr } = await import('exifr');
	const tiff = info.exif
		? ((await exifr
				.parse(info.exif, { translateValues: false, reviveValues: true, mergeOutput: true, tiff: true, gps: true })
				.catch(() => null)) as Record<string, unknown> | null)
		: null;
	const text = (key: string) => {
		const value = tiff?.[key];
		return typeof value === 'string' ? value.trim() || null : null;
	};
	const number = (key: string) => {
		const value = tiff?.[key];
		return typeof value === 'number' ? value : null;
	};

	const make = text('Make');
	const model = text('Model');
	const camera = make && model?.startsWith(make) ? model : [make, model].filter(Boolean).join(' ') || null;
	const exposureTime = number('ExposureTime');
	const exposure = [
		exposureTime ? (exposureTime < 1 ? `1/${Math.round(1 / exposureTime)} s` : `${exposureTime} s`) : null,
		number('FNumber') ? `f/${number('FNumber')}` : null,
		number('ISO') ? `ISO ${number('ISO')}` : null,
	]
		.filter(Boolean)
		.join(' · ');
	const latitude = number('latitude');
	const longitude = number('longitude');
	const taken = tiff?.['DateTimeOriginal'];

	let iptc: string | null = null;
	if (info.jpeg?.photoshop.length) {
		const parsed = (await exifr
			.parse(bytes, { iptc: true, tiff: false, mergeOutput: true })
			.catch(() => null)) as Record<string, unknown> | null;
		iptc = typeof parsed?.['Caption'] === 'string' ? `“${parsed['Caption']}”` : 'present';
	}

	return {
		info,
		summary: {
			format: `${info.format.toUpperCase()} · ${info.bitDepth}-bit`,
			size: `${info.width} × ${info.height}`,
			orientation: `${info.orientation} · ${ORIENTATIONS[info.orientation]}`,
			software: text('Software'),
			camera,
			lens: text('LensModel'),
			taken:
				taken instanceof Date
					? taken.toISOString().slice(0, 19).replace('T', ' ')
					: typeof taken === 'string'
						? taken
						: null,
			exposure: exposure || null,
			location:
				latitude !== null && longitude !== null
					? `${coordinate(latitude, 'N', 'S')}, ${coordinate(longitude, 'E', 'W')}`
					: null,
			profile: info.icc ? (iccDescription(info.icc) ?? `${info.icc.byteLength.toLocaleString()} bytes`) : null,
			xmp: info.xmp ? `${info.xmp.byteLength.toLocaleString()} bytes` : null,
			iptc,
		},
	};
}

export const SUMMARY_ROWS: Array<{ field: SummaryField; label: string }> = [
	{ field: 'format', label: 'Format' },
	{ field: 'size', label: 'Pixels' },
	{ field: 'orientation', label: 'Orientation' },
	{ field: 'software', label: 'Software' },
	{ field: 'camera', label: 'Camera' },
	{ field: 'lens', label: 'Lens' },
	{ field: 'taken', label: 'Taken' },
	{ field: 'exposure', label: 'Exposure' },
	{ field: 'location', label: 'Location' },
	{ field: 'profile', label: 'Colour profile' },
	{ field: 'xmp', label: 'XMP' },
	{ field: 'iptc', label: 'IPTC caption' },
];
