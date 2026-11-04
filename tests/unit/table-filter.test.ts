import { describe, expect, it } from 'vitest';
import {
	escapeTableCell,
	formatTableCellValue,
	parseTableAlignments,
	pickFilter,
	renderRhizomeTemplate,
	TemporalDrop,
	tableFilter,
} from '../../src/core/templates';

describe('Liquid table filter (tableFilter, parseTableAlignments, formatTableCellValue, escapeTableCell)', () => {
	describe('input shapes and root-column discovery', () => {
		it('renders an array of plain objects using root keys in first-seen order and preserves key casing/whitespace', () => {
			const row1 = Object.create(null) as Record<string, unknown>;
			row1['Book Title'] = 'Dune';
			row1.Author = 'Frank Herbert';

			const row2 = {
				Author: 'Ursula K. Le Guin',
				'Book Title': 'The Left Hand of Darkness',
				'Publication Year': 1969,
			};

			const out = tableFilter([row1, row2]);
			expect(out).toBe(
				[
					'| Book Title | Author | Publication Year |',
					'| :--- | :--- | :--- |',
					'| Dune | Frank Herbert |  |',
					'| The Left Hand of Darkness | Ursula K. Le Guin | 1969 |',
				].join('\n'),
			);
		});

		it('renders a single plain object as a 1-row table', () => {
			const single = { Name: 'Rhizome', Active: true, Version: 1 };
			expect(tableFilter(single)).toBe(
				[
					'| Name | Active | Version |',
					'| :--- | :--- | :--- |',
					'| Rhizome | true | 1 |',
				].join('\n'),
			);
		});

		it('returns an empty string for vacuous, non-object, or column-less inputs', () => {
			expect(tableFilter(null)).toBe('');
			expect(tableFilter(undefined)).toBe('');
			expect(tableFilter('')).toBe('');
			expect(tableFilter(42)).toBe('');
			expect(tableFilter([])).toBe('');
			expect(tableFilter({})).toBe('');
			expect(tableFilter([null, undefined, 'not-an-object', 123, []])).toBe('');
			expect(tableFilter([{}, {}])).toBe('');
		});

		it('ignores FORBIDDEN_KEYS and inherited Object.prototype properties on rows', () => {
			const row = JSON.parse('{"__proto__": {"polluted": 1}, "Title": "Safe"}') as Record<
				string,
				unknown
			>;
			expect(tableFilter(row)).toBe(['| Title |', '| :--- |', '| Safe |'].join('\n'));
		});
	});

	describe('exception-based alignment arguments (parseTableAlignments)', () => {
		it('parses <, ^, >, bare column names, comma-separated lists, and array arguments with last-wins precedence', () => {
			const map = parseTableAlignments([
				'<Title',
				'^Status, >Rating',
				['Count', '>Count'],
				'>',
				'<',
				'^',
				'',
				'__proto__',
			]);

			expect(map.get('Title')).toBe('left');
			expect(map.get('Status')).toBe('center');
			expect(map.get('Rating')).toBe('right');
			expect(map.get('Count')).toBe('right');
			expect(map.has('')).toBe(false);
			expect(map.has('__proto__')).toBe(false);
		});

		it('applies alignments to matching columns, defaults unmentioned columns to left, and ignores unknown columns', () => {
			const rows = [{ Title: 'Alpha', Status: 'Open', Rating: 5, Notes: 'Ready' }];
			const out = tableFilter(rows, '>Rating, ^Status', '<Title', '>NonExistentColumn');
			expect(out).toBe(
				[
					'| Title | Status | Rating | Notes |',
					'| :--- | :---: | ---: | :--- |',
					'| Alpha | Open | 5 | Ready |',
				].join('\n'),
			);
		});
	});

	describe('cell value formatting (formatTableCellValue)', () => {
		it('renders scalars verbatim without coercing ISO date strings and handles TemporalDrop, -0, and booleans', () => {
			expect(formatTableCellValue('2026-10-15')).toBe('2026-10-15');
			expect(formatTableCellValue(0)).toBe('0');
			expect(formatTableCellValue(-0)).toBe('0');
			expect(formatTableCellValue(42.5)).toBe('42.5');
			expect(formatTableCellValue(Number.NaN)).toBe('');
			expect(formatTableCellValue(Number.POSITIVE_INFINITY)).toBe('');
			expect(formatTableCellValue(true)).toBe('true');
			expect(formatTableCellValue(false)).toBe('false');

			const drop = new TemporalDrop({
				start: Date.UTC(2026, 9, 15, 0, 0, 0, 0),
				end: Date.UTC(2026, 9, 16, 0, 0, 0, 0),
				grain: 'day',
				isRange: false,
				timeZone: 'UTC',
				referenceTimeMs: Date.UTC(2026, 9, 15, 0, 0, 0, 0),
				raw: '2026-10-15',
			});
			expect(formatTableCellValue(drop)).toBe('2026-10-15');
		});

		it('renders vacuous values as empty string', () => {
			expect(formatTableCellValue(null)).toBe('');
			expect(formatTableCellValue(undefined)).toBe('');
			expect(formatTableCellValue('')).toBe('');
			expect(formatTableCellValue([])).toBe('');
			expect(formatTableCellValue([null, undefined, '', [], {}])).toBe('');
			expect(formatTableCellValue({})).toBe('');
		});

		it('renders non-empty plain objects as single-line ellipsized summaries based on non-vacuous scalar count', () => {
			// 0 scalar properties (only nested objects/arrays or vacuous properties)
			expect(formatTableCellValue({ nested: { a: 1 }, tags: ['x'] })).toBe('{...}');
			expect(formatTableCellValue({ empty: '', nil: null })).toBe('{...}');

			// 1 scalar property
			expect(formatTableCellValue({ path: 'Notes/A.md', nested: { a: 1 } })).toBe(
				'{path: Notes/A.md, ...}',
			);

			// 2 scalar properties
			expect(formatTableCellValue({ path: 'Notes/A.md', size: 120 })).toBe(
				'{path: Notes/A.md, ..., size: 120}',
			);

			// 3+ scalar properties (shows first and last in key order)
			expect(
				formatTableCellValue({
					path: 'Notes/A.md',
					basename: 'A',
					extension: 'md',
					size: 120,
				}),
			).toBe('{path: Notes/A.md, ..., size: 120}');
		});

		it('formats 1D arrays with locale-aware Intl.ListFormat conjunction and ellipsizes nested arrays/objects', () => {
			expect(formatTableCellValue(['alpha', 'beta', 'gamma'], 'en')).toBe(
				'alpha, beta, and gamma',
			);
			expect(formatTableCellValue(['alpha', 'beta', 'gamma'], 'de')).toBe(
				'alpha, beta und gamma',
			);
			expect(formatTableCellValue(['alpha', 'beta', 'gamma'], 'fr')).toBe(
				'alpha, beta et gamma',
			);
			// Invalid locale falls back to 'en'
			expect(formatTableCellValue(['alpha', 'beta'], 'invalid_locale_tag_$$$')).toBe(
				'alpha and beta',
			);

			// Filters out vacuous elements and ellipsizes complex elements
			expect(
				formatTableCellValue(
					['solo', null, '', { id: 1, label: 'one', extra: true }, ['nested', 'array']],
					'en',
				),
			).toBe('solo, {id: 1, ..., extra: true}, and {...}');
		});
	});

	describe('Markdown table escaping (escapeTableCell) and end-to-end template rendering', () => {
		it('normalizes line breaks to <br> and escapes pipes (including wikilinks and pre-escaped pipes) without double-escaping', () => {
			expect(escapeTableCell('[[Folder/Note|Display Alias]]')).toBe(
				'[[Folder/Note\\|Display Alias]]',
			);
			expect(escapeTableCell('Already \\| escaped | and raw')).toBe(
				'Already \\| escaped \\| and raw',
			);
			expect(escapeTableCell('Even slashes \\\\| and odd \\\\\\| pipes')).toBe(
				'Even slashes \\\\\\| and odd \\\\\\| pipes',
			);
			expect(escapeTableCell('Line 1\nLine 2\r\nLine 3\rLine 4')).toBe(
				'Line 1<br>Line 2<br>Line 3<br>Line 4',
			);

			const weirdRow = {
				'Col | 1\nSub': '[[Note|Alias]]\nNext line',
			};
			expect(tableFilter(weirdRow, '>Col | 1\nSub')).toBe(
				['| Col \\| 1<br>Sub |', '| ---: |', '| [[Note\\|Alias]]<br>Next line |'].join(
					'\n',
				),
			);
		});

		it('integrates with pick and runtimeContext.language inside Liquid templates and selector pipelines', async () => {
			const matches = [
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

			// Direct TypeScript pipeline: pick -> table
			const picked = pickFilter(
				matches,
				'file.basename as Title',
				'properties.author as Author',
				'properties.rating as Rating',
				'properties.published as Published',
				'tags as Tags',
				'file as FileMeta',
			);
			const directTable = tableFilter(picked, '>Rating, ^Published');
			expect(directTable).toBe(
				[
					'| Title | Author | Rating | Published | Tags | FileMeta |',
					'| :--- | :--- | ---: | :---: | :--- | :--- |',
					'| Dune | Frank Herbert | 5 | 1965-08-01 | scifi, classic, and desert | {path: Books/Dune.md, ..., size: 420} |',
					'| Neuromancer | William Gibson | 4.5 | 1984-07-01 | scifi and cyberpunk | {path: Books/Neuromancer.md, ..., size: 310} |',
				].join('\n'),
			);

			// Full Liquid template render with German locale
			const rendered = await renderRhizomeTemplate(
				[
					'{%- query books -%}tag:scifi{%- endquery -%}',
					'{{ query.books | pick: "file.basename as Titel", "tags as Schlagworte", "properties.rating as Wertung" | table: ">Wertung" }}',
				].join('\n'),
				{
					runQueries: async () => ({ books: matches }),
					explainQuery: async () => '',
					runtimeContext: {
						language: 'de',
					},
				},
			);

			expect(rendered.ok).toBe(true);
			expect(rendered.markdown).toBe(
				[
					'| Titel | Schlagworte | Wertung |',
					'| :--- | :--- | ---: |',
					'| Dune | scifi, classic und desert | 5 |',
					'| Neuromancer | scifi und cyberpunk | 4.5 |',
				].join('\n'),
			);
		});
	});
});
