// SPDX-License-Identifier: Apache-2.0
import type { Backend, OutputFormat } from '@hush/core';
import { readStored, writeStored } from './storage.ts';

/**
 * Settings that outlive a visit (§4.2: localStorage, nothing server-side).
 * Each reader validates what it finds, so a value from an older or newer
 * Hush falls back to the default instead of breaking the page.
 */

export interface ExportSettings {
	/** 'auto' keeps the photo's format; HEIC and AVIF become JPEG (§2.6). */
	format: OutputFormat | 'auto';
	/** JPEG and WebP quality. */
	quality: number;
	suffix: string;
	removeLocation: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
	format: 'auto',
	quality: 95,
	suffix: '-denoised',
	removeLocation: false,
};

/** The quality slider's range: below 50, a denoised photo would gain blocks instead. */
export const QUALITY_RANGE = { min: 50, max: 100 } as const;

const EXPORT_KEY = 'hush.export.v1';
const PROCESSING_KEY = 'hush.processing';
const THEME_KEY = 'hush.theme';
const PRESET_KEY = 'hush.preset';
const FORMATS: readonly ExportSettings['format'][] = ['auto', 'jpeg', 'png', 'webp'];

export function loadExportSettings(): ExportSettings {
	return readStored(
		EXPORT_KEY,
		(value) => {
			const v = (value ?? {}) as Partial<Record<keyof ExportSettings, unknown>>;
			const quality = typeof v.quality === 'number' && Number.isFinite(v.quality) ? Math.round(v.quality) : NaN;
			return {
				format: FORMATS.includes(v.format as ExportSettings['format'])
					? (v.format as ExportSettings['format'])
					: DEFAULT_EXPORT_SETTINGS.format,
				quality: Number.isNaN(quality)
					? DEFAULT_EXPORT_SETTINGS.quality
					: Math.min(QUALITY_RANGE.max, Math.max(QUALITY_RANGE.min, quality)),
				suffix: typeof v.suffix === 'string' ? v.suffix.slice(0, 64) : DEFAULT_EXPORT_SETTINGS.suffix,
				removeLocation: typeof v.removeLocation === 'boolean' ? v.removeLocation : false,
			};
		},
		DEFAULT_EXPORT_SETTINGS,
	);
}

export function saveExportSettings(settings: ExportSettings): void {
	writeStored(EXPORT_KEY, settings);
}

/** §2.10's manual override: Automatic / Graphics chip / Processor. */
export type Processing = 'auto' | Backend;

export function loadProcessing(): Processing {
	return readStored(PROCESSING_KEY, (value) => (value === 'webgpu' || value === 'wasm' ? value : 'auto'), 'auto');
}

export function saveProcessing(processing: Processing): void {
	writeStored(PROCESSING_KEY, processing);
}

/** Dark by default whatever the system says (§5.1); light grey is the accessibility option. */
export type Theme = 'dark' | 'light';

export function loadTheme(): Theme {
	return readStored(THEME_KEY, (value): Theme => (value === 'light' ? 'light' : 'dark'), 'dark');
}

export function applyTheme(theme: Theme): void {
	document.documentElement.dataset['theme'] = theme;
	document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', theme === 'light' ? '#d9d9d9' : '#191919');
}

export function saveTheme(theme: Theme): void {
	writeStored(THEME_KEY, theme);
	applyTheme(theme);
}

/** The preset last chosen, by id; null is the defaults. */
export function loadSelectedPreset(): string | null {
	return readStored(PRESET_KEY, (value) => (typeof value === 'string' ? value : null), null);
}

export function saveSelectedPreset(id: string | null): void {
	writeStored(PRESET_KEY, id);
}
