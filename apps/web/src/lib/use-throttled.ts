// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';

/**
 * A value that changes at most every `ms`: for polite live regions, so a
 * screen reader hears progress now and then rather than every tile (§5.10:
 * throttled polite aria-live for progress).
 */
export function useThrottled<T>(value: T, ms = 4000): T {
	const [held, setHeld] = useState(value);
	const last = useRef(0);
	useEffect(() => {
		const wait = Math.max(0, last.current + ms - Date.now());
		const timer = window.setTimeout(() => {
			last.current = Date.now();
			setHeld(value);
		}, wait);
		return () => window.clearTimeout(timer);
	}, [value, ms]);
	return held;
}
