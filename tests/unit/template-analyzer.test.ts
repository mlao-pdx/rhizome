import { Text } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { findRhizomeCodeBlocks } from '../../src/adapters/codemirror/rhizome-editor-extension';
import { initEngineConfig } from '../../src/core/search';
import { analyzeRhizomeCodeBlock } from '../../src/core/templates';

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
			'{%- query tasks explain -%}',
			'  {% # Inner query comment %}',
			'  tag:work AND (#urgent OR [score: >= 10]) [due: @today] /^sprint/i "quoted" links:[[Target]] bareword',
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

		// Hints for [[Target]] and bareword should be shifted into codeblock coordinates
		const diagCodes = analysis.diagnostics.map((d) => d.code);
		expect(diagCodes).toContain('HINT_WIKILINK_BRACKETS_IN_SCOPE');
		expect(diagCodes).toContain('HINT_BARE_TEXT_NO_BODY');
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
});
