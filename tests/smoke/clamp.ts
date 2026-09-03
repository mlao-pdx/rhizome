/**
 * Trivial pure helper used as a harness canary — proves the vitest +
 * fast-check test pipeline (unit tests, property tests, finding capture,
 * and the promote script) works end-to-end. See `README.md#testing`.
 */
export function clamp(value: number, min: number, max: number): number {
	if (min > max) {
		throw new Error(`clamp: min (${min}) must not be greater than max (${max})`);
	}
	return Math.min(Math.max(value, min), max);
}
