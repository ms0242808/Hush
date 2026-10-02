// SPDX-License-Identifier: Apache-2.0
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/** Decimal megabytes, the way download sizes are usually quoted ("59 MB"). */
export function formatMegabytes(bytes: number, locale: string): string {
	const mb = bytes / 1e6;
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: mb < 10 ? 1 : 0 }).format(mb)} MB`;
}

export function formatSeconds(ms: number, locale: string): string {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: ms < 10_000 ? 1 : 0 }).format(ms / 1000);
}

/** `IMG_2041.JPG` → `IMG_2041-denoised.jpg`. */
export function outputName(input: string, suffix = '-denoised', extension = 'jpg'): string {
	const dot = input.lastIndexOf('.');
	const stem = dot > 0 ? input.slice(0, dot) : input;
	return `${stem}${suffix}.${extension}`;
}

export function isChromium(): boolean {
	const data = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData;
	return data?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand)) ?? false;
}
