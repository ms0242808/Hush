// SPDX-License-Identifier: Apache-2.0
import { InferenceError, ModelOutputError, type Backend, type InferenceSession } from '@hush/core';
import assets from 'virtual:ort-assets';
import { isFinitePrefix } from '../validate';

import type * as OrtModule from 'onnxruntime-web/webgpu';

type Ort = typeof OrtModule;

export type OrtLogLevel = 'verbose' | 'info' | 'warning' | 'error';

/**
 * WebGPU execution-provider defaults. NCHW measured ~12% faster than ORT's
 * default NHWC conversion for NAFNet on Apple silicon (docs/phase-0-results.md).
 */
const WEBGPU_DEFAULTS: Record<string, string> = { preferredLayout: 'NCHW' };

/**
 * What ONNX Runtime's own WebGPU device asks for (webgpu_context.cc), so a
 * device Hush creates gets the same kernels and the same speed.
 */
const DEVICE_FEATURES = ['shader-f16', 'subgroups', 'timestamp-query'];
const DEVICE_LIMITS = [
	'maxBindGroups',
	'maxComputeWorkgroupStorageSize',
	'maxComputeWorkgroupsPerDimension',
	'maxStorageBufferBindingSize',
	'maxBufferSize',
	'maxComputeInvocationsPerWorkgroup',
	'maxComputeWorkgroupSizeX',
	'maxComputeWorkgroupSizeY',
	'maxComputeWorkgroupSizeZ',
] as const;

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
		return { backend, ort, threads, loadMs: now() - start, wasmBytes: build.wasmBytes };
	})();
	runtime.catch(() => {
		runtime = null; // let a retry start over
	});
	return runtime;
}

export interface DeviceInfo {
	vendor: string;
	architecture: string;
	maxBufferBytes: number;
}

/** A WebGPU device of Hush's own, so it can watch for out-of-memory and loss and replace it (§2.3). */
async function requestDevice(): Promise<{ device: GPUDevice; info: DeviceInfo }> {
	const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
	const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
	if (!adapter) throw new InferenceError('device-lost', 'No WebGPU adapter is available');
	const requiredFeatures = DEVICE_FEATURES.filter((feature) => adapter.features.has(feature)) as GPUFeatureName[];
	const requiredLimits: Record<string, number> = {};
	for (const name of DEVICE_LIMITS) requiredLimits[name] = adapter.limits[name];
	const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
	return {
		device,
		info: {
			vendor: adapter.info.vendor,
			architecture: adapter.info.architecture,
			maxBufferBytes: Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize),
		},
	};
}

interface WatchedDevice {
	device: GPUDevice;
	info: DeviceInfo;
	lost: Promise<GPUDeviceLostInfo>;
	lostInfo: GPUDeviceLostInfo | null;
	/** An out-of-memory error was raised since the last run started. */
	outOfMemory: boolean;
}

function watch(device: GPUDevice, info: DeviceInfo): WatchedDevice {
	const watched: WatchedDevice = { device, info, lost: device.lost, lostInfo: null, outOfMemory: false };
	void device.lost.then((lostInfo) => {
		watched.lostInfo = lostInfo;
	});
	device.addEventListener('uncapturederror', (event) => {
		if (event.error instanceof GPUOutOfMemoryError) watched.outOfMemory = true;
	});
	return watched;
}

const OUT_OF_MEMORY =
	/out of memory|outofmemory|\boom\b|allocation failed|failed to allocate|could not allocate|memory\.grow|array buffer allocation|exceeds the max|maxBufferSize|maxStorageBufferBindingSize/i;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a runtime error means for the tiler: smaller tiles, a new device, or neither. */
