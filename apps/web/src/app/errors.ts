// SPDX-License-Identifier: Apache-2.0
import type { TFunction } from 'i18next';

/**
 * Errors arrive from the worker as plain Errors with their `name` and
 * primitive fields intact (lib/worker-errors.ts). Each says what happened and
 * what to do (§5.11).
 */
export function describeError(error: unknown, t: TFunction, fileName: string): string {
	const name = error instanceof Error ? error.name : '';
	const message = error instanceof Error ? error.message : String(error);
	const field = (key: string): unknown => (error as Record<string, unknown> | null)?.[key];
	switch (name) {
		case 'UnsupportedPhotoError':
			switch (field('code')) {
				case 'cmyk':
					return t('error.cmyk', { name: fileName });
				case 'hdr':
					return t('error.hdr', { name: fileName });
				case 'animated':
					return t('error.animated', { name: fileName });
				default:
					return t('error.unsupported', { name: fileName });
			}
		case 'UnsupportedFormatError':
			return t('error.unsupported', { name: fileName });
		case 'DecodeError':
			return t('error.decode', { name: fileName });
		case 'PhotoTooLargeError':
			return t('error.tooLarge', {
				name: fileName,
				mp: Math.round(Number(field('megapixels'))),
				limit: field('limit'),
			});
		case 'ModelIntegrityError':
		case 'ModelError':
		case 'ManifestError':
			return t('error.model');
		case 'DeviceLostError':
			return t('error.gpu');
		case 'InferenceError':
			return field('kind') === 'out-of-memory' ? t('error.memory') : t('error.gpu');
		case 'OutOfMemoryError':
			return t('error.memory');
		case 'EncodeError':
			return t('error.encode', { name: fileName });
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

/** Errors about the photo itself: trying the same file again can't help. */
const ABOUT_THE_PHOTO = ['UnsupportedPhotoError', 'UnsupportedFormatError', 'DecodeError', 'PhotoTooLargeError'];

/** Whether "Try again" could succeed: downloads, GPUs and memory can recover; a photo's format can't. */
export function isRetryable(error: unknown): boolean {
	return !(error instanceof Error && ABOUT_THE_PHOTO.includes(error.name));
}
