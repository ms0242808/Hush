// SPDX-License-Identifier: Apache-2.0
import type { TFunction } from 'i18next';

/**
 * Estimates the way people say them (§2.7: "About 3 h 40 min left"): precise
 * enough to plan around, never falsely exact. Under ten seconds is "a few
 * seconds"; then to 5 s, to the minute, to 5 minutes, and to 10 minutes once
 * it's hours.
 */
export type RoundedDuration =
	| { unit: 'few' }
	| { unit: 'seconds'; count: number }
	| { unit: 'minutes'; count: number }
	| { unit: 'hours'; hours: number; minutes: number };

export function roundDuration(ms: number): RoundedDuration {
	const s = Math.max(0, ms) / 1000;
	if (s < 10) return { unit: 'few' };
	if (s < 57.5) return { unit: 'seconds', count: Math.round(s / 5) * 5 };
	const minutes = s / 60;
	if (minutes < 9.5) return { unit: 'minutes', count: Math.max(1, Math.round(minutes)) };
	if (minutes < 57.5) return { unit: 'minutes', count: Math.round(minutes / 5) * 5 };
	const tens = Math.round(minutes / 10);
	return { unit: 'hours', hours: Math.floor(tens / 6), minutes: (tens % 6) * 10 };
}

/** "45 s", "6 min", "1 h 20 min", in the interface language. */
export function formatDuration(ms: number, t: TFunction): string {
	const rounded = roundDuration(ms);
	switch (rounded.unit) {
		case 'few':
			return t('duration.few');
		case 'seconds':
			return t('duration.seconds', { count: rounded.count });
		case 'minutes':
			return t('duration.minutes', { count: rounded.count });
		case 'hours':
			return rounded.minutes === 0
				? t('duration.hours', { count: rounded.hours })
				: t('duration.hoursMinutes', { hours: rounded.hours, minutes: rounded.minutes });
	}
}
