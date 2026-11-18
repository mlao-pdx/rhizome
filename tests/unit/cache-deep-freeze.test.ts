import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../../src/core/cache/deep-freeze';

describe('deepFreeze', () => {
	it('freezes nested plain objects and arrays', () => {
		const value = { a: { b: [1, { c: 'x' }] } };
		const frozen = deepFreeze(value);

		expect(frozen).toBe(value);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.a)).toBe(true);
		expect(Object.isFrozen(value.a.b)).toBe(true);
		expect(Object.isFrozen(value.a.b[1])).toBe(true);
	});

	it('freezes null-prototype records', () => {
		const record = Object.create(null) as Record<string, unknown>;
		record['x'] = { y: [1] };
		deepFreeze(record);

		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record['x'])).toBe(true);
	});

	it('traverses already frozen parents to freeze mutable children', () => {
		const child = { mutable: true };
		const parent = Object.freeze({ child });
		deepFreeze(parent);

		expect(Object.isFrozen(child)).toBe(true);
	});

	it('leaves primitives and exotic objects untouched', () => {
		const map = new Map([['k', { v: 1 }]]);
		const value = { map, n: 1, s: 'x', nil: null };
		deepFreeze(value);

		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(map)).toBe(false);
		expect(Object.isFrozen(map.get('k'))).toBe(false);
	});

	it('is cycle-safe and idempotent', () => {
		const node: { self?: unknown; child: { list: number[] } } = { child: { list: [1] } };
		node.self = node;
		deepFreeze(node);
		deepFreeze(node);

		expect(Object.isFrozen(node)).toBe(true);
		expect(Object.isFrozen(node.child.list)).toBe(true);
	});
});
