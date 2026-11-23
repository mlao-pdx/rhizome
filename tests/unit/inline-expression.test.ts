import { describe, expect, it } from 'vitest';
import {
	analyzeInlineRhizomeSpan,
	evaluateInlineRhizomeExpression,
	extractInlineRhizomeExpression,
	MAX_INLINE_RENDER_DEPTH,
	MAX_TEMPLATE_OUTPUT_CHARS,
	parseInlineRhizomeExpression,
} from '../../src/core/templates';

const PINNED_REF_MS = Date.parse('2026-11-22T04:46:08.000Z');

describe('Inline Rhizome expressions (core parser, evaluator & static analyzer)', () => {
	it('enforces exact signet activation rules, CommonMark normalization, and GFM table pipe unescaping', () => {
		expect(MAX_INLINE_RENDER_DEPTH).toBe(4);

		// Non-matching literal code spans return null
		expect(extractInlineRhizomeExpression('')).toBeNull();
		expect(extractInlineRhizomeExpression('◊')).toBeNull();
		expect(extractInlineRhizomeExpression('◊host')).toBeNull();
		expect(extractInlineRhizomeExpression('◊InternalRhizome')).toBeNull();
		expect(extractInlineRhizomeExpression('◊ ')).toBeNull();
		expect(extractInlineRhizomeExpression('◊   \t\n  ')).toBeNull();
		expect(extractInlineRhizomeExpression('this.file.basename')).toBeNull();
		// Two leading & trailing spaces strip only one space -> normalized starts with ' ', not '◊'
		expect(extractInlineRhizomeExpression('  ◊ this.file.basename  ')).toBeNull();

		// Standard signet + ASCII space / NBSP / newline
		const simple = extractInlineRhizomeExpression('◊ this.file.basename');
		expect(simple).not.toBeNull();
		expect(simple?.expr).toBe('this.file.basename');
		expect(simple?.signetOffset).toBe(0);
		expect(simple?.exprOffsets[0]).toBe(2);
		expect(simple?.exprOffsets[simple.expr.length]).toBe('◊ this.file.basename'.length);

		const nbsp = extractInlineRhizomeExpression('◊\u00A0this.tags');
		expect(nbsp?.expr).toBe('this.tags');

		const multiline = extractInlineRhizomeExpression('◊\r\nthis.file.name');
		expect(multiline?.expr).toBe('this.file.name');
		expect(multiline?.exprOffsets[0]).toBe(3);

		// CommonMark multi-backtick single leading & trailing space stripping
		const paddedBacktick = extractInlineRhizomeExpression(' ◊ "ends with `" ');
		expect(paddedBacktick?.expr).toBe('"ends with `"');
		expect(paddedBacktick?.signetOffset).toBe(1);
		expect(paddedBacktick?.exprOffsets[0]).toBe(3);
		expect(paddedBacktick?.exprOffsets[paddedBacktick.expr.length]).toBe(16);

		// GFM table cell `\|` unescaping preserves exact raw character offsets
		const tableCell = extractInlineRhizomeExpression('◊ this.tags \\| join: ", "', {
			unescapeTablePipes: true,
		});
		expect(tableCell?.expr).toBe('this.tags | join: ", "');
		// In expr: index 10 is '|', which came from raw `\|` at [12, 14)
		expect(tableCell?.exprOffsets[10]).toBe(12);
		expect(tableCell?.exprOffsets[11]).toBe(14);
	});

	it('rejects unquoted Liquid delimiters, unclosed quotes, dangling pipes, and trailing tokens while allowing quoted delimiters', () => {
		const invalidExpressions = [
			'',
			'   ',
			'{% assign x = 1 %}',
			'this.title {% if true %}',
			'{{ this.title }}',
			'this.title }}',
			'this.title % }'.replace('% }', '%}'),
			'"unclosed double',
			"'unclosed single",
			'this.title |',
			'this.title |   ',
			'this.title = 1',
			'this.title, 2',
			'this.title)',
			'(1..5',
		];

		for (const expr of invalidExpressions) {
			const res = parseInlineRhizomeExpression(expr);
			expect(res.ok, `Expected "${expr}" to fail syntax check`).toBe(false);
			if (!res.ok) {
				expect(res.diagnostic.code).toBe('TEMPLATE_SYNTAX_ERROR');
				expect(res.diagnostic.hint).toBeTruthy();
			}
		}

		// Quoted Liquid delimiters are valid string literals
		const quotedTag = evaluateInlineRhizomeExpression('"{{ literal }} {% ok %}"', null);
		expect(quotedTag).toEqual({ ok: true, markdown: '{{ literal }} {% ok %}' });

		// Exercise LRU compilation cache past 256 entries without failure
		for (let i = 0; i < 270; i++) {
			const res = evaluateInlineRhizomeExpression(`${i} | plus: 1`, null);
			expect(res).toEqual({ ok: true, markdown: String(i + 1) });
		}
		// Re-hitting an entry refreshes LRU order cleanly
		expect(evaluateInlineRhizomeExpression('269 | plus: 1', null)).toEqual({
			ok: true,
			markdown: '270',
		});
	});

	it('evaluates host metadata, ambient globals, heading/payload filters, missing hosts, prototype guards, and output limits synchronously', () => {
		const hostMatch = {
			file: {
				path: 'Projects/Alpha.md',
				name: 'Alpha.md',
				basename: 'Alpha',
				folder: 'Projects',
			},
			tags: ['#active', '#roadmap'],
			properties: {
				status: 'in-progress',
				budget: 1200,
			},
			backlinks: [{ path: 'Goals/2026.md' }, { path: 'Daily/2026-11-22.md' }],
		};

		const runtimeCtx = {
			sourcePath: 'Projects/Alpha.md',
			referenceTimeMs: PINNED_REF_MS,
			timeZone: 'UTC',
			vault: 'Narradin',
			language: 'en',
			platform: { isDesktop: true, isMobile: false },
			headingLevel: 2,
		};

		expect(
			evaluateInlineRhizomeExpression('this.file.basename | upcase', hostMatch, runtimeCtx),
		).toEqual({ ok: true, markdown: 'ALPHA' });

		expect(
			evaluateInlineRhizomeExpression(
				'this.backlinks.size | append: " backlinks"',
				hostMatch,
				runtimeCtx,
			),
		).toEqual({ ok: true, markdown: '2 backlinks' });

		expect(
			evaluateInlineRhizomeExpression('this.tags | sentence', hostMatch, runtimeCtx),
		).toEqual({ ok: true, markdown: '#active and #roadmap' });

		expect(
			evaluateInlineRhizomeExpression('"Summary" | heading', hostMatch, runtimeCtx),
		).toEqual({ ok: true, markdown: '\n## Summary\n' });

		expect(
			evaluateInlineRhizomeExpression('"Summary" | heading: "demote"', hostMatch, runtimeCtx),
		).toEqual({ ok: true, markdown: '\n### Summary\n' });

		expect(
			evaluateInlineRhizomeExpression('today | date: "%Y-%m-%d"', hostMatch, runtimeCtx),
		).toEqual({ ok: true, markdown: '2026-11-22' });

		expect(
			evaluateInlineRhizomeExpression(
				'vault | append: ":" | append: language',
				hostMatch,
				runtimeCtx,
			),
		).toEqual({ ok: true, markdown: 'Narradin:en' });

		// Missing host note (`null`) evaluates `this.*` cleanly to empty string
		expect(evaluateInlineRhizomeExpression('this.file.basename', null, runtimeCtx)).toEqual({
			ok: true,
			markdown: '',
		});

		// `query.*` is empty `{}` at runtime (non-blocking)
		expect(
			evaluateInlineRhizomeExpression(
				'query.tasks.size | default: "none"',
				hostMatch,
				runtimeCtx,
			),
		).toEqual({ ok: true, markdown: 'none' });

		// Prototype pollution segments resolve safely to empty
		expect(evaluateInlineRhizomeExpression('this.__proto__', hostMatch, runtimeCtx)).toEqual({
			ok: true,
			markdown: '',
		});
		expect(
			evaluateInlineRhizomeExpression('this.properties.constructor', hostMatch, runtimeCtx),
		).toEqual({ ok: true, markdown: '' });

		// Output exceeding MAX_TEMPLATE_OUTPUT_CHARS fails cleanly with TEMPLATE_RENDER_ERROR
		const huge = 'x'.repeat(MAX_TEMPLATE_OUTPUT_CHARS / 2 + 10);
		const overflowRes = evaluateInlineRhizomeExpression(
			'this.properties.big | append: this.properties.big',
			{ properties: { big: huge } },
			runtimeCtx,
		);
		expect(overflowRes.ok).toBe(false);
		if (!overflowRes.ok) {
			expect(overflowRes.diagnostic.code).toBe('TEMPLATE_RENDER_ERROR');
		}
	});

	it('emits bounded syntax tokens, INLINE_QUERY_SCOPE_UNAVAILABLE warnings, and GFM pipe-mapped offsets', () => {
		expect(analyzeInlineRhizomeSpan('ordinary code')).toEqual({
			tokens: [],
			diagnostics: [],
		});

		const valid = analyzeInlineRhizomeSpan('◊ this.tags \\| default: "none" \\| join: ", "', {
			unescapeTablePipes: true,
		});
		expect(valid.diagnostics).toHaveLength(0);
		expect(valid.tokens[0]).toEqual({
			startOffset: 0,
			endOffset: 1,
			kind: 'liquid-delimiter',
		});
		// Verify `\| default` mapped back to rawInterior slice `\| default`
		const filterTok = valid.tokens.find((t) => t.kind === 'liquid-filter');
		expect(filterTok).toBeDefined();
		expect(
			'◊ this.tags \\| default: "none" \\| join: ", "'.slice(
				filterTok!.startOffset,
				filterTok!.endOffset,
			),
		).toBe('\\| default');

		// `query` / `query.*` root variable emits warning, while `this.properties.query` and `"query"` do not
		const withQueryScope = analyzeInlineRhizomeSpan('◊ query.tasks | size');
		expect(withQueryScope.diagnostics).toHaveLength(1);
		expect(withQueryScope.diagnostics[0]?.code).toBe('INLINE_QUERY_SCOPE_UNAVAILABLE');
		expect(withQueryScope.diagnostics[0]?.severity).toBe('warning');
		expect(
			'◊ query.tasks | size'.slice(
				withQueryScope.diagnostics[0]!.startOffset,
				withQueryScope.diagnostics[0]!.endOffset,
			),
		).toBe('query.tasks');

		expect(analyzeInlineRhizomeSpan('◊ this.properties.query').diagnostics).toHaveLength(0);
		expect(analyzeInlineRhizomeSpan('◊ "query.tasks"').diagnostics).toHaveLength(0);
		expect(analyzeInlineRhizomeSpan('◊ query_count').diagnostics).toHaveLength(0);
	});
});
