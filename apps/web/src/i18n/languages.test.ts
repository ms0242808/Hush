// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { preferredLanguage, toSupportedLanguage } from './languages';

// §5.9: zh-Hant for zh-TW, zh-HK and zh-Hant-*; English for everything else.
describe('language detection', () => {
	it.each([
		['zh-TW', 'zh-Hant'],
		['zh-HK', 'zh-Hant'],
		['zh-MO', 'zh-Hant'],
		['zh-Hant', 'zh-Hant'],
		['zh-Hant-TW', 'zh-Hant'],
		['ZH-tw', 'zh-Hant'],
		['en', 'en'],
		['en-GB', 'en'],
		['zh-CN', null],
		['zh-Hans', null],
		['zh', null],
		['zh-TWX', null],
		['ja', null],
	] as const)('%s → %s', (tag, expected) => {
		expect(toSupportedLanguage(tag)).toBe(expected);
	});

	it('takes the first language Hush speaks, in the browser’s order', () => {
		expect(preferredLanguage(['ja', 'zh-TW', 'en'])).toBe('zh-Hant');
		expect(preferredLanguage(['fr', 'en-US', 'zh-TW'])).toBe('en');
	});

	it('falls back to English, never to Traditional Chinese for Simplified', () => {
		expect(preferredLanguage(['zh-CN', 'ja'])).toBe('en');
		expect(preferredLanguage([])).toBe('en');
	});
});
