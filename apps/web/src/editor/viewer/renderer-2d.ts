// SPDX-License-Identifier: Apache-2.0
import { adjustImage, intersectRects, pixelBounds, type Affine, type Rect, type Size } from '@hush/core';
import type { Frame, PixelsRGBA, RenderParams, Renderer } from './renderer.ts';
import { applyAffine, invertAffine } from './view-model.ts';

/**
 * The comparison without WebGL2 (rare: no GPU acceleration at all, or a
 * blocklisted driver with software GL turned off). It runs core's own adjust
 * stage over the visible part of the region, so it shows exactly what an
 * export would, just more slowly: a slider change costs one pass on the CPU.
 */

type Surface = HTMLCanvasElement | OffscreenCanvas;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function surface(width: number, height: number): Surface {
	if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function compose([a1, b1, c1, d1, e1, f1]: Affine, [a2, b2, c2, d2, e2, f2]: Affine): Affine {
	return [
		a1 * a2 + c1 * b2,
		b1 * a2 + d1 * b2,
		a1 * c2 + c1 * d2,
		b1 * c2 + d1 * d2,
		a1 * e2 + c1 * f2 + e1,
		b1 * e2 + d1 * f2 + f1,
	];
}

export class CanvasRenderer implements Renderer {
	readonly kind = 'canvas2d';
	readonly maxRegionSide = 4096;
	private readonly context: CanvasRenderingContext2D;
	private readonly colourSpace: PredefinedColorSpace;
	private overview: { surface: Surface; width: number; height: number; stored: Size } | null = null;
	private regionData: { rect: Rect; original: Uint8Array; denoised: Uint8Array; surface: Surface } | null = null;
	private adjusted: { key: string; rect: Rect; surface: Surface } | null = null;

	private constructor(context: CanvasRenderingContext2D, colourSpace: PredefinedColorSpace) {
		this.context = context;
		this.colourSpace = colourSpace;
	}

	static create(canvas: HTMLCanvasElement, colourSpace: PredefinedColorSpace): CanvasRenderer | null {
		const context = canvas.getContext('2d', { alpha: false, colorSpace: colourSpace });
		return context ? new CanvasRenderer(context, colourSpace) : null;
	}

	get region(): Rect | null {
		return this.regionData?.rect ?? null;
	}

	private paint(width: number, height: number, data: Uint8Array): Surface {
		const target = surface(width, height);
		const context = target.getContext('2d', { colorSpace: this.colourSpace }) as Context2D;
		const pixels = new Uint8ClampedArray(
			data.buffer,
			data.byteOffset,
			data.byteLength,
		) as Uint8ClampedArray<ArrayBuffer>;
		context.putImageData(new ImageData(pixels, width, height, { colorSpace: this.colourSpace }), 0, 0);
		return target;
	}

	setOverview(overview: PixelsRGBA, stored: Size): void {
		this.overview = {
			surface: this.paint(overview.width, overview.height, overview.data),
			width: overview.width,
			height: overview.height,
			stored,
		};
	}

	setRegion(rect: Rect, original: Uint8Array): void {
		this.regionData = {
			rect,
			original,
			denoised: new Uint8Array(original.length),
			surface: this.paint(rect.width, rect.height, original),
		};
		this.adjusted = null;
	}

	updateDenoised(rect: Rect, pixels: Uint8Array): void {
		const region = this.regionData;
		if (!region) return;
		const overlap = intersectRects(rect, region.rect);
		if (!overlap) return;
		for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
			const from = ((y - rect.y) * rect.width + (overlap.x - rect.x)) * 4;
			const to = ((y - region.rect.y) * region.rect.width + (overlap.x - region.rect.x)) * 4;
			region.denoised.set(pixels.subarray(from, from + overlap.width * 4), to);
		}
		this.adjusted = null;
	}

	/** Core's adjust stage over `rect` (inside the region), with two pixels of margin for its blur. */
	private adjust(rect: Rect, params: RenderParams, key: string): { key: string; rect: Rect; surface: Surface } {
		const region = this.regionData!;
		const margin = intersectRects(
			{ x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 },
			region.rect,
		)!;
		const { width, height } = margin;
		const original = new Uint8Array(width * height * 4);
		const denoised = new Float32Array(3 * width * height);
		const ready = new Uint8Array(width * height);
		const plane = width * height;
		for (let y = 0; y < height; y++) {
			const row = ((margin.y - region.rect.y + y) * region.rect.width + (margin.x - region.rect.x)) * 4;
			original.set(region.original.subarray(row, row + width * 4), y * width * 4);
			for (let x = 0; x < width; x++) {
				const p = row + x * 4;
				const o = y * width + x;
				ready[o] = region.denoised[p + 3]! > 0 ? 1 : 0;
				// Where no tile is done yet, the "result" is the original: no change.
				const source = ready[o] ? region.denoised : region.original;
				denoised[o] = source[p]! / 255;
				denoised[plane + o] = source[p + 1]! / 255;
				denoised[2 * plane + o] = source[p + 2]! / 255;
			}
		}
		const out = adjustImage({ width, height, channels: 4, data: original }, denoised, params);
		// Pixels still waiting for their tile show the original, exactly.
		for (let o = 0; o < plane; o++) {
			if (!ready[o]) out.data.set(original.subarray(o * 4, o * 4 + 4), o * 4);
		}
		return { key, rect: margin, surface: this.paint(width, height, out.data) };
	}

	draw(frame: Frame): void {
		const { context } = this;
		const { width, height } = frame.viewport;
		if (context.canvas.width !== width || context.canvas.height !== height) {
			context.canvas.width = width;
			context.canvas.height = height;
		}
		const [r, g, b] = frame.background;
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.fillStyle = `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
		context.fillRect(0, 0, width, height);
		if (!this.overview) return;
		const toDevice = invertAffine(frame.toStored);

		const { overview } = this;
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = 'high';
		context.setTransform(
			...compose(toDevice, [
				overview.stored.width / overview.width,
				0,
				0,
				overview.stored.height / overview.height,
				0,
				0,
			]),
		);
		context.drawImage(overview.surface, 0, 0);

		const region = this.regionData;
		if (frame.fit || !region) return;
		context.imageSmoothingEnabled = false;
		context.setTransform(...compose(toDevice, [1, 0, 0, 1, region.rect.x, region.rect.y]));
		context.drawImage(region.surface, 0, 0);
		if (frame.divider === null || frame.divider >= width) return;

		// What's visible, in stored pixels: the adjust stage runs there only.
		const corners = [
			{ x: frame.divider, y: 0 },
			{ x: width, y: 0 },
			{ x: frame.divider, y: height },
			{ x: width, y: height },
		].map((corner) => applyAffine(frame.toStored, corner));
		const xs = corners.map((c) => c.x);
		const ys = corners.map((c) => c.y);
		const visible = intersectRects(
			pixelBounds({
				x: Math.min(...xs),
				y: Math.min(...ys),
				width: Math.max(...xs) - Math.min(...xs),
				height: Math.max(...ys) - Math.min(...ys),
			}),
			region.rect,
		);
		if (!visible) return;
		const { strength, luma, colour, detail } = frame.params;
		const key = `${visible.x},${visible.y},${visible.width},${visible.height}|${strength},${luma},${colour},${detail}`;
		if (this.adjusted?.key !== key) this.adjusted = this.adjust(visible, frame.params, key);
		const adjusted = this.adjusted;
		context.save();
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.beginPath();
		context.rect(frame.divider, 0, width - frame.divider, height);
		context.clip();
		context.setTransform(...compose(toDevice, [1, 0, 0, 1, adjusted.rect.x, adjusted.rect.y]));
		context.drawImage(adjusted.surface, 0, 0);
		context.restore();
	}

	read(frame: Frame): PixelsRGBA {
		this.draw(frame);
		const { width, height } = frame.viewport;
		const image = this.context.getImageData(0, 0, width, height, { colorSpace: this.colourSpace });
		return { width, height, data: new Uint8Array(image.data.buffer) };
	}

	dispose(): void {
		this.overview = null;
		this.regionData = null;
		this.adjusted = null;
	}
}
