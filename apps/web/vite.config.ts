// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { codecAssets } from './build/codec-assets.ts';
import { models } from './build/models.ts';
import { locateOrt, ortAssets } from './build/ort-assets.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ort = locateOrt();

// Cross-origin isolation unlocks SharedArrayBuffer, which the multithreaded
// WASM fallback needs. Production gets these (and the CSP) from public/_headers.
const isolation = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
	plugins: [react(), tailwindcss(), ortAssets(), codecAssets(), models(here)],
	resolve: {
		alias: [
			{ find: '@', replacement: path.join(here, 'src') },
			// The non-bundled ORT builds: they load their WASM from /ort/<version>/
			// instead of emitting a 27 MB asset next to the app code.
			{ find: /^onnxruntime-web\/webgpu$/, replacement: path.join(ort.dist, 'ort.webgpu.min.mjs') },
			{ find: /^onnxruntime-web\/wasm$/, replacement: path.join(ort.dist, 'ort.wasm.min.mjs') },
		],
	},
	define: {
		__HUSH_VERSION__: JSON.stringify(process.env['HUSH_VERSION'] ?? '0.0.0-dev'),
	},
	// Workers are bundled separately and need the virtual asset modules too.
	worker: { format: 'es', plugins: () => [ortAssets(), codecAssets()] },
	build: {
		target: 'es2023',
		manifest: true,
		sourcemap: true,
		assetsInlineLimit: 0,
		rolldownOptions: {
			input: {
				main: path.join(here, 'index.html'),
				bench: path.join(here, 'bench/index.html'),
			},
		},
	},
	server: { headers: isolation },
	preview: { headers: isolation },
	optimizeDeps: {
		// Pre-bundling breaks their `new URL('x.wasm', import.meta.url)` lookups.
		exclude: ['onnxruntime-web', '@jsquash/jpeg', '@jsquash/png', '@jsquash/webp', '@jsquash/avif'],
	},
});
