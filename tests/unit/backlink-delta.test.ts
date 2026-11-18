import { describe, expect, it } from 'vitest';

import {
	buildTargetSources,
	diffSources,
	normalizeResolvedLinks,
	recordsEqual,
} from '../../src/core/backlinks/backlink-delta';

describe('normalizeResolvedLinks & recordsEqual', () => {
	it('treats empty or missing destination maps as undefined and equal', () => {
		expect(normalizeResolvedLinks(undefined)).toBeUndefined();
		expect(normalizeResolvedLinks(null)).toBeUndefined();
		expect(normalizeResolvedLinks({})).toBeUndefined();
		expect(normalizeResolvedLinks({ 'a.md': Number.NaN })).toBeUndefined();
		expect(recordsEqual(undefined, {})).toBe(true);
		expect(recordsEqual({}, undefined)).toBe(true);
	});

	it('compares destination counts accurately', () => {
		const a = normalizeResolvedLinks({ 'a.md': 1, 'b.md': 2 });
		const b = normalizeResolvedLinks({ 'b.md': 2, 'a.md': 1 });
		expect(recordsEqual(a, b)).toBe(true);
		expect(recordsEqual(a, { 'a.md': 1, 'b.md': 3 })).toBe(false);
		expect(recordsEqual(a, { 'a.md': 1 })).toBe(false);
	});
});

describe('buildTargetSources', () => {
	it('inverts resolvedLinks and skips ignored sources, ignored targets, and malformed counts', () => {
		const targets = buildTargetSources(
			{
				'a.md': { 't.md': 2, 'other.md': 1, 'ignored.md': 4 },
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
		expect(targets.has('ignored.md')).toBe(false);
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
