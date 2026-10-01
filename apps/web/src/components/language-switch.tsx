// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage, type Language } from '@/i18n';
import { cn } from '@/lib/utils';

const SHORT: Record<Language, string> = { en: 'EN', 'zh-Hant': '中文' };

/** Two quiet text toggles. Switching is instant: it's chrome, not content. */
export function LanguageSwitch() {
	const { t, i18n } = useTranslation();
	const current = (i18n.resolvedLanguage ?? 'en') as Language;
	return (
		<div role="radiogroup" aria-label={t('language.label')} className="flex items-center rounded-lg bg-sunken p-0.5">
			{LANGUAGES.map((language) => (
				<button
					key={language}
					type="button"
					role="radio"
					aria-checked={current === language}
					aria-label={t(`language.${language}`)}
					lang={language}
					onClick={() => setLanguage(language)}
					className={cn(
						'h-7 rounded-md px-2.5 text-[12px] font-medium transition-[background-color,color] duration-150',
						current === language ? 'bg-raised text-fg' : 'text-fg-subtle hover:text-fg-muted',
					)}
				>
					{SHORT[language]}
				</button>
			))}
		</div>
	);
}
