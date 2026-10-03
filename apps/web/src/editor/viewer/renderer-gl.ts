// SPDX-License-Identifier: Apache-2.0
import { intersectRects, type Rect, type Size } from '@hush/core';
import type { Frame, PixelsRGBA, Renderer } from './renderer.ts';

/**
 * The comparison on the GPU, with the adjust stage of core/adjust.ts as a
 * shader (§2.5):
 *
 *   Δ = denoised − original,  ΔY = luminance of Δ (BT.601)
 *   ΔY′ = (1 − detail)·ΔY + detail·blur(ΔY)
 *   out = original + strength·(luma·ΔY′ + colour·(Δ − ΔY))
 *
 * blur(ΔY) is the same 5-tap binomial both ways, mirrored at the edges. It
 * doesn't depend on any slider, so two passes compute it into a texture only
 * when new preview tiles arrive; a slider drag is one pass over the screen.
 * Values in between are 8-bit textures carrying 16-bit fixed point (1/128 of
 * a level), so nothing needs float render targets.
 */

const VERTEX = `#version 300 es
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float K0 = 1.0 / 16.0;
const float K1 = 4.0 / 16.0;
const float K2 = 6.0 / 16.0;
vec4 encode(float v) {
	float q = clamp(floor((v + 256.0) * 128.0 + 0.5), 0.0, 65535.0);
	float hi = floor(q / 256.0);
	return vec4(hi / 255.0, (q - hi * 256.0) / 255.0, 0.0, 1.0);
}
float decode(vec4 c) {
	return (floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5)) / 128.0 - 256.0;
}
int mirror(int i, int n) {
	if (n == 1) return 0;
	if (i < 0) i = -i;
	if (i >= n) i = 2 * (n - 1) - i;
	return clamp(i, 0, n - 1);
}
`;

/** Pass 1: horizontally blurred ΔY over the region. */
const BLUR_H = `${COMMON}
uniform sampler2D uOriginal;
uniform sampler2D uDenoised;
uniform ivec2 uSize;
out vec4 outColor;
float deltaY(ivec2 p) {
	vec4 d = texelFetch(uDenoised, p, 0);
	if (d.a < 0.5) return 0.0;
	vec3 o = texelFetch(uOriginal, p, 0).rgb;
	return dot(floor(d.rgb * 255.0 + 0.5) - floor(o * 255.0 + 0.5), LUMA);
}
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	int y = p.y;
	float sum = K0 * deltaY(ivec2(mirror(p.x - 2, uSize.x), y))
		+ K1 * deltaY(ivec2(mirror(p.x - 1, uSize.x), y))
		+ K2 * deltaY(p)
		+ K1 * deltaY(ivec2(mirror(p.x + 1, uSize.x), y))
		+ K0 * deltaY(ivec2(mirror(p.x + 2, uSize.x), y));
	outColor = encode(sum);
}`;

/** Pass 2: the vertical half of the blur: the coarse luminance change. */
const BLUR_V = `${COMMON}
uniform sampler2D uHorizontal;
uniform ivec2 uSize;
out vec4 outColor;
float at(int x, int y) {
	return decode(texelFetch(uHorizontal, ivec2(x, mirror(y, uSize.y)), 0));
}
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	float sum = K0 * at(p.x, p.y - 2) + K1 * at(p.x, p.y - 1) + K2 * at(p.x, p.y) + K1 * at(p.x, p.y + 1) + K0 * at(p.x, p.y + 2);
	outColor = encode(sum);
}`;

/** Pass 3: the screen. */
const DISPLAY = `${COMMON}
uniform sampler2D uOverview;
uniform sampler2D uOriginal;
uniform sampler2D uDenoised;
uniform sampler2D uCoarse;
uniform mat3 uToStored;
uniform vec2 uViewport;
uniform vec2 uStored;
uniform vec4 uRegion;
uniform bool uHasRegion;
uniform bool uFit;
uniform float uDivider;
uniform bool uCompare;
uniform vec3 uWeights;
uniform vec3 uBackground;
out vec4 outColor;
void main() {
	vec2 device = vec2(gl_FragCoord.x, uViewport.y - gl_FragCoord.y);
	vec2 s = (uToStored * vec3(device, 1.0)).xy;
	if (s.x < 0.0 || s.y < 0.0 || s.x >= uStored.x || s.y >= uStored.y) {
		outColor = vec4(uBackground, 1.0);
		return;
	}
	vec2 r = s - uRegion.xy;
	if (uFit || !uHasRegion || r.x < 0.0 || r.y < 0.0 || r.x >= uRegion.z || r.y >= uRegion.w) {
		outColor = vec4(texture(uOverview, s / uStored).rgb, 1.0);
		return;
	}
	ivec2 t = ivec2(floor(r));
	vec3 o = floor(texelFetch(uOriginal, t, 0).rgb * 255.0 + 0.5);
	vec3 result = o;
	if (uCompare && device.x >= uDivider) {
		vec4 d = texelFetch(uDenoised, t, 0);
		if (d.a > 0.5) {
			vec3 delta = floor(d.rgb * 255.0 + 0.5) - o;
			float dy = dot(delta, LUMA);
			float adjusted = uWeights.z > 0.0 ? mix(dy, decode(texelFetch(uCoarse, t, 0)), uWeights.z) : dy;
			result = clamp(floor(o + uWeights.x * adjusted + uWeights.y * (delta - dy) + 0.5), 0.0, 255.0);
		}
	}
	outColor = vec4(result / 255.0, 1.0);
}`;

