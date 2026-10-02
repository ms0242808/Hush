// SPDX-License-Identifier: Apache-2.0
/**
 * Serve and ship the model set that fetch-models prepared.
 *
 * `pnpm fetch-models` writes `apps/web/.models/release/` (manifest plus split,
 * verified parts); `--set test` writes `.models/test/` with the tiny models CI
 * uses. Builds in the `e2e` mode (or with HUSH_MODELS=test) ship the test set
 * at /models/; everything else ships the release set. Running the end-to-end
 * tests therefore never overwrites real models.
 */
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export function models(appRoot: string): Plugin {
	let set = 'release';
	let dir = '';
	let hint = '';
	let outDir = '';
	let serving = false;

	return {
		name: 'hush:models',
		configResolved(config) {
			set = process.env['HUSH_MODELS'] ?? (config.mode === 'e2e' ? 'test' : 'release');
			dir = path.join(appRoot, '.models', set);
			hint = `Run \`pnpm fetch-models${set === 'test' ? ' --set test' : ''}\` first.`;
			outDir = path.resolve(config.root, config.build.outDir);
			serving = config.command === 'serve';
		},
		buildStart() {
			if (existsSync(path.join(dir, 'manifest.json'))) return;
			if (serving) this.warn(`No ${set} models in ${dir}: photos can't be processed. ${hint}`);
			else this.error(`No ${set} models in ${dir}. ${hint}`);
		},
		configureServer(server) {
			server.middlewares.use('/models', (request, response, next) => {
				const relative = decodeURIComponent((request.url ?? '/').split('?')[0]!);
				const file = path.join(dir, relative);
				if (!file.startsWith(dir + path.sep) || !existsSync(file) || statSync(file).isDirectory()) {
					next();
					return;
				}
				const manifest = file.endsWith('manifest.json');
				response.setHeader('Content-Type', manifest ? 'application/json' : 'application/octet-stream');
				response.setHeader('Cache-Control', manifest ? 'no-cache' : 'public, max-age=31536000, immutable');
				createReadStream(file).pipe(response);
			});
		},
		writeBundle() {
			cpSync(dir, path.join(outDir, 'models'), { recursive: true });
		},
	};
}
