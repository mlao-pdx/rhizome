import { Lexer } from 'chevrotain';
import { describe, expect, it } from 'vitest';
import {
	ALL_TOKENS,
	collectReferencedPropertyKeys,
	containsRegexLeaf,
	decodeQuotedString,
	decodeRegexLiteral,
	decodeWikiLinkValue,
	deepFreezeAST,
	initEngineConfig,
	MAX_QUERY_LENGTH,
	MAX_SYNTACTIC_DEPTH,
	normalizeAST,
	parseQuery,
	SearchParser,
	substringStringMatch,
	testRegex,
	validateRegexLiteral,
	VIRTUAL_FILE_KEYS_LIST,
	type LogicalNode,
	type ScopedFilterNode,
	type TextMatchNode,
} from '../../src/core/search';

describe('Invariant 1a: Lexer & SearchParser self-analysis smoke test', () => {
	it('initializes new Lexer(ALL_TOKENS) and new SearchParser() with zero errors', () => {
		const lexer = new Lexer(ALL_TOKENS);
		expect(lexer.lexerDefinitionErrors).toEqual([]);

		const parser = new SearchParser();
		expect(parser.errors).toEqual([]);
	});

	it('lowers empty and whitespace-only queries to MATCH_ALL', () => {
		for (const q of ['', '   ', '\t\n  ']) {
			const res = parseQuery(q);
			expect(res.diagnostics).toEqual([]);
			expect(res.ast).toEqual({ type: 'MATCH_ALL' });
		}
	});
});