interface Program {
	program: WebGLProgram;
	uniforms: Map<string, WebGLUniformLocation | null>;
}

interface RegionTextures {
	rect: Rect;
	original: WebGLTexture;
	denoised: WebGLTexture;
	horizontal: WebGLTexture;
	coarse: WebGLTexture;
	framebuffers: [WebGLFramebuffer, WebGLFramebuffer];
	blurDirty: boolean;
}

export class GlRenderer implements Renderer {
	readonly kind = 'webgl2';
	readonly maxRegionSide: number;
	private readonly gl: WebGL2RenderingContext;
	private readonly display: Program;
	private readonly blurH: Program;
	private readonly blurV: Program;
	private overview: { texture: WebGLTexture; stored: Size } | null = null;
	private regionTextures: RegionTextures | null = null;

	private constructor(gl: WebGL2RenderingContext) {
		this.gl = gl;
		this.maxRegionSide = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
		this.display = this.compile(DISPLAY, [
			'uOverview',
			'uOriginal',
			'uDenoised',
			'uCoarse',
			'uToStored',
			'uViewport',
			'uStored',
			'uRegion',
			'uHasRegion',
			'uFit',
			'uDivider',
			'uCompare',
			'uWeights',
			'uBackground',
		]);
		this.blurH = this.compile(BLUR_H, ['uOriginal', 'uDenoised', 'uSize']);
		this.blurV = this.compile(BLUR_V, ['uHorizontal', 'uSize']);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
	}

	/** A renderer for the canvas, or null when WebGL2 isn't usable here (the Canvas 2D path takes over). */
	static create(canvas: HTMLCanvasElement, colourSpace: PredefinedColorSpace): GlRenderer | null {
		const gl = canvas.getContext('webgl2', {
			alpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			premultipliedAlpha: false,
			preserveDrawingBuffer: false,
			powerPreference: 'default',
		});
		if (!gl || typeof (gl as Partial<WebGL2RenderingContext>).texStorage2D !== 'function') return null;
		// Pixels are decoded without colour conversion (§2.6): draw them in the photo's own space.
		if ('drawingBufferColorSpace' in gl) {
			try {
				gl.drawingBufferColorSpace = colourSpace;
			} catch {
				// Display P3 canvases aren't supported here: sRGB it is.
			}
		}
		try {
			const renderer = new GlRenderer(gl);
			if (renderer.maxRegionSide < 2048) return null;
			return renderer;
		} catch (error) {
			console.warn('WebGL2 renderer unavailable; drawing with Canvas 2D.', error);
			return null;
		}
	}

	get region(): Rect | null {
		return this.regionTextures?.rect ?? null;
	}

