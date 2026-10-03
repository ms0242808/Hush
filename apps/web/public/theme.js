// SPDX-License-Identifier: Apache-2.0
// Apply the light-grey theme before the first paint, so it never flashes dark.
// A separate same-origin file because the Content-Security-Policy allows no inline script.
try {
	if (localStorage.getItem('hush.theme') === '"light"') {
		document.documentElement.dataset.theme = 'light';
		document.querySelector('meta[name="color-scheme"]').setAttribute('content', 'light');
	}
} catch {
	// Storage blocked: dark, the default.
}
