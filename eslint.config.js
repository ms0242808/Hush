// SPDX-License-Identifier: Apache-2.0
// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import hush from '@hush/eslint-plugin';

/** Browser and Node globals that platform-free code must never touch (§4.5). */
const PLATFORM_GLOBALS = [
	'window',
	'document',
	'navigator',
	'self',
	'location',
	'localStorage',
	'sessionStorage',
	'indexedDB',
	'caches',
	'fetch',
	'XMLHttpRequest',
	'Worker',
	'OffscreenCanvas',
	'ImageData',
	'ImageBitmap',
	'createImageBitmap',
	'performance',
	'crypto',
	'process',
	'Buffer',
	'require',
	'__dirname',
	'__filename',
	'setTimeout',
	'setInterval',
	'requestAnimationFrame',
	'console',
];

export default defineConfig(
	{
		ignores: [
			'**/dist/**',
			'**/dist-e2e/**',
			'**/dist-real/**',
			'**/node_modules/**',
			'**/.wrangler/**',
			'**/coverage/**',
			'**/playwright-report/**',
			'**/test-results/**',
			'apps/web/.models/**',
			'apps/web/public/ort/**',
			'apps/web/public/codecs/**',
			'tools/models/.venv/**',
			'tools/fixtures/.venv/**',
			'tools/models/.cache/**',
			'tools/models/out/**',
			'.claude/**',
			'.agents/**',
		],
	},
	js.configs.recommended,
	tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
		},
	},
	// Type-aware rules cover shipped source (apps/web/src, packages/*/src). Tests,
	// configs, scripts and tools are type-checked by `pnpm typecheck` and linted
	// without type information.
	{
		files: ['**/*.js', '**/*.config.ts', '**/test/**', 'apps/web/{build,e2e,scripts}/**', 'tools/**'],
		extends: [tseslint.configs.disableTypeChecked],
	},

	// The privacy promise, checkable: nothing may send data anywhere (§4.7).
	{
		plugins: { hush },
		rules: { 'hush/no-upload': 'error' },
	},

	// packages/core and packages/ops are platform-free: no DOM, no Node (§4.5).
	// Their tsconfig has no DOM or Node types; this catches what types can't.
	{
		files: ['packages/*/src/**/*.ts'],
		rules: {
			'no-restricted-globals': [
				'error',
				...PLATFORM_GLOBALS.map((name) => ({
					name,
					message: 'packages/core and packages/ops are platform-free: get this through PlatformAdapters.',
				})),
			],
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							regex: '^node:|^(fs|path|os|crypto|url|child_process)$',
							message: 'packages/core and packages/ops are platform-free.',
						},
					],
				},
			],
			'@typescript-eslint/triple-slash-reference': ['error', { lib: 'never', path: 'never', types: 'never' }],
		},
	},

	// The web app.
	{
		files: ['apps/web/src/**/*.{ts,tsx}'],
		extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
		languageOptions: { globals: { ...globals.browser } },
	},
	{
		files: ['apps/web/src/worker/**/*.ts'],
		languageOptions: { globals: { ...globals.worker } },
	},
	// Classic scripts served as they are (the pre-paint theme).
	{
		files: ['apps/web/public/*.js'],
		languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
	},

	// Node-side code: build plugins, scripts, tools, tests.
	{
		files: [
			'apps/web/{build,scripts,e2e}/**/*.ts',
			'apps/web/*.config.ts',
			'tools/**/*.{ts,js}',
			'**/test/**/*.{ts,js}',
			'*.config.{ts,js}',
		],
		languageOptions: { globals: { ...globals.node } },
	},
);
