import { describe, expect, it, vi } from 'vitest';
import { renderRhizomeTemplate } from '../../src/core/templates';

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
			'Tasks ({{ tasks.size }}):',
			'{% for item in tasks %}- {{ item.file.basename }}\n{% endfor %}',
			'Empty ({{ emptyList.size }})',
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
			'Count: {{ validWithExplain.size }}',
			'{% query brokenQuery %}',
			'  [invalid_syntax',
			'{% endquery %}',
			'After broken: {{ brokenQuery.size | default: 0 }}',
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
			'Found: {{ q.size }}',
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
			'{% query strayBrace %}{{% endquery %}\n{% query quotedBraces %}"{{hello"{% endquery %}\nMatched: {{ quotedBraces.size }}',
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

	it('resolves dynamic partials and layouts inside configured vault folders while blocking path traversal, URLs, and ◊InternalRhizome 001 notes', async () => {
		const mockVaultFiles: Record<string, string> = {
			'◊Rhizome/partials/row.md': '* {{ label }}: {{ count }}',
			'◊Rhizome/layouts/frame.md': 'BEGIN\n{% block %}{% endblock %}\nEND',
			'◊Rhizome/partials/secret-log.md':
				'---\n◊InternalRhizome:\n  "001": Do not index or query.\n---\nSecret log body',
			'◊Rhizome/partials/nested-query.md': '{% query inner %}tag:x{% endquery %}',
			'SecretOutside.md': 'Should never be accessible',
		};

		const readTemplateFile = vi.fn(
			async (vaultPath: string) => mockVaultFiles[vaultPath] ?? null,
		);
		const runQueries = vi.fn(async () => ({
			tasks: [{ file: { basename: 'Alpha' } }, { file: { basename: 'Beta' } }],
		}));
		const explainQuery = vi.fn(async () => '');

		const validTemplate = [
			"{% layout 'frame' %}",
			'{% query tasks %}tag:task{% endquery %}',
			"{% assign partialName = 'row' %}",
			'{% render partialName, label: "Tasks", count: tasks.size %}',
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
		expect(nestedQueryInPartial.ok).toBe(false);
		expect(nestedQueryInPartial.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(nestedQueryInPartial.diagnostics[0]?.issue).toContain(
			'◊Rhizome/partials/nested-query.md',
		);
		expect(nestedQueryInPartial.diagnostics[0]?.span).toBeNull();
	});
});
