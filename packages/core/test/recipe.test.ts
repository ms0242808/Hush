// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
	normaliseParams,
	parseRecipe,
	RecipeError,
	serialiseRecipe,
	stepFor,
	type ControlSchema,
} from '../src/index.ts';

const controls: ControlSchema[] = [
	{ id: 'strength', min: 0, max: 1, step: 0.01, default: 1 },
	{ id: 'luma', min: 0, max: 1, step: 0.01, default: 1 },
	{ id: 'colour', min: 0, max: 1, step: 0.01, default: 1 },
	{ id: 'detail', min: 0, max: 1, step: 0.01, default: 0 },
];
const catalogue = { denoise: { controls } };

describe('recipes (§4.5)', () => {
	it('loads a schema 1 recipe as the spec writes it', () => {
		const recipe = parseRecipe(
			{
				schema: 1,
				name: 'Wedding reception',
				ops: [
					{ op: 'denoise', model: 'nafnet-sidd-w32', params: { strength: 0.7, luma: 0.8, colour: 1.0, detail: 0.3 } },
				],
			},
			catalogue,
		);
		expect(recipe).toEqual({
			schema: 1,
			name: 'Wedding reception',
			ops: [{ op: 'denoise', model: 'nafnet-sidd-w32', params: { strength: 0.7, luma: 0.8, colour: 1, detail: 0.3 } }],
		});
		expect(stepFor(recipe, 'denoise')?.params.detail).toBe(0.3);
		expect(stepFor(recipe, 'sharpen')).toBeNull();
	});

	it('fills missing parameters with defaults, clamps and snaps the rest, ignores unknown ones', () => {
		const recipe = parseRecipe(
			{ schema: 1, ops: [{ op: 'denoise', params: { strength: 1.7, detail: 0.12345, grain: 4 } }] },
			catalogue,
		);
		expect(recipe.ops[0]!.params).toEqual({ strength: 1, luma: 1, colour: 1, detail: 0.12 });
	});

	it('fails clearly on an operation from a future version, instead of loading half the recipe', () => {
		const future = {
			schema: 1,
			ops: [
				{ op: 'denoise', params: {} },
				{ op: 'sharpen', params: { amount: 0.4 } },
			],
		};
		expect(() => parseRecipe(future, catalogue)).toThrow(RecipeError);
		try {
			parseRecipe(future, catalogue);
		} catch (error) {
			expect(error).toMatchObject({ code: 'unknown-op', subject: 'sharpen' });
			expect((error as Error).message).toContain('“sharpen”');
		}
	});

	it('fails clearly on a newer schema, and on things that are not recipes', () => {
		expect(() => parseRecipe({ schema: 2, ops: [] }, catalogue)).toThrow(/newer version of Hush/);
		for (const value of [null, 42, 'denoise', { ops: 'x' }, { schema: 1, ops: [] }, { schema: 1, ops: [{}] }]) {
			expect(() => parseRecipe(value, catalogue)).toThrow(RecipeError);
		}
		expect(() => parseRecipe({ schema: 1, ops: [{ op: 'denoise', params: { strength: 'lots' } }] }, catalogue)).toThrow(
			/strength must be a number/,
		);
	});

	it('serialises with stable key order and parses back to the same recipe', () => {
		const recipe = parseRecipe(
			{ schema: 1, name: '  Night  ', ops: [{ op: 'denoise', params: { detail: 0.2, strength: 0.9 } }] },
			catalogue,
		);
		const text = serialiseRecipe(recipe);
		expect(text).toBe(
			'{\n\t"schema": 1,\n\t"name": "Night",\n\t"ops": [\n\t\t{\n\t\t\t"op": "denoise",\n\t\t\t"params": {\n\t\t\t\t"colour": 1,\n\t\t\t\t"detail": 0.2,\n\t\t\t\t"luma": 1,\n\t\t\t\t"strength": 0.9\n\t\t\t}\n\t\t}\n\t]\n}\n',
		);
		expect(parseRecipe(JSON.parse(text), catalogue)).toEqual(recipe);
	});

	it('normalises parameters on their own, for the settings panel', () => {
		expect(normaliseParams(controls)).toEqual({ strength: 1, luma: 1, colour: 1, detail: 0 });
		expect(normaliseParams(controls, { luma: -3 })).toMatchObject({ luma: 0 });
	});
});
