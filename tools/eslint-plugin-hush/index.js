// SPDX-License-Identifier: Apache-2.0
// @ts-check
import noUpload from './rules/no-upload.js';

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
	meta: { name: '@hush/eslint-plugin', version: '0.0.0' },
	rules: { 'no-upload': noUpload },
};

export default plugin;