	private compile(fragment: string, uniforms: string[]): Program {
		const { gl } = this;
		const shader = (type: number, source: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, source);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
				throw new Error(`Shader: ${gl.getShaderInfoLog(s) ?? 'failed to compile'}`);
			}
			return s;
		};
		const program = gl.createProgram();
		gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
		gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
			throw new Error(`Program: ${gl.getProgramInfoLog(program) ?? 'failed to link'}`);
		}
		return { program, uniforms: new Map(uniforms.map((name) => [name, gl.getUniformLocation(program, name)])) };
	}

	private texture(width: number, height: number, filter: number, data: Uint8Array | null): WebGLTexture {
		const { gl } = this;
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const levels = filter === gl.LINEAR_MIPMAP_LINEAR ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
		gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height);
		if (data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
		return texture;
	}

	setOverview(overview: PixelsRGBA, stored: Size): void {
		const { gl } = this;
		if (this.overview) gl.deleteTexture(this.overview.texture);
		const texture = this.texture(overview.width, overview.height, gl.LINEAR_MIPMAP_LINEAR, overview.data);
		gl.generateMipmap(gl.TEXTURE_2D);
		this.overview = { texture, stored };
	}

	setRegion(rect: Rect, original: Uint8Array): void {
		const { gl } = this;
		this.dropRegion();
		const { width, height } = rect;
		const horizontal = this.texture(width, height, gl.NEAREST, null);
		const coarse = this.texture(width, height, gl.NEAREST, null);
		const framebuffers = [horizontal, coarse].map((texture) => {
			const framebuffer = gl.createFramebuffer();
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
			return framebuffer;
		}) as [WebGLFramebuffer, WebGLFramebuffer];
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.regionTextures = {
			rect,
			original: this.texture(width, height, gl.NEAREST, original),
			denoised: this.texture(width, height, gl.NEAREST, null), // WebGL zero-fills: nothing denoised yet
			horizontal,
			coarse,
			framebuffers,
			blurDirty: true,
		};
	}

	private dropRegion(): void {
		const region = this.regionTextures;
		if (!region) return;
		const { gl } = this;
		for (const texture of [region.original, region.denoised, region.horizontal, region.coarse])
			gl.deleteTexture(texture);
		for (const framebuffer of region.framebuffers) gl.deleteFramebuffer(framebuffer);
		this.regionTextures = null;
	}

	updateDenoised(rect: Rect, pixels: Uint8Array): void {
		const region = this.regionTextures;
		if (!region) return;
		const overlap = intersectRects(rect, region.rect);
		if (!overlap) return;
		const { gl } = this;
		gl.bindTexture(gl.TEXTURE_2D, region.denoised);
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rect.width);
		gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, overlap.x - rect.x);
		gl.pixelStorei(gl.UNPACK_SKIP_ROWS, overlap.y - rect.y);
		gl.texSubImage2D(
			gl.TEXTURE_2D,
			0,
			overlap.x - region.rect.x,
			overlap.y - region.rect.y,
			overlap.width,
			overlap.height,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			pixels,
		);
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
		gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
		gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
		region.blurDirty = true;
	}

	private bind(program: Program, unit: number, name: string, texture: WebGLTexture): void {
		const { gl } = this;
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(program.uniforms.get(name)!, unit);
	}

	/** Recompute blur(ΔY) for the region: only after new tiles, and only when Detail is in use. */
	private blur(region: RegionTextures): void {
		const { gl } = this;
		const { width, height } = region.rect;
		gl.viewport(0, 0, width, height);

		gl.useProgram(this.blurH.program);
		this.bind(this.blurH, 0, 'uOriginal', region.original);
		this.bind(this.blurH, 1, 'uDenoised', region.denoised);
		gl.uniform2i(this.blurH.uniforms.get('uSize')!, width, height);
		gl.bindFramebuffer(gl.FRAMEBUFFER, region.framebuffers[0]);
		gl.drawArrays(gl.TRIANGLES, 0, 3);

		gl.useProgram(this.blurV.program);
		this.bind(this.blurV, 0, 'uHorizontal', region.horizontal);
		gl.uniform2i(this.blurV.uniforms.get('uSize')!, width, height);
		gl.bindFramebuffer(gl.FRAMEBUFFER, region.framebuffers[1]);
		gl.drawArrays(gl.TRIANGLES, 0, 3);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		region.blurDirty = false;
	}

	draw(frame: Frame): void {
		const { gl } = this;
		if (gl.isContextLost() || !this.overview) return;
		const region = this.regionTextures;
		const compare = frame.divider !== null && !frame.fit;
		if (region && compare && frame.params.detail > 0 && region.blurDirty) this.blur(region);

		const { width, height } = frame.viewport;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, width, height);
		const p = this.display;
		const u = (name: string) => p.uniforms.get(name)!;
		gl.useProgram(p.program);
		this.bind(p, 0, 'uOverview', this.overview.texture);
		if (region) {
			this.bind(p, 1, 'uOriginal', region.original);
			this.bind(p, 2, 'uDenoised', region.denoised);
			this.bind(p, 3, 'uCoarse', region.coarse);
		}
		const [a, b, c, d, e, f] = frame.toStored;
		gl.uniformMatrix3fv(u('uToStored'), false, [a, b, 0, c, d, 0, e, f, 1]);
		gl.uniform2f(u('uViewport'), width, height);
		gl.uniform2f(u('uStored'), this.overview.stored.width, this.overview.stored.height);
		const rect = region?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
		gl.uniform4f(u('uRegion'), rect.x, rect.y, rect.width, rect.height);
		gl.uniform1i(u('uHasRegion'), region ? 1 : 0);
		gl.uniform1i(u('uFit'), frame.fit ? 1 : 0);
		gl.uniform1f(u('uDivider'), frame.divider ?? 0);
		gl.uniform1i(u('uCompare'), compare ? 1 : 0);
		const { strength, luma, colour, detail } = frame.params;
		const clamp = (v: number) => Math.min(1, Math.max(0, v));
		gl.uniform3f(u('uWeights'), clamp(strength) * clamp(luma), clamp(strength) * clamp(colour), clamp(detail));
		gl.uniform3f(u('uBackground'), ...frame.background);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	read(frame: Frame): PixelsRGBA {
		const { gl } = this;
		this.draw(frame);
		const { width, height } = frame.viewport;
		const flipped = new Uint8Array(width * height * 4);
		gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
		const data = new Uint8Array(flipped.length);
		for (let y = 0; y < height; y++) {
			data.set(flipped.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
		}
		return { width, height, data };
	}

	dispose(): void {
		this.dropRegion();
		if (this.overview) this.gl.deleteTexture(this.overview.texture);
		this.overview = null;
		for (const program of [this.display, this.blurH, this.blurV]) this.gl.deleteProgram(program.program);
	}
}
