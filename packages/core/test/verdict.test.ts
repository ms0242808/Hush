// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { megapixelsPerSecond, previewVerdict, throughputVerdict } from '../src/index.ts';

describe('§4.6 verdicts', () => {
	it('computes megapixels per second', () => {
		expect(megapixelsPerSecond(6000, 4000, 30_000)).toBeCloseTo(0.8, 6);
		expect(megapixelsPerSecond(6000, 4000, 0)).toBe(0);
	});

	it.each([
		['integrated', 0.8, 'go'],
		['integrated', 0.79, 'borderline'],
		['integrated', 0.4, 'borderline'],
		['integrated', 0.39, 'no-go'],
		['strong', 2.4, 'go'],
		['strong', 1.2, 'borderline'],
		['strong', 1.19, 'no-go'],
		['cpu', 0.08, 'go'],
		['cpu', 0.04, 'borderline'],
		['cpu', 0.039, 'no-go'],
	] as const)('%s at %f MP/s is %s', (machine, mps, verdict) => {
		expect(throughputVerdict(mps, machine)).toBe(verdict);
	});

	it.each([
		[1.5, 'go'],
		[1.51, 'borderline'],
		[3, 'borderline'],
		[3.01, 'no-go'],
	] as const)('a %f s preview is %s', (seconds, verdict) => {
		expect(previewVerdict(seconds)).toBe(verdict);
	});
});
