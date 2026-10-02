// SPDX-License-Identifier: Apache-2.0
/**
 * Self-host ONNX Runtime Web.
 *
 * Copies the two runtime builds Hush uses into `public/ort/<version>/` and
 * splits any WASM binary over 24 MiB into parts (Cloudflare serves at most
 * 25 MiB per file). The app fetches the parts, joins them and hands the result
 * to ORT as `env.wasm.wasmBinary`. The file list reaches the app as the
 * `virtual:ort-assets` module. The versioned path makes every file immutable.
 *
 *   webgpu  the asyncify build: ORT's WebGPU execution provider (also runs WASM)
 *   wasm    the plain SIMD + threads build: the processor-only path, ~half the size
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

export const PART_BYTES = 24 * 1024 * 1024;

const BUILDS = {
	webgpu: 'ort-wasm-simd-threaded.asyncify',
	wasm: 'ort-wasm-simd-threaded',
} as const;

export interface OrtBuildFiles {
	glue: string;
	wasmBytes: number;
	wasmParts: string[];
}

export interface OrtAssets {
	version: string;
	base: string;
	builds: Record<keyof typeof BUILDS, OrtBuildFiles>;
}

/** The directory holding ORT's dist files, and ORT's version. */
export function locateOrt(): { dist: string; version: string } {
	const require = createRequire(import.meta.url);
	const dist = path.dirname(require.resolve('onnxruntime-web')); // resolves to dist/ort.node.min.js
	const pkg = JSON.parse(readFileSync(path.join(dist, '..', 'package.json'), 'utf8')) as { version: string };
	return { dist, version: pkg.version };
}

function writeOrtFiles(publicDir: string): OrtAssets {
	const { dist, version } = locateOrt();
	const root = path.join(publicDir, 'ort');
	const target = path.join(root, version);
	const stamp = path.join(target, 'assets.json');

	if (existsSync(stamp)) return JSON.parse(readFileSync(stamp, 'utf8')) as OrtAssets;

	rmSync(root, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });

	const builds = {} as OrtAssets['builds'];
	for (const [key, name] of Object.entries(BUILDS) as Array<[keyof typeof BUILDS, string]>) {
		copyFileSync(path.join(dist, `${name}.mjs`), path.join(target, `${name}.mjs`));
		const wasm = readFileSync(path.join(dist, `${name}.wasm`));
		const parts: string[] = [];
		for (let offset = 0, i = 0; offset < wasm.byteLength; offset += PART_BYTES, i++) {
			const part = `${name}.wasm.${String(i).padStart(3, '0')}`;
			writeFileSync(path.join(target, part), wasm.subarray(offset, offset + PART_BYTES));
			parts.push(part);
		}
		builds[key] = { glue: `${name}.mjs`, wasmBytes: wasm.byteLength, wasmParts: parts };
	}

	const assets: OrtAssets = { version, base: `/ort/${version}/`, builds };
	writeFileSync(stamp, JSON.stringify(assets, null, '\t') + '\n');
	return assets;
}

export function ortAssets(): Plugin {
	const id = 'virtual:ort-assets';
	let assets: OrtAssets | undefined;
	return {
		name: 'hush:ort-assets',
		configResolved(config) {
			assets = writeOrtFiles(config.publicDir);
		},
		resolveId(source) {
			return source === id ? `\0${id}` : undefined;
		},
		load(resolved) {
			if (resolved !== `\0${id}`) return undefined;
			return `export default ${JSON.stringify(assets)};`;
		},
	};
}
