// SPDX-License-Identifier: Apache-2.0
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhHant from './locales/zh-Hant.json';
import { LANGUAGES, preferredLanguage, type Language } from './languages';

export { LANGUAGES, type Language };

const STORAGE_KEY = 'hush.language';

const detector = new LanguageDetector();
detector.addDetector({
	name: 'hushNavigator',
	lookup: () => preferredLanguage(navigator.languages.length > 0 ? navigator.languages : [navigator.language]),
});

void i18n
	.use(detector)
	.use(initReactI18next)
	.init({
		resources: { en: { translation: en }, 'zh-Hant': { translation: zhHant } },
		supportedLngs: LANGUAGES,
		nonExplicitSupportedLngs: false,
		load: 'currentOnly',
		// Missing keys fall back to English one key at a time, never a whole page.
		fallbackLng: 'en',
		interpolation: { escapeValue: false },
		detection: {
			order: ['localStorage', 'hushNavigator'],
			lookupLocalStorage: STORAGE_KEY,
			caches: [], // only a manual switch is remembered
		},
	});

const syncDocumentLanguage = (language: string) => {
	document.documentElement.lang = language;
};
syncDocumentLanguage(i18n.resolvedLanguage ?? 'en');
i18n.on('languageChanged', syncDocumentLanguage);

/** Switch language and remember the choice. */
export function setLanguage(language: Language): void {
	void i18n.changeLanguage(language);
	try {
		localStorage.setItem(STORAGE_KEY, language);
	} catch {
		// Storage can be blocked; the switch still applies to this visit.
	}
}

export default i18n;
