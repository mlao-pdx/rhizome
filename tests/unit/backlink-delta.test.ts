import { describe, expect, it } from 'vitest';

import {
	buildTargetSources,
	diffSources,
	hashTargetMap,
	hashTargetSources,
	RollingMultisetHash,
} from '../../src/core/backlinks/backlink-delta';

describe('hashTargetSources', () => {
	it('is stable, order-independent, and sensitive to paths and counts', () => {
		const a = hashTargetSources({ 'a.md': 1, 'b.md': 2 });
		const b = hashTargetSources({ 'b.md': 2, 'a.md': 1 });
		expect(a).toBe(b);
		expect(hashTargetSources({ 'a.md': 1, 'b.md': 3 })).not.toBe(a);
		expect(hashTargetSources({ 'a.md': 1 })).not.toBe(a);
	});

	it('excludes ignored sources', () => {
		expect(hashTargetSources({ 'a.md': 1, 'ignored.md': 5 }, new Set(['ignored.md']))).toBe(
			hashTargetSources({ 'a.md': 1 }),
		);
	});
});

describe('buildTargetSources', () => {
	it('inverts resolvedLinks and skips ignored and malformed counts', () => {
		const targets = buildTargetSources(
			{
				'a.md': { 't.md': 2, 'other.md': 1 },
				'b.md': { 't.md': 1 },
				'ignored.md': { 't.md': 9 },
				'bad.md': { 't.md': Number.NaN },
			},
			new Set(['ignored.md']),
		);

		expect([...targets.get('t.md')!.entries()]).toEqual([
			['a.md', 2],
			['b.md', 1],
		]);
		expect(targets.get('other.md')!.get('a.md')).toBe(1);
		expect(targets.has('missing.md')).toBe(false);
	});
});

describe('diffSources', () => {
	it('marks targets when a source gains, loses, moves, or re-counts a link', () => {
		expect([...diffSources({ 'a.md': {} }, { 'a.md': { 't.md': 1 } })].sort()).toEqual([
			't.md',
		]);
		expect([...diffSources({ 'a.md': { 't.md': 1 } }, { 'a.md': {} })].sort()).toEqual([
			't.md',
		]);
		expect(
			[...diffSources({ 'a.md': { 't.md': 1 } }, { 'a.md': { 'u.md': 1 } })].sort(),
		).toEqual(['t.md', 'u.md']);
		expect(
			[...diffSources({ 'a.md': { 't.md': 1 } }, { 'a.md': { 't.md': 2 } })].sort(),
		).toEqual(['t.md']);
	});

	it('returns nothing when a source reverts to its previous destinations', () => {
		expect(diffSources({ 'a.md': { 't.md': 1 } }, { 'a.md': { 't.md': 1 } })).toEqual(
			new Set(),
		);
	});

	it('marks targets of a source whose ignored status changed', () => {
		expect(
			[...diffSources({ 'a.md': { 't.md': 1 } }, { 'a.md': { 't.md': 1 } }, ['a.md'])].sort(),
		).toEqual(['t.md']);
		expect([...diffSources({}, { 'a.md': { 'u.md': 2 } }, ['a.md'])].sort()).toEqual(['u.md']);
	});
});

describe('rolling multiset hash', () => {
	it('is order-independent and subtracts back to the previous digest', () => {
		const hashes = hashTargetMap(
			new Map([
				['a.md', new Map([['s1.md', 1]])],
				['b.md', new Map([['s2.md', 2]])],
			]),
		);
		const h1 = hashes.get('a.md')!;
		const h2 = hashes.get('b.md')!;

		const forward = new RollingMultisetHash();
		forward.add(h1);
		forward.add(h2);
		const reverse = new RollingMultisetHash();
		reverse.add(h2);
		reverse.add(h1);
		expect(forward.digest()).toBe(reverse.digest());

		forward.remove(h1);
		expect(forward.digest()).toBe(h2);
	});

	it('matches a fresh sum after add/remove sequences', () => {
		const hashes = [11, 22, 33, 44].map((n) => {
			const record: Record<string, number> = { [`s${n}.md`]: n };
			return hashTargetSources(record);
		});
		const rolling = new RollingMultisetHash();
		const expected = hashes.reduce((sum, h) => (sum + h) >>> 0, 0);

		hashes.forEach((h) => rolling.add(h));
		expect(rolling.digest()).toBe(expected);
		rolling.remove(hashes[1]!);
		rolling.add(hashes[1]!);
		expect(rolling.digest()).toBe(expected);
	});
});
