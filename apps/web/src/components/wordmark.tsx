// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';

/** Noise on the left settling into a still line: the whole idea in one mark. */
export function Mark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
			<rect width="32" height="32" rx="8" className="fill-raised" />
			<path
				d="M6 16c1.2-3.6 2.4-3.6 3.6 0s2.4 3.6 3.6 0 1.8-2 2.8-1c.8.8 1.4 1 2 1H26"
				fill="none"
				className="stroke-accent"
				strokeWidth="2.25"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function Wordmark() {
	const { t } = useTranslation();
	return (
		<a href="/" className="flex items-center gap-2.5 rounded-md text-[15px] font-semibold tracking-[-0.01em] text-fg">
			<Mark className="size-7" />
			<span>{t('app.name')}</span>
		</a>
	);
}
