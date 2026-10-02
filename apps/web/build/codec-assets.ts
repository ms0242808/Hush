// SPDX-License-Identifier: Apache-2.0
/**
 * Self-host the HEIC decoder as a separately loaded module.
 *
 * libheif-js is LGPL-3.0 (§9.1). Copied to `public/codecs/libheif/<version>/`
 * with its licence and imported by URL at runtime — never bundled into
 * Hush's own code — it stays a replaceable file, which is what the LGPL asks
 * of a combined work. The versioned path makes it immutable. The URL reaches
 * the app as the `virtual:codec-assets` module.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

export interface CodecAssets {
	libheif: { version: string; module: string };
}

function writeCodecFiles(publicDir: string): CodecAssets {
	const require = createRequire(import.meta.url);
	const root = path.dirname(require.resolve('libheif-js/package.json'));
	const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
	const base = path.join(publicDir, 'codecs');
	const target = path.join(base, 'libheif', version);
	const assets: CodecAssets = { libheif: { version, module: `/codecs/libheif/${version}/libheif-bundle.mjs` } };
	const stamp = path.join(target, 'assets.json');
	if (existsSync(stamp)) return assets;

	rmSync(base, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	copyFileSync(path.join(root, 'libheif-wasm', 'libheif-bundle.mjs'), path.join(target, 'libheif-bundle.mjs'));
	copyFileSync(path.join(root, 'libheif-wasm', 'LICENSE'), path.join(target, 'LICENSE'));
	writeFileSync(
		path.join(target, 'README.txt'),
		[
			`libheif-js ${version} (https://github.com/catdad-experiments/libheif-js), an Emscripten build of`,
			'libheif (https://github.com/strukturag/libheif) and libde265, licensed under the GNU LGPL v3 (see LICENSE).',
			'Hush loads this file at runtime only to decode HEIC photos; it can be replaced with any',
			'compatible build of libheif-js.',
			'',
		].join('\n'),
	);
	writeFileSync(stamp, JSON.stringify(assets, null, '\t') + '\n');
	return assets;
}

export function codecAssets(): Plugin {
	const id = 'virtual:codec-assets';
	let assets: CodecAssets | undefined;
	return {
		name: 'hush:codec-assets',
		configResolved(config) {
			assets = writeCodecFiles(config.publicDir);
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
