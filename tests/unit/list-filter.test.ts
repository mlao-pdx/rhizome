import { describe, expect, it } from 'vitest';
import {
	groupByFilter,
	isGroupByBucket,
	listFilter,
	parseListArguments,
	renderRhizomeTemplate,
	sentenceFilter,
	TemporalDrop,
} from '../../src/core/templates';

describe('Liquid list and sentence (array_to_sentence_string) filters', () => {
	describe('sentenceFilter / array_to_sentence_string', () => {
		it('formats 1D scalar arrays with locale-aware Intl.ListFormat conjunction and filters vacuous items', () => {
			expect(sentenceFilter(['alpha', 'beta', 'gamma'])).toBe('alpha, beta, and gamma');
			expect(sentenceFilter(['alpha', null, '', undefined, 'beta'])).toBe('alpha and beta');
			expect(sentenceFilter(['solo'])).toBe('solo');
			expect(sentenceFilter('scalar')).toBe('scalar');
			expect(sentenceFilter(42)).toBe('42');
			expect(sentenceFilter(true)).toBe('true');

			const drop = new TemporalDrop({
				start: Date.UTC(2026, 9, 15, 0, 0, 0, 0),
				end: Date.UTC(2026, 9, 16, 0, 0, 0, 0),
				grain: 'day',
				isRange: false,
				timeZone: 'UTC',
				referenceTimeMs: Date.UTC(2026, 9, 15, 0, 0, 0, 0),
				raw: '2026-10-15',
			});
			expect(sentenceFilter([drop, '2026-10-20'])).toBe('2026-10-15 and 2026-10-20');
		});

		it('returns empty string for vacuous inputs and arrays of only vacuous elements', () => {
			expect(sentenceFilter(null)).toBe('');
			expect(sentenceFilter(undefined)).toBe('');
			expect(sentenceFilter('')).toBe('');
			expect(sentenceFilter([])).toBe('');
			expect(sentenceFilter([null, undefined, '', [], {}])).toBe('');
			expect(sentenceFilter({})).toBe('');
		});

		it('ellipsizes plain objects and nested arrays inside sentence items', () => {
			expect(
				sentenceFilter([
					'alpha',
					{ path: 'Notes/A.md', size: 120 },
					{ onlyNested: { a: 1 } },
					['nested', 'array'],
				]),
			).toBe('alpha, {path: Notes/A.md, ..., size: 120}, {...}, and {...}');
		});

		it('supports custom connector string overrides for 1, 2, and 3+ items', () => {
			expect(sentenceFilter(['alpha'], 'or')).toBe('alpha');
			expect(sentenceFilter(['alpha', 'beta'], 'or')).toBe('alpha or beta');
			expect(sentenceFilter(['alpha', 'beta', 'gamma'], 'or')).toBe('alpha, beta, or gamma');
			expect(sentenceFilter(['alpha', 'beta', 'gamma'], 'und')).toBe(
				'alpha, beta, und gamma',
			);
		});

		it('respects runtimeContext.language for both sentence and array_to_sentence_string in Liquid templates', async () => {
			const deResult = await renderRhizomeTemplate(
				[
					'{%- assign tags = "scifi, classic, desert" | split: ", " -%}',
					'{{ tags | sentence }} / {{ tags | array_to_sentence_string }} / {{ tags | array_to_sentence_string: "oder" }}',
				].join('\n'),
				{
					runQueries: async () => ({}),
					explainQuery: async () => '',
					runtimeContext: { language: 'de' },
				},
			);

			expect(deResult.ok).toBe(true);
			expect(deResult.markdown).toBe(
				'scifi, classic und desert / scifi, classic und desert / scifi, classic, oder desert',
			);

			const frResult = await renderRhizomeTemplate(
				'{%- assign tags = "un, deux, trois" | split: ", " -%}{{ tags | sentence }}',
				{
					runQueries: async () => ({}),
					explainQuery: async () => '',
					runtimeContext: { language: 'fr' },
				},
			);
			expect(frResult.ok).toBe(true);
			expect(frResult.markdown).toBe('un, deux et trois');
		});
	});

	describe('parseListArguments and isGroupByBucket', () => {
		it('parses default styles, trailing "...", explicit depth sequences, and leaf selectors', () => {
			// Default: 6 levels of '-'
			const def = parseListArguments([]);
			expect(def.styles).toEqual(['-', '-', '-', '-', '-', '-']);
			expect(def.selectors).toEqual([]);

			// Trailing "..." with "1."
			const orderedAll = parseListArguments(['1., ...']);
			expect(orderedAll.styles).toEqual(['1.', '1.', '1.', '1.', '1.', '1.']);

			// Mixed "1., -, ..." + selectors
			const mixed = parseListArguments([
				'1., -, ...',
				'file.basename, properties.author as Author',
			]);
			expect(mixed.styles).toEqual(['1.', '-', '-', '-', '-', '-']);
			expect(mixed.selectors).toHaveLength(2);
			expect(mixed.selectors[0]?.outputKey).toBe('basename');
			expect(mixed.selectors[1]?.outputKey).toBe('Author');

			// Explicit finite depth without "..."
			const finite = parseListArguments(['1.', '-']);
			expect(finite.styles).toEqual(['1.', '-']);

			// Explicit depth > 6
			const deep7 = parseListArguments(['-', '1.', '-', '1.', '-', '1.', '-']);
			expect(deep7.styles).toHaveLength(7);

			// Named 2-tuple selector alongside style array
			const tupleAndArray = parseListArguments([
				['1.', '-'],
				['Author', 'properties.author'],
			]);
			expect(tupleAndArray.styles).toEqual(['1.', '-']);
			expect(tupleAndArray.selectors).toHaveLength(1);
			expect(tupleAndArray.selectors[0]?.outputKey).toBe('Author');
		});

		it('identifies valid GroupByBucket records and rejects non-bucket objects', () => {
			expect(isGroupByBucket({ name: 'scifi', items: [{ a: 1 }], size: 1 })).toBe(true);
			expect(
				isGroupByBucket({
					name: null,
					items: [],
					size: 0,
					groups: [{ name: 'sub', items: [], size: 0 }],
				}),
			).toBe(true);

			// Extra unrelated keys or missing required properties are rejected
			expect(isGroupByBucket({ name: 'scifi', items: [], size: 0, extra: true })).toBe(false);
			expect(isGroupByBucket({ name: 'scifi', items: 'not-array', size: 0 })).toBe(false);
			expect(isGroupByBucket({ name: 'scifi', items: [] })).toBe(false);
			expect(isGroupByBucket(null)).toBe(false);
			expect(isGroupByBucket(['name', 'items', 'size'])).toBe(false);
		});
	});

	describe('listFilter on scalars, 1D arrays, multi-line strings, and vacuous inputs', () => {
		it('renders 1D scalar arrays, TemporalDrop items, and numbered lists while skipping vacuous items', () => {
			const drop = new TemporalDrop({
				start: Date.UTC(2026, 9, 15, 0, 0, 0, 0),
				end: Date.UTC(2026, 9, 16, 0, 0, 0, 0),
				grain: 'day',
				isRange: false,
				timeZone: 'UTC',
				referenceTimeMs: Date.UTC(2026, 9, 15, 0, 0, 0, 0),
				raw: '2026-10-15',
			});

			expect(listFilter(['Alpha', null, '', undefined, 42, false, drop])).toBe(
				['- Alpha', '- 42', '- false', '- 2026-10-15'].join('\n'),
			);

			expect(listFilter(['First', null, 'Second', 'Third'], '1.')).toBe(
				['1. First', '2. Second', '3. Third'].join('\n'),
			);
		});

		it('returns empty string for vacuous inputs and ignores FORBIDDEN_KEYS', () => {
			expect(listFilter(null)).toBe('');
			expect(listFilter(undefined)).toBe('');
			expect(listFilter('')).toBe('');
			expect(listFilter([])).toBe('');
			expect(listFilter([null, undefined, '', [], {}])).toBe('');
			expect(listFilter({})).toBe('');

			const polluted = JSON.parse('{"__proto__": {"bad": 1}, "Title": "Clean"}') as Record<
				string,
				unknown
			>;
			expect(listFilter(polluted)).toBe('- Title: Clean');
		});

		it('normalizes line breaks and indents continuation lines to match bullet depth', () => {
			const items = ['Line 1\nLine 2\r\nLine 3\rLine 4', 'Single line'];
			expect(listFilter(items)).toBe(
				['- Line 1', '  Line 2', '  Line 3', '  Line 4', '- Single line'].join('\n'),
			);

			const nested = {
				Section: {
					Note: 'First line\nSecond line',
				},
			};
			expect(listFilter(nested)).toBe(
				['- Section', '  - Note: First line', '    Second line'].join('\n'),
			);
		});
	});

	describe('listFilter on plain objects and object arrays with leaf selectors and horizon collapsing', () => {
		const books = [
			{
				file: { path: 'Books/Dune.md', basename: 'Dune', size: 420 },
				tags: ['scifi', 'classic', 'desert'],
				properties: {
					author: 'Frank Herbert',
					rating: 5,
					published: '1965-08-01',
				},
			},
			{
				file: { path: 'Books/Neuromancer.md', basename: 'Neuromancer', size: 310 },
				tags: ['scifi', 'cyberpunk'],
				properties: {
					author: 'William Gibson',
					rating: 4.5,
					published: '1984-07-01',
				},
			},
		];

		it('renders 1-key projected objects directly as headline bullets and increments ordered indices for nested 1-key values', () => {
			expect(listFilter(books, 'file.basename')).toBe(['- Dune', '- Neuromancer'].join('\n'));
			expect(listFilter(books, '1.', 'file.basename')).toBe(
				['1. Dune', '2. Neuromancer'].join('\n'),
			);
			expect(listFilter(books, '1., -', 'tags')).toBe(
				[
					'1. tags',
					'  - scifi',
					'  - classic',
					'  - desert',
					'2. tags',
					'  - scifi',
					'  - cyberpunk',
				].join('\n'),
			);
			expect(listFilter({ outer: { inner: { empty: null } }, valid: 'ok' })).toBe(
				'- valid: ok',
			);
		});

		it('renders 2+-key projected objects with 1st key as headline and remaining keys at depth + 1', () => {
			// Default depth (N = 6): remaining keys expand as child bullets at depth 2
			expect(
				listFilter(
					books,
					'file.basename, properties.author as Author, properties.rating as Rating',
				),
			).toBe(
				[
					'- Dune',
					'  - Author: Frank Herbert',
					'  - Rating: 5',
					'- Neuromancer',
					'  - Author: William Gibson',
					'  - Rating: 4.5',
				].join('\n'),
			);

			// Depth N = 1 ("1."): remaining keys hit horizon at depth 2 and collapse into a single "- " bullet
			expect(
				listFilter(
					books,
					'1.',
					'file.basename, properties.author as Author, properties.rating as Rating',
				),
			).toBe(
				[
					'1. Dune',
					'  - Author: Frank Herbert and Rating: 5',
					'2. Neuromancer',
					'  - Author: William Gibson and Rating: 4.5',
				].join('\n'),
			);

			expect(
				listFilter(
					books,
					'1.',
					'file.basename, properties.author as Author, properties.rating as Rating, properties.published as Published',
				),
			).toBe(
				[
					'1. Dune',
					'  - Author: Frank Herbert, Rating: 5, and Published: 1965-08-01',
					'2. Neuromancer',
					'  - Author: William Gibson, Rating: 4.5, and Published: 1984-07-01',
				].join('\n'),
			);
		});

		it('renders a single root plain object with key: value pairs and nested arrays/objects', () => {
			const rootObj = {
				Author: 'Frank Herbert',
				Year: 1965,
				Tags: ['scifi', 'classic'],
				Empty: null,
			};

			// Default N = 6 expands Tags at depth 2
			expect(listFilter(rootObj)).toBe(
				[
					'- Author: Frank Herbert',
					'- Year: 1965',
					'- Tags',
					'  - scifi',
					'  - classic',
				].join('\n'),
			);

			// N = 1 ("1.") collapses Tags into a single horizon bullet at depth 2
			expect(listFilter(rootObj, '1.')).toBe(
				[
					'1. Author: Frank Herbert',
					'2. Year: 1965',
					'3. Tags',
					'  - scifi and classic',
				].join('\n'),
			);
		});
	});

	describe('listFilter with group_by buckets and (size) vs (size+) horizon badges', () => {
		const tasks = [
			{
				file: { basename: 'Task A' },
				properties: { status: 'open', priority: 'high', owner: 'Alice' },
			},
			{
				file: { basename: 'Task B' },
				properties: { status: 'open', priority: 'low', owner: 'Bob' },
			},
			{
				file: { basename: 'Task C' },
				properties: { status: null, priority: 'high', owner: 'Carol' },
			},
		];

		it('renders 1-level group_by with (size) when not truncated and (size+) when truncated at the horizon', () => {
			const grouped = groupByFilter(tasks, 'properties.status');

			// Default depth (N = 6) with 1 selector: items render at depth 2 without hitting horizon -> (size)
			expect(listFilter(grouped, 'file.basename')).toBe(
				['- open (2)', '  - Task A', '  - Task B', '- (1)', '  - Task C'].join('\n'),
			);

			// Depth N = 1 ("1."): bucket is at depth 1, items collapse at horizon depth 2 -> (size+)
			expect(listFilter(grouped, '1.', 'file.basename')).toBe(
				['1. open (2+)', '  - Task A and Task B', '2. (1+)', '  - Task C'].join('\n'),
			);
		});

		it('renders multi-level group_by trees and propagates (size+) when any descendant hits the horizon', () => {
			const multiGrouped = groupByFilter(tasks, 'properties.status, properties.priority');

			// Default depth (N = 6) with 1 selector: depth 1 status, depth 2 priority, depth 3 item -> no horizon hit
			expect(listFilter(multiGrouped, '1., -, ...', 'file.basename')).toBe(
				[
					'1. open (2)',
					'  - high (1)',
					'    - Task A',
					'  - low (1)',
					'    - Task B',
					'2. (1)',
					'  - high (1)',
					'    - Task C',
				].join('\n'),
			);

			// Depth N = 2 ("1., -"): depth 1 status, depth 2 priority, items collapse at depth 3 (horizon) -> (size+) on both levels
			expect(listFilter(multiGrouped, '1., -', 'file.basename')).toBe(
				[
					'1. open (2+)',
					'  - high (1+)',
					'    - Task A',
					'  - low (1+)',
					'    - Task B',
					'2. (1+)',
					'  - high (1+)',
					'    - Task C',
				].join('\n'),
			);

			// Depth N = 1 ("1."): depth 1 status, child priority groups collapse at depth 2 (horizon) -> (size+)
			expect(listFilter(multiGrouped, '1.', 'file.basename')).toBe(
				['1. open (2+)', '  - high (1+) and low (1+)', '2. (1+)', '  - high (1+)'].join(
					'\n',
				),
			);
		});

		it('integrates end-to-end with group_by and runtimeContext.language in renderRhizomeTemplate', async () => {
			const rendered = await renderRhizomeTemplate(
				[
					'{%- query tasks -%}tag:task{%- endquery -%}',
					'{{ query.tasks | group_by: "properties.status" | list: "1.", "file.basename" }}',
				].join('\n'),
				{
					runQueries: async () => ({ tasks }),
					explainQuery: async () => '',
					runtimeContext: { language: 'de' },
				},
			);

			expect(rendered.ok).toBe(true);
			expect(rendered.markdown).toBe(
				['1. open (2+)', '  - Task A und Task B', '2. (1+)', '  - Task C'].join('\n'),
			);
		});
	});
});
