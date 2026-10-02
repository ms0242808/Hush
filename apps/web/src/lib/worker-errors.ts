// SPDX-License-Identifier: Apache-2.0
import * as Comlink from 'comlink';

/**
 * Comlink sends errors across the worker boundary as name, message and stack
 * only. Hush's errors carry a little more — why a photo is unsupported, how
 * many megapixels it was — so the interface can say exactly what happened.
 * This handler keeps their primitive fields too. Byte buffers stay behind.
 *
 * Imported for its side effect by both the worker and the page.
 */
const original = Comlink.transferHandlers.get('throw')!;

type Fields = Record<string, string | number | boolean | null>;

function fieldsOf(error: Error): Fields {
	const fields: Fields = {};
	for (const [key, value] of Object.entries(error)) {
		if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
			fields[key] = value as string | number | boolean | null;
		}
	}
	return fields;
}

Comlink.transferHandlers.set('throw', {
	canHandle: (value: unknown) => original.canHandle(value),
	serialize(thrown: unknown) {
		const value = (thrown as { value: unknown }).value;
		if (value instanceof Error) {
			return [
				{ isError: true, value: { ...fieldsOf(value), name: value.name, message: value.message, stack: value.stack } },
				[],
			];
		}
		return original.serialize(thrown);
	},
	deserialize: (serialized: unknown) => original.deserialize(serialized),
});
