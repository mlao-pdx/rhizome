import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import { assertProperty } from '../support/assertProperty';
import { clamp } from './clamp';

describe('clamp (property)', () => {
	it('result is always within [min(a,b), max(a,b)]', async () => {
		await assertProperty(
			'smoke/clamp__result-within-bounds',
			fc.property(fc.integer(), fc.integer(), fc.integer(), (value, a, b) => {
				const min = Math.min(a, b);
				const max = Math.max(a, b);
				const result = clamp(value, min, max);
				return result >= min && result <= max;
			}),
		);
	});
});
