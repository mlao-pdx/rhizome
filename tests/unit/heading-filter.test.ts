import { describe, expect, it } from 'vitest';
import { initEngineConfig } from '../../src/core/search';
import {
	analyzeRhizomeCodeBlock,
	clampHeadingLevel,
	groupByFilter,
	headingFilter,
	parseHeadingArguments,
	parseHeadingLevelSpec,
	pickFilter,
	renderRhizomeTemplate,
	resolveCodeBlockHeadingLevel,
	resolveHeadingLevel,
	TemporalDrop,
} from '../../src/core/templates';

describe('Liquid heading filter and {% heading %} block tag', () => {
	describe('parseHeadingLevelSpec, resolveHeadingLevel, clampHeadingLevel, and parseHeadingArguments', () => {
		it('parses valid level specifiers (1..6, promote, demote) and rejects invalid values', () => {
			for (const n of [1, 2, 3, 4, 5, 6] as const) {
				expect(parseHeadingLevelSpec(n)).toBe(n);
				expect(parseHeadingLevelSpec(String(n))).toBe(n);
				expect(parseHeadingLevelSpec(`"${n}"`)).toBe(n);
			}
			expect(parseHeadingLevelSpec('promote')).toBe('promote');
			expect(parseHeadingLevelSpec('PROMOTE')).toBe('promote');
			expect(parseHeadingLevelSpec('demote')).toBe('demote');
			expect(parseHeadingLevelSpec('Demote')).toBe('demote');

			expect(parseHeadingLevelSpec(0)).toBeNull();
			expect(parseHeadingLevelSpec(7)).toBeNull();
			expect(parseHeadingLevelSpec(-1)).toBeNull();
			expect(parseHeadingLevelSpec('+2')).toBeNull();
			expect(parseHeadingLevelSpec('-2')).toBeNull();
			expect(parseHeadingLevelSpec('invalid')).toBeNull();
			expect(parseHeadingLevelSpec(null)).toBeNull();
		});

		it('resolves unclamped relative/absolute levels and clamps emitted ATX levels to 1..6', () => {
			expect(resolveHeadingLevel(2, null)).toBe(2);
			expect(resolveHeadingLevel(2, 4)).toBe(4);
			expect(resolveHeadingLevel(2, 'promote')).toBe(1);
			expect(resolveHeadingLevel(2, 'demote')).toBe(3);
			expect(resolveHeadingLevel(0, 'demote')).toBe(1);
			expect(resolveHeadingLevel(0, 'promote')).toBe(-1);
			expect(resolveHeadingLevel(6, 'demote')).toBe(7);

			expect(clampHeadingLevel(-3)).toBe(1);
			expect(clampHeadingLevel(0)).toBe(1);
			expect(clampHeadingLevel(1)).toBe(1);
			expect(clampHeadingLevel(6)).toBe(6);
			expect(clampHeadingLevel(9)).toBe(6);
		});

		it('separates an optional leading level specifier from list styles and leaf selectors', () => {
			const def = parseHeadingArguments([]);
			expect(def.levelSpec).toBeNull();
			expect(def.styles).toEqual(['-', '-', '-', '-', '-', '-']);
			expect(def.selectors).toEqual([]);

			const withNumber = parseHeadingArguments([3, '1., -', 'file.basename']);
			expect(withNumber.levelSpec).toBe(3);
			expect(withNumber.styles).toEqual(['1.', '-']);
			expect(withNumber.selectors).toHaveLength(1);
			expect(withNumber.selectors[0]?.outputKey).toBe('basename');

			const withCommaSpec = parseHeadingArguments([
				'demote, 1., ...',
				'file.basename, properties.author as Author',
			]);
			expect(withCommaSpec.levelSpec).toBe('demote');
			expect(withCommaSpec.styles).toEqual(['1.', '1.', '1.', '1.', '1.', '1.']);
			expect(withCommaSpec.selectors).toHaveLength(2);

			const withoutLevelSpec = parseHeadingArguments(['1., -', 'file.basename']);
			expect(withoutLevelSpec.levelSpec).toBeNull();
			expect(withoutLevelSpec.styles).toEqual(['1.', '-']);
			expect(withoutLevelSpec.selectors).toHaveLength(1);
		});
	});

	describe('resolveCodeBlockHeadingLevel', () => {
		const headings = [
			{ level: 1, position: { start: { line: 2 } } },
			{ level: 3, position: { start: { line: 8 } } },
			{ level: 2, position: { start: { line: 20 } } },
		];

		it('returns 0 when no heading precedes lineStart or when inputs are empty', () => {
			expect(resolveCodeBlockHeadingLevel(null, 10)).toBe(0);
			expect(resolveCodeBlockHeadingLevel(undefined, 10)).toBe(0);
			expect(resolveCodeBlockHeadingLevel([], 10)).toBe(0);
			expect(resolveCodeBlockHeadingLevel(headings, 0)).toBe(0);
			expect(resolveCodeBlockHeadingLevel(headings, 2)).toBe(0);
		});

		it('returns the level of the closest heading strictly preceding lineStart', () => {
			expect(resolveCodeBlockHeadingLevel(headings, 3)).toBe(1);
			expect(resolveCodeBlockHeadingLevel(headings, 8)).toBe(1);
			expect(resolveCodeBlockHeadingLevel(headings, 9)).toBe(3);
			expect(resolveCodeBlockHeadingLevel(headings, 20)).toBe(3);
			expect(resolveCodeBlockHeadingLevel(headings, 25)).toBe(2);
		});
	});

	describe('headingFilter on scalars, vacuous inputs, line breaks, and inline concatenation', () => {
		it('returns empty string for vacuous inputs and ignores FORBIDDEN_KEYS', () => {
			expect(headingFilter(null)).toBe('');
			expect(headingFilter(undefined)).toBe('');
			expect(headingFilter('')).toBe('');
			expect(headingFilter('   \n\t  ')).toBe('');
			expect(headingFilter([])).toBe('');
			expect(headingFilter([null, undefined, '', [], {}])).toBe('');
			expect(headingFilter({})).toBe('');

			const polluted = JSON.parse('{"__proto__": {"bad": 1}, "Title": "Clean"}') as Record<
				string,
				unknown
			>;
			expect(headingFilter(polluted, 2)).toBe('\n## Title: Clean\n');
		});

		it('formats scalars, TemporalDrop values, and normalizes internal newlines onto a single heading line', () => {
			const drop = new TemporalDrop({
				start: Date.UTC(2026, 9, 15, 0, 0, 0, 0),
				end: Date.UTC(2026, 9, 16, 0, 0, 0, 0),
				grain: 'day',
				isRange: false,
				timeZone: 'UTC',
				referenceTimeMs: Date.UTC(2026, 9, 15, 0, 0, 0, 0),
				raw: '2026-10-15',
			});

			expect(headingFilter('Overview')).toBe('\n# Overview\n');
			expect(headingFilter('Overview', 3)).toBe('\n### Overview\n');
			expect(headingFilter(42, 2)).toBe('\n## 42\n');
			expect(headingFilter(true, 4)).toBe('\n#### true\n');
			expect(headingFilter(drop, 5)).toBe('\n##### 2026-10-15\n');
			expect(headingFilter('Line 1\nLine 2\r\nLine 3\rLine 4', 2)).toBe(
				'\n## Line 1 Line 2 Line 3 Line 4\n',
			);
		});

		it('guarantees leading and trailing newlines so inline template usage never concatenates onto surrounding text', async () => {
			const rendered = await renderRhizomeTemplate(
				'Intro text{{ "Section Title" | heading }}Body paragraph',
				{
					runQueries: async () => ({}),
					explainQuery: async () => '',
					runtimeContext: { headingLevel: 2 },
				},
			);

			expect(rendered.ok).toBe(true);
			expect(rendered.markdown).toBe('Intro text\n## Section Title\nBody paragraph');
		});

		it('is pure and never mutates the ambient heading level across consecutive filter calls', async () => {
			const rendered = await renderRhizomeTemplate(
				[
					'{{ "BaseBefore" | heading }}',
					'{{ "DemotedOnce" | heading: "demote" }}',
					'{{ "PromotedOnce" | heading: "promote" }}',
					'{{ "ExplicitFive" | heading: 5 }}',
					'{{ "BaseAfter" | heading }}',
				].join(''),
				{
					runQueries: async () => ({}),
					explainQuery: async () => '',
					runtimeContext: { headingLevel: 2 },
				},
			);

			expect(rendered.ok).toBe(true);
			expect(rendered.markdown).toBe(
				[
					'\n## BaseBefore\n',
					'\n### DemotedOnce\n',
					'\n# PromotedOnce\n',
					'\n##### ExplicitFive\n',
					'\n## BaseAfter\n',
				].join(''),
			);
		});
	});

	describe('headingFilter on group_by buckets, Missing value headings, and H6-to-list fallback', () => {
		const tasks = [
			{
				file: { basename: 'Task A' },
				properties: { status: 'open', priority: 'high', area: 'core' },
			},
			{
				file: { basename: 'Task B' },
				properties: { status: 'open', priority: 'low', area: 'ui' },
			},
			{
				file: { basename: 'Task C' },
				properties: { status: null, priority: 'high', area: 'core' },
			},
		];

		it('renders 1-level group_by buckets as headings without (size) badges and uses Missing value for vacuous bucket names', () => {
			const grouped = groupByFilter(tasks, 'properties.status');

			expect(headingFilter(grouped, 2, '1.', 'file.basename')).toBe(
				['', '## open', '1. Task A', '2. Task B', '## Missing value', '1. Task C', ''].join(
					'\n',
				),
			);
		});

		it('advances nested group_by levels starting from H1 when initial headingLevel is 0', () => {
			const multiGrouped = groupByFilter(tasks, 'properties.status, properties.priority');

			expect(headingFilter(multiGrouped, 'file.basename')).toBe(
				[
					'',
					'# open',
					'## high',
					'- Task A',
					'## low',
					'- Task B',
					'# Missing value',
					'## high',
					'- Task C',
					'',
				].join('\n'),
			);
		});

		it('automatically transitions nested group_by subtrees beyond H6 into list rendering', () => {
			const threeLevel = groupByFilter(
				tasks,
				'properties.status, properties.priority, properties.area',
			);

			// Starting at level 5:
			// status -> H5 (#####)
			// priority -> H6 (######)
			// area (level 7 > 6) -> transitions to list depth 1 with (size) badges and leaf items at list depth 2
			expect(headingFilter(threeLevel, 5, '1., -', 'file.basename')).toBe(
				[
					'',
					'##### open',
					'###### high',
					'1. core (1)',
					'  - Task A',
					'###### low',
					'1. ui (1)',
					'  - Task B',
					'##### Missing value',
					'###### high',
					'1. core (1)',
					'  - Task C',
					'',
				].join('\n'),
			);
		});
	});

	describe('headingFilter on plain objects, object arrays, nested arrays, and pick sub-pipelines', () => {
		const books = [
			{
				file: { basename: 'Dune' },
				properties: { author: 'Frank Herbert', rating: 5 },
			},
			{
				file: { basename: 'Neuromancer' },
				properties: { author: 'William Gibson', rating: 4.5 },
			},
		];

		it('renders 1-key and multi-key projected object arrays and nested arrays', () => {
			expect(headingFilter(books, 2, 'file.basename')).toBe(
				['', '## Dune', '## Neuromancer', ''].join('\n'),
			);

			expect(
				headingFilter(
					books,
					3,
					'1.',
					'file.basename, properties.author as Author, properties.rating as Rating',
				),
			).toBe(
				[
					'',
					'### Dune',
					'1. Author: Frank Herbert',
					'2. Rating: 5',
					'### Neuromancer',
					'1. Author: William Gibson',
					'2. Rating: 4.5',
					'',
				].join('\n'),
			);

			expect(
				headingFilter(
					[
						['Group One', 'Item 1', 'Item 2'],
						['Group Two', 'Item 3'],
					],
					2,
				),
			).toBe(
				['', '## Group One', '- Item 1', '- Item 2', '## Group Two', '- Item 3', ''].join(
					'\n',
				),
			);
		});

		it('renders a single plain record with scalar and nested array/object keys and works inside pick sub-pipelines', () => {
			const record = {
				Author: 'Frank Herbert',
				Tags: ['scifi', 'classic'],
				Meta: { Year: 1965 },
			};
			expect(headingFilter(record, 2)).toBe(
				[
					'',
					'## Author: Frank Herbert',
					'## Tags',
					'- scifi',
					'- classic',
					'## Meta',
					'- Year: 1965',
					'',
				].join('\n'),
			);

			const picked = pickFilter({ title: 'Chapter 1' }, 'title | heading: 2') as {
				title?: string;
			};
			expect(picked.title).toBe('\n## Chapter 1\n');
		});
	});

	describe('{% heading <1..6 | promote | demote> %} ... {% endheading %} block tag', () => {
		it('scopes heading level changes, supports nested promote/demote, and restores unclamped level on exit', async () => {
			const template = [
				'{{- "RootAt6" | heading -}}',
				'{%- heading demote -%}',
				'{{- "DemotedTo7Clamped6" | heading -}}',
				'{%- heading demote -%}',
				'{{- "DemotedTo8Clamped6" | heading -}}',
				'{%- heading promote -%}',
				'{{- "PromotedBackTo7Clamped6" | heading -}}',
				'{%- endheading -%}',
				'{%- endheading -%}',
				'{%- endheading -%}',
				'{%- heading promote -%}',
				'{{- "PromotedFrom6To5" | heading -}}',
				'{%- heading: 2 -%}',
				'{{- "PinnedTo2" | heading -}}',
				'{%- endheading -%}',
				'{{- "RestoredTo5" | heading -}}',
				'{%- endheading -%}',
				'{{- "RestoredTo6" | heading -}}',
			].join('');

			const result = await renderRhizomeTemplate(template, {
				runQueries: async () => ({}),
				explainQuery: async () => '',
				runtimeContext: { headingLevel: 6 },
			});

			expect(result.ok).toBe(true);
			expect(result.markdown).toBe(
				[
					'\n###### RootAt6\n',
					'\n###### DemotedTo7Clamped6\n',
					'\n###### DemotedTo8Clamped6\n',
					'\n###### PromotedBackTo7Clamped6\n',
					'\n##### PromotedFrom6To5\n',
					'\n## PinnedTo2\n',
					'\n##### RestoredTo5\n',
					'\n###### RestoredTo6\n',
				].join(''),
			);
		});

		it('propagates active heading level into {% render %} partials and {% layout %} files and extracts nested {% query %} blocks', async () => {
			const files: Record<string, string> = {
				'Templates/Layouts/wrapper.md':
					'{{ "LayoutHeader" | heading }}{% heading demote %}{% block %}{% endblock %}{% endheading %}{{ "LayoutFooter" | heading }}',
				'Templates/Partials/section.md':
					'{% query items %}tag:item{% endquery %}{{ "PartialHeader" | heading }}{% heading demote %}{{ query.items | heading: "file.basename" }}{% endheading %}',
			};

			const source = [
				'{% layout "wrapper" %}',
				'{{ "BodyHeader" | heading }}',
				'{% heading demote %}',
				'{% render "section" %}',
				'{% endheading %}',
				'{{ "BodyAfterPartial" | heading }}',
			].join('');

			const result = await renderRhizomeTemplate(source, {
				folders: {
					templatesFolder: 'Templates',
					partialsFolder: 'Templates/Partials',
					layoutsFolder: 'Templates/Layouts',
				},
				readTemplateFile: async (path) => files[path] ?? null,
				runQueries: async (queries) => {
					expect(queries).toHaveProperty('items', 'tag:item');
					return {
						items: [{ file: { basename: 'Leaf Item' } }],
					};
				},
				explainQuery: async () => '',
				runtimeContext: { headingLevel: 1 },
			});

			expect(result.ok).toBe(true);
			// Root starts at H1, body renders first during {% layout %} evaluation:
			// BodyHeader -> H1 (#), then demote -> PartialHeader H2 (##), then demote -> Leaf Item H3 (###),
			// then BodyAfterPartial -> H1 (#).
			// Then wrapper.md renders with {{ content }} inside {% heading demote %}, and LayoutHeader/Footer at H1 (#).
			expect(result.markdown).toBe(
				[
					'\n# LayoutHeader\n',
					'\n# BodyHeader\n',
					'\n## PartialHeader\n',
					'\n### Leaf Item\n',
					'\n# BodyAfterPartial\n',
					'\n# LayoutFooter\n',
				].join(''),
			);
		});

		it('emits Pass 1 diagnostics for invalid {% heading %} arguments, unclosed blocks, and unexpected {% endheading %} arguments', async () => {
			const missingArg = await renderRhizomeTemplate('{% heading %}text{% endheading %}', {
				runQueries: async () => ({}),
				explainQuery: async () => '',
			});
			expect(missingArg.ok).toBe(false);
			expect(missingArg.diagnostics[0]?.code).toBe('INVALID_HEADING_TAG_ARGS');

			const invalidLevel = await renderRhizomeTemplate(
				'{% heading 7 %}text{% endheading %}',
				{
					runQueries: async () => ({}),
					explainQuery: async () => '',
				},
			);
			expect(invalidLevel.ok).toBe(false);
			expect(invalidLevel.diagnostics[0]?.code).toBe('INVALID_HEADING_TAG_ARGS');

			const extraArgs = await renderRhizomeTemplate(
				'{% heading 2 extra %}text{% endheading %}',
				{
					runQueries: async () => ({}),
					explainQuery: async () => '',
				},
			);
			expect(extraArgs.ok).toBe(false);
			expect(extraArgs.diagnostics[0]?.code).toBe('INVALID_HEADING_TAG_ARGS');

			const unclosed = await renderRhizomeTemplate(
				'{% heading demote %}{{ "A" | heading }}',
				{
					runQueries: async () => ({}),
					explainQuery: async () => '',
				},
			);
			expect(unclosed.ok).toBe(false);
			expect(unclosed.diagnostics[0]?.code).toBe('TEMPLATE_SYNTAX_ERROR');

			const endWithArgs = await renderRhizomeTemplate(
				'{% heading 2 %}text{% endheading extra %}',
				{
					runQueries: async () => ({}),
					explainQuery: async () => '',
				},
			);
			expect(endWithArgs.ok).toBe(false);
			expect(endWithArgs.diagnostics[0]?.code).toBe('TEMPLATE_SYNTAX_ERROR');
		});

		it('highlights heading, endheading, promote, and demote as liquid-keyword tokens in analyzeRhizomeCodeBlock', () => {
			const cfgRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
			if (!cfgRes.ok) throw new Error('Expected valid engine config');
			const src = '{% heading demote %}{% heading promote %}{% endheading %}{% endheading %}';
			const analysis = analyzeRhizomeCodeBlock(src, cfgRes.config, Date.now());
			expect(analysis.diagnostics).toHaveLength(0);

			const keywordTexts = analysis.tokens
				.filter((t) => t.kind === 'liquid-keyword')
				.map((t) => src.slice(t.startOffset, t.endOffset));
			expect(keywordTexts).toEqual([
				'heading',
				'demote',
				'heading',
				'promote',
				'endheading',
				'endheading',
			]);
		});
	});
});
