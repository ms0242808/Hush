// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

// Plain Node, no DOM shims: passing here is what proves the package is platform-free.
export default defineProject({
	test: {
		name: 'core',
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
