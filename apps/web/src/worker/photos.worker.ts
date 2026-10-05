// SPDX-License-Identifier: Apache-2.0
/**
 * Looks at a batch's photos before any is processed (§5.4: drop many files →
 * thumbnail grid): reads each container for its size and orientation —
 * refusing, with the reason, what Hush can't process (§2.9) — and makes a
 * small upright thumbnail. A worker of its own, so a hundred photos being
 * read never stall the page or the batch, and its decoders' memory goes when
 * it is terminated.
 */
import { describeSource, readPhoto, type Format, type Image8, type Orientation } from '@hush/core';
import * as Comlink from 'comlink';
import '../lib/worker-errors.ts';
import { orientationMatrix } from '../lib/orientation.ts';
import { browserCodecs } from './adapters/codecs.ts';
import { browserZlib } from './adapters/platform.ts';
import { overviewOf } from './editor-images.ts';

export interface PhotoFacts {
	format: Format;
	/** Stored size, before orientation. */
	width: number;
	height: number;
	orientation: Orientation;
	bitDepth: number;
	hadLocation: boolean;
}

/** Thumbnails are small JPEGs: plenty for a grid cell, a few kilobytes each. */
const THUMBNAIL_QUALITY = 0.82;

function uprightSize(facts: Pick<PhotoFacts, 'width' | 'height' | 'orientation'>) {
	return facts.orientation >= 5
		? { width: facts.height, height: facts.width }
		: { width: facts.width, height: facts.height };
}

/** The browser's own decoder: fast, downscales while decoding JPEGs, applies EXIF orientation. */
async function viaBrowser(file: File, facts: PhotoFacts, maxSide: number): Promise<OffscreenCanvas> {
	const upright = uprightSize(facts);
	const scale = Math.min(1, maxSide / Math.max(upright.width, upright.height));
	const size =
		upright.width >= upright.height
			? { resizeWidth: Math.max(1, Math.round(upright.width * scale)) }
			: { resizeHeight: Math.max(1, Math.round(upright.height * scale)) };
	const bitmap = await createImageBitmap(file, { ...size, resizeQuality: 'medium', imageOrientation: 'from-image' });
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
		return canvas;
	} finally {
		bitmap.close();
	}
}

/** Hush's own decoders, for what the browser can't read (HEIC outside Safari), drawn upright here. */
async function viaCodecs(file: File, facts: PhotoFacts, maxSide: number): Promise<OffscreenCanvas> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const decoded = await browserCodecs.decode(bytes, facts.format);
	const small = overviewOf(decoded.image as Image8, maxSide);
	const orientation: Orientation = decoded.orientation === 'applied' ? 1 : facts.orientation;
	const stored = new OffscreenCanvas(small.width, small.height);
	const pixels = new Uint8ClampedArray(small.data.buffer) as Uint8ClampedArray<ArrayBuffer>;
	stored.getContext('2d')!.putImageData(new ImageData(pixels, small.width, small.height), 0, 0);
	if (orientation === 1) return stored;
	const upright = uprightSize({ width: small.width, height: small.height, orientation });
	const canvas = new OffscreenCanvas(upright.width, upright.height);
	const context = canvas.getContext('2d')!;
	context.setTransform(...orientationMatrix(orientation, small.width, small.height));
	context.drawImage(stored, 0, 0);
	return canvas;
}

/**
 * A JPEG's metadata all comes before its image data, so its first megabyte
 * is usually enough: a 400-photo folder of 45 MP JPEGs reads 0.4 GB, not 11.
 * Other formats, and JPEGs whose metadata runs on, are read whole.
 */
const JPEG_HEAD_BYTES = 2 ** 20;

async function readInfo(file: File) {
	const head = new Uint8Array(await file.slice(0, JPEG_HEAD_BYTES).arrayBuffer());
	if (head[0] === 0xff && head[1] === 0xd8 && file.size > JPEG_HEAD_BYTES) {
		try {
			return await readPhoto(head, browserZlib);
		} catch (error) {
			if (error instanceof Error && error.name === 'UnsupportedPhotoError') throw error;
			// The metadata goes past the first megabyte: read it all.
		}
	}
	return readPhoto(new Uint8Array(await file.arrayBuffer()), browserZlib);
}

const api = {
	/** The photo's container: size, orientation, and whether Hush can process it at all. Throws the refusal. */
	async inspect(file: File): Promise<PhotoFacts> {
		const info = await readInfo(file);
		return {
			format: info.format,
			width: info.width,
			height: info.height,
			orientation: info.orientation,
			bitDepth: info.bitDepth,
			hadLocation: describeSource(info).hadLocation,
		};
	},

	/** An upright JPEG thumbnail, at most `maxSide` pixels along its longer side. */
	async thumbnail(file: File, facts: PhotoFacts, maxSide: number): Promise<Blob> {
		let canvas: OffscreenCanvas;
		try {
			canvas = await viaBrowser(file, facts, maxSide);
		} catch {
			canvas = await viaCodecs(file, facts, maxSide);
		}
		return canvas.convertToBlob({ type: 'image/jpeg', quality: THUMBNAIL_QUALITY });
	},
};

export type PhotosApi = typeof api;

Comlink.expose(api);
