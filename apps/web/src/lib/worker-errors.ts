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

/** An error as plain data: what crosses a worker boundary outside a thrown RPC (callbacks, events). */
export interface PlainError {
	name: string;
	message: string;
	fields: Fields;
}

function fieldsOf(error: Error): Fields {
	const fields: Fields = {};
	for (const [key, value] of Object.entries(error)) {
		if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
			fields[key] = value as string | number | boolean | null;
		}
	}
	return fields;
}

export function plainError(error: unknown): PlainError {
	if (error instanceof Error) return { name: error.name, message: error.message, fields: fieldsOf(error) };
	return { name: 'Error', message: String(error), fields: {} };
}

/** Back to an Error with its name and fields, as `describeError` expects. */
export function fromPlainError(plain: PlainError): Error {
	const error = new Error(plain.message);
	error.name = plain.name;
	return Object.assign(error, plain.fields);
}

Comlink.transferHandlers.set('throw', {
	canHandle: (value: unknown): value is unknown => original.canHandle(value),
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
