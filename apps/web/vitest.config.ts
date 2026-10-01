// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

// Unit tests for the web app's pure logic. Browser behaviour is covered by
// the Playwright suite in e2e/, which Vitest must not pick up.
export default defineProject({
	test: {
		name: 'web',
		environment: 'node',
		include: ['src/**/*.test.ts'],
	},
});
