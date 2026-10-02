// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

export default defineProject({
	test: {
		name: 'model-tools',
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
