// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import zhHant from './locales/zh-Hant.json';

type Tree = { [key: string]: string | Tree };

/** Every string by its dotted key; plural forms (`_one`, `_other`) folded into one key. */
function flatten(tree: Tree, prefix = ''): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [key, value] of Object.entries(tree)) {
		const path = `${prefix}${key}`;
		if (typeof value === 'string') {
			const base = path.replace(/_(zero|one|two|few|many|other)$/, '');
			out.set(base, [...(out.get(base) ?? []), value]);
		} else {
			for (const [k, v] of flatten(value, `${path}.`)) out.set(k, v);
		}
	}
	return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('translations (§5.9)', () => {
	const english = flatten(en);
	const chinese = flatten(zhHant);

	it('every English string has a Traditional Chinese one, and nothing is left over', () => {
		expect([...english.keys()].filter((key) => !chinese.has(key))).toEqual([]);
		expect([...chinese.keys()].filter((key) => !english.has(key))).toEqual([]);
	});

	it('the same placeholders on both sides', () => {
		const mismatched: string[] = [];
		for (const [key, values] of english) {
			const expected = [...new Set(values.flatMap(placeholders))].sort().join(',');
			const actual = [...new Set((chinese.get(key) ?? []).flatMap(placeholders))].sort().join(',');
			if (expected !== actual) mismatched.push(`${key}: ${expected} ≠ ${actual}`);
		}
		expect(mismatched).toEqual([]);
	});

	it('uses Taiwan photography vocabulary, never Mainland terms', () => {
		const mainland = [
			'噪点',
			'导出',
			'批量',
			'文件夹',
			'图片',
			'预设',
			'亮度',
			'彩色噪点',
			'设置',
			'视频',
			'打开',
			'保存',
			'软件',
		];
		const offending = [...chinese.entries()].flatMap(([key, values]) =>
			values.flatMap((text) => mainland.filter((term) => text.includes(term)).map((term) => `${key}: ${term}`)),
		);
		expect(offending).toEqual([]);
	});

	it('says noise, export and preset the Taiwan way', () => {
		const all = [...chinese.values()].flat().join('\n');
		expect(all).toContain('雜訊');
		expect(all).toContain('匯出');
		expect(all).toContain('預設集');
		expect(all).toContain('明度雜訊');
		expect(all).toContain('色彩雜訊');
	});
});
