import { Text } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { editorInfoField } from 'obsidian';
import {
	findRhizomeCodeBlocks,
	resolveEditorHostFile,
} from '../../src/adapters/codemirror/rhizome-editor-extension';
import { initEngineConfig } from '../../src/core/search';
import { analyzeRhizomeCodeBlock } from '../../src/core/templates';
import { parseRhizomeTemplatePass1ForAnalysis } from '../../src/core/templates/template-engine';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

describe('analyzeRhizomeCodeBlock & findRhizomeCodeBlocks', () => {
	const cfgRes = initEngineConfig({
		timeZone: 'UTC',
		propertyTypes: {
			score: 'number',
			due: 'date',
			done: 'checkbox',
		},
	});
	if (!cfgRes.ok) throw new Error('Expected valid config');
	const config = cfgRes.config;

	it('classifies outer Liquid tokens and inner query DSL tokens with exact offsets', () => {
		const code = [
			'{% # Outer inline comment %}',
			'{%- query tasks cutoff: 500 -%}',
			'  {% # Inner query comment %}',
			'  tag:work AND (#urgent OR [score: >= 10]) [due: @today] file:/^sprint/i aliases:"quoted" links:[[Target]] [score: != 5]',
			'{%- endquery -%}',
			'{% for item in tasks %}',
			'  - {{ item.file.basename | upcase | truncate: 20, "..." }}',
			'{% endfor %}',
		].join('\n');

		const analysis = analyzeRhizomeCodeBlock(code, config, PINNED_REF_MS);
		const kinds = new Set(analysis.tokens.map((t) => t.kind));

		expect(kinds.has('comment')).toBe(true);
		expect(kinds.has('liquid-delimiter')).toBe(true);
		expect(kinds.has('liquid-keyword')).toBe(true);
		expect(kinds.has('liquid-variable')).toBe(true);
		expect(kinds.has('liquid-filter')).toBe(true);
		expect(kinds.has('liquid-number')).toBe(true);
		expect(kinds.has('liquid-string')).toBe(true);
		expect(kinds.has('query-scope')).toBe(true);
		expect(kinds.has('query-keyword')).toBe(true);
		expect(kinds.has('query-paren')).toBe(true);
		expect(kinds.has('query-tag')).toBe(true);
		expect(kinds.has('query-property')).toBe(true);
		expect(kinds.has('query-operator')).toBe(true);
		expect(kinds.has('query-date')).toBe(true);
		expect(kinds.has('query-regex')).toBe(true);
		expect(kinds.has('query-string')).toBe(true);
		expect(kinds.has('query-wikilink')).toBe(true);
		expect(kinds.has('query-identifier')).toBe(true);

		// Hints for [[Target]] and [score: != 5] should be shifted into codeblock coordinates
		const diagCodes = analysis.diagnostics.map((d) => d.code);
		expect(diagCodes).toContain('HINT_WIKILINK_BRACKETS_IN_SCOPE');
		expect(diagCodes).toContain('HINT_PROP_NEQ_EXISTENCE');
		for (const diag of analysis.diagnostics) {
			const slice = code.slice(diag.startOffset, diag.endOffset);
			expect(slice.length).toBeGreaterThan(0);
		}
	});

	it('recovers resiliently when an outer Liquid tag fails parsing so query highlighting and diagnostics remain active', () => {
		const code = [
			'{% if unclosed_condition %}',
			'{% query tasks %}',
			'  unknown_scope:val [score: = "not-a-number"]',
			'{% endquery %}',
		].join('\n');

		const analysis = analyzeRhizomeCodeBlock(code, config, PINNED_REF_MS);
		expect(analysis.queries).toHaveLength(1);

		const diagCodes = analysis.diagnostics.map((d) => d.code);
		expect(diagCodes).toContain('TEMPLATE_SYNTAX_ERROR');
		expect(diagCodes).toContain('ERROR_UNKNOWN_SCOPE');
		expect(diagCodes).toContain('ERROR_TYPE_MISMATCH');

		const scopeToken = analysis.tokens.find((t) => t.kind === 'query-scope');
		expect(scopeToken).toBeDefined();
		expect(code.slice(scopeToken!.startOffset, scopeToken!.endOffset)).toBe('unknown_scope');
	});

	it('highlights half-typed outer Liquid tags that have no closing delimiter', () => {
		const code = '{% query tasks\n{% if condition';
		const analysis = analyzeRhizomeCodeBlock(code, config, PINNED_REF_MS);

		const delimiters = analysis.tokens
			.filter((t) => t.kind === 'liquid-delimiter')
			.map((t) => code.slice(t.startOffset, t.endOffset));
		expect(delimiters).toEqual(['{%', '{%']);

		const keywords = analysis.tokens
			.filter((t) => t.kind === 'liquid-keyword')
			.map((t) => code.slice(t.startOffset, t.endOffset));
		expect(keywords).toContain('query');
		expect(keywords).toContain('if');
	});

	it('matches LiquidJS quote handling for tag and output delimiters', () => {
		// Outputs respect quotes: a quoted `}}` does not close an unclosed output.
		const outputCode = '{{ "}}';
		const outputAnalysis = analyzeRhizomeCodeBlock(outputCode, config, PINNED_REF_MS);
		expect(
			outputAnalysis.tokens.some(
				(t) => t.kind === 'liquid-delimiter' && t.startOffset === outputCode.length - 2,
			),
		).toBe(false);

		// Tags do not respect quotes: the first `%}` closes the tag, even inside a string.
		const tagCode = '{% assign x = "%}" %}';
		const tagAnalysis = analyzeRhizomeCodeBlock(tagCode, config, PINNED_REF_MS);
		const firstCloseIdx = tagCode.indexOf('%}');
		expect(
			tagAnalysis.tokens.some(
				(t) => t.kind === 'liquid-delimiter' && t.startOffset === firstCloseIdx,
			),
		).toBe(true);
	});

	it('does not let an unmatched apostrophe in tag args swallow later tags', () => {
		const code = "{% raw don't %}\n{% if x %}";
		const analysis = analyzeRhizomeCodeBlock(code, config, PINNED_REF_MS);
		const secondOpen = code.indexOf('{%', 2);

		expect(
			analysis.tokens.some(
				(t) => t.kind === 'liquid-delimiter' && t.startOffset === secondOpen,
			),
		).toBe(true);
	});

	it('does not merge an unclosed tag into a later closed tag', () => {
		const code = '{% if condition\n{% endif %}';
		const analysis = analyzeRhizomeCodeBlock(code, config, PINNED_REF_MS);
		const secondOpen = code.indexOf('{%', 2);

		expect(
			analysis.tokens.some((t) => t.kind === 'liquid-delimiter' && t.startOffset === 0),
		).toBe(true);
		expect(
			analysis.tokens.some(
				(t) => t.kind === 'liquid-delimiter' && t.startOffset === secondOpen,
			),
		).toBe(true);
		expect(
			analysis.tokens.some((t) => t.startOffset === 0 && t.endOffset === code.length),
		).toBe(false);
	});

	it('analyzes the body of an unclosed query block while it is being typed', () => {
		const code = '{% query tasks %}\ntag:work AND (#urgent OR [score: >= 10])';
		const analysis = analyzeRhizomeCodeBlock(code, config, PINNED_REF_MS);

		expect(analysis.queries).toHaveLength(1);
		const query = analysis.queries[0]!;
		expect(query.name).toBe('tasks');
		expect(query.fullSpan.startOffset).toBe(0);
		expect(query.fullSpan.endOffset).toBe(code.length);

		const kinds = new Set(analysis.tokens.map((t) => t.kind));
		expect(kinds.has('query-keyword')).toBe(true);
		expect(kinds.has('query-tag')).toBe(true);
		expect(kinds.has('query-property')).toBe(true);

		expect(analysis.diagnostics.map((d) => d.code)).toContain('TEMPLATE_SYNTAX_ERROR');
	});

	it('reuses one Liquid instance across analyzer Pass 1 parses', () => {
		const first = parseRhizomeTemplatePass1ForAnalysis(
			'{% query first %}tag:one{% endquery %}',
		);
		const second = parseRhizomeTemplatePass1ForAnalysis(
			'{% query second %}tag:two{% endquery %}',
		);

		expect(first.liquid).toBe(second.liquid);
		expect(first.env).not.toBe(second.env);
		expect(first.env.queries[0]?.name).toBe('first');
		expect(second.env.queries[0]?.name).toBe('second');
	});

	it("resolves each editor view's own host file rather than the workspace active file", () => {
		const fileA = { path: 'A.md', name: 'A.md', stat: { mtime: 1 } };
		const fileB = { path: 'B.md', name: 'B.md', stat: { mtime: 2 } };
		const makeView = (file: unknown) =>
			({
				state: {
					field: (field: unknown) => (field === editorInfoField ? { file } : undefined),
				},
			}) as unknown as Parameters<typeof resolveEditorHostFile>[0];

		expect(resolveEditorHostFile(makeView(fileA))).toBe(fileA);
		expect(resolveEditorHostFile(makeView(fileB))).toBe(fileB);
		expect(resolveEditorHostFile(makeView(null))).toBeNull();
	});

	it('locates fenced rhizome codeblocks in a CodeMirror Text document', () => {
		const docText = [
			'# Heading',
			'',
			'```rhizome',
			'{% query a %}tag:work{% endquery %}',
			'```',
			'',
			'```js',
			'console.log(1);',
			'```',
			'',
			'~~~rhizome',
			'{{ a.size }}',
			'~~~',
		].join('\n');

		const doc = Text.of(docText.split('\n'));
		const blocks = findRhizomeCodeBlocks(doc);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.source.trim()).toBe('{% query a %}tag:work{% endquery %}');
		expect(blocks[1]?.source.trim()).toBe('{{ a.size }}');
	});

	it('highlights graph arrows, subquery braces, scopes inside { ... }, and @query.* tokens, and lints unknown/circular @query.* blocks', () => {
		const standalone = [
			'{% query tasks %}',
			'[up ->* { tag:project }] AND links <- @query.missing',
			'{% endquery %}',
		].join('\n');

		const analysis = analyzeRhizomeCodeBlock(standalone, config, PINNED_REF_MS);
		const tokenTextByKind = (kind: string) =>
			analysis.tokens
				.filter((t) => t.kind === kind)
				.map((t) => standalone.slice(t.startOffset, t.endOffset));

		expect(tokenTextByKind('query-operator')).toContain('->*');
		expect(tokenTextByKind('query-operator')).toContain('<-');
		expect(tokenTextByKind('query-paren')).toContain('{');
		expect(tokenTextByKind('query-paren')).toContain('}');
		expect(tokenTextByKind('query-scope')).toContain('tag');
		expect(tokenTextByKind('query-scope')).toContain('links');
		expect(tokenTextByKind('query-date')).toContain('@query.missing');

		expect(analysis.diagnostics.map((d) => d.code)).toContain('ERROR_UNKNOWN_QUERY_REF');

		// When external {% render %} is present, unknown @query.* may come from a partial, so suppress ERROR_UNKNOWN_QUERY_REF
		const withPartial = `${standalone}\n{% render "shared-queries" %}`;
		const partialAnalysis = analyzeRhizomeCodeBlock(withPartial, config, PINNED_REF_MS);
		expect(partialAnalysis.diagnostics.map((d) => d.code)).not.toContain(
			'ERROR_UNKNOWN_QUERY_REF',
		);

		// Circular @query.* references are always caught in-block with exact cycle chain
		const cyclic = [
			'{% query alpha %}links -> @query.beta{% endquery %}',
			'{% query beta %}[up <- @query.alpha]{% endquery %}',
		].join('\n');
		const cyclicAnalysis = analyzeRhizomeCodeBlock(cyclic, config, PINNED_REF_MS);
		const cycDiags = cyclicAnalysis.diagnostics.filter(
			(d) => d.code === 'ERROR_CIRCULAR_QUERY_REF',
		);
		expect(cycDiags.length).toBeGreaterThanOrEqual(2);
		expect(cycDiags[0]?.issue).toContain('alpha -> beta -> alpha');
	});

	it('highlights cutoff as liquid-keyword and <int> as liquid-number for spaced and compact forms, preserves dotted cutoff variables, and recovers cutoff metadata on outer syntax errors', () => {
		const source = [
			'{% query a cutoff: 500 %}#a{% endquery %}',
			'{% query b cutoff:0 %}#b{% endquery %}',
			'{{ item.properties.cutoff }}',
		].join('\n');

		const analysis = analyzeRhizomeCodeBlock(source, config, PINNED_REF_MS);
		const tokensWithText = analysis.tokens.map((t) => ({
			kind: t.kind,
			text: source.slice(t.startOffset, t.endOffset),
		}));

		expect(
			tokensWithText.filter((t) => t.kind === 'liquid-keyword' && t.text === 'cutoff'),
		).toHaveLength(2);
		expect(tokensWithText).toContainEqual({ kind: 'liquid-number', text: '500' });
		expect(tokensWithText).toContainEqual({ kind: 'liquid-number', text: '0' });
		expect(tokensWithText).toContainEqual({
			kind: 'liquid-variable',
			text: 'item.properties.cutoff',
		});

		expect(analysis.queries).toHaveLength(2);
		expect(analysis.queries[0]).toMatchObject({
			name: 'a',
			cutoff: 500,
			explicitCutoff: true,
		});
		expect(analysis.queries[1]).toMatchObject({
			name: 'b',
			cutoff: 0,
			explicitCutoff: true,
		});

		// Legacy `{% query ... explain %}` emits INVALID_QUERY_TAG_ARGS with rhizome-sample hint
		const legacyExplain = analyzeRhizomeCodeBlock(
			'{% query tasks explain %}#work{% endquery %}',
			config,
			PINNED_REF_MS,
		);
		expect(legacyExplain.diagnostics[0]?.code).toBe('INVALID_QUERY_TAG_ARGS');
		expect(legacyExplain.diagnostics[0]?.hint).toContain('rhizome-sample');

		// Fallback recovery when outer Liquid fails tokenization ({{ unclosed)
		const brokenOuter = [
			'{{ unclosed',
			'{% query recovered cutoff: 42 %}#work{% endquery %}',
			'{% query defaultRecovered %}#home{% endquery %}',
		].join('\n');
		const recovered = analyzeRhizomeCodeBlock(brokenOuter, config, PINNED_REF_MS);
		expect(recovered.queries).toHaveLength(2);
		expect(recovered.queries[0]).toMatchObject({
			name: 'recovered',
			cutoff: 42,
			explicitCutoff: true,
		});
		expect(recovered.queries[1]).toMatchObject({
			name: 'defaultRecovered',
			cutoff: 5_000,
			explicitCutoff: false,
		});
	});

	it('highlights targetPath, frontmatter, closed, active, template keywords, ◊.trigger variables, and reports QUERY_IN_LOOP_ERROR', () => {
		const cfgRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
		expect(cfgRes.ok).toBe(true);
		if (!cfgRes.ok) return;

		const src = [
			'{% targetPath template.folders.default active %}',
			'{% frontmatter "today as created" %}',
			'{{ ◊.trigger }}',
			'{% for x in (1..2) %}{% query bad %}#work{% endquery %}{% endfor %}',
		].join('\n');

		const analysis = analyzeRhizomeCodeBlock(src, cfgRes.config, PINNED_REF_MS);
		const tokenTextsByKind = (kind: string) =>
			analysis.tokens
				.filter((t) => t.kind === kind)
				.map((t) => src.slice(t.startOffset, t.endOffset));

		expect(tokenTextsByKind('liquid-keyword')).toEqual(
			expect.arrayContaining(['targetPath', 'active', 'frontmatter', 'for', 'query']),
		);
		expect(tokenTextsByKind('liquid-variable')).toEqual(
			expect.arrayContaining(['template.folders.default', '◊.trigger']),
		);
		expect(analysis.diagnostics.some((d) => d.code === 'QUERY_IN_LOOP_ERROR')).toBe(true);
	});
});
