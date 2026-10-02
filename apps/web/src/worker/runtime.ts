// SPDX-License-Identifier: Apache-2.0
import type { Backend, InferenceSession } from '@hush/core';
import assets from 'virtual:ort-assets';
import { isFinitePrefix } from './validate';

import type * as OrtModule from 'onnxruntime-web/webgpu';

type Ort = typeof OrtModule;

/**
 * WebGPU execution-provider defaults. NCHW measured ~12% faster than ORT's
 * default NHWC conversion for NAFNet on Apple silicon (docs/phase-0-results.md).
 */
const WEBGPU_DEFAULTS: Record<string, string> = { preferredLayout: 'NCHW' };

interface LoadedRuntime {
	backend: Backend;
	ort: Ort;
	threads: number;
	/** Time to fetch and join the runtime's WASM binary. */
	loadMs: number;
	wasmBytes: number;
}

let runtime: Promise<LoadedRuntime> | null = null;

async function fetchBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

export type OrtLogLevel = 'verbose' | 'info' | 'warning' | 'error';

/**
 * Load ONNX Runtime for one backend. The binary comes from our own origin in
 * ≤ 24 MiB parts and is joined here. A worker holds one runtime: switching
 * backend means starting a new worker.
 */
export function loadRuntime(
	backend: Backend,
	threads: number,
	now: () => number,
	logLevel: OrtLogLevel = 'error',
): Promise<LoadedRuntime> {
	if (runtime) {
		return runtime.then((loaded) => {
			if (loaded.backend !== backend) throw new Error(`This worker already runs ${loaded.backend}`);
			return loaded;
		});
	}
	runtime = (async () => {
		const start = now();
		const build = assets.builds[backend];
		const [ort, parts] = await Promise.all([
			backend === 'webgpu' ? import('onnxruntime-web/webgpu') : (import('onnxruntime-web/wasm') as Promise<Ort>),
			Promise.all(build.wasmParts.map((part) => fetchBytes(assets.base + part))),
		]);
		const binary = new Uint8Array(build.wasmBytes);
		let offset = 0;
		for (const part of parts) {
			binary.set(part, offset);
			offset += part.byteLength;
		}
		if (offset !== build.wasmBytes)
			throw new Error(`ONNX Runtime binary is ${offset} bytes, expected ${build.wasmBytes}`);

		ort.env.logLevel = logLevel;
		ort.env.wasm.wasmBinary = binary;
		ort.env.wasm.wasmPaths = { mjs: new URL(assets.base + build.glue, self.location.origin).href };
		ort.env.wasm.numThreads = threads;
		if (backend === 'webgpu') ort.env.webgpu.powerPreference = 'high-performance';
		return { backend, ort, threads, loadMs: now() - start, wasmBytes: build.wasmBytes };
	})();
	runtime.catch(() => {
		runtime = null; // let a retry start over
	});
	return runtime;
}

function named(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

export interface SessionInfo {
	session: InferenceSession;
	createMs: number;
	/** Fires if the GPU device is lost (driver reset, sleep, out of memory). */
	deviceLost: Promise<string> | null;
}

/** Create an ORT session and wrap it in the platform-free InferenceSession interface. */
export async function createSession(
	loaded: LoadedRuntime,
	model: Uint8Array,
	now: () => number,
	logLevel: OrtLogLevel = 'error',
	webgpuOptions: Record<string, string> = {},
): Promise<SessionInfo> {
	const { ort, backend } = loaded;
	const start = now();
	const severity = { verbose: 0, info: 1, warning: 2, error: 3 } as const;
	const session = await ort.InferenceSession.create(model, {
		executionProviders: [backend === 'webgpu' ? { name: 'webgpu', ...WEBGPU_DEFAULTS, ...webgpuOptions } : backend],
		graphOptimizationLevel: 'all',
		logSeverityLevel: severity[logLevel],
	});
	const createMs = now() - start;
	const inputName = session.inputNames[0]!;
	const outputName = session.outputNames[0]!;

	let deviceLost: Promise<string> | null = null;
	if (backend === 'webgpu') {
		const device = await ort.env.webgpu.device;
		deviceLost = device.lost.then((info) => `${info.reason}: ${info.message}`);
	}

	return {
		createMs,
		deviceLost,
		session: {
			backend,
			async run(input, width, height) {
				const tensor = new ort.Tensor('float32', input, [1, 3, height, width]);
				const outputs = await session.run({ [inputName]: tensor });
				const output = outputs[outputName];
				if (!output) throw new Error(`Model produced no "${outputName}" output`);
				const data = output.data as Float32Array;
				if (!isFinitePrefix(data)) {
					throw named('ModelOutputError', 'The model returned invalid values (NaN or infinity)');
				}
				return data;
			},
			dispose: () => session.release(),
		},
	};
}
