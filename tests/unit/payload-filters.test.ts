import { describe, expect, it, vi } from 'vitest';
import {
	aggregateFilter,
	mergeFilter,
	percentageFilter,
	pickFilter,
	pruneFilter,
	renderRhizomeTemplate,
	TemporalDrop,
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
	});
});
