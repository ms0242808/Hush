// SPDX-License-Identifier: Apache-2.0
import type { TFunction } from 'i18next';
import type { BatchState } from './store';

/** Where the batch is saving, in words (§5.13): "Wedding/denoised", or Downloads with its ZIP files. */
export function placeName(state: Pick<BatchState, 'destination' | 'parts'>, t: TFunction): string {
	const destination = state.destination;
	if (!destination) return t('save.downloads');
	if (destination.kind === 'zip') return t('batch.zipPlace', { count: Math.max(1, state.parts.length) });
	return destination.inside ? `${destination.folder.name}/${destination.inside}` : destination.folder.name;
}
