// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />

declare const __HUSH_VERSION__: string;

declare module 'virtual:ort-assets' {
	interface OrtBuildFiles {
		glue: string;
		wasmBytes: number;
		wasmParts: string[];
	}
	const assets: {
		version: string;
		base: string;
		builds: { webgpu: OrtBuildFiles; wasm: OrtBuildFiles };
	};
	export default assets;
}

declare module 'virtual:codec-assets' {
	const assets: {
		/** libheif-js, served as its own file (LGPL) and imported by URL. */
		libheif: { version: string; module: string };
	};
	export default assets;
}
