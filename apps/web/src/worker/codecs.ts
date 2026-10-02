// SPDX-License-Identifier: Apache-2.0
import type { Image8 } from '@hush/core';
import { sniffFormat, type PhotoFormat } from '../lib/formats.ts';

export { sniffFormat, type PhotoFormat };

export class UnsupportedFormatError extends Error {
	constructor() {
		super('Unsupported format');
		this.name = 'UnsupportedFormatError';
	}
}

export class DecodeError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : 'Decoding failed');
		this.name = 'DecodeError';
	}
}

/**
 * Decode straight to RGBA pixels with WASM codecs, never through a canvas:
 * canvases have size ceilings photographer-sized images hit, and they convert
 * colour. Codecs load on first use.
 */
export async function decodePhoto(buffer: ArrayBuffer): Promise<{ image: Image8; format: PhotoFormat }> {
	const format = sniffFormat(new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength)));
	if (!format) throw new UnsupportedFormatError();

	let decoded: ImageData;
	try {
		switch (format) {
			case 'jpeg':
				decoded = await (await import('@jsquash/jpeg/decode')).default(buffer);
				break;
			case 'png':
				decoded = await (await import('@jsquash/png/decode')).default(buffer);
				break;
			case 'webp':
				decoded = await (await import('@jsquash/webp/decode')).default(buffer);
				break;
		}
	} catch (error) {
		throw new DecodeError(error);
	}
	const data = new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
	return { image: { width: decoded.width, height: decoded.height, channels: 4, data }, format };
}

/** Encode RGBA pixels as JPEG with MozJPEG. */
export async function encodeJpeg(image: Image8, quality: number): Promise<Uint8Array> {
	if (image.channels !== 4) throw new Error('JPEG encoding expects RGBA pixels');
	const { default: encode } = await import('@jsquash/jpeg/encode');
	const pixels = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength);
	const imageData = new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
	return new Uint8Array(await encode(imageData, { quality }));
}