async function classify(error: unknown, gpu: WatchedDevice | null): Promise<unknown> {
	if (error instanceof InferenceError || error instanceof ModelOutputError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (gpu) {
		// The run may reject a moment before the device reports the loss.
		await Promise.race([gpu.lost, delay(100)]);
		if (gpu.lostInfo) {
			return new InferenceError(
				'device-lost',
				`The GPU device was lost (${gpu.lostInfo.reason}): ${gpu.lostInfo.message}`,
			);
		}
		if (gpu.outOfMemory) return new InferenceError('out-of-memory', message);
	}
	if (OUT_OF_MEMORY.test(message)) return new InferenceError('out-of-memory', message);
	return error;
}

/** Faults to inject, for the end-to-end tests of OOM backoff and device recovery. Never set in production. */
export interface FaultPlan {
	/** Fail tiles larger than this many pixels with out-of-memory. */
	outOfMemoryAbove?: number;
	/** Lose the device on this run (1-based, counted from when the plan was set). */
	loseDeviceOnRun?: number;
}

export interface SessionOptions {
	logLevel?: OrtLogLevel;
	/** Benchmark experiments only: WebGPU execution-provider options. */
	webgpuOptions?: Record<string, string>;
}

/**
 * An ONNX Runtime session behind the platform-free InferenceSession
 * interface: tiles in, tiles out, failures reported as InferenceError so the
 * tiler can back off or recover, NaN output refused.
 */
export class OrtSession implements InferenceSession {
	readonly backend: Backend;
	createMs = 0;
	recoveries = 0;
	private session: OrtModule.InferenceSession | null = null;
	private gpu: WatchedDevice | null = null;
	private faults: FaultPlan = {};
	private runs = 0;
	private readonly ort: Ort;
	/** Kept only on WebGPU, where a lost device means building the session again. */
	private readonly model: Uint8Array | null;
	private readonly options: SessionOptions;

	private constructor(loaded: LoadedRuntime, model: Uint8Array, options: SessionOptions) {
		this.ort = loaded.ort;
		this.backend = loaded.backend;
		this.model = loaded.backend === 'webgpu' ? model : null;
		this.options = options;
	}

	static async create(loaded: LoadedRuntime, model: Uint8Array, now: () => number, options: SessionOptions = {}) {
		const session = new OrtSession(loaded, model, options);
		const start = now();
		await session.open(model);
		session.createMs = now() - start;
		return session;
	}

	/** The device's limits, for choosing a tile size (null on the processor). */
	get device(): DeviceInfo | null {
		return this.gpu?.info ?? null;
	}

	private async open(model: Uint8Array): Promise<void> {
		const severity = { verbose: 0, info: 1, warning: 2, error: 3 } as const;
		let provider: OrtModule.InferenceSession.ExecutionProviderConfig = 'wasm';
		if (this.backend === 'webgpu') {
			const { device, info } = await requestDevice();
			this.gpu = watch(device, info);
			provider = { name: 'webgpu', ...WEBGPU_DEFAULTS, ...this.options.webgpuOptions, device };
		}
		this.session = await this.ort.InferenceSession.create(model, {
			executionProviders: [provider],
			graphOptimizationLevel: 'all',
			logSeverityLevel: severity[this.options.logLevel ?? 'error'],
		});
	}

	setFaults(plan: FaultPlan): void {
		this.faults = plan;
		this.runs = 0;
	}

	async run(input: Float32Array, width: number, height: number): Promise<Float32Array> {
		const session = this.session;
		if (!session) throw new Error('The session was released');
		this.runs++;
		if (this.faults.outOfMemoryAbove !== undefined && width * height > this.faults.outOfMemoryAbove) {
			throw new InferenceError('out-of-memory', `Injected: ${width}×${height} tile is over the memory budget`);
		}
		if (this.faults.loseDeviceOnRun === this.runs) {
			const { loseDeviceOnRun: _done, ...rest } = this.faults;
			this.faults = rest;
			if (this.gpu)
				this.gpu.device.destroy(); // a genuine loss: the run below fails the way a real one does
			else throw new InferenceError('device-lost', 'Injected: device lost');
		}

		const gpu = this.gpu;
		if (gpu) gpu.outOfMemory = false;
		const tensor = new this.ort.Tensor('float32', input, [1, 3, height, width]);
		const running = session.run({ [session.inputNames[0]!]: tensor });
		let outputs: OrtModule.InferenceSession.ReturnType;
		try {
			outputs = gpu
				? await Promise.race([
						running,
						gpu.lost.then((info) => {
							throw new InferenceError('device-lost', `The GPU device was lost (${info.reason}): ${info.message}`);
						}),
					])
				: await running;
		} catch (error) {
			running.catch(() => {});
			throw await classify(error, gpu);
		}
		if (gpu?.outOfMemory) throw new InferenceError('out-of-memory', 'The GPU ran out of memory during this tile');
		const output = outputs[session.outputNames[0]!];
		if (!output) throw new Error('The model produced no output');
		const data = output.data as Float32Array;
		if (!isFinitePrefix(data)) throw new ModelOutputError();
		return data;
	}

	/**
	 * After a lost device: a new device and a new session, in place (§2.3). On
	 * the processor there is no device to lose; the tiler just retries.
	 */
	async recover(): Promise<void> {
		this.recoveries++;
		if (this.backend !== 'webgpu') return;
		const old = this.session;
		this.session = null;
		this.gpu = null;
		// The old session's device is gone; release what can be released, without waiting on it.
		if (old) void Promise.race([old.release(), delay(2000)]).catch(() => {});
		await this.open(this.model!);
	}

	async dispose(): Promise<void> {
		const session = this.session;
		this.session = null;
		await session?.release();
		this.gpu?.device.destroy();
		this.gpu = null;
	}
}
