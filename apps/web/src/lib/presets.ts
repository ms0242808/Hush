// SPDX-License-Identifier: Apache-2.0
import { parseRecipe, RecipeError, serialiseRecipe, stepFor, type Params, type Recipe } from '@hush/core';
import { DENOISE_CONTROLS, defaultRecipe, OPERATIONS } from '@hush/ops';
import { readStored, writeStored } from './storage.ts';

/**
 * Presets are edit recipes (§4.5): an ordered list of operations, saved in
 * localStorage and moved between computers as JSON files. A preset made by
 * a newer Hush, or naming an operation this build doesn't have, is refused
 * with a message rather than half-loaded.
 */
export interface Preset {
	id: string;
	recipe: Recipe & { name: string };
}

export type DenoiseParams = { strength: number; luma: number; colour: number; detail: number };

const KEY = 'hush.presets.v1';

/** The denoise sliders at their defaults: the model's output, unchanged. */
export function defaultParams(): DenoiseParams {
	return paramsOf(defaultRecipe());
}

/** The four sliders of a recipe's denoise step, defaults where it has none. */
export function paramsOf(recipe: Recipe): DenoiseParams {
	const params: Params = stepFor(recipe, 'denoise')?.params ?? {};
	const value = (id: keyof DenoiseParams) =>
		params[id] ?? DENOISE_CONTROLS.find((control) => control.id === id)!.default;
	return { strength: value('strength'), luma: value('luma'), colour: value('colour'), detail: value('detail') };
}

/** A recipe for the current sliders; `name` makes it a preset. */
export function recipeFor(params: DenoiseParams, name?: string, model?: string): Recipe {
	const recipe = parseRecipe(
		{ schema: 1, ...(name && { name }), ops: [{ op: 'denoise', ...(model && { model }), params }] },
		OPERATIONS,
	);
	return recipe;
}

export function sameParams(a: DenoiseParams, b: DenoiseParams): boolean {
	return (Object.keys(a) as (keyof DenoiseParams)[]).every((key) => Math.abs(a[key] - b[key]) < 1e-6);
}

function newId(): string {
	return typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function asPreset(value: unknown): Preset | null {
	if (typeof value !== 'object' || value === null) return null;
	const { id, recipe } = value as { id?: unknown; recipe?: unknown };
	if (typeof id !== 'string') return null;
	try {
		const parsed = parseRecipe(recipe, OPERATIONS);
		return parsed.name ? { id, recipe: { ...parsed, name: parsed.name } } : null;
	} catch {
		return null; // written by a newer Hush, or damaged: leave it out rather than fail to start
	}
}

export function loadPresets(): Preset[] {
	return readStored(
		KEY,
		(value) => (Array.isArray(value) ? value.map(asPreset).filter((p): p is Preset => p !== null) : []),
		[],
	);
}

export function savePresets(presets: readonly Preset[]): boolean {
	return writeStored(KEY, presets);
}

/** A name not yet taken: "Wedding", "Wedding 2", "Wedding 3"… */
export function uniqueName(name: string, taken: readonly string[]): string {
	const base = name.trim() || 'Preset';
	const lower = new Set(taken.map((n) => n.toLocaleLowerCase()));
	if (!lower.has(base.toLocaleLowerCase())) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base} ${n}`;
		if (!lower.has(candidate.toLocaleLowerCase())) return candidate;
	}
}

export function createPreset(name: string, params: DenoiseParams, model?: string): Preset {
	const recipe = recipeFor(params, name.trim(), model);
	return { id: newId(), recipe: { ...recipe, name: recipe.name ?? name.trim() } };
}

/** The file a preset exports to: its recipe, stable key order (§4.5). */
export function presetFile(preset: Preset): { name: string; text: string } {
	const slug =
		preset.recipe.name
			.normalize('NFKC')
			.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
			.trim()
			.replace(/\s+/g, '-')
			.slice(0, 80) || 'preset';
	return { name: `${slug}.hush-preset.json`, text: serialiseRecipe(preset.recipe) };
}

export interface ImportResult {
	imported: Preset[];
	problems: { file: string; error: RecipeError }[];
}

/**
 * Read preset files. Each must be one recipe; names that are already taken
 * get a number. A file that isn't a preset, or is from a newer Hush, is
 * reported by name and skipped.
 */
export async function importPresets(files: readonly File[], taken: readonly string[]): Promise<ImportResult> {
	const imported: Preset[] = [];
	const problems: ImportResult['problems'] = [];
	const names = [...taken];
	for (const file of files) {
		try {
			if (file.size > 1_000_000) throw new RecipeError('not-a-recipe', 'This file is too large to be a preset');
			let json: unknown;
			try {
				json = JSON.parse(await file.text());
			} catch {
				throw new RecipeError('not-a-recipe', 'This file is not a Hush preset');
			}
			const recipe = parseRecipe(json, OPERATIONS);
			const fallback = file.name.replace(/\.hush-preset\.json$|\.json$/i, '');
			const name = uniqueName(recipe.name ?? fallback, names);
			names.push(name);
			imported.push({ id: newId(), recipe: { ...recipe, name } });
		} catch (error) {
			problems.push({
				file: file.name,
				error: error instanceof RecipeError ? error : new RecipeError('not-a-recipe', String(error)),
			});
		}
	}
	return { imported, problems };
}
