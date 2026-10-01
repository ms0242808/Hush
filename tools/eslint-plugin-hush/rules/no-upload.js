// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Hush's privacy promise is that photos never leave the device. The CSP
 * (`connect-src 'self'`) stops requests to other origins; this rule stops the
 * code from ever trying to send data anywhere, the own origin included:
 *
 *   - fetch() and new Request() may not carry a body or use a method other than GET/HEAD;
 *   - their options must be an inline object literal, so the check can't be dodged;
 *   - XMLHttpRequest, WebSocket, RTCPeerConnection and sendBeacon are not used at all.
 *
 * Stricter than "no Blob, File or ArrayBuffer bodies": a static site that only
 * ever reads files has no reason to send a body of any kind.
 */

const CHANNELS = new Set(['XMLHttpRequest', 'WebSocket', 'RTCPeerConnection', 'WebTransport']);

/** @param {import('estree').Node} node */
function calleeName(node) {
	if (node.type === 'Identifier') return node.name;
	if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
		return node.property.name;
	}
	return null;
}

/** @param {import('estree').Node} node */
function isNullish(node) {
	return (node.type === 'Literal' && node.value === null) || (node.type === 'Identifier' && node.name === 'undefined');
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
	meta: {
		type: 'problem',
		docs: { description: 'Forbid request bodies and outbound channels: Hush never uploads.' },
		schema: [],
		messages: {
			body: 'Hush never uploads: {{callee}} may not carry a request body.',
			method: 'Hush only reads files: {{callee}} may only use GET or HEAD.',
			opaque: 'Pass {{callee}} options as an inline object literal so the no-upload rule can check them.',
			channel: 'Hush never uploads: {{name}} can send data off this device.',
		},
	},
	create(context) {
		/**
		 * @param {import('estree').Node | undefined} init
		 * @param {string} callee
		 */
		function checkInit(init, callee) {
			if (!init) return;
			if (init.type !== 'ObjectExpression') {
				context.report({ node: init, messageId: 'opaque', data: { callee } });
				return;
			}
			for (const property of init.properties) {
				if (property.type === 'SpreadElement' || property.computed) {
					context.report({ node: property, messageId: 'opaque', data: { callee } });
					continue;
				}
				const key =
					property.key.type === 'Identifier'
						? property.key.name
						: property.key.type === 'Literal'
							? String(property.key.value)
							: null;
				if (key === 'body' && !isNullish(property.value)) {
					context.report({ node: property, messageId: 'body', data: { callee } });
				}
				if (key === 'method') {
					const value = property.value;
					const safe = value.type === 'Literal' && typeof value.value === 'string' && /^(get|head)$/i.test(value.value);
					if (!safe) context.report({ node: property, messageId: 'method', data: { callee } });
				}
			}
		}

		return {
			CallExpression(node) {
				const name = calleeName(node.callee);
				if (name === 'fetch')
					checkInit(/** @type {import('estree').Node | undefined} */ (node.arguments[1]), 'fetch()');
				if (name === 'sendBeacon') {
					context.report({ node, messageId: 'channel', data: { name: 'navigator.sendBeacon()' } });
				}
			},
			NewExpression(node) {
				const name = calleeName(node.callee);
				if (name === 'Request') {
					checkInit(/** @type {import('estree').Node | undefined} */ (node.arguments[1]), 'new Request()');
				}
				if (name && CHANNELS.has(name)) context.report({ node, messageId: 'channel', data: { name } });
			},
		};
	},
};

export default rule;
