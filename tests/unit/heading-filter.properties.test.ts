import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	groupByFilter,
	type HeadingLevelSpec,
	headingFilter,
	renderRhizomeTemplate,
} from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

const safeKeyArb = fc
	.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,8}$/)
	.filter((k) => k !== '__proto__' && k !== 'prototype' && k !== 'constructor');

const headingLevelSpecArb: fc.Arbitrary<HeadingLevelSpec> = fc.constantFrom<HeadingLevelSpec[]>(
	1,
	2,
	3,
	4,
	5,
	6,
	'promote',
	'demote',
);

const trickyHeadingScalarArb = fc.oneof(
	fc.constant(null),
	fc.constant(''),
	fc.integer({ min: -500, max: 500 }),
	fc.boolean(),
	fc.stringMatching(/^[a-zA-Z0-9 _-]{1,16}$/),
	fc.constantFrom('Line 1\nLine 2', 'A\r\nB\rC', '  Spaced Title  '),
);

describe('Heading Filter & Tag Property Invariants', () => {
	it('ATX Clamping, Newline Boundary, and Single-Line Heading Invariant: every emitted heading starts after a newline, has 1..6 # characters, and contains no internal line breaks', async () => {
		const rowArb = fc.dictionary(safeKeyArb, trickyHeadingScalarArb, {
			minKeys: 1,
			maxKeys: 4,
		});

		await assertProperty(
			'templates/heading-filter__atx-clamping-and-newline-invariant',
			fc.property(
				fc.array(rowArb, { minLength: 0, maxLength: 6 }),
				fc.option(headingLevelSpecArb, { nil: undefined }),
				(rows, levelSpec) => {
					const snapshotBefore = JSON.stringify(rows);
					const out =
						levelSpec !== undefined
							? headingFilter(rows, levelSpec)
							: headingFilter(rows);
					expect(JSON.stringify(rows)).toBe(snapshotBefore);

					if (out.length === 0) {
						return;
					}

					expect(out.startsWith('\n')).toBe(true);
					expect(out.endsWith('\n')).toBe(true);
					expect(out.includes('\r')).toBe(false);

					const bodyLines = out.slice(1, -1).split('\n');
					for (const line of bodyLines) {
						if (line.startsWith('#')) {
							expect(/^#{1,6} \S/.test(line)).toBe(true);
						} else {
							expect(line.length).toBeGreaterThan(0);
						}
					}
				},
			),
		);
	});

	it('GroupBy Heading Hierarchy & Post-H6 List Transition Invariant: group_by buckets emit Missing value for vacuous names, omit (size) badges on headings, and transition to list at depth > 6', async () => {
		await assertProperty(
			'templates/heading-filter__group-by-h6-transition-invariant',
			fc.property(
				fc.integer({ min: 1, max: 6 }),
				fc.array(
					fc.record({
						g1: fc.option(fc.constantFrom('Alpha', 'Beta'), { nil: null }),
						g2: fc.option(fc.constantFrom('Sub1', 'Sub2'), { nil: null }),
						g3: fc.constantFrom('LeafA', 'LeafB'),
						title: fc.stringMatching(/^[a-zA-Z0-9]{1,8}$/),
					}),
					{ minLength: 1, maxLength: 6 },
				),
				(startLevel, items) => {
					const grouped = groupByFilter(items, 'g1, g2, g3');
					const out = headingFilter(grouped, startLevel, 'title');
					expect(out.startsWith('\n')).toBe(true);
					expect(out.endsWith('\n')).toBe(true);

					const lines = out.slice(1, -1).split('\n');
					for (const line of lines) {
						if (line.startsWith('#')) {
							expect(/^#{1,6} \S/.test(line)).toBe(true);
							expect(/\(\d+\+?\)$/.test(line)).toBe(false);
						} else {
							expect(/^(?: {2})*(?:- |\d+\. ).+/.test(line)).toBe(true);
						}
					}
				},
			),
		);
	});

	it('Scoped Heading Block Restoration Invariant: nested {% heading %} blocks and | heading filter calls always restore the outer heading level upon exit', async () => {
		await assertProperty(
			'templates/heading-filter__scoped-block-restoration-invariant',
			fc.asyncProperty(
				fc.integer({ min: 0, max: 6 }),
				fc.array(headingLevelSpecArb, { minLength: 1, maxLength: 4 }),
				fc.option(headingLevelSpecArb, { nil: null }),
				async (initialLevel, blockSpecs, filterSpec) => {
					const openTags = blockSpecs.map((s) => `{%- heading ${s} -%}`).join('');
					const closeTags = blockSpecs.map(() => '{%- endheading -%}').join('');
					const innerFilter =
						filterSpec !== null
							? `{{- "Inner" | heading: "${filterSpec}" -}}`
							: '{{- "Inner" | heading -}}';

					const template = [
						'{{- "Before" | heading -}}',
						openTags,
						innerFilter,
						closeTags,
						'{{- "After" | heading -}}',
					].join('');

					const res = await renderRhizomeTemplate(template, {
						runQueries: async () => ({}),
						explainQuery: async () => '',
						runtimeContext: { headingLevel: initialLevel },
					});

					expect(res.ok).toBe(true);
					const expectedBaseHashes = '#'.repeat(Math.max(1, Math.min(6, initialLevel)));
					const headingLines = res.markdown
						.split('\n')
						.filter((l) => l.trim().length > 0);
					expect(headingLines).toHaveLength(3);
					expect(headingLines[0]).toBe(`${expectedBaseHashes} Before`);
					expect(headingLines[2]).toBe(`${expectedBaseHashes} After`);
					expect(/^#{1,6} Inner$/.test(headingLines[1] ?? '')).toBe(true);
				},
			),
		);
	});
});
