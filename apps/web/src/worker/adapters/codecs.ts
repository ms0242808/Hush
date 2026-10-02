// SPDX-License-Identifier: Apache-2.0
import {
	DecodeError,
	EncodeError,
	type CodecAdapter,
	type DecodedImage,
	type EncodeOptions,
	type Format,
	type Image8,
} from '@hush/core';
import codecAssets from 'virtual:codec-assets';
import { jpegOptions, RESET_AFTER_MEGAPIXELS } from './jpeg-options.ts';

/**
 * Decode and encode with WASM codecs, never through a canvas (§2.2):
 * canvases have size ceilings photographer-sized images hit, and they convert
 * colour. Each codec loads on first use, so a JPEG never pulls in the HEIC
 * decoder.
 *
 *   JPEG, PNG, WebP, AVIF   jSquash (MozJPEG, Rust png, libwebp, libavif + dav1d), pixels as stored
 *   HEIC                    libheif-js, loaded by URL as its own file (LGPL, §9.1); applies HEIF rotation
 */

/** The ImageData buffer as plain bytes, without copying. */
const bytesOf = (data: Uint8ClampedArray | Uint8Array): Uint8Array =>
	new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

/** jSquash wants a standalone ArrayBuffer. */
function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
		return bytes.buffer;
	}
	return bytes.slice().buffer;
}

function rgba(width: number, height: number, data: Uint8Array): DecodedImage['image'] {
	return { width, height, channels: 4, bitDepth: 8, colourSpace: 'srgb', data };
}

interface HeifImageHandle {
	get_width(): number;
	get_height(): number;
	is_primary(): boolean;
	display(target: { data: Uint8Array; width: number; height: number }, done: (result: unknown) => void): void;
	free(): void;
}

interface Libheif {
	HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImageHandle[] };
}

let libheif: Libheif | null = null;

async function loadLibheif(): Promise<Libheif> {
	if (libheif) return libheif;
	const url = new URL(codecAssets.libheif.module, self.location.origin).href;
	const module = (await import(/* @vite-ignore */ url)) as { default: () => Libheif };
	libheif = module.default();
	return libheif;
}

async function decodeHeic(bytes: Uint8Array): Promise<DecodedImage> {
	const { HeifDecoder } = await loadLibheif();
	const images = new HeifDecoder().decode(bytes);
	try {
		const primary = images.find((image) => image.is_primary()) ?? images[0];
		if (!primary) throw new Error('No image in the HEIC file');
		const width = primary.get_width();
		const height = primary.get_height();
		const data = new Uint8Array(width * height * 4);
		const result = await new Promise<unknown>((resolve) => primary.display({ data, width, height }, resolve));
		if (!result) throw new Error('libheif could not decode the image');
		// libheif applies the container's rotation and mirroring (irot/imir) while decoding.
		return { image: rgba(width, height, data), orientation: 'applied' };
	} finally {
		for (const image of images) image.free();
	}
}

async function decode(bytes: Uint8Array, format: Format): Promise<DecodedImage> {
	try {
		switch (format) {
			case 'jpeg': {
				const image = await (await import('@jsquash/jpeg/decode')).default(arrayBufferOf(bytes));
				return { image: rgba(image.width, image.height, bytesOf(image.data)), orientation: 'as-stored' };
			}
			case 'png': {
				const image = await (await import('@jsquash/png/decode')).default(arrayBufferOf(bytes));
				return { image: rgba(image.width, image.height, bytesOf(image.data)), orientation: 'as-stored' };
			}
			case 'webp': {
				const image = await (await import('@jsquash/webp/decode')).default(arrayBufferOf(bytes));
				return { image: rgba(image.width, image.height, bytesOf(image.data)), orientation: 'as-stored' };
			}
			case 'avif': {
				const image = await (await import('@jsquash/avif/decode')).default(arrayBufferOf(bytes));
				if (!image) throw new Error('libavif could not decode the image');
				// libavif leaves irot/imir to the application: Hush keeps them as an orientation tag.
				return { image: rgba(image.width, image.height, bytesOf(image.data)), orientation: 'as-stored' };
			}
			case 'heic':
				return await decodeHeic(bytes);
		}
	} catch (error) {
		throw new DecodeError(format, error);
	}
}

/** ImageData over the pixels, adding an opaque alpha channel to RGB. */
function imageData(image: Image8): ImageData {
	let pixels: Uint8Array = image.data;
	if (image.channels === 3) {
		pixels = new Uint8Array(image.width * image.height * 4);
		for (let i = 0, o = 0; i < image.data.length; i += 3, o += 4) {
			pixels[o] = image.data[i]!;
			pixels[o + 1] = image.data[i + 1]!;
			pixels[o + 2] = image.data[i + 2]!;
			pixels[o + 3] = 255;
		}
	}
	const clamped = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	return new ImageData(clamped as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
}

/** Emscripten throws plain objects ({ name: 'ExitStatus', message }) as well as Errors. */
const messageOf = (error: unknown): string =>
	typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);

/** An encoder that ran out of memory exits its WASM program: a fresh instance is needed either way. */
const outOfEncoderMemory = (error: unknown) => /Program terminated|exit\(1\)|memory|abort/i.test(messageOf(error));

async function encodeJpeg(data: ImageData, quality: number): Promise<Uint8Array> {
	const jpeg = await import('@jsquash/jpeg/encode');
	const megapixels = (data.width * data.height) / 1e6;
	try {
		const first = jpegOptions(quality, megapixels);
		try {
			return new Uint8Array(await jpeg.default(data, first));
		} catch (error) {
			if (!outOfEncoderMemory(error) || first.chroma_subsample === 2) throw error;
			await jpeg.init(); // the failed instance is spent; retry at 4:2:0 with a fresh one
			return new Uint8Array(await jpeg.default(data, jpegOptions(quality, megapixels, false)));
		}
	} catch (error) {
		await jpeg.init();
		throw new EncodeError('jpeg', new Error(messageOf(error)));
	} finally {
		if (megapixels > RESET_AFTER_MEGAPIXELS) await jpeg.init();
	}
}

async function encode(image: Image8, options: EncodeOptions): Promise<Uint8Array> {
	const data = imageData(image);
	switch (options.format) {
		case 'jpeg':
			return encodeJpeg(data, options.quality);
		case 'png': {
			const { default: encodePng } = await import('@jsquash/png/encode');
			return new Uint8Array(await encodePng(data));
		}
		case 'webp': {
			const { default: encodeWebp } = await import('@jsquash/webp/encode');
			return new Uint8Array(
				await encodeWebp(
					data,
					options.lossless ? { lossless: 1, quality: 100, exact: 1 } : { quality: options.quality, method: 4 },
				),
			);
		}
	}
}

export const browserCodecs: CodecAdapter = { decode, encode };
