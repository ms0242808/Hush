// SPDX-License-Identifier: Apache-2.0
import type { OutputAdapter, PlatformAdapters } from '@hush/core';
import { browserCodecs } from './codecs.ts';
import { ortInference, type OrtLogLevel } from './inference.ts';
import { browserAssets, browserStorage, browserZlib, memoryOutput, sha256Hex } from './platform.ts';

export interface BrowserAdapterOptions {
	/** WASM threads for ONNX Runtime. */
	threads: number;
	logLevel?: OrtLogLevel;
	/** Benchmark experiments only: WebGPU execution-provider options. */
	webgpuOptions?: Record<string, string>;
	/** Where finished files go; by default handed back to the page. */
	output?: OutputAdapter;
}

const now = () => performance.now();

/**
 * Everything the platform-free pipeline needs, implemented with browser APIs
 * (§4.5): WASM codecs, ONNX Runtime Web, the Cache API, same-origin fetches,
 * Web Crypto and Compression Streams.
 */
export function browserAdapters(options: BrowserAdapterOptions): PlatformAdapters {
	return {
		codecs: browserCodecs,
		inference: ortInference({
			threads: options.threads,
			now,
			...(options.logLevel && { logLevel: options.logLevel }),
			...(options.webgpuOptions && { webgpuOptions: options.webgpuOptions }),
		}),
		storage: browserStorage,
		assets: browserAssets,
		output: options.output ?? memoryOutput(),
		crypto: { sha256: sha256Hex },
		zlib: browserZlib,
		clock: { now },
	};
}
