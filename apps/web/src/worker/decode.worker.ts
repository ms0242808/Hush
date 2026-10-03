// SPDX-License-Identifier: Apache-2.0
/**
 * Decodes one photo for the pipeline worker, then is thrown away.
 *
 * A 45 MP JPEG takes the WASM decoder most of a second, and the noise search
 * and the overview a little more. On a thread of their own, the pipeline
 * worker loads the model at the same time, so the first denoised tile arrives
 * sooner (§4.6: the preview number decides whether the tool feels fast). And
 * when this worker ends, the decoder's WASM heap — the size of the photo —
 * goes with it instead of staying allocated for the session.
 */
import {
	asImage8,
	noiseMap,
	noisiestPoint,
	PhotoTooLargeError,
	readPhoto,
	type DecodedOrientation,
	type Image8,
	type PhotoInfo,
	type Point,
	type Size,
} from '@hush/core';
import * as Comlink from 'comlink';
import '../lib/worker-errors.ts';
import { browserCodecs } from './adapters/codecs.ts';
import { browserZlib } from './adapters/platform.ts';
import { overviewOf } from './editor-images.ts';

export interface DecodedPhoto {
	info: PhotoInfo;
	/** Whether the decoder already turned the pixels upright (libheif does). */
	orientation: DecodedOrientation;
	image: Image8;
	decodeMs: number;
	/** For the editor: where to open (stored coordinates) and the fit view's overview. */
	editor: { noisiest: Point; overview: Image8 } | null;
}

export interface DecodeOptions {
	/** §2.9: refuse before decoding what this device can't hold. */
	maxMegapixels: number;
	/** The viewer's size in display pixels, for the editor; null for a plain decode. */
	view: Size | null;
}

/**
 * Give every byte array its own buffer. The metadata are views into the whole
 * file; sending a view would copy the file's 20 MB buffer along with it.
 */
function detached<T>(value: T): T {
	if (value instanceof Uint8Array) return value.slice() as T;
	if (Array.isArray(value)) return value.map(detached) as T;
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, detached(entry)])) as T;
	}
	return value;
}

const api = {
	async decode(file: File, options: DecodeOptions): Promise<DecodedPhoto> {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const info = await readPhoto(bytes, browserZlib);
		const megapixels = (info.width * info.height) / 1e6;
		if (megapixels > options.maxMegapixels) throw new PhotoTooLargeError(megapixels, options.maxMegapixels);
		const started = performance.now();
		const decoded = await browserCodecs.decode(bytes, info.format);
		const image = asImage8(decoded.image);
		const decodeMs = performance.now() - started;

		let editor: DecodedPhoto['editor'] = null;
		if (options.view) {
			const orientation = decoded.orientation === 'applied' ? 1 : info.orientation;
			// The view is measured upright; the noise search works on stored pixels.
			const window = orientation >= 5 ? { width: options.view.height, height: options.view.width } : options.view;
			editor = { noisiest: noisiestPoint(noiseMap(image), window), overview: overviewOf(image) };
		}
		const transfers: Transferable[] = [image.data.buffer];
		if (editor) transfers.push(editor.overview.data.buffer);
		return Comlink.transfer(
			{ info: detached(info), orientation: decoded.orientation, image, decodeMs, editor },
			transfers,
		);
	},
};

export type DecodeApi = typeof api;

Comlink.expose(api);
