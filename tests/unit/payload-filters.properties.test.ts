import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	aggregateFilter,
	mergeFilter,
	percentageFilter,
	pickFilter,
	pruneFilter,
} from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

const safeKeyArb = fc
	.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,8}$/)
	.filter((k) => k !== '__proto__' && k !== 'prototype' && k !== 'constructor');

const scalarValueArb = fc.oneof(
	fc.constant(null),
	fc.constant(''),
	fc.integer({ min: -1000, max: 1000 }),
	fc.string({ minLength: 1, maxLength: 10 }),
	fc.boolean(),
);

const cellValueArb = fc.oneof(
	scalarValueArb,
	fc.array(scalarValueArb, { minLength: 0, maxLength: 4 }),
);

const recordArb = fc.dictionary(safeKeyArb, cellValueArb, { maxKeys: 6 });

describe('Payload-Shaping & Aggregation Filter Property Invariants', () => {
	it('Pure Immutability Invariant: pick, prune, merge, aggregate, and percentage never mutate input objects or arrays', async () => {
		await assertProperty(
			'templates/payload-filters__immutability-invariant',
			fc.property(
				fc.array(recordArb, { minLength: 0, maxLength: 8 }),
				fc.array(safeKeyArb, { minLength: 1, maxLength: 4 }),
				(rows, keys) => {
					const snapshotBefore = JSON.stringify(rows);

					pickFilter(rows, ...keys);
					pruneFilter(rows, ...keys);
					mergeFilter(rows);
					if (rows.length > 0) {
						mergeFilter(rows[0], rows);
						mergeFilter(rows, rows[0]);
						mergeFilter(rows, rows);
					}
					aggregateFilter(rows, ...keys);

					expect(JSON.stringify(rows)).toBe(snapshotBefore);
				},
			),
		);
	});

	it('Merge Algebraic & Vacuous Collision Invariant: (arr | merge) === ({} | merge: arr) and leading vacuous scalars never produce [null, ...]', async () => {
		await assertProperty(
			'templates/payload-filters__merge-fold-and-vacuous-collision',
			fc.property(fc.array(recordArb, { minLength: 0, maxLength: 10 }), (rows) => {
				const foldShorthand = mergeFilter(rows);
				const foldExplicit = mergeFilter({}, rows);
				expect(foldShorthand).toEqual(foldExplicit);

				// Check that scalar-only series with vacuous values never inject leading null into promoted array
				const scalarOnlyRows = rows.map((r) => {
					const copy: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(r)) {
						if (!Array.isArray(v)) {
							copy[k] = v;
						}
					}
					return copy;
				});
				const mergedScalars = mergeFilter(scalarOnlyRows) as Record<string, unknown>;
				for (const val of Object.values(mergedScalars)) {
					if (Array.isArray(val)) {
						for (const item of val) {
							expect(item).not.toBeNull();
							expect(item).not.toBe('');
						}
					}
				}
			}),
		);
	});

	it('Aggregate Mathematical Invariant: value_count, sum, average, min <= average <= max, and interval === [min, max] hold across arbitrary numeric/null/array rows', async () => {
		const numericOrNullOrArrayArb = fc.oneof(
			fc.constant(null),
			fc.constant(undefined),
			fc.constant(''),
			fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
			fc.array(
				fc.oneof(
					fc.constant(null),
					fc.constant(''),
					fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
				),
				{ minLength: 0, maxLength: 5 },
			),
		);

		await assertProperty(
			'templates/payload-filters__aggregate-numeric-invariants',
			fc.property(
				fc.array(numericOrNullOrArrayArb, { minLength: 0, maxLength: 15 }),
				(rawValues) => {
					const rows = rawValues.map((v) => ({ val: v }));
					const agg = aggregateFilter(rows, 'val');

					expect(agg).toHaveLength(rows.length);
					expect(agg.total_index_count).toBe(rows.length);

					const expectedValidNumbers: number[] = [];
					for (let i = 0; i < rows.length; i++) {
						const v = rawValues[i];
						const items = Array.isArray(v) ? v : [v];
						for (const item of items) {
							if (typeof item === 'number' && Number.isFinite(item)) {
								expectedValidNumbers.push(item === 0 ? 0 : item);
							}
						}

						const step = agg[i] as Record<string, unknown>;
						expect(step.index_count).toBe(i + 1);
						expect(step.value_count).toBe(expectedValidNumbers.length);

						if (expectedValidNumbers.length === 0) {
							expect(step.sum).toBeNull();
							expect(step.average).toBeNull();
							expect(step.min).toBeNull();
							expect(step.max).toBeNull();
							expect(step.interval).toBeNull();
						} else {
							const minVal = step.min as number;
							const maxVal = step.max as number;
							const avgVal = step.average as number;
							expect(minVal).toBeLessThanOrEqual(maxVal);
							// Allow tiny IEEE-754 floating-point rounding tolerance on average bounds
							expect(avgVal).toBeGreaterThanOrEqual(minVal - 1e-7);
							expect(avgVal).toBeLessThanOrEqual(maxVal + 1e-7);
							expect(step.interval).toEqual([minVal, maxVal]);
						}
					}

					if (rows.length > 0) {
						const lastStep = agg[rows.length - 1] as Record<string, unknown>;
						expect(agg.total_value_count).toBe(lastStep.value_count);
						expect(agg.total_sum).toBe(lastStep.sum);
						expect(agg.total_average).toBe(lastStep.average);
						expect(agg.total_min).toBe(lastStep.min);
						expect(agg.total_max).toBe(lastStep.max);
						expect(agg.total_interval).toEqual(lastStep.interval);
					} else {
						expect(agg.total_value_count).toBe(0);
						expect(agg.total_sum).toBeNull();
						expect(agg.total_average).toBeNull();
						expect(agg.total_min).toBeNull();
						expect(agg.total_max).toBeNull();
						expect(agg.total_interval).toBeNull();
					}
				},
			),
		);
	});

	it('Multi-Selector Same-outputKey Equivalence Invariant: agg("a as v", "b as v") matches agg("v") on [{ v: [a, b] }]', async () => {
		const scalarNumOrNullArb = fc.oneof(
			fc.constant(null),
			fc.constant(''),
			fc.integer({ min: -5000, max: 5000 }),
		);

		await assertProperty(
			'templates/payload-filters__aggregate-same-outputkey-equivalence',
			fc.property(
				fc.array(fc.tuple(scalarNumOrNullArb, scalarNumOrNullArb), {
					minLength: 0,
					maxLength: 12,
				}),
				(pairs) => {
					const splitRows = pairs.map(([a, b]) => ({ a, b }));
					const combinedRows = pairs.map(([a, b]) => ({ v: [a, b] }));

					const aggSplit = aggregateFilter(splitRows, 'a as v', 'b as v');
					const aggCombined = aggregateFilter(combinedRows, 'v');

					expect(aggSplit).toEqual(aggCombined);
					expect(aggSplit.v).toEqual(aggCombined.v);
					expect(aggSplit.total_value_count).toBe(aggCombined.total_value_count);
					expect(aggSplit.total_sum).toBe(aggCombined.total_sum);
					expect(aggSplit.total_average).toBe(aggCombined.total_average);
					expect(aggSplit.total_min).toBe(aggCombined.total_min);
					expect(aggSplit.total_max).toBe(aggCombined.total_max);
					expect(aggSplit.total_interval).toEqual(aggCombined.total_interval);
				},
			),
		);
	});

	it('Percentage Safety Invariant: percentage returns null iff either input is non-numeric or total is 0, and finite number otherwise', async () => {
		const numOrBadArb = fc.oneof(
			fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true }),
			fc.constant(0),
			fc.constant(null),
			fc.constant(''),
			fc.constant('not-a-number'),
		);

		await assertProperty(
			'templates/payload-filters__percentage-safety',
			fc.property(numOrBadArb, numOrBadArb, (val, total) => {
				const res = percentageFilter(val, total);
				const validVal = typeof val === 'number' && Number.isFinite(val);
				const validTotal =
					typeof total === 'number' && Number.isFinite(total) && total !== 0;

				if (!validVal || !validTotal) {
					expect(res).toBeNull();
				} else {
					expect(typeof res).toBe('number');
					expect(Number.isFinite(res)).toBe(true);
				}
			}),
		);
	});
});
