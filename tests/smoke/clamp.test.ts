import { describe, expect, it } from 'vitest';
import { clamp } from './clamp';

describe('clamp', () => {
	it('returns min when value is below range', () => {
		expect(clamp(-5, 0, 10)).toBe(0);
	});

	it('returns max when value is above range', () => {
		expect(clamp(15, 0, 10)).toBe(10);
	});

	it('returns value unchanged when within range', () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});

	it('throws when min > max', () => {
		expect(() => clamp(5, 10, 0)).toThrow();
	});
});
