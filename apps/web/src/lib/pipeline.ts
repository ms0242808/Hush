// SPDX-License-Identifier: Apache-2.0
import * as Comlink from 'comlink';
import type { PipelineApi } from '../worker/pipeline.worker.ts';

export type Pipeline = Comlink.Remote<PipelineApi>;

export interface PipelineHandle {
	api: Pipeline;
	terminate(): void;
}

/** Start a pipeline worker. One worker holds one runtime, so switching backend means a new worker. */
export function startPipeline(): PipelineHandle {
	const worker = new Worker(new URL('../worker/pipeline.worker.ts', import.meta.url), {
		type: 'module',
		name: 'hush-pipeline',
	});
	const api = Comlink.wrap<PipelineApi>(worker);
	return {
		api,
		terminate() {
			api[Comlink.releaseProxy]();
			worker.terminate();
		},
	};
}

export const proxy = Comlink.proxy;