describe('Grammar Disambiguation & Conformance Scenarios', () => {
	it('Conformance Test 1: disambiguates tag:#work/urgent vs #work and normalizes identically', () => {
		const scopedRes = parseQuery('tag:#work/urgent');
		expect(scopedRes.diagnostics).toEqual([]);
		expect(scopedRes.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'tag',
			rawScope: 'tag',
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: '#work/urgent', quoted: false },
			},
		});

		const shortRes = parseQuery('#work/urgent');
		expect(shortRes.diagnostics).toEqual([]);
		expect(shortRes.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'tag',
			rawScope: '#',
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: '#work/urgent', quoted: false },
			},
		});

		const bareTagScopeRes = parseQuery('tag:work/urgent');
		expect(bareTagScopeRes.diagnostics).toEqual([]);
		expect(normalizeAST(scopedRes.ast!)).toEqual(normalizeAST(shortRes.ast!));
		expect(normalizeAST(bareTagScopeRes.ast!)).toEqual(normalizeAST(shortRes.ast!));
	});

	it('Conformance Test 2: lowers signed numeric RHS [score >= -10.5] via SignedIdentifier', () => {
		const res = parseQuery('[score >= -10.5]');
		expect(res.diagnostics).toEqual([]);
		expect(res.ast).toMatchObject({
			type: 'PROPERTY_FILTER',
			key: 'score',
			rawKey: 'score',
			operator: '>=',
			valueExpr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: '-10.5', quoted: false },
			},
		});
	});

	it('Conformance Test 3: disambiguates -draft vs file:-draft vs file:(-draft)', () => {
		const docNeg = parseQuery('-draft');
		expect(docNeg.diagnostics).toEqual([]);
		expect(docNeg.ast).toMatchObject({
			type: 'NOT',
			syntax: '-',
			child: {
				type: 'TEXT_MATCH',
				rawText: 'draft',
				matcher: { kind: 'string', value: 'draft', quoted: false },
			},
		});

		const signedLeaf = parseQuery('file:-draft');
		expect(signedLeaf.diagnostics).toEqual([]);
		expect(signedLeaf.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'file',
			rawScope: 'file',
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: '-draft', quoted: false },
			},
		});

		const valueNeg = parseQuery('file:(-draft)');
		expect(valueNeg.diagnostics).toEqual([]);
		expect(valueNeg.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'file',
			rawScope: 'file',
			expr: {
				type: 'VALUE_NOT',
				syntax: '-',
				child: {
					type: 'VALUE_LEAF',
					matcher: { kind: 'string', value: 'draft', quoted: false },
				},
			},
		});
	});

	it('Conformance Test 4: disambiguates path:"/projects/active" vs path:/projects/active vs path:Projects/Active/Archive', () => {
		const quotedPath = parseQuery('path:"/projects/active"');
		expect(quotedPath.diagnostics).toEqual([]);
		expect(quotedPath.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'path',
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: '/projects/active', quoted: true },
			},
		});

		const regexPath = parseQuery('path:/projects/active');
		expect(regexPath.diagnostics).toEqual([]);
		expect(regexPath.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'path',
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'regex', pattern: 'projects', flags: 'active' },
			},
		});

		const unquotedPath = parseQuery('path:Projects/Active/Archive');
		expect(unquotedPath.diagnostics).toEqual([]);
		expect(unquotedPath.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'path',
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: 'Projects/Active/Archive', quoted: false },
			},
		});
	});

	it('Conformance Test 8: lowers headings:(Intro AND Summary) and value-level OR/NOT expressions', () => {
		const res = parseQuery('headings:(Intro AND Summary OR NOT Appendix)');
		expect(res.diagnostics).toEqual([]);
		expect(res.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'headings',
			rawScope: 'headings',
			expr: {
				type: 'VALUE_LOGICAL',
				operator: 'OR',
				children: [
					{
						type: 'VALUE_LOGICAL',
						operator: 'AND',
						children: [
							{
								type: 'VALUE_LEAF',
								matcher: { kind: 'string', value: 'Intro', quoted: false },
							},
							{
								type: 'VALUE_LEAF',
								matcher: { kind: 'string', value: 'Summary', quoted: false },
							},
						],
					},
					{
						type: 'VALUE_NOT',
						syntax: 'NOT',
						child: {
							type: 'VALUE_LEAF',
							matcher: { kind: 'string', value: 'Appendix', quoted: false },
						},
					},
				],
			},
		});
	});

	it('Conformance Test 11b: lowers links:[[Notes/A|Custom Label]] and emits HINT_WIKILINK_BRACKETS_IN_SCOPE', () => {
		const res = parseQuery('links:[[Notes/A|Custom Label]]');
		expect(res.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'links',
			rawScope: 'links',
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: 'Notes/A', quoted: true },
			},
		});
		expect(res.diagnostics).toEqual([
			{
				code: 'HINT_WIKILINK_BRACKETS_IN_SCOPE',
				severity: 'hint',
				issue: 'Wikilink brackets "[[...]]" are not needed.',
				hint: 'Stripped "[[...]]" automatically.',
				span: {
					startOffset: 6,
					endOffset: 30,
					startLine: 1,
					startColumn: 7,
				},
			},
		]);

		// Also supports WikiLinkValue inside parenthesized ValueOrExpr
		const groupRes = parseQuery('links:([[Notes/A]] OR [[Notes/B|Bee]])');
		expect(groupRes.ast).not.toBeNull();
		expect(groupRes.diagnostics).toHaveLength(2);
		expect(
			groupRes.diagnostics.every((d) => d.code === 'HINT_WIKILINK_BRACKETS_IN_SCOPE'),
		).toBe(true);
	});

	it('resolves scope aliases using resolvedConfig when provided and preserves unknown scope names for Phase 5 validation', () => {
		const cfgRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: {},
			customScopes: [
				{
					canonicalName: 'tasks',
					aliases: ['task', 'todo'],
					extract: () => [],
					matchString: substringStringMatch,
				},
			],
		});
		if (!cfgRes.ok) throw new Error('Expected valid config');

		const customRes = parseQuery('todo:urgent', cfgRes.config);
		expect(customRes.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'tasks',
			rawScope: 'todo',
		});

		const aliasRes = parseQuery('filename:Note');
		expect(aliasRes.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'file',
			rawScope: 'filename',
		});

		const unknownRes = parseQuery('unknownScope:val', cfgRes.config);
		expect(unknownRes.ast).toMatchObject({
			type: 'SCOPED_FILTER',
			scope: 'unknownScope',
			rawScope: 'unknownScope',
		});
	});

	it('sets parenthesized: true on parenthesized LogicalNode and preserves spans', () => {
		const res = parseQuery('(a AND b) OR c');
		expect(res.diagnostics).toEqual([]);
		expect(res.ast).toMatchObject({
			type: 'LOGICAL',
			operator: 'OR',
			children: [
				{
					type: 'LOGICAL',
					operator: 'AND',
					parenthesized: true,
					span: { startOffset: 0, endOffset: 9, startLine: 1, startColumn: 1 },
				},
				{
					type: 'TEXT_MATCH',
					rawText: 'c',
				},
			],
		});
	});
});

