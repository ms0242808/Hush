// SPDX-License-Identifier: Apache-2.0
import { parseRecipe } from '@hush/core';
import { OPERATIONS } from '@hush/ops';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createPreset,
	defaultParams,
	importPresets,
	loadPresets,
	paramsOf,
	presetFile,
	recipeFor,
	sameParams,
	savePresets,
	uniqueName,
} from './presets';

function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key) => items.get(key) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		removeItem: (key) => void items.delete(key),
		setItem: (key, value) => void items.set(key, String(value)),
	};
}

const json = (value: unknown, name = 'preset.json') =>
	new File([JSON.stringify(value)], name, { type: 'application/json' });

describe('presets are recipes (§4.5)', () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
	});
	afterEach(() => {
		Reflect.deleteProperty(globalThis, 'localStorage');
	});

	it('defaults leave the model’s output unchanged', () => {
		expect(defaultParams()).toEqual({ strength: 1, luma: 1, colour: 1, detail: 0 });
	});

	it('round-trips sliders through a recipe, snapped to their step', () => {
		const recipe = recipeFor({ strength: 0.704, luma: 0.8, colour: 1, detail: 0.3 }, 'Wedding', 'nafnet-sidd-w32');
		expect(recipe).toEqual({
			schema: 1,
			name: 'Wedding',
			ops: [{ op: 'denoise', model: 'nafnet-sidd-w32', params: { strength: 0.7, luma: 0.8, colour: 1, detail: 0.3 } }],
		});
		expect(paramsOf(recipe)).toEqual({ strength: 0.7, luma: 0.8, colour: 1, detail: 0.3 });
		expect(sameParams(paramsOf(recipe), { strength: 0.7, luma: 0.8, colour: 1, detail: 0.3 })).toBe(true);
	});

	it('saves and loads, skipping entries this version can’t read', () => {
		const wedding = createPreset('Wedding reception', { strength: 0.7, luma: 0.8, colour: 1, detail: 0.3 });
		expect(savePresets([wedding])).toBe(true);
		localStorage.setItem(
			'hush.presets.v1',
			JSON.stringify([
				wedding,
				{ id: 'future', recipe: { schema: 9, name: 'From the future', ops: [] } },
				{ id: 'sharpen', recipe: { schema: 1, name: 'Sharpen', ops: [{ op: 'sharpen', params: {} }] } },
				'garbage',
			]),
		);
		expect(loadPresets()).toEqual([wedding]);
	});

	it('loads nothing, rather than failing, when storage is unavailable or damaged', () => {
		localStorage.setItem('hush.presets.v1', '{not json');
		expect(loadPresets()).toEqual([]);
		Reflect.deleteProperty(globalThis, 'localStorage');
		expect(loadPresets()).toEqual([]);
		expect(savePresets([])).toBe(false);
	});

	it('exports a preset as its recipe, under a safe file name', () => {
		const preset = createPreset('Night / indoor: "ISO 6400"', { strength: 0.9, luma: 1, colour: 1, detail: 0.2 });
		const file = presetFile(preset);
		expect(file.name).toBe('Night-indoor-ISO-6400.hush-preset.json');
		expect(parseRecipe(JSON.parse(file.text), OPERATIONS)).toEqual(preset.recipe);
	});

	it('imports preset files, numbering names already taken', async () => {
		const exported = presetFile(createPreset('Wedding', { strength: 0.5, luma: 1, colour: 1, detail: 0 }));
		const result = await importPresets(
			[
				new File([exported.text], exported.name),
				json({ schema: 1, ops: [{ op: 'denoise', params: { strength: 0.25 } }] }, 'Concert.hush-preset.json'),
			],
			['Wedding'],
		);
		expect(result.problems).toEqual([]);
		expect(result.imported.map((p) => p.recipe.name)).toEqual(['Wedding 2', 'Concert']);
		expect(paramsOf(result.imported[1]!.recipe)).toEqual({ strength: 0.25, luma: 1, colour: 1, detail: 0 });
	});

	it('names each file it can’t import, and why', async () => {
		const result = await importPresets(
			[
				new File(['not json'], 'notes.txt'),
				json({ schema: 2, ops: [] }, 'newer.json'),
				json({ schema: 1, ops: [{ op: 'upscale', params: {} }] }, 'upscale.json'),
			],
			[],
		);
		expect(result.imported).toEqual([]);
		expect(result.problems.map((p) => [p.file, p.error.code, p.error.subject])).toEqual([
			['notes.txt', 'not-a-recipe', null],
			['newer.json', 'newer-schema', null],
			['upscale.json', 'unknown-op', 'upscale'],
		]);
	});

	it('finds a free name', () => {
		expect(uniqueName('Wedding', [])).toBe('Wedding');
		expect(uniqueName('wedding', ['Wedding', 'Wedding 2'])).toBe('wedding 3');
		expect(uniqueName('  ', [])).toBe('Preset');
	});
});
