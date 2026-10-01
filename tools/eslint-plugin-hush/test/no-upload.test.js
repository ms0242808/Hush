// SPDX-License-Identifier: Apache-2.0
import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';
import rule from '../rules/no-upload.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } });

tester.run('no-upload', rule, {
	valid: [
		'fetch("/models/manifest.json")',
		'fetch(url, { cache: "no-cache", signal })',
		'fetch(url, { method: "GET" })',
		'fetch(url, { method: "head" })',
		'fetch(url, { body: undefined })',
		'globalThis.fetch(url, { signal })',
		'new Request(url, { cache: "force-cache" })',
		'socket.send(data)', // not one of ours: no XMLHttpRequest exists to call send() on
	],
	invalid: [
		{ code: 'fetch(url, { method: "POST", body: file })', errors: [{ messageId: 'method' }, { messageId: 'body' }] },
		{ code: 'fetch(url, { body: blob })', errors: [{ messageId: 'body' }] },
		{ code: 'window.fetch(url, { body: buffer })', errors: [{ messageId: 'body' }] },
		{ code: 'fetch(url, { "body": bytes })', errors: [{ messageId: 'body' }] },
		{ code: 'fetch(url, { method: m })', errors: [{ messageId: 'method' }] },
		{ code: 'fetch(url, options)', errors: [{ messageId: 'opaque' }] },
		{ code: 'fetch(url, { ...options })', errors: [{ messageId: 'opaque' }] },
		{ code: 'fetch(url, { [key]: value })', errors: [{ messageId: 'opaque' }] },
		{
			code: 'new Request(url, { method: "PUT", body: data })',
			errors: [{ messageId: 'method' }, { messageId: 'body' }],
		},
		{ code: 'navigator.sendBeacon("/log", data)', errors: [{ messageId: 'channel' }] },
		{ code: 'new XMLHttpRequest()', errors: [{ messageId: 'channel' }] },
		{ code: 'new WebSocket("wss://example.com")', errors: [{ messageId: 'channel' }] },
		{ code: 'new RTCPeerConnection()', errors: [{ messageId: 'channel' }] },
	],
});
