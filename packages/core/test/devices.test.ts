// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { deviceClass, fitsDevice } from '../src/index.ts';

describe('§2.9 device limits', () => {
	it.each([
		[null, 'standard'],
		[undefined, 'standard'],
		[8, 'high'],
		[4, 'standard'],
		[2, 'constrained'],
		[0.5, 'constrained'],
	] as const)('deviceMemory %s → %s', (memory, expected) => {
		expect(deviceClass(memory)).toBe(expected);
	});

	it('lets a 45 MP photo through on a standard machine but not a constrained one', () => {
		expect(fitsDevice(8256, 5504, null)).toBe(true);
		expect(fitsDevice(8256, 5504, 2)).toBe(false);
	});

	it('takes 102 MP medium format on a high-memory machine only', () => {
		expect(fitsDevice(11648, 8736, 8)).toBe(true);
		expect(fitsDevice(11648, 8736, 4)).toBe(false);
	});
});
