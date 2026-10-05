// SPDX-License-Identifier: Apache-2.0

/**
 * While a batch runs (§2.7): keep the screen awake — a sleeping laptop stops
 * the GPU, and the batch with it. The browser lets the lock go whenever the
 * page is hidden, so it is asked for again when the page comes back. Returns
 * the function that ends it.
 */
export function keepAwake(): () => void {
	let sentinel: WakeLockSentinel | null = null;
	let active = true;
	const request = async () => {
		if (!active || sentinel || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
		try {
			const lock = await navigator.wakeLock.request('screen');
			if (!active) {
				void lock.release().catch(() => {});
				return;
			}
			sentinel = lock;
			lock.addEventListener('release', () => {
				if (sentinel === lock) sentinel = null;
			});
		} catch {
			// Denied (battery saver, a policy): the batch still runs.
		}
	};
	const onVisibility = () => void request();
	document.addEventListener('visibilitychange', onVisibility);
	void request();
	return () => {
		active = false;
		document.removeEventListener('visibilitychange', onVisibility);
		void sentinel?.release().catch(() => {});
		sentinel = null;
	};
}

/** Ask before the tab is closed or reloaded while there's unsaved work (§2.7). Returns the function that stops asking. */
export function warnBeforeLeaving(): () => void {
	const onBeforeUnload = (event: BeforeUnloadEvent) => {
		event.preventDefault();
		event.returnValue = ''; // older browsers show the prompt only when this is set
	};
	window.addEventListener('beforeunload', onBeforeUnload);
	return () => window.removeEventListener('beforeunload', onBeforeUnload);
}
