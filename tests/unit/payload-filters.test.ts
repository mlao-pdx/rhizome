import { describe, expect, it, vi } from 'vitest';
import {
	aggregateFilter,
	createQueryTagEnvironment,
	createRhizomeLiquidInstance,
	findFilter,
	findIndexFilter,
	groupByFilter,
	hasFilter,
	mapFilter,
	mergeFilter,
	percentageFilter,
	pickFilter,
	pruneFilter,
	rejectFilter,
	renderRhizomeTemplate,
	sortFilter,
	sortNaturalFilter,
	sumFilter,
	TemporalDrop,
	uniqFilter,
	whereFilter,
} from '../../src/core/templates';

describe('Payload-Shaping & Aggregation Filters (pick, prune, merge, aggregate/agg, percentage/percent)', () => {
	describe('pick filter', () => {
		it('picks root and deep-dotted paths from a single object and from an array of objects', () => {
			const propsA = Object.create(null) as Record<string, unknown>;
			propsA.status = 'open';
			propsA.Owner = 'Alice';
			propsA.owner = 'Bob';

			const propsB = Object.create(null) as Record<string, unknown>;
			propsB.status = 'done';

			const matchA = {
				file: { path: 'Projects/Alpha.md', basename: 'Alpha', size: 120 },
				tags: ['project', 'active'],
				properties: propsA,
			};
			const matchB = {
				file: { path: 'Projects/Beta.md', basename: 'Beta', size: 240 },
				tags: [],
				properties: propsB,
			};

			const singlePicked = pickFilter(
				matchA,
				'file.basename',
				'properties.status as state',
				'properties.Owner',
				'properties.owner',
				'properties.missing',
			);
			expect(singlePicked).toEqual({
				basename: 'Alpha',
				state: 'open',
				Owner: 'Alice',
				owner: 'Bob',
				missing: null,
			});

			const arrayPicked = pickFilter(
				[matchA, matchB],
				['file.basename as title', 'properties.status'],
			);
			expect(arrayPicked).toEqual([
				{ title: 'Alpha', status: 'open' },
				{ title: 'Beta', status: 'done' },
			]);
		});

		it('resolves same-leaf collisions without "as" via the shared vacuous-aware Collision Resolution Rule', () => {
			const row1 = {
				file: { name: null },
				properties: { name: 'Alpha' },
				extra: { name: '' },
				tail: { name: 'Beta' },
			};
			expect(
				pickFilter(row1, 'file.name', 'properties.name', 'extra.name', 'tail.name'),
			).toEqual({
				name: ['Alpha', 'Beta'],
			});

			const rowAllVacuous = {
				a: { key: null },
				b: { key: undefined },
				c: { key: '' },
			};
			expect(pickFilter(rowAllVacuous, 'a.key', 'b.key', 'c.key')).toEqual({
				key: null,
			});

			const rowWithInternalNullArray = {
				a: { items: [null, 'x', ''] },
				b: { items: 'y' },
			};
			expect(pickFilter(rowWithInternalNullArray, 'a.items', 'b.items')).toEqual({
				items: [null, 'x', '', 'y'],
			});
		});

		it('rejects FORBIDDEN_KEYS in path segments or aliases and never mutates input', () => {
			const input = Object.freeze({
				file: Object.freeze({ basename: 'Note' }),
			});
			const out = pickFilter(
				input,
				'__proto__.polluted',
				'file.constructor',
				'file.basename as __proto__',
				'file.basename as safe',
			) as Record<string, unknown>;

			expect(out).toEqual({ safe: 'Note' });
			expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
		});
	});

	describe('prune filter', () => {
		it('non-destructively removes root and deep-dotted paths from objects and arrays while preserving siblings and case-sensitivity', () => {
			const origProps = {
				Owner: 'Alice',
				owner: 'Bob',
				secret: 'xyz',
			};
			const origFile = {
				path: 'Notes/A.md',
				basename: 'A',
				size: 512,
			};
			const doc = {
				file: origFile,
				tags: ['a'],
				tagLocations: [{ tag: 'a', line: 1 }],
				properties: origProps,
			};

			const pruned = pruneFilter(
				doc,
				'tagLocations',
				'file.size',
				'properties.Owner',
				'properties.nonexistent.deep',
			) as Record<string, unknown>;

			expect(pruned).toEqual({
				file: { path: 'Notes/A.md', basename: 'A' },
				tags: ['a'],
				properties: { owner: 'Bob', secret: 'xyz' },
			});
			// Original objects are completely untouched
			expect(origFile.size).toBe(512);
			expect(origProps.Owner).toBe('Alice');
			expect(doc.tagLocations).toHaveLength(1);

			const arrPruned = pruneFilter([doc], ['tagLocations', 'properties.secret']);
			expect(arrPruned).toEqual([
				{
					file: { path: 'Notes/A.md', basename: 'A', size: 512 },
					tags: ['a'],
					properties: { Owner: 'Alice', owner: 'Bob' },
				},
			]);

			// Strings containing filter pipes or `as` clauses are ignored by prune
			const ignoredFilterAndAlias = pruneFilter(
				{ file: { size: 512 }, secret: 'keep' },
				'file.size | plus: 1',
				'secret as alias',
			);
			expect(ignoredFilterAndAlias).toEqual({
				file: { size: 512 },
				secret: 'keep',
			});
		});
	});

	describe('merge filter', () => {
		it('handles all 5 shape combinations with lhs dictating the output shape and vacuous-aware collision resolution', () => {
			// 1. Object | merge: Object -> Object
			expect(
				mergeFilter(
					{ a: null, b: 'first', c: [null, 'x'] },
					{ a: 'filled', b: 'second', c: '', d: 42 },
				),
			).toEqual({
				a: 'filled',
				b: ['first', 'second'],
				c: [null, 'x'],
				d: 42,
			});

			// 2. Object | merge: Object[] -> Object (fold array into object)
			expect(mergeFilter({}, [{ k1: 'v1' }, { k1: 'v2', k2: 'v2' }])).toEqual({
				k1: ['v1', 'v2'],
				k2: 'v2',
			});

			// 3. Object[] | merge (no rhs arg) -> Object (shorthand fold)
			expect(
				mergeFilter([
					{ k1: '', k2: 'init' },
					{ k1: 'v1', k2: null },
					{ k1: 'v2', k2: 'final' },
				]),
			).toEqual({
				k1: ['v1', 'v2'],
				k2: ['init', 'final'],
			});

			// 4. Object[] | merge: Object -> Object[] (broadcast)
			expect(
				mergeFilter([{ id: 1 }, { id: 2, source: 'local' }], { source: 'vault' }),
			).toEqual([
				{ id: 1, source: 'vault' },
				{ id: 2, source: ['local', 'vault'] },
			]);

			// 5. Object[] | merge: Object[] -> Object[] (positional zip, including uneven lengths)
			expect(
				mergeFilter(
					[{ id: 1, tag: 'a' }, { id: 2, tag: 'b' }, { id: 3 }],
					[{ score: 10, tag: 'x' }, { score: 20 }],
				),
			).toEqual([
				{ id: 1, tag: ['a', 'x'], score: 10 },
				{ id: 2, tag: 'b', score: 20 },
				{ id: 3 },
			]);
		});
	});

	describe('aggregate / agg filter', () => {
		it('computes single-pass cumulative and total_* metrics with SQL NULL semantics and single-attribute shorthand', () => {
			const rows = [
				{ properties: { amount: 10 } },
				{ properties: { amount: null } },
				{ properties: { amount: '' } },
				{ properties: { amount: 20 } },
			];

			const agg = aggregateFilter(rows, 'properties.amount');
			expect(agg).toHaveLength(4);

			// Top-level summary (both under `agg.amount` and mirrored on `agg` for single attribute)
			expect(agg.total_index_count).toBe(4);
			expect(agg.total_value_count).toBe(2);
			expect(agg.total_sum).toBe(30);
			expect(agg.total_average).toBe(15);
			expect(agg.total_min).toBe(10);
			expect(agg.total_max).toBe(20);
			expect(agg.total_interval).toEqual([10, 20]);
			expect(agg.amount).toEqual({
				total_index_count: 4,
				total_value_count: 2,
				total_sum: 30,
				total_average: 15,
				total_min: 10,
				total_max: 20,
				total_interval: [10, 20],
			});

			// Step 0: [10]
			const step0 = agg[0] as Record<string, unknown>;
			expect(step0.index_count).toBe(1);
			expect(step0.value_count).toBe(1);
			expect(step0.sum).toBe(10);
			expect(step0.average).toBe(10);
			expect(step0.interval).toEqual([10, 10]);
			expect(step0.total_sum).toBe(30);

			// Step 1: [10, null] -> index_count=2, value_count=1, average still 10
			const step1 = agg[1] as Record<string, unknown>;
			expect(step1.index_count).toBe(2);
			expect(step1.value_count).toBe(1);
			expect(step1.sum).toBe(10);
			expect(step1.average).toBe(10);

			// Step 3: [10, null, '', 20] -> index_count=4, value_count=2, sum=30, average=15
			const step3 = agg[3] as Record<string, unknown>;
			expect(step3.index_count).toBe(4);
			expect(step3.value_count).toBe(2);
			expect(step3.sum).toBe(30);
			expect(step3.average).toBe(15);
			expect(step3.interval).toEqual([10, 20]);
		});

		it('unrolls array values within a single row so value_count and average remain mathematically sound', () => {
			const rows = [{ scores: [10, 20, null, ''] }, { scores: 30 }];

			const agg = aggregateFilter(rows, 'scores');
			const step0 = agg[0] as Record<string, unknown>;
			expect(step0.index_count).toBe(1);
			expect(step0.value_count).toBe(2);
			expect(step0.sum).toBe(30);
			expect(step0.average).toBe(15);
			expect(step0.min).toBe(10);
			expect(step0.max).toBe(20);
			expect(step0.interval).toEqual([10, 20]);

			expect(agg.total_index_count).toBe(2);
			expect(agg.total_value_count).toBe(3);
			expect(agg.total_sum).toBe(60);
			expect(agg.total_average).toBe(20);
			expect(agg.total_min).toBe(10);
			expect(agg.total_max).toBe(30);
			expect(agg.total_interval).toEqual([10, 30]);
		});

		it('aggregates multiple attributes in a single pass, including temporal intervals and all-null attributes', () => {
			const rows = [
				{
					properties: {
						amount: 50,
						due: '2026-03-10',
						emptyAttr: null,
					},
				},
				{
					properties: {
						amount: 150,
						due: '2026-03-01..2026-03-05',
						emptyAttr: '',
					},
				},
			];

			const agg = aggregateFilter(
				rows,
				'properties.amount',
				'properties.due as due_date',
				'properties.emptyAttr as missing',
			);

			const amountTotals = agg.amount as Record<string, unknown>;
			expect(amountTotals.total_sum).toBe(200);
			expect(amountTotals.total_average).toBe(100);
			expect(amountTotals.total_interval).toEqual([50, 150]);

			const dueTotals = agg.due_date as Record<string, unknown>;
			expect(dueTotals.total_value_count).toBe(2);
			expect(dueTotals.total_sum).toBeNull();
			expect(dueTotals.total_average).toBeNull();
			expect(dueTotals.total_min).toBeInstanceOf(TemporalDrop);
			expect(String(dueTotals.total_min)).toBe('2026-03-01..2026-03-05');
			expect(String(dueTotals.total_max)).toBe('2026-03-10');
			expect(dueTotals.total_interval).toBeInstanceOf(TemporalDrop);
			expect(String(dueTotals.total_interval)).toBe('2026-03-01..2026-03-10');

			const missingTotals = agg.missing as Record<string, unknown>;
			expect(missingTotals).toEqual({
				total_index_count: 2,
				total_value_count: 0,
				total_sum: null,
				total_average: null,
				total_min: null,
				total_max: null,
				total_interval: null,
			});
		});

		it('folds multiple selectors targeting the same outputKey into a single accumulator and activates single-attribute shorthand', () => {
			const rows = [
				{ a: { amount: 10 }, b: { amount: [20, null] } },
				{ a: { amount: null }, b: { amount: 30 } },
			];

			const agg = aggregateFilter(rows, 'a.amount', 'b.amount');
			expect(agg).toHaveLength(2);
			expect(agg.total_index_count).toBe(2);
			expect(agg.total_value_count).toBe(3);
			expect(agg.total_sum).toBe(60);
			expect(agg.total_average).toBe(20);
			expect(agg.total_min).toBe(10);
			expect(agg.total_max).toBe(30);
			expect(agg.total_interval).toEqual([10, 30]);
			expect(agg.amount).toEqual({
				total_index_count: 2,
				total_value_count: 3,
				total_sum: 60,
				total_average: 20,
				total_min: 10,
				total_max: 30,
				total_interval: [10, 30],
			});

			const step0 = agg[0] as Record<string, unknown>;
			expect(step0.index_count).toBe(1);
			expect(step0.value_count).toBe(2);
			expect(step0.sum).toBe(30);
			expect(step0.average).toBe(15);
			expect(step0.interval).toEqual([10, 20]);

			const step1 = agg[1] as Record<string, unknown>;
			expect(step1.index_count).toBe(2);
			expect(step1.value_count).toBe(3);
			expect(step1.sum).toBe(60);
			expect(step1.average).toBe(20);
			expect(step1.interval).toEqual([10, 30]);
		});

		it('protects explicit attribute maps and row index counters from single-attribute shorthand key collisions', () => {
			const sumRows = [{ sum: 10 }, { sum: 20 }];
			const aggSum = aggregateFilter(sumRows, 'sum');
			expect(aggSum.total_index_count).toBe(2);
			expect(aggSum.total_value_count).toBe(2);
			expect(aggSum.total_sum).toBe(30);
			expect(aggSum.sum).toEqual({
				total_index_count: 2,
				total_value_count: 2,
				total_sum: 30,
				total_average: 15,
				total_min: 10,
				total_max: 20,
				total_interval: [10, 20],
			});
			const sumStep0 = aggSum[0] as Record<string, unknown>;
			expect(sumStep0.index_count).toBe(1);
			expect(sumStep0.value_count).toBe(1);
			expect(sumStep0.average).toBe(10);
			expect(sumStep0.sum).toEqual({
				index_count: 1,
				value_count: 1,
				sum: 10,
				average: 10,
				min: 10,
				max: 10,
				interval: [10, 10],
				total_index_count: 2,
				total_value_count: 2,
				total_sum: 30,
				total_average: 15,
				total_min: 10,
				total_max: 20,
				total_interval: [10, 20],
			});

			const idxRows = [{ index_count: 100 }, { index_count: 200 }];
			const aggIdx = aggregateFilter(idxRows, 'index_count');
			expect(aggIdx.total_index_count).toBe(2);
			expect(aggIdx.total_sum).toBe(300);
			expect(aggIdx.index_count).toEqual({
				total_index_count: 2,
				total_value_count: 2,
				total_sum: 300,
				total_average: 150,
				total_min: 100,
				total_max: 200,
				total_interval: [100, 200],
			});
			const idxStep0 = aggIdx[0] as Record<string, unknown>;
			const idxStep1 = aggIdx[1] as Record<string, unknown>;
			expect(idxStep0.index_count).toBe(1);
			expect(idxStep1.index_count).toBe(2);
			expect(idxStep0.sum).toBe(100);
			expect(idxStep1.sum).toBe(300);
		});

		it('caches and reuses numeric and TemporalDrop intervals across steps when bounds and grain do not change', () => {
			const rows = [
				{ amount: 10, due: '2026-03-01..2026-03-10' },
				{ amount: 50, due: '2026-03-20' },
				{ amount: 25, due: '2026-03-05' },
				{ amount: null, due: null },
			];

			const agg = aggregateFilter(rows, 'amount', 'due');
			const step1 = agg[1] as {
				amount: { interval: unknown };
				due: { interval: unknown };
			};
			const step2 = agg[2] as {
				amount: { interval: unknown };
				due: { interval: unknown };
			};
			const step3 = agg[3] as {
				amount: { interval: unknown };
				due: { interval: unknown };
			};

			// Steps 1, 2, and 3 all share the exact same [10, 50] tuple and TemporalDrop instance
			expect(step1.amount.interval).toBe(step2.amount.interval);
			expect(step2.amount.interval).toBe(step3.amount.interval);
			expect(step1.due.interval).toBe(step2.due.interval);
			expect(step2.due.interval).toBe(step3.due.interval);
		});
	});

	describe('percentage / percent filter', () => {
		it('computes (value / total) * 100 and returns null on zero total or vacuous/non-numeric inputs', () => {
			expect(percentageFilter(25, 200)).toBe(12.5);
			expect(percentageFilter('50', '200')).toBe(25);
			expect(percentageFilter(0, 100)).toBe(0);
			expect(percentageFilter(-0, 100)).toBe(0);
			expect(percentageFilter(10, 0)).toBeNull();
			expect(percentageFilter(null, 100)).toBeNull();
			expect(percentageFilter(10, null)).toBeNull();
			expect(percentageFilter('', 100)).toBeNull();
			expect(percentageFilter('abc', 100)).toBeNull();
		});
	});

	describe('End-to-end Liquid pipeline integration', () => {
		it('chains pick, prune, merge, agg, percent, and Liquid round in a Rhizome template', async () => {
			const runQueries = vi.fn(async () => ({
				orders: [
					{
						file: { basename: 'Order 1', size: 100 },
						tagLocations: [{ tag: 'order', line: 1 }],
						properties: { amount: 25, due: '2026-04-02' },
					},
					{
						file: { basename: 'Order 2', size: 200 },
						tagLocations: [{ tag: 'order', line: 1 }],
						properties: { amount: null, due: '2026-04-05' },
					},
					{
						file: { basename: 'Order 3', size: 300 },
						tagLocations: [{ tag: 'order', line: 1 }],
						properties: { amount: 75, due: '2026-04-01' },
					},
				],
			}));
			const explainQuery = vi.fn(async () => '');

			const template = [
				'{%- query orders -%}tag:order{%- endquery -%}',
				'{%- assign shaped = query.orders | prune: "tagLocations" | pick: "file.basename as title", "properties.amount", "properties.due" -%}',
				'{%- assign stats = shaped | agg: "amount as amount_agg", "due as due_agg" -%}',
				'{%- assign enriched = shaped | merge: stats -%}',
				'{%- assign direct_stats = query.orders | agg: "properties.amount" -%}',
				'{%- assign direct_enriched = query.orders | merge: direct_stats -%}',
				'TotalSum={{ stats.amount_agg.total_sum }}',
				'TotalAvg={{ stats.amount_agg.total_average }}',
				'TotalValCount={{ stats.amount_agg.total_value_count }}/{{ stats.total_index_count }}',
				'Span={{ stats.due_agg.total_interval }}',
				'DirectLastCum={{ direct_enriched[2].amount.sum }}',
				'{%- for row in enriched %}',
				'Row {{ row.index_count }} ({{ row.title }}): cum={{ row.amount_agg.sum | default: "N/A" }} share={{ row.amount_agg.sum | percent: row.amount_agg.total_sum | round: 1 | default: "N/A" }}%',
				'{%- endfor %}',
				'RoundTen={{ 34 | percent: 100 | round: -1 }}',
			].join('\n');

			const res = await renderRhizomeTemplate(template, {
				runQueries,
				explainQuery,
				runtimeContext: {
					timeZone: 'UTC',
					referenceTimeMs: Date.UTC(2026, 3, 1, 0, 0, 0),
				},
			});

			expect(res.ok).toBe(true);
			expect(res.diagnostics).toEqual([]);
			expect(res.markdown).toContain('TotalSum=100');
			expect(res.markdown).toContain('TotalAvg=50');
			expect(res.markdown).toContain('TotalValCount=2/3');
			expect(res.markdown).toContain('Span=2026-04-01..2026-04-05');
			expect(res.markdown).toContain('DirectLastCum=100');
			expect(res.markdown).toContain('Row 1 (Order 1): cum=25 share=25%');
			expect(res.markdown).toContain('Row 2 (Order 2): cum=25 share=25%');
			expect(res.markdown).toContain('Row 3 (Order 3): cum=100 share=100%');
			expect(res.markdown).toContain('RoundTen=30');
		});

		it('supports pick with filter pipelines, sibling item references, and copy-on-write deep target paths without mutating frozen inputs', () => {
			const frozenDoc = Object.freeze({
				file: Object.freeze({
					path: 'Projects/Alpha.md',
					basename: 'Alpha',
					stat: Object.freeze({ size: 2048 }),
				}),
				properties: Object.freeze({
					status: 'in_progress',
				}),
			});

			const picked = pickFilter(
				frozenDoc,
				"file.path | prepend: '[[' | append: '|' | append: file.basename | append: ']]' as link.wiki",
				'file.stat.size | divided_by: 1024 as meta.size.kb',
				'file',
				'properties.status | upcase as file.statusUpper',
			) as Record<string, unknown>;

			expect(picked).toEqual({
				link: { wiki: '[[Projects/Alpha.md|Alpha]]' },
				meta: { size: { kb: 2 } },
				file: {
					path: 'Projects/Alpha.md',
					basename: 'Alpha',
					stat: { size: 2048 },
					statusUpper: 'IN_PROGRESS',
				},
			});
			// Original frozen file object is untouched
			expect('statusUpper' in frozenDoc.file).toBe(false);

			// Merging into pre-existing array and vacuous keys on a cloned intermediate container
			const mergedCloned = pickFilter(
				{
					a: Object.freeze({ tags: Object.freeze(['t1']), empty: '' }),
					b: { tags: 't2', label: 'filled' },
				},
				'a',
				'b.tags as a.tags',
				'b.label as a.empty',
			);
			expect(mergedCloned).toEqual({
				a: {
					tags: ['t1', 't2'],
					empty: 'filled',
				},
			});
		});

		it('supports aggregate (agg) with inline filter pipelines on selectors', () => {
			const rows = [{ file: { stat: { size: 1024 } } }, { file: { stat: { size: 3072 } } }];

			const agg = aggregateFilter(rows, 'file.stat.size | divided_by: 1024 as kb');
			expect(agg.total_sum).toBe(4);
			expect(agg.total_average).toBe(2);
			expect(agg.kb).toEqual({
				total_index_count: 2,
				total_value_count: 2,
				total_sum: 4,
				total_average: 2,
				total_min: 1,
				total_max: 3,
				total_interval: [1, 3],
			});
		});

		it('sorts via sort and sort_natural with deep paths, compound keys, +1/-1 property names, NULLS LAST, and Intl.Collator natural folding', async () => {
			const items = [
				{
					id: 'null-row',
					properties: { status: null, '+1': 99 },
					file: { basename: 'Note 100' },
				},
				{
					id: 'empty-row',
					properties: { status: '', '+1': 50 },
					file: { basename: 'Note 50' },
				},
				{
					id: 'b-high',
					properties: { status: 'open', '+1': 20 },
					file: { basename: 'Note 10' },
				},
				{
					id: 'a-low',
					properties: { status: 'open', '+1': 5 },
					file: { basename: 'Note 2' },
				},
				{
					id: 'c-done',
					properties: { status: 'done', '+1': 1 },
					file: { basename: 'Note 1' },
				},
			];

			// Compound sort with literal `+1` property segment and NULLS LAST in both asc and desc
			const sortedAsc = sortFilter(
				items,
				'properties.status asc, properties.+1 desc',
			) as typeof items;
			expect(sortedAsc.map((x) => x.id)).toEqual([
				'c-done',
				'b-high',
				'a-low',
				'null-row',
				'empty-row',
			]);

			const sortedDesc = sortFilter(
				items,
				['properties.status', 'desc'],
				'file.basename asc',
			) as typeof items;
			// Non-vacuous 'open' then 'done', followed by vacuous rows at the end (NULLS LAST)
			expect(sortedDesc.map((x) => x.id)).toEqual([
				'b-high',
				'a-low',
				'c-done',
				'null-row',
				'empty-row',
			]);

			// Natural sort: numeric ordering ("Note 2" before "Note 10"), diacritic/ligature folding, and tie-breaking
			const naturalNotes = sortNaturalFilter(items, 'file.basename asc') as typeof items;
			expect(naturalNotes.map((x) => x.file.basename)).toEqual([
				'Note 1',
				'Note 2',
				'Note 10',
				'Note 50',
				'Note 100',
			]);

			const diacriticItems = [
				{ word: 'Fable', rank: 1 },
				{ word: 'Éclair', rank: 2 },
				{ word: 'eclair', rank: 1 },
				{ word: 'Straße', rank: 2 },
				{ word: 'Strasse', rank: 1 },
				{ word: 'Łódź', rank: 2 },
				{ word: 'Lodz', rank: 1 },
				{ word: 'Øresund', rank: 2 },
				{ word: 'Oresund', rank: 1 },
			];
			const naturalDiacritics = sortNaturalFilter(
				diacriticItems,
				'word',
				'rank',
			) as typeof diacriticItems;
			expect(naturalDiacritics.map((x) => `${x.word}:${x.rank}`)).toEqual([
				'eclair:1',
				'Éclair:2',
				'Fable:1',
				'Lodz:1',
				'Łódź:2',
				'Oresund:1',
				'Øresund:2',
				'Strasse:1',
				'Straße:2',
			]);

			// Code-point tie-breaker when collator returns 0 on single-key sort_natural
			expect(sortNaturalFilter(['alpha', 'Alpha'])).toEqual(['Alpha', 'alpha']);

			// Verify language context propagation in template engine for sort_natural
			const tplRes = await renderRhizomeTemplate(
				'{%- query words -%}tag:word{%- endquery -%}{{ query.words | map: "w" | sort_natural | join: "," }}',
				{
					runQueries: async () => ({
						words: [{ w: 'Note 10' }, { w: 'Note 2' }, { w: 'Éclair' }],
					}),
					explainQuery: async () => '',
					runtimeContext: { language: 'en' },
				},
			);
			expect(tplRes.ok).toBe(true);
			expect(tplRes.markdown).toBe('Éclair,Note 2,Note 10');
		});

		it('groups hierarchically via group_by (Option B) with grain-partitioned temporal widening subsumption and null bucket last', () => {
			// 1. Hierarchical multi-key grouping + vacuous bucket placed last
			const docs = [
				{ properties: { folder: 'Work', status: 'open' }, title: 'W1' },
				{ properties: { folder: null, status: 'open' }, title: 'Unfiled' },
				{ properties: { folder: 'Work', status: 'done' }, title: 'W2' },
				{ properties: { folder: 'Work', status: 'open' }, title: 'W3' },
			];

			const nestedGroups = groupByFilter(docs, 'properties.folder, properties.status');
			expect(nestedGroups).toHaveLength(2);
			expect(nestedGroups[0]?.name).toBe('Work');
			expect(nestedGroups[0]?.size).toBe(3);
			expect(nestedGroups[0]?.groups).toHaveLength(2);
			expect(nestedGroups[0]?.groups?.[0]?.name).toBe('open');
			expect(
				nestedGroups[0]?.groups?.[0]?.items.map(
					(x: unknown) => (x as { title: string }).title,
				),
			).toEqual(['W1', 'W3']);
			expect(nestedGroups[0]?.groups?.[1]?.name).toBe('done');
			expect(nestedGroups[1]?.name).toBeNull();
			expect(nestedGroups[1]?.size).toBe(1);

			// 2. Temporal grain partitioning (2026 year grain does not swallow 2026-10-01 day grain)
			//    and arrival-order-independent widening subsumption ([Oct 1, Oct 15, Oct 1..Oct 31])
			const temporalDocs = [
				{ id: 'oct-1', due: '2026-10-01' },
				{ id: 'year-2026', due: '2026' },
				{ id: 'oct-15', due: '2026-10-15' },
				{ id: 'oct-range', due: '2026-10-01..2026-10-31' },
			];

			const tempGroups = groupByFilter(temporalDocs, 'due');
			expect(tempGroups).toHaveLength(2);
			expect(String(tempGroups[0]?.name)).toBe('2026-10-01..2026-10-31');
			expect(tempGroups[0]?.size).toBe(3);
			expect(tempGroups[0]?.items.map((x: unknown) => (x as { id: string }).id)).toEqual([
				'oct-1',
				'oct-15',
				'oct-range',
			]);
			expect(String(tempGroups[1]?.name)).toBe('2026');
			expect(tempGroups[1]?.size).toBe(1);

			// 3. Timezone-aware UTC comparison for group_by and uniq (explicit offsets + naïve dates in local/context timezone)
			const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
			const localNaive = '2026-10-15T08:00';
			// Compute the exact UTC ISO string corresponding to `localNaive` in the system's local timezone
			const localDrop = groupByFilter([{ ts: localNaive }], 'ts')[0]?.name as TemporalDrop;
			const utcIsoMinute = new Date(localDrop.start).toISOString().slice(0, 16) + 'Z';
			const tzMixedDocs = [
				{ id: 'naive-local', ts: localNaive },
				{ id: 'explicit-utc', ts: utcIsoMinute },
			];
			const tzGroups = groupByFilter(tzMixedDocs, 'ts');
			expect(tzGroups).toHaveLength(1);
			expect(tzGroups[0]?.name).toBeInstanceOf(TemporalDrop);
			expect((tzGroups[0]?.name as TemporalDrop).timeZone).toBe(sysTz);
			expect(tzGroups[0]?.items.map((x: unknown) => (x as { id: string }).id)).toEqual([
				'naive-local',
				'explicit-utc',
			]);
			expect(uniqFilter(tzMixedDocs, 'ts')).toHaveLength(1);

			// 4. Minute-grain range string preserves 'minute' grain and subsumes covered minute timestamps
			const minuteDocs = [
				{ id: 'm1', at: '2026-10-15T09:00' },
				{ id: 'm2', at: '2026-10-15T08:00..2026-10-15T10:00' },
			];
			const minuteGroups = groupByFilter(minuteDocs, 'at');
			expect(minuteGroups).toHaveLength(1);
			expect(String(minuteGroups[0]?.name)).toBe('2026-10-15T08:00..2026-10-15T10:00');
		});

		it('compares explicit-offset and naïve timestamps in UTC using runtimeContext.timeZone in templates', async () => {
			// In America/New_York on 2026-10-15 (EDT, UTC-4):
			// - Naïve "2026-10-15T08:00" == 2026-10-15T12:00Z
			// - Explicit "2026-10-15T14:00+02:00" == 2026-10-15T12:00Z
			const res = await renderRhizomeTemplate(
				[
					'{%- query events -%}tag:event{%- endquery -%}',
					'{%- assign grouped = query.events | group_by: "properties.at" -%}',
					'GroupCount={{ grouped.size }}|GroupIds={{ grouped[0].items | map: "id" | join: "," }}|UniqCount={{ query.events | uniq: "properties.at" | size }}',
				].join('\n'),
				{
					runQueries: async () => ({
						events: [
							{ id: 'ny-naive', properties: { at: '2026-10-15T08:00' } },
							{ id: 'berlin-offset', properties: { at: '2026-10-15T14:00+02:00' } },
							{ id: 'utc-z', properties: { at: '2026-10-15T12:00Z' } },
						],
					}),
					explainQuery: async () => '',
					runtimeContext: {
						timeZone: 'America/New_York',
						referenceTimeMs: Date.UTC(2026, 9, 15, 12, 0, 0),
					},
				},
			);

			expect(res.ok).toBe(true);
			expect(res.markdown).toBe(
				'GroupCount=1|GroupIds=ny-naive,berlin-offset,utc-z|UniqCount=1',
			);
		});

		it('supports deep-dotted and filter-pipeline selectors in where, reject, find, find_index, has, map, uniq, and sum, and removes *_exp filters', () => {
			const notes = [
				{
					file: { basename: 'Alpha', size: 100 },
					tags: ['project', 'active'],
					properties: { status: 'Open', due: '2026-10-15' },
				},
				{
					file: { basename: 'Beta', size: 300 },
					tags: ['archive'],
					properties: { status: 'Done', due: '2026-11-05' },
				},
				{
					file: { basename: 'Gamma', size: 200 },
					tags: [],
					properties: { status: 'open', due: null },
				},
			];

			expect(
				whereFilter(notes, 'properties.status | downcase', 'open').map(
					(n: unknown) => (n as { file: { basename: string } }).file.basename,
				),
			).toEqual(['Alpha', 'Gamma']);

			// Array membership in where & temporal range matching
			expect(whereFilter(notes, 'tags', 'active')).toHaveLength(1);
			expect(whereFilter(notes, 'properties.due', '2026-10-01..2026-10-31')).toHaveLength(1);
			// 1-arg truthiness/non-vacuous where & nil matching
			expect(whereFilter(notes, 'tags')).toHaveLength(2);
			expect(whereFilter(notes, 'properties.due', null)).toHaveLength(1);

			expect(
				rejectFilter(notes, 'properties.status | downcase', 'open').map(
					(n: unknown) => (n as { file: { basename: string } }).file.basename,
				),
			).toEqual(['Beta']);

			expect(
				(
					findFilter(notes, 'file.size | divided_by: 100', 3) as {
						file: { basename: string };
					}
				)?.file.basename,
			).toBe('Beta');
			expect(findIndexFilter(notes, 'file.size | divided_by: 100', 3)).toBe(1);
			expect(hasFilter(notes, 'file.basename | downcase', 'gamma')).toBe(true);
			expect(hasFilter(notes, 'file.basename | downcase', 'delta')).toBe(false);

			expect(mapFilter(notes, 'file.basename | upcase')).toEqual(['ALPHA', 'BETA', 'GAMMA']);
			expect(
				uniqFilter(notes, 'properties.status | downcase').map(
					(n: unknown) => (n as { file: { basename: string } }).file.basename,
				),
			).toEqual(['Alpha', 'Beta']);
			expect(sumFilter(notes, 'file.size | divided_by: 100')).toBe(6);
			expect(uniqFilter(notes, '')).toEqual([]);
			expect(uniqFilter(notes, '__proto__')).toEqual([]);
			expect(sumFilter([10, 20], '')).toBe(0);
			expect(sumFilter([10, 20], '__proto__')).toBe(0);
			// Own-property check prevents reading inherited Object.prototype methods like toString/valueOf
			expect(mapFilter([{ a: 1 }], 'toString')).toEqual([null]);
			expect(pickFilter({ a: 1 }, 'valueOf')).toEqual({ valueOf: null });
			// Self-item selectors (`.` and `this`) with filter pipelines and multi-arg piped filters in sort
			expect(mapFilter(['Alpha', 'Beta'], '. | downcase')).toEqual(['alpha', 'beta']);
			expect(sortFilter(['b_item', 'a_item'], 'this | slice: 0, 1 | upcase desc')).toEqual([
				'b_item',
				'a_item',
			]);

			// Verify *_exp filters are unregistered from createRhizomeLiquidInstance
			const liquid = createRhizomeLiquidInstance(createQueryTagEnvironment());
			for (const removed of [
				'group_by_exp',
				'where_exp',
				'reject_exp',
				'find_exp',
				'find_index_exp',
				'has_exp',
			]) {
				expect(liquid.filters[removed]).toBeUndefined();
			}
		});
	});
});
