// SPDX-License-Identifier: Apache-2.0
/**
 * Build-output checks. Fails CI when:
 *   - any file is over 24 MiB (§6.6 rule 1: Cloudflare serves at most 25 MiB per file);
 *   - the root page's first-load JavaScript is over 150 KB gzipped (§5.10).
 *
 *   node tools/check-dist.ts [dir]      default apps/web/dist
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { INITIAL_JS_BUDGET_BYTES, MAX_FILE_BYTES } from './limits.ts';

interface ManifestChunk {
	file: string;
	imports?: string[];
	isEntry?: boolean;
}

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : [full];
	});
}

/** The JS an entry loads before anything is clicked: its chunk plus static imports, recursively. */
export function initialChunks(manifest: Record<string, ManifestChunk>, entry: string): string[] {
	const seen = new Set<string>();
	const visit = (key: string) => {
		const chunk = manifest[key];
		if (!chunk || seen.has(chunk.file)) return;
		seen.add(chunk.file);
		for (const imported of chunk.imports ?? []) visit(imported);
	};
	visit(entry);
	return [...seen];
}

function main(): void {
	const root = path.resolve(
		process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/dist'),
	);
	const files = walk(root);
	const failures: string[] = [];

	const tooBig = files.filter((file) => statSync(file).size > MAX_FILE_BYTES);
	for (const file of tooBig) {
		failures.push(`${path.relative(root, file)} is ${(statSync(file).size / 2 ** 20).toFixed(1)} MiB (limit 24 MiB)`);
	}

	const manifest = JSON.parse(readFileSync(path.join(root, '.vite/manifest.json'), 'utf8')) as Record<
		string,
		ManifestChunk
	>;
	const chunks = initialChunks(manifest, 'index.html');
	const gzipped = chunks.reduce(
		(sum, file) => sum + gzipSync(readFileSync(path.join(root, file)), { level: 9 }).byteLength,
		0,
	);
	if (gzipped > INITIAL_JS_BUDGET_BYTES) {
		failures.push(
			`first-load JS is ${(gzipped / 1024).toFixed(1)} KB gzipped (budget ${INITIAL_JS_BUDGET_BYTES / 1024} KB)`,
		);
	}

	const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
	const largest = files.reduce((a, b) => (statSync(a).size >= statSync(b).size ? a : b));
	console.log(`${files.length} files, ${(total / 1e6).toFixed(1)} MB in ${path.relative(process.cwd(), root) || '.'}`);
	console.log(
		`largest file: ${path.relative(root, largest)} (${(statSync(largest).size / 2 ** 20).toFixed(1)} MiB, limit 24 MiB)`,
	);
	console.log(
		`first-load JS (${chunks.length} chunks): ${(gzipped / 1024).toFixed(1)} KB gzipped (budget ${INITIAL_JS_BUDGET_BYTES / 1024} KB)`,
	);

	if (failures.length > 0) {
		for (const failure of failures) console.error(`✗ ${failure}`);
		process.exit(1);
	}
	console.log('✓ build output within limits');
}

if (import.meta.main) main();
