// SPDX-License-Identifier: Apache-2.0

/** Device classes from §2.9, by how large a photo they can process without the tab running out of memory. */
export type DeviceClass = 'high' | 'standard' | 'constrained';

export const MAX_MEGAPIXELS: Record<DeviceClass, number> = {
	high: 102, // medium format
	standard: 61,
	constrained: 24,
};

/**
 * Classify from `navigator.deviceMemory` (GB, Chrome and Edge only, capped at 8).
 * Unknown memory — Safari, Firefox — counts as standard: desktop browsers there
 * run on machines that comfortably hold a 61 MP photo.
 */
export function deviceClass(deviceMemory: number | null | undefined): DeviceClass {
	if (deviceMemory === null || deviceMemory === undefined) return 'standard';
	if (deviceMemory >= 8) return 'high';
	if (deviceMemory >= 4) return 'standard';
	return 'constrained';
}

export function fitsDevice(width: number, height: number, deviceMemory: number | null | undefined): boolean {
	return (width * height) / 1e6 <= MAX_MEGAPIXELS[deviceClass(deviceMemory)];
}
