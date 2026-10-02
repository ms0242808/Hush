// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: ['packages/*', 'apps/web', 'tools/eslint-plugin-hush', 'tools/models'],
	},
});
