import { describe, expect, it, vi } from 'vitest';
import { pickFilter, renderRhizomeTemplate } from '../../src/core/templates';

describe('renderRhizomeTemplate & {% query %} tag', () => {
	it('batches multiple {% query %} blocks into a single runQueries call and binds results in root Liquid scope', async () => {
		const runQueries = vi.fn(async (queries: Readonly<Record<string, string>>) => ({
			tasks: [{ file: { basename: 'Task A' } }, { file: { basename: 'Task B' } }],
			emptyList: [],
			_echo: Object.keys(queries),
		}));
		const explainQuery = vi.fn(async (q: string, heading: string) => `# ${heading}\n${q}`);

		const template = [
			'{%- query tasks -%}',
			'  tag:task [status: = "open"]',
			'{%- endquery -%}',
			'{%- query emptyList -%}',
			'  tag:none',
			'{%- endquery -%}',
			'Tasks ({{ query.tasks.size }}):',
			'{% for item in query.tasks %}- {{ item.file.basename }}\n{% endfor %}',
			'Empty ({{ query.emptyList.size }})',
		].join('\n');

		const res = await renderRhizomeTemplate(template, { runQueries, explainQuery });
		expect(res.ok).toBe(true);
		expect(res.diagnostics).toEqual([]);
		expect(res.queries).toHaveLength(2);
		expect(runQueries).toHaveBeenCalledTimes(1);
		expect(runQueries).toHaveBeenCalledWith({
			tasks: '\n  tag:task [status: = "open"]\n',
			emptyList: '\n  tag:none\n',
		});
		expect(explainQuery).not.toHaveBeenCalled();
		expect(res.markdown).toContain('Tasks (2):');
		expect(res.markdown).toContain('- Task A');
		expect(res.markdown).toContain('- Task B');
		expect(res.markdown).toContain('Empty (0)');
	});

	it('enforces the Missing vs. Empty Payload Contract for explain and failed queries', async () => {
		const runQueries = vi.fn(async () => ({
			validWithExplain: [{ file: { basename: 'Note 1' } }],
			// 'brokenQuery' is intentionally omitted from payload to simulate compilation failure
		}));
		const explainQuery = vi.fn(
			async (q: string, heading: string) => `# ${heading}\nExplained: ${q.trim()}`,
		);

		const template = [
			'{% query validWithExplain explain %}',
			'  tag:project',
			'{% endquery %}',
			'Count: {{ query.validWithExplain.size }}',
			'{% query brokenQuery %}',
			'  [invalid_syntax',
			'{% endquery %}',
			'After broken: {{ query.brokenQuery.size | default: 0 }}',
		].join('\n');

		const res = await renderRhizomeTemplate(template, { runQueries, explainQuery });
		expect(res.ok).toBe(true);
		expect(runQueries).toHaveBeenCalledTimes(1);
		expect(explainQuery).toHaveBeenCalledTimes(2);
		expect(res.markdown).toContain('# Query Explain Plan: validWithExplain');
		expect(res.markdown).toContain('Explained: tag:project');
		expect(res.markdown).toContain('Count: 1');
		expect(res.markdown).toContain('# Query Explain Plan: brokenQuery');
		expect(res.markdown).toContain('Explained: [invalid_syntax');
		expect(res.markdown).toContain('After broken: 0');
	});

	it('tracks nested {% comment %}...{% endcomment %} inside {% query %} so inner {% endquery %} does not close the block', async () => {
		const runQueries = vi.fn(async () => ({
			q: [{ file: { basename: 'Matched' } }],
		}));
		const explainQuery = vi.fn(async () => '');

		const template = [
			'{% query q %}',
			'  tag:work {% comment %} ignore {% endquery %} inside comment {% endcomment %} [status: active]',
			'{% endquery %}',
			'Found: {{ query.q.size }}',
		].join('\n');

		const res = await renderRhizomeTemplate(template, { runQueries, explainQuery });
		expect(res.ok).toBe(true);
		expect(res.queries).toHaveLength(1);
		expect(res.queries[0]?.query).toContain('{% endquery %}');
		expect(res.markdown.trim()).toBe('Found: 1');
	});

	it('allows {% endquery %} to close a query block when an inner {% comment %} is unclosed so SearchLexer can report SYNTAX_ERROR', async () => {
		const runQueries = vi.fn(async () => ({}));
		const explainQuery = vi.fn(
			async (q: string, heading: string) => `# ${heading}\n${q.trim()}`,
		);

		const template = [
			'{% query unclosedCommentQuery %}',
			'  tag:work {% comment %} forgot endcomment',
			'{% endquery %}',
			'Still renders template footer',
		].join('\n');

		const res = await renderRhizomeTemplate(template, { runQueries, explainQuery });
		expect(res.ok).toBe(true);
		expect(runQueries).toHaveBeenCalledTimes(1);
		expect(explainQuery).toHaveBeenCalledTimes(1);
		expect(res.markdown).toContain('# Query Explain Plan: unclosedCommentQuery');
		expect(res.markdown).toContain('Still renders template footer');
	});

	it('short-circuits with 0 vault scans and renders [!danger] callouts on duplicate query names, invalid tag args, or Liquid syntax errors', async () => {
		const runQueries = vi.fn(async () => ({}));
		const explainQuery = vi.fn(async () => '');

		const duplicateRes = await renderRhizomeTemplate(
			'{% query tasks %}tag:a{% endquery %}\n{% query tasks %}tag:b{% endquery %}',
			{ runQueries, explainQuery },
		);
		expect(duplicateRes.ok).toBe(false);
		expect(duplicateRes.diagnostics[0]?.code).toBe('DUPLICATE_QUERY_NAME');
		expect(duplicateRes.markdown).toContain(
			'> [!danger] Template Error: `DUPLICATE_QUERY_NAME`',
		);
		expect(duplicateRes.markdown).toContain('‼️{% query tasks %}‼️');
		expect(runQueries).not.toHaveBeenCalled();

		const badArgsRes = await renderRhizomeTemplate('{% query explain %}tag:a{% endquery %}', {
			runQueries,
			explainQuery,
		});
		expect(badArgsRes.ok).toBe(false);
		expect(badArgsRes.diagnostics[0]?.code).toBe('INVALID_QUERY_TAG_ARGS');
		expect(runQueries).not.toHaveBeenCalled();

		const extraArgsRes = await renderRhizomeTemplate('{% query a b c %}tag:a{% endquery %}', {
			runQueries,
			explainQuery,
		});
		expect(extraArgsRes.ok).toBe(false);
		expect(extraArgsRes.diagnostics[0]?.code).toBe('INVALID_QUERY_TAG_ARGS');
		expect(runQueries).not.toHaveBeenCalled();

		const syntaxErrRes = await renderRhizomeTemplate(
			'{% query a %}tag:a{% endquery %}\n{% if unclosed %}',
			{ runQueries, explainQuery },
		);
		expect(syntaxErrRes.ok).toBe(false);
		expect(syntaxErrRes.diagnostics[0]?.code).toBe('TEMPLATE_SYNTAX_ERROR');
		expect(syntaxErrRes.markdown).toContain(
			'> [!danger] Template Error: `TEMPLATE_SYNTAX_ERROR`',
		);
		expect(runQueries).not.toHaveBeenCalled();
	});

	it('shields query bodies containing stray braces or {{ sequences from outer Liquid tokenization', async () => {
		const runQueries = vi.fn(async (queries: Readonly<Record<string, string>>) => ({
			quotedBraces: queries['quotedBraces']?.includes('{{hello')
				? [{ file: { basename: 'Braced' } }]
				: [],
			// 'strayBrace' fails query compilation so it is omitted from payload
		}));
		const explainQuery = vi.fn(async (q: string, heading: string) => `# ${heading}\nRaw:${q}`);

		const res = await renderRhizomeTemplate(
			'{% query strayBrace %}{{% endquery %}\n{% query quotedBraces %}"{{hello"{% endquery %}\nMatched: {{ query.quotedBraces.size }}',
			{ runQueries, explainQuery },
		);
		expect(res.ok).toBe(true);
		expect(res.queries).toHaveLength(2);
		expect(res.queries[0]?.query).toBe('{');
		expect(res.queries[1]?.query).toBe('"{{hello"');
		expect(res.markdown).toContain('# Query Explain Plan: strayBrace');
		expect(res.markdown).toContain('Matched: 1');
	});

	it('does not swallow {% endquery %} when an unclosed inner {% comment %} is followed by an outer {% comment %}...{% endcomment %}', async () => {
		const runQueries = vi.fn(async () => ({}));
		const explainQuery = vi.fn(
			async (q: string, heading: string) => `# ${heading}\n${q.trim()}`,
		);

		const template = [
			'{% query q %}',
			'  tag:work {% comment %} unclosed inside query',
			'{% endquery %}',
			'Visible text between blocks',
			'{% comment %} outer closed comment {% endcomment %}',
			'Footer text',
		].join('\n');

		const res = await renderRhizomeTemplate(template, { runQueries, explainQuery });
		expect(res.ok).toBe(true);
		expect(res.markdown).toContain('# Query Explain Plan: q');
		expect(res.markdown).toContain('Visible text between blocks');
		expect(res.markdown).toContain('Footer text');
		expect(res.markdown).not.toContain('outer closed comment');
	});

	it('resolves static partials and layouts inside configured vault folders while blocking path traversal, URLs, and ◊InternalRhizome 001 notes', async () => {
		const mockVaultFiles: Record<string, string> = {
			'◊Rhizome/partials/row.md': '* {{ label }}: {{ count }}',
			'◊Rhizome/layouts/frame.md': 'BEGIN\n{% block %}{% endblock %}\nEND',
			'◊Rhizome/partials/secret-log.md':
				'---\n◊InternalRhizome:\n  "001": Do not index or query.\n---\nSecret log body',
			'◊Rhizome/partials/nested-query.md':
				'{% query inner %}tag:x{% endquery %}Inner={{ query.inner.size }}',
			'SecretOutside.md': 'Should never be accessible',
		};

		const readTemplateFile = vi.fn(
			async (vaultPath: string) => mockVaultFiles[vaultPath] ?? null,
		);
		const runQueries = vi.fn(async () => ({
			tasks: [{ file: { basename: 'Alpha' } }, { file: { basename: 'Beta' } }],
			inner: [{ file: { basename: 'Gamma' } }],
		}));
		const explainQuery = vi.fn(async () => '');

		const validTemplate = [
			"{% layout 'frame' %}",
			'{% query tasks %}tag:task{% endquery %}',
			'{% render "row", label: "Tasks", count: query.tasks.size %}',
		].join('\n');

		const okRes = await renderRhizomeTemplate(validTemplate, {
			runQueries,
			explainQuery,
			readTemplateFile,
		});
		expect(okRes.ok).toBe(true);
		expect(okRes.markdown).toContain('BEGIN');
		expect(okRes.markdown).toContain('* Tasks: 2');
		expect(okRes.markdown).toContain('END');

		const blockedPaths = [
			"{% render '../SecretOutside' %}",
			"{% render '/SecretOutside' %}",
			"{% render 'https://evil.example/p.md' %}",
			"{% render '.hidden-config/workspace' %}",
			"{% render 'secret-log' %}",
		];

		for (const tpl of blockedPaths) {
			const blockedRes = await renderRhizomeTemplate(tpl, {
				runQueries,
				explainQuery,
				readTemplateFile,
			});
			expect(blockedRes.ok).toBe(false);
			expect(blockedRes.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
			expect(blockedRes.markdown).not.toContain('Should never be accessible');
			expect(blockedRes.markdown).not.toContain('Secret log body');
		}

		const nestedQueryInPartial = await renderRhizomeTemplate("{% render 'nested-query' %}", {
			runQueries,
			explainQuery,
			readTemplateFile,
		});
		expect(nestedQueryInPartial.ok).toBe(true);
		expect(nestedQueryInPartial.queries).toHaveLength(1);
		expect(nestedQueryInPartial.queries[0]?.name).toBe('inner');
		expect(nestedQueryInPartial.queries[0]?.file).toBe('◊Rhizome/partials/nested-query.md');
		expect(nestedQueryInPartial.markdown).toContain('Inner=1');
	});

	it('supports multi-level (3+ deep) partials and layouts with {% query %} blocks, explain flags, query body masking, and flat {{ query.<name> }} namespace', async () => {
		const mockVaultFiles: Record<string, string> = {
			'◊Rhizome/layouts/outer-layout.md': [
				'{%- query layoutQ -%}tag:layout "{{masked"{%- endquery -%}',
				'LAYOUT[{{ query.layoutQ.first.file.basename }}|{{ query.leafQ.first.file.basename }}]:',
				'{% block %}{% endblock %}',
			].join('\n'),
			'◊Rhizome/partials/level1.md': [
				'{%- query p1Q -%}tag:p1{%- endquery -%}',
				'L1({{ query.p1Q.size }})->{% render "level2", passedFromRoot: rootVal %}',
			].join('\n'),
			'◊Rhizome/partials/level2.md': [
				'{%- query p2Q explain -%}tag:p2{%- endquery -%}',
				'L2({{ passedFromRoot }},{{ query.p2Q.size }})->{% render "level3" %}',
			].join('\n'),
			'◊Rhizome/partials/level3.md': [
				'{%- query leafQ -%}{{%- endquery -%}',
				'L3(root={{ query.rootQ.size }},layout={{ query.layoutQ.size }},p1={{ query.p1Q.size }})',
			].join('\n'),
		};

		const readTemplateFile = vi.fn(
			async (vaultPath: string) => mockVaultFiles[vaultPath] ?? null,
		);
		const capturedBatches: Array<Readonly<Record<string, string>>> = [];
		const runQueries = vi.fn(async (queries: Readonly<Record<string, string>>) => {
			capturedBatches.push(queries);
			return {
				rootQ: [{ file: { basename: 'RootDoc' } }],
				layoutQ: [{ file: { basename: 'LayoutDoc' } }],
				p1Q: [{ file: { basename: 'P1DocA' } }, { file: { basename: 'P1DocB' } }],
				p2Q: [{ file: { basename: 'P2Doc' } }],
				// leafQ omitted to simulate query syntax error on `{` and trigger explain fallback
			};
		});
		const explainQuery = vi.fn(
			async (q: string, heading: string) => `[EXPLAIN:${heading}:${q.trim()}]`,
		);

		const rootSource = [
			"{% layout 'outer-layout' %}",
			'{%- query rootQ -%}tag:root{%- endquery -%}',
			'{% render "level1", rootVal: "hello" %}',
		].join('\n');

		const res = await renderRhizomeTemplate(rootSource, {
			runQueries,
			explainQuery,
			readTemplateFile,
		});

		expect(res.ok).toBe(true);
		expect(runQueries).toHaveBeenCalledTimes(1);
		expect(capturedBatches[0]).toEqual({
			rootQ: 'tag:root',
			p1Q: 'tag:p1',
			p2Q: 'tag:p2',
			leafQ: '{',
			layoutQ: 'tag:layout "{{masked"',
		});
		expect(res.queries.map((q) => ({ name: q.name, file: q.file }))).toEqual([
			{ name: 'rootQ', file: null },
			{ name: 'p1Q', file: '◊Rhizome/partials/level1.md' },
			{ name: 'p2Q', file: '◊Rhizome/partials/level2.md' },
			{ name: 'leafQ', file: '◊Rhizome/partials/level3.md' },
			{ name: 'layoutQ', file: '◊Rhizome/layouts/outer-layout.md' },
		]);
		expect(explainQuery).toHaveBeenCalledTimes(2);
		expect(res.markdown).toContain('LAYOUT[LayoutDoc|]:');
		expect(res.markdown).toContain('L1(2)->');
		expect(res.markdown).toContain('[EXPLAIN:Query Explain Plan: p2Q:tag:p2]');
		expect(res.markdown).toContain('L2(hello,1)->');
		expect(res.markdown).toContain('[EXPLAIN:Query Explain Plan: leafQ:{]');
		expect(res.markdown).toContain('L3(root=1,layout=1,p1=2)');
	});

	it('handles diamond partial inclusion (including mixed .md extensions) and {% render %} inside {% for %} loops without false DUPLICATE_QUERY_NAME errors', async () => {
		const mockVaultFiles: Record<string, string> = {
			'◊Rhizome/partials/branch-a.md': 'A[{% render "shared-leaf" %}]',
			'◊Rhizome/partials/branch-b.md': 'B[{% render "shared-leaf.md" %}]',
			'◊Rhizome/partials/shared-leaf.md':
				'{%- query sharedQ -%}tag:shared{%- endquery -%}{{ label | default: "leaf" }}={{ query.sharedQ.size }}',
		};

		const readTemplateFile = vi.fn(
			async (vaultPath: string) => mockVaultFiles[vaultPath] ?? null,
		);
		const runQueries = vi.fn(async () => ({
			sharedQ: [{ file: { basename: 'S1' } }, { file: { basename: 'S2' } }],
		}));
		const explainQuery = vi.fn(async () => '');

		const template = [
			'{% render "branch-a" %}',
			'{% render "branch-b" %}',
			'{% for idx in (1..3) %}{% render "shared-leaf", label: idx %};{% endfor %}',
		].join('\n');

		const res = await renderRhizomeTemplate(template, {
			runQueries,
			explainQuery,
			readTemplateFile,
		});

		expect(res.ok).toBe(true);
		expect(res.queries).toHaveLength(1);
		expect(res.queries[0]?.name).toBe('sharedQ');
		expect(runQueries).toHaveBeenCalledTimes(1);
		expect(readTemplateFile).toHaveBeenCalledTimes(3); // branch-a, shared-leaf, branch-b
		expect(res.markdown).toContain('A[leaf=2]');
		expect(res.markdown).toContain('B[leaf=2]');
		expect(res.markdown).toContain('1=2;2=2;3=2;');
	});

	it('detects DUPLICATE_QUERY_NAME across root and partials or across two partials with file-accurate caret snippets', async () => {
		const mockVaultFiles: Record<string, string> = {
			'◊Rhizome/partials/p-one.md': 'Line 1\n{% query dup %}tag:one{% endquery %}',
			'◊Rhizome/partials/p-two.md':
				'Header\nSecond line\n{% query dup %}tag:two{% endquery %}',
		};
		const readTemplateFile = vi.fn(
			async (vaultPath: string) => mockVaultFiles[vaultPath] ?? null,
		);
		const runQueries = vi.fn(async () => ({}));
		const explainQuery = vi.fn(async () => '');

		// 1. Root + partial collision
		const rootVsPartial = await renderRhizomeTemplate(
			'{% query dup %}tag:root{% endquery %}\n{% render "p-one" %}',
			{ runQueries, explainQuery, readTemplateFile },
		);
		expect(rootVsPartial.ok).toBe(false);
		expect(rootVsPartial.diagnostics).toHaveLength(1);
		expect(rootVsPartial.diagnostics[0]?.code).toBe('DUPLICATE_QUERY_NAME');
		expect(rootVsPartial.diagnostics[0]?.file).toBe('◊Rhizome/partials/p-one.md');
		expect(rootVsPartial.diagnostics[0]?.span?.startLine).toBe(2);
		expect(rootVsPartial.diagnostics[0]?.issue).toContain('in the root codeblock, on line 1');
		expect(rootVsPartial.markdown).toContain(
			"in '◊Rhizome/partials/p-one.md', line 2, column 1",
		);
		expect(rootVsPartial.markdown).toContain('‼️{% query dup %}‼️tag:one{% endquery %}');
		expect(runQueries).not.toHaveBeenCalled();

		// 2. Partial + partial collision
		const partialVsPartial = await renderRhizomeTemplate(
			'{% render "p-one" %}\n{% render "p-two" %}',
			{ runQueries, explainQuery, readTemplateFile },
		);
		expect(partialVsPartial.ok).toBe(false);
		expect(partialVsPartial.diagnostics).toHaveLength(1);
		expect(partialVsPartial.diagnostics[0]?.code).toBe('DUPLICATE_QUERY_NAME');
		expect(partialVsPartial.diagnostics[0]?.file).toBe('◊Rhizome/partials/p-two.md');
		expect(partialVsPartial.diagnostics[0]?.span?.startLine).toBe(3);
		expect(partialVsPartial.diagnostics[0]?.issue).toContain(
			"in '◊Rhizome/partials/p-one.md', on line 2",
		);
		expect(partialVsPartial.markdown).toContain(
			"in '◊Rhizome/partials/p-two.md', line 3, column 1",
		);
		expect(partialVsPartial.markdown).toContain('‼️{% query dup %}‼️tag:two{% endquery %}');
	});

	it('detects circular partial/layout references (A -> B -> A and self-cycles) during Pass 1 and emits TEMPLATE_SYNTAX_ERROR', async () => {
		const mockVaultFiles: Record<string, string> = {
			'◊Rhizome/partials/cycle-a.md': '{% render "cycle-b" %}',
			'◊Rhizome/partials/cycle-b.md': '{% render "cycle-a" %}',
			'◊Rhizome/partials/self-cycle.md': '{% render "self-cycle" %}',
		};
		const readTemplateFile = vi.fn(
			async (vaultPath: string) => mockVaultFiles[vaultPath] ?? null,
		);
		const runQueries = vi.fn(async () => ({}));
		const explainQuery = vi.fn(async () => '');

		const abCycle = await renderRhizomeTemplate('{% render "cycle-a" %}', {
			runQueries,
			explainQuery,
			readTemplateFile,
		});
		expect(abCycle.ok).toBe(false);
		expect(abCycle.diagnostics).toHaveLength(1);
		expect(abCycle.diagnostics[0]?.code).toBe('TEMPLATE_SYNTAX_ERROR');
		expect(abCycle.diagnostics[0]?.file).toBe('◊Rhizome/partials/cycle-b.md');
		expect(abCycle.diagnostics[0]?.issue).toContain(
			'render:cycle-a -> render:cycle-b -> render:cycle-a',
		);
		expect(runQueries).not.toHaveBeenCalled();

		const selfCycle = await renderRhizomeTemplate('{% render "self-cycle" %}', {
			runQueries,
			explainQuery,
			readTemplateFile,
		});
		expect(selfCycle.ok).toBe(false);
		expect(selfCycle.diagnostics[0]?.code).toBe('TEMPLATE_SYNTAX_ERROR');
		expect(selfCycle.diagnostics[0]?.issue).toContain('render:self-cycle -> render:self-cycle');
	});

	it('rejects dynamic variable filenames in {% render %} and {% layout %} and rejects deprecated {% include %}', async () => {
		const runQueries = vi.fn(async () => ({}));
		const explainQuery = vi.fn(async () => '');

		const dynamicRender = await renderRhizomeTemplate(
			"{% assign p = 'row' %}\n{% render p %}",
			{ runQueries, explainQuery },
		);
		expect(dynamicRender.ok).toBe(false);
		expect(dynamicRender.diagnostics[0]?.code).toBe('TEMPLATE_SYNTAX_ERROR');
		expect(dynamicRender.diagnostics[0]?.issue).toContain(
			"Dynamic or variable filename in '{% render p %}' is not supported",
		);
		expect(dynamicRender.markdown).toContain('‼️{% render p %}‼️');

		const interpolatedLayout = await renderRhizomeTemplate('{% layout "frames/{{ kind }}" %}', {
			runQueries,
			explainQuery,
		});
		expect(interpolatedLayout.ok).toBe(false);
		expect(interpolatedLayout.diagnostics[0]?.code).toBe('TEMPLATE_SYNTAX_ERROR');
		expect(interpolatedLayout.diagnostics[0]?.issue).toContain(
			"'{% layout %}' requires a static quoted string filename",
		);

		const layoutNoneRes = await renderRhizomeTemplate('{% layout none %}Plain body', {
			runQueries,
			explainQuery,
		});
		expect(layoutNoneRes.ok).toBe(true);
		expect(layoutNoneRes.markdown).toBe('Plain body');

		const deprecatedInclude = await renderRhizomeTemplate("{% include 'row' %}", {
			runQueries,
			explainQuery,
		});
		expect(deprecatedInclude.ok).toBe(false);
		expect(deprecatedInclude.diagnostics[0]?.code).toBe('TEMPLATE_SYNTAX_ERROR');
		expect(deprecatedInclude.diagnostics[0]?.issue).toContain(
			"'{% include 'row' %}' is disabled; use '{% render ... %}' instead",
		);
		expect(deprecatedInclude.markdown).toContain("‼️{% include 'row' %}‼️");
		expect(runQueries).not.toHaveBeenCalled();
	});

	it('exposes host note metadata via ◊host at the root scope, namespaces queries under query.*, and exposes vault/tz/language/platform globals', async () => {
		const runQueries = vi.fn(async () => ({
			'◊host': [
				{
					file: {
						path: 'Projects/Alpha.md',
						name: 'Alpha.md',
						basename: 'Alpha',
						extension: 'md',
						folder: 'Projects',
						parent: 'Projects',
						created: 1700000000000,
						modified: Date.UTC(2026, 9, 31, 8, 33, 0, 0),
						size: 1024,
					},
					aliases: ['Project Alpha', 'PA'],
					aliasLocations: [
						{ alias: 'Project Alpha', source: 'frontmatter', origin: '[[Alpha]]' },
					],
					tags: ['project', 'active'],
					tagLocations: [{ tag: 'project', source: 'frontmatter', origin: '[[Alpha]]' }],
					headings: [{ text: 'Overview', level: 1 }],
					links: [],
					embeds: [],
					blocks: ['summary-block'],
					properties: { status: 'in-progress', priority: 1 },
					propertyLocations: [
						{
							property: 'status',
							value: 'in-progress',
							source: 'frontmatter',
							origin: '[[Alpha]]',
						},
					],
				},
			],
			myFirstQuery: [{ file: { basename: 'Task 1' } }, { file: { basename: 'Task 2' } }],
		}));
		const explainQuery = vi.fn(async () => '');

		const template = [
			'{%- query myFirstQuery -%}tag:task{%- endquery -%}',
			'Host: {{ file.basename }} ({{ file.path }})',
			'Status: {{ properties.status }}',
			'Aliases: {% for a in aliases %}{{ a }}{% unless forloop.last %}, {% endunless %}{% endfor %}',
			'Tags: {{ tags | join: "+" }}',
			'Heading: {{ headings[0].text }}',
			'Block: {{ blocks.first }}',
			'Query items: {% for note in query.myFirstQuery %}{{ note.file.basename }};{% endfor %}',
			'Hidden host in query: {{ query["◊host"] | default: "HIDDEN" }}',
			'Env: {{ vault }} | {{ tz }} | {{ language }} | mac={{ platform.isMacOS }} | mobile={{ platform.isMobile }}',
		].join('\n');

		const res = await renderRhizomeTemplate(template, {
			runQueries,
			explainQuery,
			runtimeContext: {
				referenceTimeMs: Date.UTC(2026, 9, 31, 8, 33, 0, 0),
				timeZone: 'UTC',
				vault: 'NarradinVault',
				language: 'en-GB',
				platform: {
					isDesktop: true,
					isMobile: false,
					isDesktopApp: true,
					isMobileApp: false,
					isIosApp: false,
					isAndroidApp: false,
					isPhone: false,
					isTablet: false,
					isMacOS: true,
					isWin: false,
					isLinux: false,
					isSafari: false,
				},
			},
		});

		expect(res.ok).toBe(true);
		expect(res.markdown).toContain('Host: Alpha (Projects/Alpha.md)');
		expect(res.markdown).toContain('Status: in-progress');
		expect(res.markdown).toContain('Aliases: Project Alpha, PA');
		expect(res.markdown).toContain('Tags: project+active');
		expect(res.markdown).toContain('Heading: Overview');
		expect(res.markdown).toContain('Block: summary-block');
		expect(res.markdown).toContain('Query items: Task 1;Task 2;');
		expect(res.markdown).toContain('Hidden host in query: HIDDEN');
		expect(res.markdown).toContain(
			'Env: NarradinVault | UTC | en-GB | mac=true | mobile=false',
		);
	});

	it('renders grain-guided ISO temporal literals, ranges, | date formatting, interval comparisons, and for-loop iteration', async () => {
		// Pin to 2026-10-31T08:39:15.123Z in UTC
		const refMs = Date.UTC(2026, 9, 31, 8, 39, 15, 123);
		const runQueries = vi.fn(async () => ({
			'◊host': [
				{
					file: {
						path: 'Daily/2026-10-31.md',
						name: '2026-10-31.md',
						basename: '2026-10-31',
						extension: 'md',
						folder: 'Daily',
						parent: 'Daily',
						created: Date.UTC(2026, 9, 31, 6, 15, 0, 0),
						modified: Date.UTC(2026, 9, 31, 8, 30, 0, 0),
						size: 256,
					},
					aliases: [],
					tags: [],
					tagLocations: [],
					headings: [],
					links: [],
					embeds: [],
					blocks: [],
					properties: {
						due: '2026-10-31',
						window: '2026-10-01..2026-10-31',
					},
				},
			],
			notes: [
				{ file: { basename: 'TodayNote', created: Date.UTC(2026, 9, 31, 7, 0, 0, 0) } },
				{ file: { basename: 'OldNote', created: Date.UTC(2026, 9, 20, 7, 0, 0, 0) } },
			],
		}));
		const explainQuery = vi.fn(async () => '');

		const template = [
			'{%- query notes -%}* {%- endquery -%}',
			'year={{ thisyear }}',
			'lastyear={{ lastyear }}',
			'nextyear={{ nextyear }}',
			'quarter={{ thisquarter }}',
			'month={{ thismonth }}',
			'week={{ thisweek }}',
			'today={{ today }}',
			'yesterday={{ yesterday }}',
			'tomorrow={{ tomorrow }}',
			'minus7={{ today-7d }}',
			'plus3={{ yesterday+3d }}',
			'now={{ now }}',
			'r_year_today={{ thisyear..today }}',
			'r_month_year={{ thismonth..thisyear }}',
			'r_today_now={{ today..now }}',
			'r_paren={{ (yesterday..tomorrow) }}',
			'fmt_mod={{ file.modified | date: "%Y-%m-%d %H:%M" }}',
			'fmt_today={{ today | date: "%Y/%m/%d" }}',
			'fmt_str_now={{ "now" | date: "%Y-%m-%d %H:%M" }}',
			'fmt_to_str={{ today | date_to_string }}',
			'where_today={% assign matching = query.notes | where_exp: "n", "n.file.created == today" %}{% for m in matching %}{{ m.file.basename }}{% endfor %}',
			'cmp_created_today={% if file.created == today %}YES{% else %}NO{% endif %}',
			'cmp_created_yesterday={% if file.created > yesterday %}YES{% else %}NO{% endif %}',
			'cmp_created_tomorrow={% if file.created < tomorrow %}YES{% else %}NO{% endif %}',
			'cmp_due_today={% if properties.due == today %}YES{% else %}NO{% endif %}',
			'cmp_due_month={% if properties.due <= thismonth %}YES{% else %}NO{% endif %}',
			'cmp_window_month={% if properties.window == thismonth %}YES{% else %}NO{% endif %}',
			'cmp_null_neq={% if properties.missing != today %}YES{% else %}NO{% endif %}',
			'cmp_null_eq={% if properties.missing == today %}YES{% else %}NO{% endif %}',
			'iter_months={% for m in thismonth..thisyear %}{{ m }};{% endfor %}',
			'iter_days={% for d in today-2d..today %}{{ d }};{% endfor %}',
			'iter_mins={% for min in "2026-10-31T08:38"..now %}{{ min }};{% endfor %}',
			'iter_num={% for n in (1..3) %}{{ n }}{% endfor %}',
		].join('\n');

		const res = await renderRhizomeTemplate(template, {
			runQueries,
			explainQuery,
			runtimeContext: {
				referenceTimeMs: refMs,
				timeZone: 'UTC',
			},
		});

		expect(res.ok).toBe(true);
		expect(res.markdown).toContain('year=2026');
		expect(res.markdown).toContain('lastyear=2025');
		expect(res.markdown).toContain('nextyear=2027');
		expect(res.markdown).toContain('quarter=2026-10..2026-12');
		expect(res.markdown).toContain('month=2026-10');
		expect(res.markdown).toContain('week=2026-10-26..2026-11-01');
		expect(res.markdown).toContain('today=2026-10-31');
		expect(res.markdown).toContain('yesterday=2026-10-30');
		expect(res.markdown).toContain('tomorrow=2026-11-01');
		expect(res.markdown).toContain('minus7=2026-10-24');
		expect(res.markdown).toContain('plus3=2026-11-02');
		expect(res.markdown).toContain('now=2026-10-31T08:39');
		expect(res.markdown).toContain('r_year_today=2026-01-01..2026-10-31');
		expect(res.markdown).toContain('r_month_year=2026-10..2026-12');
		expect(res.markdown).toContain('r_today_now=2026-10-31T00:00..2026-10-31T08:39');
		expect(res.markdown).toContain('r_paren=2026-10-30..2026-11-01');
		expect(res.markdown).toContain('fmt_mod=2026-10-31 08:30');
		expect(res.markdown).toContain('fmt_today=2026/10/31');
		expect(res.markdown).toContain('fmt_str_now=2026-10-31 08:39');
		expect(res.markdown).toContain('fmt_to_str=31 Oct 2026');
		expect(res.markdown).toContain('where_today=TodayNote');
		expect(res.markdown).toContain('cmp_created_today=YES');
		expect(res.markdown).toContain('cmp_created_yesterday=YES');
		expect(res.markdown).toContain('cmp_created_tomorrow=YES');
		expect(res.markdown).toContain('cmp_due_today=YES');
		expect(res.markdown).toContain('cmp_due_month=YES');
		expect(res.markdown).toContain('cmp_window_month=YES');
		expect(res.markdown).toContain('cmp_null_neq=YES');
		expect(res.markdown).toContain('cmp_null_eq=NO');
		expect(res.markdown).toContain('iter_months=2026-10;2026-11;2026-12;');
		expect(res.markdown).toContain('iter_days=2026-10-29;2026-10-30;2026-10-31;');
		expect(res.markdown).toContain('iter_mins=2026-10-31T08:38;2026-10-31T08:39;');
		expect(res.markdown).toContain('iter_num=123');
	});

	it('reports TEMPLATE_RENDER_ERROR with a swap hint when a temporal range is reversed', async () => {
		const refMs = Date.UTC(2026, 9, 31, 8, 39, 0, 0);
		const res = await renderRhizomeTemplate('{{ today..yesterday }}', {
			runQueries: async () => ({}),
			explainQuery: async () => '',
			runtimeContext: {
				referenceTimeMs: refMs,
				timeZone: 'UTC',
			},
		});

		expect(res.ok).toBe(false);
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(res.diagnostics[0]?.issue).toContain("Reversed temporal range 'today..yesterday'");
		expect(res.diagnostics[0]?.hint).toBe('Use yesterday..today');
		expect(res.markdown).toContain('> [!danger] Template Error: `TEMPLATE_RENDER_ERROR`');
		expect(res.markdown).toContain('‼️today..yesterday‼️');
		expect(res.markdown).toContain('Use yesterday..today');
	});

	it('reports TEMPLATE_RENDER_ERROR when both endpoints of a range are invalid temporal literals or unparenthesized non-numbers, while keeping parenthesized nil/empty ranges lenient', async () => {
		const refMs = Date.UTC(2026, 9, 31, 8, 39, 0, 0);
		const invalidCases = [
			{
				source: '{{ "2026-02-30".."2026-02-31" }}',
				expectedBadSide: '"2026-02-30"',
			},
			{
				source: '{{ ("2026-02-30".."2026-02-31") }}',
				expectedBadSide: '"2026-02-30"',
			},
			{
				source: '{{ tday..tmorrow }}',
				expectedBadSide: 'tday',
			},
			{
				source: '{{ properties.missing..false }}',
				expectedBadSide: 'properties.missing',
			},
			{
				source: '{{ "liquidMethodMissing"..today }}',
				expectedBadSide: '"liquidMethodMissing"',
			},
			{
				source: '{{ today.."liquidMethodMissing" }}',
				expectedBadSide: '"liquidMethodMissing"',
			},
		];

		for (const tc of invalidCases) {
			const res = await renderRhizomeTemplate(tc.source, {
				runQueries: async () => ({}),
				explainQuery: async () => '',
				runtimeContext: {
					referenceTimeMs: refMs,
					timeZone: 'UTC',
				},
			});
			expect(res.ok).toBe(false);
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
			expect(res.diagnostics[0]?.issue).toContain(
				`'${tc.expectedBadSide}' is not a valid temporal literal`,
			);
		}

		// Parenthesized (lhs..rhs) with undefined/null/empty-string endpoints remains lenient (`[]`),
		// and does not coerce null/false/"" to 0.
		const lenientRes = await renderRhizomeTemplate(
			'{% assign emptyStr = "" %}[{% for x in (missingA..missingB) %}{{ x }}{% endfor %}][{% for x in (emptyStr..2) %}{{ x }}{% endfor %}][{% for x in (false..2) %}{{ x }}{% endfor %}]',
			{
				runQueries: async () => ({}),
				explainQuery: async () => '',
				runtimeContext: {
					referenceTimeMs: refMs,
					timeZone: 'UTC',
				},
			},
		);
		expect(lenientRes.ok).toBe(true);
		expect(lenientRes.markdown).toBe('[][][]');
	});

	it('disambiguates bare 4-digit year literals vs epoch-ms numeric variables (including 0) when paired with a temporal endpoint', async () => {
		const refMs = Date.UTC(2026, 9, 31, 8, 39, 0, 0);
		const res = await renderRhizomeTemplate(
			[
				'epoch_zero={{ file.created..today }}',
				'year_lit={{ 2020..today }}',
				'year_lit_rhs={{ "2018-06"..2020 }}',
				'num_range={{ (2020..2022) | join: "," }}',
			].join('\n'),
			{
				runQueries: async () => ({
					'◊host': [
						{
							file: {
								path: 'EpochNote.md',
								name: 'EpochNote.md',
								basename: 'EpochNote',
								extension: 'md',
								folder: '',
								parent: '',
								created: 0,
								modified: refMs,
								size: 10,
							},
						},
					],
				}),
				explainQuery: async () => '',
				runtimeContext: {
					sourcePath: 'EpochNote.md',
					referenceTimeMs: refMs,
					timeZone: 'UTC',
				},
			},
		);

		expect(res.ok).toBe(true);
		expect(res.markdown).toContain('epoch_zero=1970-01-01T00:00..2026-10-31T23:59');
		expect(res.markdown).toContain('year_lit=2020-01-01..2026-10-31');
		expect(res.markdown).toContain('year_lit_rhs=2018-06..2020-12');
		expect(res.markdown).toContain('num_range=2020,2021,2022');
	});

	it('keeps context temporal metadata unshadowable when templates assign tz or now, and falls back to UTC on invalid runtimeContext.timeZone', async () => {
		const refMs = Date.UTC(2026, 9, 31, 8, 39, 0, 0);
		const res = await renderRhizomeTemplate(
			[
				'{% assign tz = "Not/AZone" %}',
				'{% assign now = "custom-now" %}',
				'range={{ "yesterday".."tomorrow" }}',
				'fmt={{ today | date: "%Y-%m-%d" }}',
				'user_tz={{ tz }}',
				'user_now={{ now }}',
			].join('\n'),
			{
				runQueries: async () => ({}),
				explainQuery: async () => '',
				runtimeContext: {
					referenceTimeMs: refMs,
					timeZone: 'Invalid/TimeZone_Identifier',
				},
			},
		);

		expect(res.ok).toBe(true);
		expect(res.markdown).toContain('range=2026-10-30..2026-11-01');
		expect(res.markdown).toContain('fmt=2026-10-31');
		expect(res.markdown).toContain('user_tz=Not/AZone');
		expect(res.markdown).toContain('user_now=custom-now');
	});

	it('seeds ◊host in renderRhizomeTemplate when runtimeContext.sourcePath is provided even with zero {% query %} blocks', async () => {
		const capturedBatches: Array<Readonly<Record<string, string>>> = [];
		const res = await renderRhizomeTemplate(
			'Host={{ file.basename }} | Prop={{ properties.category }}',
			{
				runQueries: async (batch) => {
					capturedBatches.push(batch);
					return {
						'◊host': [
							{
								file: { basename: 'ZeroQueryHost' },
								properties: { category: 'reference' },
							},
						],
					};
				},
				explainQuery: async () => '',
				runtimeContext: {
					sourcePath: 'Notes/ZeroQueryHost.md',
				},
			},
		);

		expect(res.ok).toBe(true);
		expect(capturedBatches).toHaveLength(1);
		expect(capturedBatches[0]).toEqual({
			'◊host': '[file.path: = "Notes/ZeroQueryHost.md"]',
		});
		expect(res.markdown).toBe('Host=ZeroQueryHost | Prop=reference');
	});

	it('evaluates recursive parenthesized filtered expressions in filter args, tags, conditionals, and trailing property/index chains', async () => {
		const res = await renderRhizomeTemplate(
			[
				'{%- query notes -%}tag:note{%- endquery -%}',
				'append={{ "Note: " | append: (file.basename | upcase) }}',
				'{% assign a = 3 %}{% assign b = 5 %}',
				'nested={{ ((a | plus: 1) | times: (b | minus: 1)) }}',
				'for_sorted={% for n in (query.notes | sort: "file.basename") %}{{ n.file.basename }};{% endfor %}',
				'if_cond={% if (file.basename | downcase) == "readme" %}matched{% else %}nope{% endif %}',
				'chain={{ (query.notes | sort: "file.stat.mtime desc")[0].file.basename }}',
			].join('\n'),
			{
				runQueries: async () => ({
					'◊host': [
						{
							file: { basename: 'ReadMe' },
						},
					],
					notes: [
						{ file: { basename: 'Beta', stat: { mtime: 100 } } },
						{ file: { basename: 'Gamma', stat: { mtime: 300 } } },
						{ file: { basename: 'Alpha', stat: { mtime: 200 } } },
					],
				}),
				explainQuery: async () => '',
				runtimeContext: {
					sourcePath: 'ReadMe.md',
				},
			},
		);

		expect(res.ok).toBe(true);
		expect(res.diagnostics).toEqual([]);
		expect(res.markdown).toContain('append=Note: README');
		expect(res.markdown).toContain('nested=16');
		expect(res.markdown).toContain('for_sorted=Alpha;Beta;Gamma;');
		expect(res.markdown).toContain('if_cond=matched');
		expect(res.markdown).toContain('chain=Gamma');
	});

	it('supports both Obsidian Moment.js date formats and LiquidJS strftime formats in | date using % as the flavor trigger', async () => {
		// Pin to 2026-10-31T14:05:09.123Z (Saturday)
		const refMs = Date.UTC(2026, 9, 31, 14, 5, 9, 123);
		const res = await renderRhizomeTemplate(
			[
				'{%- query notes -%}* {%- endquery -%}',
				'm_iso={{ file.modified | date: "YYYY-MM-DD HH:mm:ss.SSS" }}',
				'm_human={{ today | date: "dddd, MMMM Do YYYY" }}',
				'm_escaped={{ now | date: "[Today is] ddd, MMM D [at] h:mm A" }}',
				'm_backslash={{ today | date: "\\\\YYYY YYYY" }}',
				'm_quarters_weeks={{ today | date: "Q Qo [W]WW Wo w wo DDD DDDD DDDo e E d dd" }}',
				'm_week_years={{ "2026-01-01" | date: "gggg gg GGGG GG" }}',
				'm_hours={{ file.modified | date: "H HH h hh k kk a A hmm hmmss Hmm Hmmss eHHmm" }}',
				'm_frac={{ file.modified | date: "S SS SSS SSSS SSSSS SSSSSS" }}',
				'm_unix={{ file.modified | date: "X | x" }}',
				'm_zone_utc={{ file.modified | date: "Z ZZ z zz" }}',
				'm_zone_ny={{ file.modified | date: "YYYY-MM-DD HH:mm Z ZZ", "America/New_York" }}',
				'm_zone_offset={{ file.modified | date: "YYYY-MM-DD HH:mm Z ZZ", "+05:30" }}',
				'm_zone_num={{ file.modified | date: "YYYY-MM-DD HH:mm Z ZZ", -480 }}',
				'm_long={{ file.modified | date: "LT | LTS | L | LL | LLL | LLLL" }}',
				'm_short_local={{ file.modified | date: "l | ll | lll | llll" }}',
				'm_era={{ today | date: "y yy yyy yyyy yo N NNNN NNNNN" }}',
				'm_empty={{ today | date: "" }}',
				's_basic={{ file.modified | date: "%Y-%m-%d %H:%M:%S" }}',
				's_pct={{ today | date: "100%% in %Y" }}',
				's_offset={{ file.modified | date: "%Y-%m-%d %H:%M %z", "+0530" }}',
				's_default={{ today | date }}',
				'invalid_m={{ "not-a-date" | date: "YYYY-MM-DD" }}',
				'invalid_s={{ "not-a-date" | date: "%Y-%m-%d" }}',
				'nil_m={{ properties.missing | date: "YYYY-MM-DD" }}',
				'pick_m={% assign rows = query.notes | pick: "file.basename as name", "file.modified | date: \'YYYY-MM-DD\' as mod" %}{% for r in rows %}{{ r.name }}:{{ r.mod }};{% endfor %}',
			].join('\n'),
			{
				runQueries: async () => ({
					'◊host': [
						{
							file: {
								path: 'Daily/2026-10-31.md',
								name: '2026-10-31.md',
								basename: '2026-10-31',
								extension: 'md',
								folder: 'Daily',
								parent: 'Daily',
								created: refMs,
								modified: refMs,
								size: 128,
							},
						},
					],
					notes: [{ file: { basename: 'Alpha', modified: refMs } }],
				}),
				explainQuery: async () => '',
				runtimeContext: {
					sourcePath: 'Daily/2026-10-31.md',
					referenceTimeMs: refMs,
					timeZone: 'UTC',
				},
			},
		);

		expect(res.ok).toBe(true);
		expect(res.markdown).toContain('m_iso=2026-10-31 14:05:09.123');
		expect(res.markdown).toContain('m_human=Saturday, October 31st 2026');
		expect(res.markdown).toContain('m_escaped=Today is Sat, Oct 31 at 2:05 PM');
		expect(res.markdown).toContain('m_backslash=YYYY 2026');
		expect(res.markdown).toContain(
			'm_quarters_weeks=4 4th W44 44th 44 44th 304 304 304th 6 6 6 Sa',
		);
		expect(res.markdown).toContain('m_week_years=2026 26 2026 26');
		expect(res.markdown).toContain(
			'm_hours=14 14 2 02 14 14 pm PM 205 20509 1405 140509 61405',
		);
		expect(res.markdown).toContain('m_frac=1 12 123 1230 12300 123000');
		expect(res.markdown).toContain(`m_unix=${Math.floor(refMs / 1000)} | ${refMs}`);
		expect(res.markdown).toContain('m_zone_utc=+00:00 +0000 UTC Coordinated Universal Time');
		expect(res.markdown).toContain('m_zone_ny=2026-10-31 10:05 -04:00 -0400');
		expect(res.markdown).toContain('m_zone_offset=2026-10-31 19:35 +05:30 +0530');
		expect(res.markdown).toContain('m_zone_num=2026-10-31 22:05 +08:00 +0800');
		expect(res.markdown).toContain(
			'm_long=2:05 PM | 2:05:09 PM | 10/31/2026 | October 31, 2026 | October 31, 2026 2:05 PM | Saturday, October 31, 2026 2:05 PM',
		);
		expect(res.markdown).toContain(
			'm_short_local=10/31/2026 | Oct 31, 2026 | Oct 31, 2026 2:05 PM | Sat, Oct 31, 2026 2:05 PM',
		);
		expect(res.markdown).toContain('m_era=2026 2026 2026 2026 2026th AD Anno Domini AD');
		expect(res.markdown).toContain('m_empty=\n');
		expect(res.markdown).toContain('s_basic=2026-10-31 14:05:09');
		expect(res.markdown).toContain('s_pct=100% in 2026');
		expect(res.markdown).toContain('s_offset=2026-10-31 19:35 +0530');
		expect(res.markdown).toContain('s_default=Saturday, October 31, 2026 at 12:00 am +0000');
		expect(res.markdown).toContain('invalid_m=not-a-date');
		expect(res.markdown).toContain('invalid_s=not-a-date');
		expect(res.markdown).toContain('nil_m=\n');
		expect(res.markdown).toContain('pick_m=Alpha:2026-10-31;');

		// Verify direct fallback filter execution outside a Liquid instance
		const directPicked = pickFilter(
			{ modified: refMs },
			"modified | date: 'YYYY-MM-DD', 'UTC' as momentDate",
			"modified | date: '%Y-%m-%d', 'UTC' as strftimeDate",
			'modified | date_to_string as strDate',
		) as Record<string, unknown>;
		expect(directPicked.momentDate).toBe('2026-10-31');
		expect(directPicked.strftimeDate).toBe('2026-10-31');
		expect(typeof directPicked.strDate).toBe('string');
		expect(String(directPicked.strDate)).toContain('2026');
	});
});
