// SPDX-License-Identifier: Apache-2.0
import type { Affine, Rect, Size } from '@hush/core';

/**
 * What the viewer draws with. The WebGL2 renderer is the normal path: the
 * sliders are uniforms, so dragging one redraws the comparison for the cost
 * of one pass over the screen (§2.5: "on the preview crop this runs at
 * 60 fps"). Where WebGL2 isn't available, a Canvas 2D renderer runs core's
 * own adjust code instead: slower, identical in result.
 */
export interface RenderParams {
	strength: number;
	luma: number;
	colour: number;
	detail: number;
}

export interface Frame {
	/** The canvas's size in device pixels. */
	viewport: Size;
	/** Device pixel (top-left origin) → stored photo pixel. */
	toStored: Affine;
	/** Draw from the downscaled overview only (the fit view). */
	fit: boolean;
	/** Device x of the before/after divider; null shows the original alone. */
	divider: number | null;
	params: RenderParams;
	/** Outside the photo, 0–1 sRGB. */
	background: readonly [number, number, number];
}

export interface PixelsRGBA {
	width: number;
	height: number;
	data: Uint8Array;
}

export interface Renderer {
	readonly kind: 'webgl2' | 'canvas2d';
	/** The largest region side this renderer can hold. */
	readonly maxRegionSide: number;
	setOverview(overview: PixelsRGBA, stored: Size): void;
	/** The original pixels of a region; clears the denoised layer over it. */
	setRegion(rect: Rect, original: Uint8Array): void;
	readonly region: Rect | null;
	/** Denoised preview pixels (RGBA, alpha 255 where ready) for part of the photo; ignored outside the region. */
	updateDenoised(rect: Rect, pixels: Uint8Array): void;
	draw(frame: Frame): void;
	/** Draw and read the frame back, top row first (tests and the pipeline check). */
	read(frame: Frame): PixelsRGBA;
	dispose(): void;
}

export const LUMA = [0.299, 0.587, 0.114] as const;
