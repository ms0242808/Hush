// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

// Plain Node, no DOM shims: passing here is what proves the package is platform-free.
export default defineProject({
	test: {
		name: 'ops',
		environment: 'node',
		include: ['test/**/*.test.ts'],
		// Some tests push whole photos through the pipeline (a 102 MP one among them): seconds of
		// real work that a busy CI runner may stretch past the default five.
		testTimeout: 30_000,
	},
});
