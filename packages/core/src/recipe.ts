// SPDX-License-Identifier: Apache-2.0

/**
 * Edit recipes (§4.5): a preset is an ordered list of operations, not a flat
 * settings object. This phase every recipe has exactly one `denoise` step;
 * when sharpening or crop arrive they append to the list, and every recipe
 * saved today still loads. The pipeline takes a recipe.
 */

/** One slider an operation exposes. Drives the settings panel and validates recipes. */
export interface ControlSchema {
	id: string;
	min: number;
	max: number;
	step: number;
	default: number;
}

/** What the recipe parser needs to know about the operations this build has. */
export type OperationCatalogue = Record<string, { controls: readonly ControlSchema[] }>;

export type Params = Record<string, number>;

export interface RecipeStep {
	op: string;
	/** The model the step used, by manifest id. Informational: the manifest decides what runs. */
	model?: string;
	params: Params;
}

export interface Recipe {
	schema: 1;
	name?: string;
	ops: RecipeStep[];
}

export const RECIPE_SCHEMA = 1;

export type RecipeProblem = 'not-a-recipe' | 'newer-schema' | 'unknown-op' | 'invalid-param';

export class RecipeError extends Error {
	readonly code: RecipeProblem;
	/** The operation or parameter the problem is about. */
	readonly subject: string | null;
	constructor(code: RecipeProblem, message: string, subject: string | null = null) {
		super(message);
		this.name = 'RecipeError';
		this.code = code;
		this.subject = subject;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Params with every control present, clamped to its range and snapped to its step. */
export function normaliseParams(controls: readonly ControlSchema[], params: Record<string, unknown> = {}): Params {
	const out: Params = {};
	for (const control of controls) {
		const raw = params[control.id];
		if (raw === undefined) {
			out[control.id] = control.default;
			continue;
		}
		if (typeof raw !== 'number' || !Number.isFinite(raw)) {
			throw new RecipeError('invalid-param', `${control.id} must be a number`, control.id);
		}
		const clamped = Math.min(control.max, Math.max(control.min, raw));
		const steps = Math.round((clamped - control.min) / control.step);
		out[control.id] = Number((control.min + steps * control.step).toFixed(6));
	}
	return out;
}

/**
 * Validate a recipe read from JSON (a saved preset, an imported file). A
 * recipe from a newer Hush, or one using an operation this build doesn't
 * have, fails with a message that says so rather than loading half of it.
 * Unknown parameters are ignored; missing ones take their defaults.
 */
export function parseRecipe(value: unknown, catalogue: OperationCatalogue): Recipe {
	if (!isObject(value) || !Array.isArray(value['ops'])) {
		throw new RecipeError('not-a-recipe', 'This file is not a Hush preset');
	}
	const schema = value['schema'];
	if (typeof schema === 'number' && schema > RECIPE_SCHEMA) {
		throw new RecipeError('newer-schema', `This preset was made by a newer version of Hush (schema ${schema})`);
	}
	if (schema !== RECIPE_SCHEMA) throw new RecipeError('not-a-recipe', 'This file is not a Hush preset');

	const ops = value['ops'].map((step: unknown, i): RecipeStep => {
		if (!isObject(step) || typeof step['op'] !== 'string') {
			throw new RecipeError('not-a-recipe', `Step ${i + 1} has no operation`);
		}
		const op = step['op'];
		const definition = catalogue[op];
		if (!definition) {
			throw new RecipeError('unknown-op', `This preset uses “${op}”, which this version of Hush doesn't have`, op);
		}
		const params = step['params'];
		if (params !== undefined && !isObject(params)) {
			throw new RecipeError('invalid-param', `Step ${i + 1} has invalid parameters`, op);
		}
		return {
			op,
			...(typeof step['model'] === 'string' && { model: step['model'] }),
			params: normaliseParams(definition.controls, params),
		};
	});
	if (ops.length === 0) throw new RecipeError('not-a-recipe', 'This preset has no steps');

	const name = value['name'];
	return { schema: RECIPE_SCHEMA, ...(typeof name === 'string' && name.trim() && { name: name.trim() }), ops };
}

/** The recipe as it is saved: stable key order, so exported presets diff cleanly. */
export function serialiseRecipe(recipe: Recipe): string {
	const ops = recipe.ops.map((step) => ({
		op: step.op,
		...(step.model && { model: step.model }),
		params: Object.fromEntries(Object.entries(step.params).sort(([a], [b]) => a.localeCompare(b))),
	}));
	return `${JSON.stringify({ schema: recipe.schema, ...(recipe.name && { name: recipe.name }), ops }, null, '\t')}\n`;
}

/** The parameters of the first step for an operation, or null if the recipe doesn't use it. */
export function stepFor(recipe: Recipe, op: string): RecipeStep | null {
	return recipe.ops.find((step) => step.op === op) ?? null;
}
