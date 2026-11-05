import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	aggregateFilter,
	compareRhizomeValues,
	groupByFilter,
	isVacuousSortOrGroupValue,
	listFilter,
	mergeFilter,
	percentageFilter,
	pickFilter,
	pruneFilter,
	sentenceFilter,
	sortFilter,
	sortNaturalFilter,
	tableFilter,
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
				const finiteQuotient =
					validVal && validTotal && Number.isFinite((val / total) * 100);

				if (!finiteQuotient) {
					expect(res).toBeNull();
				} else {
					expect(typeof res).toBe('number');
					expect(Number.isFinite(res)).toBe(true);
				}
			}),
		);
	});

	it('Sort Total-Order & NULLS LAST Invariant: compareRhizomeValues is antisymmetric, transitive, and places vacuous values last in both asc and desc', async () => {
		const mixedValueArb = fc.oneof(
			fc.constant(null),
			fc.constant(undefined),
			fc.constant(''),
			fc.constant([]),
			fc.constant({}),
			fc.boolean(),
			fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
			fc.string({ minLength: 1, maxLength: 12 }),
			fc.constantFrom(
				'2026-01-01',
				'2026-01-01..2026-01-31',
				'Note 2',
				'Note 10',
				'Éclair',
				'eclair',
			),
			fc.array(scalarValueArb, { minLength: 1, maxLength: 3 }),
		);

		await assertProperty(
			'templates/payload-filters__sort-total-order-and-nulls-last',
			fc.property(
				mixedValueArb,
				mixedValueArb,
				mixedValueArb,
				fc.constantFrom<'asc' | 'desc'>('asc', 'desc'),
				fc.boolean(),
				(a, b, c, dir, natural) => {
					const opts = { natural, language: 'en' };
					const ab = compareRhizomeValues(a, b, dir, opts);
					const ba = compareRhizomeValues(b, a, dir, opts);
					const bc = compareRhizomeValues(b, c, dir, opts);
					const ac = compareRhizomeValues(a, c, dir, opts);

					// Antisymmetry: sign(cmp(a, b)) + sign(cmp(b, a)) === 0
					expect(Math.sign(ab) + Math.sign(ba)).toBe(0);

					// Transitivity: if a <= b and b <= c then a <= c (and strict if either is strict)
					if (ab <= 0 && bc <= 0) {
						expect(ac).toBeLessThanOrEqual(0);
						if (ab < 0 || bc < 0) {
							expect(ac).toBeLessThan(0);
						}
					}

					// NULLS LAST in both asc and desc
					const sorted = (natural ? sortNaturalFilter : sortFilter)(
						[{ v: a }, { v: b }, { v: c }],
						`v ${dir}`,
					) as { v: unknown }[];
					let seenVacuous = false;
					for (const row of sorted) {
						const vac = isVacuousSortOrGroupValue(row.v);
						if (seenVacuous) {
							expect(vac).toBe(true);
						}
						if (vac) {
							seenVacuous = true;
						}
					}
				},
			),
		);
	});

	it('Temporal Widening Subsumption Permutation Invariant: any permutation of covered days and covering range produces the same widened bucket name and preserves relative arrival order', async () => {
		const baseEntries = [
			{ id: 0, due: '2026-10-01' },
			{ id: 1, due: '2026-10-15' },
			{ id: 2, due: '2026-10-28' },
			{ id: 3, due: '2026-10-01..2026-10-31' },
		];

		await assertProperty(
			'templates/payload-filters__group-by-temporal-subsumption-permutation',
			fc.property(
				fc.shuffledSubarray(baseEntries, { minLength: 4, maxLength: 4 }),
				(perm) => {
					const groups = groupByFilter(perm, 'due');
					expect(groups).toHaveLength(1);
					expect(String(groups[0]?.name)).toBe('2026-10-01..2026-10-31');
					expect(groups[0]?.size).toBe(4);
					expect(groups[0]?.items).toEqual(perm);
				},
			),
		);
	});

	it('Deep-Target Pick Immutability Invariant: pick with deep target paths never mutates nested input records', async () => {
		await assertProperty(
			'templates/payload-filters__deep-pick-immutability',
			fc.property(
				fc.array(recordArb, { minLength: 1, maxLength: 6 }),
				safeKeyArb,
				safeKeyArb,
				(rows, k1, k2) => {
					const nestedRows = rows.map((r) => ({ nested: r }));
					const snapshot = JSON.stringify(nestedRows);
					pickFilter(nestedRows, 'nested', `nested.${k1} as nested.${k2}`);
					expect(JSON.stringify(nestedRows)).toBe(snapshot);
				},
			),
		);
	});

	it('GFM Table Structural & Pipe-Escaping Invariant: tableFilter preserves column delimiter counts across all rows and escapes internal pipes/newlines', async () => {
		const trickyStringArb = fc.oneof(
			fc.string({ minLength: 0, maxLength: 16 }),
			fc.constantFrom(
				'[[Note|Alias]]',
				'a | b \\| c',
				'a \\\\| b \\\\\\| c',
				'line1\nline2\r\nline3',
				'2026-10-15',
				'{already}',
			),
		);
		const trickyKeyArb = fc
			.oneof(safeKeyArb, fc.constantFrom('Book Title', 'Col | Pipe', 'Line\nBreak', 'Rating'))
			.filter((k) => k !== '__proto__' && k !== 'prototype' && k !== 'constructor');

		const tableCellArb = fc.oneof(
			fc.constant(null),
			fc.constant(undefined),
			trickyStringArb,
			fc.integer({ min: -1000, max: 1000 }),
			fc.boolean(),
			fc.array(trickyStringArb, { minLength: 0, maxLength: 4 }),
			fc.dictionary(safeKeyArb, scalarValueArb, { maxKeys: 4 }),
		);
		const tableRowArb = fc.dictionary(trickyKeyArb, tableCellArb, { maxKeys: 5 });
		const alignSpecArb = fc
			.tuple(fc.constantFrom('', '<', '^', '>'), trickyKeyArb)
			.map(([sigil, col]) => `${sigil}${col}`);

		await assertProperty(
			'templates/payload-filters__table-gfm-structural-invariant',
			fc.property(
				fc.array(tableRowArb, { minLength: 0, maxLength: 8 }),
				fc.array(alignSpecArb, { minLength: 0, maxLength: 4 }),
				(rows, alignSpecs) => {
					const snapshotBefore = JSON.stringify(rows);
					const out = tableFilter(rows, ...alignSpecs);
					expect(JSON.stringify(rows)).toBe(snapshotBefore);

					const discoveredCols = new Set<string>();
					for (const r of rows) {
						for (const k of Object.keys(r)) {
							discoveredCols.add(k);
						}
					}

					if (rows.length === 0 || discoveredCols.size === 0) {
						expect(out).toBe('');
						return;
					}

					const lines = out.split('\n');
					expect(lines).toHaveLength(rows.length + 2);

					const expectedUnescapedPipes = discoveredCols.size + 1;
					for (const line of lines) {
						expect(line.includes('\r')).toBe(false);
						expect(line.startsWith('| ')).toBe(true);
						expect(line.endsWith(' |')).toBe(true);
						// Count unescaped `|` characters (not preceded by an odd number of `\`)
						const unescapedPipes =
							line.replace(/\\\\/g, '').replace(/\\\|/g, '').split('|').length - 1;
						expect(unescapedPipes).toBe(expectedUnescapedPipes);
					}
				},
			),
		);
	});

	it('Markdown List & Sentence Structural and Horizon Badge Invariant: listFilter and sentenceFilter never mutate inputs or leak FORBIDDEN_KEYS, emit valid bullet lines, and use (size+) iff depth horizon is hit', async () => {
		const singleLineScalarArb = fc.oneof(
			fc.constant(null),
			fc.constant(''),
			fc.integer({ min: -500, max: 500 }),
			fc.boolean(),
			fc.stringMatching(/^[a-zA-Z0-9 _-]{1,12}$/),
		);
		const nestedRowArb = fc.dictionary(safeKeyArb, singleLineScalarArb, {
			minKeys: 1,
			maxKeys: 4,
		});
		const styleSpecArb = fc.constantFrom(
			'-',
			'1.',
			'-, ...',
			'1., ...',
			'1., -',
			'1., -, ...',
			'-, 1., -',
		);

		await assertProperty(
			'templates/payload-filters__list-and-sentence-structural-invariant',
			fc.property(
				fc.array(nestedRowArb, { minLength: 0, maxLength: 8 }),
				styleSpecArb,
				safeKeyArb,
				safeKeyArb,
				(rows, styleSpec, groupKey, pickKey) => {
					const snapshotBefore = JSON.stringify(rows);

					const sentenceOut = sentenceFilter(rows);
					const listOut = listFilter(rows, styleSpec);
					expect(typeof sentenceOut).toBe('string');
					expect(typeof listOut).toBe('string');
					expect(JSON.stringify(rows)).toBe(snapshotBefore);

					if (listOut.length > 0) {
						for (const line of listOut.split('\n')) {
							expect(line.includes('\r')).toBe(false);
							expect(line.includes('__proto__')).toBe(false);
							expect(/^(?: {2})*(?:- |\d+\. ).+/.test(line)).toBe(true);
						}
					}

					// Check GroupByBucket (size) vs (size+) horizon badge invariant on 1-key leaf projection
					const rowsWithPickAndGroup = rows.map((r, idx) => ({
						...r,
						[groupKey]: idx % 2 === 0 ? 'GroupA' : 'GroupB',
						[pickKey]: `Item_${idx}`,
					}));
					const grouped = groupByFilter(rowsWithPickAndGroup, groupKey);
					if (grouped.length > 0) {
						// With depth N = 1 ("1."), bucket items at depth 2 hit horizon -> (size+)
						const truncatedList = listFilter(grouped, '1.', pickKey);
						const firstTruncatedLine = truncatedList.split('\n')[0] ?? '';
						expect(firstTruncatedLine).toContain(`(${grouped[0]!.size}+)`);

						// With depth N = 6 ("1., ..."), 1-key scalar items at depth 2 do not hit horizon -> (size)
						const fullList = listFilter(grouped, '1., ...', pickKey);
						const firstFullLine = fullList.split('\n')[0] ?? '';
						expect(firstFullLine).toContain(`(${grouped[0]!.size})`);
						expect(firstFullLine).not.toContain(`(${grouped[0]!.size}+)`);
					}
				},
			),
		);
	});
});
