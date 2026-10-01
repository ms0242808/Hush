// SPDX-License-Identifier: Apache-2.0
import type { TFunction } from 'i18next';

/** Errors arrive from the worker as plain Errors with their `name` intact. */
export function describeError(error: unknown, t: TFunction, fileName: string): string {
	const name = error instanceof Error ? error.name : '';
	const message = error instanceof Error ? error.message : String(error);
	switch (name) {
		case 'UnsupportedFormatError':
			return t('error.unsupported', { name: fileName });
		case 'DecodeError':
			return t('error.decode', { name: fileName });
		case 'ModelIntegrityError':
		case 'ModelError':
		case 'ManifestError':
			return t('error.model');
		case 'DeviceLostError':
			return t('error.gpu');
		case 'ModelOutputError':
			return t('error.output');
		default:
			if (/fetch|network|HTTP \d/i.test(message)) return t('error.model');
			return t('error.generic', { message });
	}
}

export function isCancelled(error: unknown): boolean {
	return error instanceof Error && error.name === 'CancelledError';
}
