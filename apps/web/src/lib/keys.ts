// SPDX-License-Identifier: Apache-2.0

/** ⌘ on Apple platforms, Ctrl elsewhere: how shortcuts are written for this reader (§5.8). */
export const COMMAND_KEY =
	typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
