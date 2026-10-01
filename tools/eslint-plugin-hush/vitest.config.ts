// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

export default defineProject({
	test: {
		name: 'eslint-plugin',
		environment: 'node',
		include: ['test/**/*.test.js'],
	},
});