describe('Resource Limits & Syntax Error Boundaries', () => {
	it('enforces MAX_QUERY_LENGTH (4096 chars succeeds; 4097 fails with SYNTAX_ERROR before lexing)', () => {
		const exact4096 = 'a'.repeat(MAX_QUERY_LENGTH);
		const okRes = parseQuery(exact4096);
		expect(okRes.diagnostics).toEqual([]);
		expect(okRes.ast).toMatchObject({
			type: 'TEXT_MATCH',
			rawText: exact4096,
		});

		const over4097 = 'a'.repeat(MAX_QUERY_LENGTH + 1);
		const errRes = parseQuery(over4097);
		expect(errRes.ast).toBeNull();
		expect(errRes.diagnostics).toHaveLength(1);
		expect(errRes.diagnostics[0]).toMatchObject({
			code: 'SYNTAX_ERROR',
			severity: 'error',
			span: {
				startOffset: 4096,
				endOffset: 4097,
				startLine: 1,
				startColumn: 4097,
			},
		});
	});

	it('enforces MAX_SYNTACTIC_DEPTH = 32 across unary negation, parentheses, and value-level expressions', () => {
		// Document-level unary negation at depth 32 succeeds; 33 fails
		expect(parseQuery(`${'-'.repeat(MAX_SYNTACTIC_DEPTH)}a`).ast).not.toBeNull();
		const neg33 = parseQuery(`${'-'.repeat(MAX_SYNTACTIC_DEPTH + 1)}a`);
		expect(neg33.ast).toBeNull();
		expect(neg33.diagnostics[0]?.code).toBe('SYNTAX_ERROR');

		// Document-level parenthesized group at depth 32 succeeds; 33 fails
		const paren32 = `${'('.repeat(MAX_SYNTACTIC_DEPTH)}a${')'.repeat(MAX_SYNTACTIC_DEPTH)}`;
		expect(parseQuery(paren32).ast).not.toBeNull();
		const paren33 = `${'('.repeat(MAX_SYNTACTIC_DEPTH + 1)}a${')'.repeat(MAX_SYNTACTIC_DEPTH + 1)}`;
		const paren33Res = parseQuery(paren33);
		expect(paren33Res.ast).toBeNull();
		expect(paren33Res.diagnostics[0]?.code).toBe('SYNTAX_ERROR');

		// Value-level negation and parentheses inside scope:(...)
		const val32 = `tag:(${'-'.repeat(16)}${'('.repeat(16)}work${')'.repeat(16)})`;
		expect(parseQuery(val32).ast).not.toBeNull();
		const val33 = `tag:(${'-'.repeat(17)}${'('.repeat(16)}work${')'.repeat(16)})`;
		expect(parseQuery(val33).ast).toBeNull();

		// >32 sequential non-nested groups succeed because depth is decremented on exit
		const sequential40 = Array.from({ length: 40 }, (_, i) => `(-term${i})`).join(' ');
		const seqRes = parseQuery(sequential40);
		expect(seqRes.diagnostics).toEqual([]);
		expect(seqRes.ast).not.toBeNull();
	});

	it('rejects spaced hyphen in comparison RHS [score = - 5] and lone hyphen [score = -] with SYNTAX_ERROR', () => {
		for (const bad of ['[score = - 5]', '[score = -]', '(', 'NOT', 'unclosed "quote']) {
			const res = parseQuery(bad);
			expect(res.ast).toBeNull();
			expect(res.diagnostics.length).toBeGreaterThan(0);
			expect(res.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
			expect(res.diagnostics[0]?.span).not.toBeNull();
			const span = res.diagnostics[0]!.span!;
			expect(Number.isSafeInteger(span.startOffset)).toBe(true);
			expect(Number.isSafeInteger(span.endOffset)).toBe(true);
			expect(Number.isSafeInteger(span.startLine)).toBe(true);
			expect(Number.isSafeInteger(span.startColumn)).toBe(true);
			// Verify JSON round-trip safety (no NaN or undefined)
			expect(JSON.parse(JSON.stringify(res.diagnostics))).toEqual(res.diagnostics);
		}
	});

	// Promoted from fast-check finding: search/parser__fuzz-totality-error-gating-and-span-integrity
	// seed=65383671 path="33:10"
	it('regression: search/parser__fuzz-totality-error-gating-and-span-integrity counterexample', () => {
		const args = ['['] as const;
		const res = parseQuery(args[0]);
		expect(res.ast).toBeNull();
		expect(res.diagnostics).toHaveLength(1);
		const span = res.diagnostics[0]!.span!;
		expect(span.startOffset).toBeGreaterThanOrEqual(0);
		expect(span.endOffset).toBeGreaterThanOrEqual(span.startOffset);
		expect(span.endOffset).toBeLessThanOrEqual(args[0].length);
		expect(span).toEqual({
			startOffset: 0,
			endOffset: 1,
			startLine: 1,
			startColumn: 1,
		});
	});

	it('rejects empty WikiLinkValue targets and empty PropertyKeys with SYNTAX_ERROR and discards non-error hints', () => {
		for (const badWiki of [
			'links:[[]]',
			'links:[[   ]]',
			'links:[[|Custom Label]]',
			'links:[[   |Label]]',
			'links:[[Notes/A]] AND links:[[|alias]]',
		]) {
			const res = parseQuery(badWiki);
			expect(res.ast).toBeNull();
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
		}

		for (const badProp of ['[""]', '["   " = 1]', "['']"]) {
			const res = parseQuery(badProp);
			expect(res.ast).toBeNull();
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
		}
	});

	it('emits WARN_UNQUOTED_MULTIWORD_SCOPE only for adjacent unquoted scope + bare term on the same line without explicit AND', () => {
		const warnRes = parseQuery('headings:Action Items');
		expect(warnRes.ast).not.toBeNull();
		expect(warnRes.diagnostics).toEqual([
			{
				code: 'WARN_UNQUOTED_MULTIWORD_SCOPE',
				severity: 'warning',
				issue: '"Items" is searched as a separate term, not inside "headings:".',
				hint: 'Use headings:"Action Items"',
				span: {
					startOffset: 0,
					endOffset: 21,
					startLine: 1,
					startColumn: 1,
				},
			},
		]);

		// Suppressed cases: explicit AND, quoted scope value, parenthesized scope, parenthesized RHS, tag shorthand, next line
		for (const cleanQuery of [
			'headings:Action AND Items',
			'headings:"Action Items"',
			'(headings:Action) Items',
			'headings:(Action) Items',
			'#work urgent',
			'headings:Action\nItems',
		]) {
			const res = parseQuery(cleanQuery);
			expect(res.ast).not.toBeNull();
			expect(res.diagnostics).toEqual([]);
		}
	});
});

describe('Literal Decoders, RegExp Validator, deepFreezeAST, normalizeAST & collectReferencedPropertyKeys', () => {
	it('decodes escapes in decodeQuotedString and preserves unknown escapes literally', () => {
		expect(decodeQuotedString('"hello \\"world\\" \\\\ \\n\\r\\t \\x"')).toBe(
			'hello "world" \\ \n\r\t \\x',
		);
		expect(decodeQuotedString("'it\\'s a \\'test\\''")).toBe("it's a 'test'");
	});

	it('extracts pattern and flags in decodeRegexLiteral and validates with validateRegexLiteral and testRegex', () => {
		expect(decodeRegexLiteral('/foo\\/bar/im')).toEqual({
			pattern: 'foo\\/bar',
			flags: 'im',
		});
		expect(decodeWikiLinkValue('[[ Folder/Note | Alias Text ]]')).toBe('Folder/Note');

		expect(validateRegexLiteral('^sprint-\\d+$', 'imsu')).toBeInstanceOf(RegExp);
		expect(validateRegexLiteral('foo', 'g')).toBeNull();
		expect(validateRegexLiteral('foo', 'ii')).toBeNull();
		expect(validateRegexLiteral('[unclosed', '')).toBeNull();

		expect(
			testRegex('Sprint-12', { kind: 'regex', pattern: '^sprint-\\d+$', flags: 'i' }),
		).toBe(true);
		expect(() => testRegex('Sprint-12', { kind: 'regex', pattern: '(', flags: '' })).toThrow(
			/Invalid regex literal/,
		);
	});

	it('deeply freezes all AST nodes, children arrays, matchers, and spans via deepFreezeAST', () => {
		const res = parseQuery('headings:(Intro OR /sum.*/i) AND -[status = "active"] AND note');
		expect(res.ast).not.toBeNull();
		const frozen = deepFreezeAST(res.ast!);

		expect(Object.isFrozen(frozen)).toBe(true);
		const logical = frozen as LogicalNode;
		expect(Object.isFrozen(logical.children)).toBe(true);
		expect(Object.isFrozen(logical.span)).toBe(true);

		expect(() => {
			(logical.children as unknown[]).push({ type: 'MATCH_ALL' });
		}).toThrow(TypeError);

		const scoped = logical.children[0] as ScopedFilterNode;
		expect(Object.isFrozen(scoped.expr)).toBe(true);
		expect(containsRegexLeaf(scoped.expr)).toBe(true);

		const textNode = logical.children[2] as TextMatchNode;
		expect(Object.isFrozen(textNode.matcher)).toBe(true);
		expect(() => {
			(textNode.matcher as { value: string }).value = 'mutated';
		}).toThrow(TypeError);

		expect(Object.isFrozen(deepFreezeAST({ type: 'MATCH_ALL' }))).toBe(true);
	});

	it('normalizes ASTs idempotently and flattens nested logical operators in normalizeAST', () => {
		const q1 = parseQuery('((a AND b) AND c) AND -d AND #work AND ["Status" = 1]');
		const q2 = parseQuery('a AND (b AND c) AND NOT d AND tag:work AND [status = 1]');
		expect(q1.ast).not.toBeNull();
		expect(q2.ast).not.toBeNull();

		const norm1 = normalizeAST(q1.ast!);
		const norm2 = normalizeAST(q2.ast!);
		expect(norm1).toEqual(norm2);
		expect(normalizeAST(norm1)).toEqual(norm1);

		// Value-level logical flattening and single-child unwrapping
		const v1 = parseQuery('headings:((a AND b) AND -c)');
		const v2 = parseQuery('header:(a AND b AND NOT c)');
		expect(normalizeAST(v1.ast!)).toEqual(normalizeAST(v2.ast!));
	});

	it('collects only non-virtual property keys across the entire AST in collectReferencedPropertyKeys', () => {
		const virtualFilters = VIRTUAL_FILE_KEYS_LIST.map((k) => `[${k}]`).join(' AND ');
		const query = `${virtualFilters} AND [Status = "done"] AND -["Due Date" < 2026-01-01] OR [priority]`;
		const res = parseQuery(query);
		expect(res.ast).not.toBeNull();

		const keys = collectReferencedPropertyKeys(res.ast!);
		expect(Array.from(keys).sort()).toEqual(['due date', 'priority', 'status']);
	});
});
