// SPDX-License-Identifier: Apache-2.0

export const LANGUAGES = ['en', 'zh-Hant'] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * zh-TW, zh-HK, zh-MO and zh-Hant-* are Traditional Chinese; any English tag is
 * English. Everything else — Simplified Chinese included — is unsupported, so
 * the caller falls through to English.
 */
export function toSupportedLanguage(tag: string): Language | null {
	const lower = tag.toLowerCase();
	if (lower === 'zh-hant' || lower.startsWith('zh-hant-') || /^zh-(tw|hk|mo)(-|$)/.test(lower)) return 'zh-Hant';
	if (lower === 'en' || lower.startsWith('en-')) return 'en';
	return null;
}

/** The first language in the browser's preference list that Hush speaks. */
export function preferredLanguage(tags: readonly string[]): Language {
	for (const tag of tags) {
		const language = toSupportedLanguage(tag);
		if (language) return language;
	}
	return 'en';
}
