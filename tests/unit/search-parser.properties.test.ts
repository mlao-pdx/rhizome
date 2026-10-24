import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	BUILT_IN_SCOPES,
	collectReferencedPropertyKeys,
	decodeQuotedString,
	deepFreezeAST,
	initEngineConfig,
	isVirtualFileKey,
	MAX_QUERY_LENGTH,
	MAX_SYNTACTIC_DEPTH,
	normalizeAST,
	parseQuery,
	parseTemporalExpr,
	resolveQueryPropertyType,
	SearchLexer,
	validateRegexLiteral,
	VIRTUAL_FILE_KEYS_LIST,
	type LeafMatcher,
	type PropertyFilterNode,
	type PropertyOperator,
	type ResolvedEngineConfig,
	type ScopedFilterNode,
	type SearchAST,
	type SourceSpan,
	type TextMatchNode,
	type ValueExprAST,
} from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

function encodeDoubleQuoted(s: string): string {
	let out = '"';
	for (const ch of s) {
		if (ch === '\\') out += '\\\\';
		else if (ch === '"') out += '\\"';
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else out += ch;
	}
	return out + '"';
}

function encodeSingleQuoted(s: string): string {
	let out = "'";
	for (const ch of s) {
		if (ch === '\\') out += '\\\\';
		else if (ch === "'") out += "\\'";
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else out += ch;
	}
	return out + "'";
}

function printLeafMatcher(matcher: LeafMatcher): string {
	if (matcher.kind === 'regex') {
		return `/${matcher.pattern}/${matcher.flags}`;
	}
	return matcher.quoted ? encodeDoubleQuoted(matcher.value) : matcher.value;
}

function printValueExpr(expr: ValueExprAST, parentOp?: 'AND' | 'OR' | 'NOT'): string {
	switch (expr.type) {
		case 'VALUE_LEAF':
			return printLeafMatcher(expr.matcher);
		case 'VALUE_NOT': {
			const childStr =
				expr.child.type === 'VALUE_LOGICAL'
					? `(${printValueExpr(expr.child)})`
					: printValueExpr(expr.child, 'NOT');
			return expr.syntax === '-' ? `-${childStr}` : `NOT ${childStr}`;
		}
		case 'VALUE_LOGICAL': {
			const joined = expr.children
				.map((c) => printValueExpr(c, expr.operator))
				.join(` ${expr.operator} `);
			if (parentOp && parentOp !== expr.operator) {
				return `(${joined})`;
			}
			return joined;
		}
	}
}

function printPropertyKey(rawKey: string): string {
	if (/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(rawKey) && !/^(?:AND|OR|NOT)$/.test(rawKey)) {
		return rawKey;
	}
	return encodeDoubleQuoted(rawKey);
}

/**
 * Pretty-prints a printable `SearchAST` into a valid query string per Section 6.1 Invariant 5.
 */
export function printAST(ast: SearchAST, parentOp?: 'AND' | 'OR' | 'NOT'): string {
	switch (ast.type) {
		case 'MATCH_ALL':
			return '';
		case 'TEXT_MATCH':
			return printLeafMatcher(ast.matcher);
		case 'NOT': {
			const childStr =
				ast.child.type === 'LOGICAL'
					? `(${printAST(ast.child)})`
					: printAST(ast.child, 'NOT');
			return ast.syntax === '-' ? `-${childStr}` : `NOT ${childStr}`;
		}
		case 'SCOPED_FILTER': {
			if (
				ast.rawScope === '#' &&
				ast.expr.type === 'VALUE_LEAF' &&
				ast.expr.matcher.kind === 'string' &&
				!ast.expr.matcher.quoted &&
				ast.expr.matcher.value.startsWith('#')
			) {
				return ast.expr.matcher.value;
			}
			const scopeName = ast.rawScope === '#' ? 'tag' : ast.scope;
			if (ast.expr.type === 'VALUE_LEAF') {
				return `${scopeName}:${printLeafMatcher(ast.expr.matcher)}`;
			}
			return `${scopeName}:(${printValueExpr(ast.expr)})`;
		}
		case 'PROPERTY_FILTER': {
			const keyStr = printPropertyKey(ast.rawKey);
			if (ast.operator === 'EXISTS') {
				return `[${keyStr}]`;
			}
			if (ast.operator === ':') {
				const rhs = ast.valueExpr!;
				if (rhs.type === 'VALUE_LEAF') {
					return `[${keyStr}:${printLeafMatcher(rhs.matcher)}]`;
				}
				return `[${keyStr}:(${printValueExpr(rhs)})]`;
			}
			return `[${keyStr} ${ast.operator} ${printValueExpr(ast.valueExpr!)}]`;
		}
		case 'LOGICAL': {
			const joined = ast.children
				.map((c) => printAST(c, ast.operator))
				.join(` ${ast.operator} `);
			if (ast.parenthesized || (parentOp && parentOp !== ast.operator)) {
				return `(${joined})`;
			}
			return joined;
		}
	}
}

function computeSyntacticDepthValueExpr(
	expr: ValueExprAST,
	parentOp?: 'AND' | 'OR' | 'NOT',
): number {
	switch (expr.type) {
		case 'VALUE_LEAF':
			return 0;
		case 'VALUE_NOT': {
			const needsParens = expr.child.type === 'VALUE_LOGICAL';
			return (
				1 +
				(needsParens ? 1 : 0) +
				computeSyntacticDepthValueExpr(expr.child, needsParens ? undefined : 'NOT')
			);
		}
		case 'VALUE_LOGICAL': {
			const needsParens = Boolean(parentOp && parentOp !== expr.operator);
			const maxChild = Math.max(
				0,
				...expr.children.map((c) => computeSyntacticDepthValueExpr(c, expr.operator)),
			);
			return (needsParens ? 1 : 0) + maxChild;
		}
	}
}

function computeSyntacticDepth(ast: SearchAST, parentOp?: 'AND' | 'OR' | 'NOT'): number {
	switch (ast.type) {
		case 'MATCH_ALL':
		case 'TEXT_MATCH':
			return 0;
		case 'NOT': {
			const needsParens = ast.child.type === 'LOGICAL';
			return (
				1 +
				(needsParens ? 1 : 0) +
				computeSyntacticDepth(ast.child, needsParens ? undefined : 'NOT')
			);
		}
		case 'SCOPED_FILTER':
			return computeSyntacticDepthValueExpr(ast.expr);
		case 'PROPERTY_FILTER':
			return ast.valueExpr ? computeSyntacticDepthValueExpr(ast.valueExpr) : 0;
		case 'LOGICAL': {
			const needsParens = Boolean(
				ast.parenthesized || (parentOp && parentOp !== ast.operator),
			);
			const maxChild = Math.max(
				0,
				...ast.children.map((c) => computeSyntacticDepth(c, ast.operator)),
			);
			return (needsParens ? 1 : 0) + maxChild;
		}
	}
}

const unquotedIdentifierArb: fc.Arbitrary<string> = fc
	.tuple(
		fc.constantFrom('a', 'b', 'c', 'note', 'work', 'sprint', 'draft', 'project', 'alpha', '_x'),
		fc.stringMatching(/^[a-zA-Z0-9_-]{0,8}$/),
	)
	.map(([head, tail]) => `${head}${tail}`)
	.filter((s) => s !== 'AND' && s !== 'OR' && s !== 'NOT');

const quotedValueArb: fc.Arbitrary<string> = fc.oneof(
	fc.string({ maxLength: 16 }),
	fc.constantFrom(
		'Action Items',
		'/projects/active',
		'quote "in" text',
		'line1\nline2\tindent',
		'back\\slash',
		'',
	),
);

const regexAtomArb: fc.Arbitrary<string> = fc.oneof(
	fc.constantFrom('note', 'sprint', 'work', '[a-z]', '[0-9]', '\\.', '\\/', '\\-'),
	fc.stringMatching(/^[a-zA-Z0-9]{1,6}$/),
);

const structuralRegexMatcherArb: fc.Arbitrary<Extract<LeafMatcher, { kind: 'regex' }>> = fc
	.tuple(
		fc.boolean(),
		fc.array(regexAtomArb, { minLength: 1, maxLength: 3 }),
		fc.boolean(),
		fc.subarray(['i', 'm', 's', 'u'], { minLength: 0, maxLength: 3 }),
	)
	.map(([caret, atoms, dollar, flagList]) => {
		const pattern = `${caret ? '^' : ''}${atoms.join('')}${dollar ? '$' : ''}`;
		const flags = flagList.join('');
		return { kind: 'regex' as const, pattern, flags };
	})
	.filter((m) => validateRegexLiteral(m.pattern, m.flags) !== null);

const unsignedLeafMatcherArb: fc.Arbitrary<LeafMatcher> = fc.oneof(
	unquotedIdentifierArb.map((value) => ({ kind: 'string' as const, value, quoted: false })),
	quotedValueArb.map((value) => ({ kind: 'string' as const, value, quoted: true })),
	structuralRegexMatcherArb,
);

const rhsLeafMatcherArb: fc.Arbitrary<LeafMatcher> = fc.oneof(
	unsignedLeafMatcherArb,
	unquotedIdentifierArb.map((id) => ({
		kind: 'string' as const,
		value: `-${id}`,
		quoted: false,
	})),
);

function buildValueExprArb(maxDepth: number): fc.Arbitrary<ValueExprAST> {
	const leafArb: fc.Arbitrary<ValueExprAST> = unsignedLeafMatcherArb.map((matcher) => ({
		type: 'VALUE_LEAF' as const,
		matcher,
	}));
	if (maxDepth <= 0) return leafArb;

	const subArb = buildValueExprArb(maxDepth - 1);
	const notArb: fc.Arbitrary<ValueExprAST> = fc
		.tuple(fc.constantFrom('NOT' as const, '-' as const), subArb)
		.map(([syntax, child]) => ({
			type: 'VALUE_NOT' as const,
			syntax,
			child,
		}));
	const logicalArb: fc.Arbitrary<ValueExprAST> = fc
		.tuple(
			fc.constantFrom('AND' as const, 'OR' as const),
			fc.array(subArb, { minLength: 2, maxLength: 3 }),
		)
		.map(([operator, children]) => ({
			type: 'VALUE_LOGICAL' as const,
			operator,
			children,
		}));

	return fc.oneof({ weight: 3, arbitrary: leafArb }, notArb, logicalArb);
}

function buildPrintableExecutableAstArb(
	resolvedConfig: ResolvedEngineConfig,
	refMs: number,
): fc.Arbitrary<SearchAST> {
	const scopeNames = BUILT_IN_SCOPES.map((s) => s.canonicalName);
	const propKeys = [
		...Object.keys(resolvedConfig.propertyTypes),
		'status',
		'category',
		'Due Date',
		...VIRTUAL_FILE_KEYS_LIST,
	];

	const numberLiteralArb = fc
		.tuple(
			fc.boolean(),
			fc.integer({ min: 0, max: 99999 }),
			fc.option(fc.integer({ min: 0, max: 999 }), { nil: null }),
		)
		.map(([neg, intPart, frac]) => {
			const sign = neg && (intPart > 0 || (frac !== null && frac > 0)) ? '-' : '';
			return `${sign}${intPart}${frac !== null ? `.${frac}` : ''}`;
		});

	const validTemporalLiteralArb = fc
		.constantFrom(
			'2026',
			'2026-10',
			'2026-10-22',
			'2026-10-22T14:00:00Z',
			'2026-01-01..2026-10-22',
			'@today',
			'@yesterday',
			'@thisweek',
			'@thismonth',
			'@thisyear..@today',
			'@today-7d..@today',
		)
		.filter(
			(lit) =>
				parseTemporalExpr(lit, {
					allowYearOnly: true,
					allowRelative: true,
					timeZone: resolvedConfig.timeZone,
					referenceTimeMs: refMs,
				}).ok,
		);

	const scopedFilterArb: fc.Arbitrary<ScopedFilterNode> = fc
		.tuple(
			fc.constantFrom(...scopeNames),
			fc.boolean(),
			fc.oneof(
				rhsLeafMatcherArb.map((matcher) => ({
					type: 'VALUE_LEAF' as const,
					matcher,
				})),
				buildValueExprArb(2),
			),
		)
		.map(([scope, useHashShorthand, expr]) => {
			if (scope === 'tag' && useHashShorthand) {
				return {
					type: 'SCOPED_FILTER' as const,
					scope: 'tag',
					rawScope: '#',
					expr: {
						type: 'VALUE_LEAF' as const,
						matcher: { kind: 'string' as const, value: '#work/urgent', quoted: false },
					},
				};
			}
			return {
				type: 'SCOPED_FILTER' as const,
				scope,
				rawScope: scope,
				expr,
			};
		});

	const propOperatorArb: fc.Arbitrary<PropertyOperator> = fc.constantFrom(
		'EXISTS',
		':',
		'=',
		'!=',
		'<',
		'>',
		'<=',
		'>=',
	);

	const propertyFilterArb: fc.Arbitrary<PropertyFilterNode> = fc
		.tuple(fc.constantFrom(...propKeys), propOperatorArb)
		.chain(([rawKey, requestedOp]) => {
			const key = rawKey.trim().toLowerCase();
			const propType = resolveQueryPropertyType(key, resolvedConfig.propertyTypes);
			const op: PropertyOperator =
				propType === 'checkbox' &&
				(requestedOp === '<' ||
					requestedOp === '>' ||
					requestedOp === '<=' ||
					requestedOp === '>=')
					? '='
					: requestedOp;

			if (op === 'EXISTS') {
				return fc.constant<PropertyFilterNode>({
					type: 'PROPERTY_FILTER',
					key,
					rawKey,
					operator: 'EXISTS',
				});
			}

			if (op === ':') {
				const valueArb =
					propType === 'checkbox'
						? fc.constantFrom('true', 'false').map((v): ValueExprAST => ({
								type: 'VALUE_LEAF',
								matcher: { kind: 'string', value: v, quoted: false },
							}))
						: fc.oneof(
								rhsLeafMatcherArb.map((matcher): ValueExprAST => ({
									type: 'VALUE_LEAF',
									matcher,
								})),
								buildValueExprArb(2),
							);
				return valueArb.map((valueExpr) => ({
					type: 'PROPERTY_FILTER' as const,
					key,
					rawKey,
					operator: ':' as const,
					valueExpr,
				}));
			}

			// Comparison operators: =, !=, <, >, <=, >=
			let leafMatcherGen: fc.Arbitrary<LeafMatcher>;
			if (propType === 'number') {
				leafMatcherGen = numberLiteralArb.map((value) => ({
					kind: 'string' as const,
					value,
					quoted: false,
				}));
			} else if (propType === 'checkbox') {
				leafMatcherGen = fc.constantFrom('true', 'false').map((value) => ({
					kind: 'string' as const,
					value,
					quoted: false,
				}));
			} else if (propType === 'date' || propType === 'datetime') {
				leafMatcherGen = validTemporalLiteralArb.map((value) => ({
					kind: 'string' as const,
					value,
					quoted: false,
				}));
			} else {
				leafMatcherGen = fc.oneof(
					unquotedIdentifierArb.map((value) => ({
						kind: 'string' as const,
						value,
						quoted: false,
					})),
					quotedValueArb.map((value) => ({
						kind: 'string' as const,
						value,
						quoted: true,
					})),
				);
			}

			return leafMatcherGen.map((matcher) => ({
				type: 'PROPERTY_FILTER' as const,
				key,
				rawKey,
				operator: op,
				valueExpr: {
					type: 'VALUE_LEAF' as const,
					matcher,
				},
			}));
		});

	const textMatchArb: fc.Arbitrary<TextMatchNode> = unsignedLeafMatcherArb.map((matcher) => ({
		type: 'TEXT_MATCH' as const,
		matcher,
		rawText: printLeafMatcher(matcher),
	}));

	const atomAstArb: fc.Arbitrary<SearchAST> = fc.oneof(
		scopedFilterArb,
		propertyFilterArb,
		textMatchArb,
	);

	function buildAstRec(depth: number): fc.Arbitrary<SearchAST> {
		if (depth <= 0) return atomAstArb;
		const subArb = buildAstRec(depth - 1);
		const notArb: fc.Arbitrary<SearchAST> = fc
			.tuple(fc.constantFrom('NOT' as const, '-' as const), subArb)
			.map(([syntax, child]) => ({
				type: 'NOT' as const,
				syntax,
				child,
			}));
		const logicalArb: fc.Arbitrary<SearchAST> = fc
			.tuple(
				fc.constantFrom('AND' as const, 'OR' as const),
				fc.boolean(),
				fc.array(subArb, { minLength: 2, maxLength: 3 }),
			)
			.map(([operator, parenthesized, children]) => ({
				type: 'LOGICAL' as const,
				operator,
				...(parenthesized ? { parenthesized: true } : {}),
				children,
			}));
		return fc.oneof({ weight: 3, arbitrary: atomAstArb }, notArb, logicalArb);
	}

	return fc
		.oneof(fc.constant<SearchAST>({ type: 'MATCH_ALL' }), buildAstRec(3))
		.filter(
			(ast) =>
				printAST(ast).length <= MAX_QUERY_LENGTH &&
				computeSyntacticDepth(ast) <= MAX_SYNTACTIC_DEPTH,
		);
}

function assertValidSpan(span: SourceSpan, inputLength: number): void {
	expect(Number.isSafeInteger(span.startOffset)).toBe(true);
	expect(Number.isSafeInteger(span.endOffset)).toBe(true);
	expect(Number.isSafeInteger(span.startLine)).toBe(true);
	expect(Number.isSafeInteger(span.startColumn)).toBe(true);
	expect(span.startOffset).toBeGreaterThanOrEqual(0);
	expect(span.endOffset).toBeGreaterThanOrEqual(span.startOffset);
	expect(span.endOffset).toBeLessThanOrEqual(inputLength);
	expect(span.startLine).toBeGreaterThanOrEqual(1);
	expect(span.startColumn).toBeGreaterThanOrEqual(1);
}

function assertAstSpansAndFreeze(ast: SearchAST, inputLength: number, checkFrozen: boolean): void {
	if (checkFrozen) {
		expect(Object.isFrozen(ast)).toBe(true);
	}
	if (ast.type === 'MATCH_ALL') return;
	if (ast.span) {
		if (checkFrozen) expect(Object.isFrozen(ast.span)).toBe(true);
		assertValidSpan(ast.span, inputLength);
	}
	switch (ast.type) {
		case 'TEXT_MATCH':
			if (checkFrozen) expect(Object.isFrozen(ast.matcher)).toBe(true);
			return;
		case 'NOT':
			assertAstSpansAndFreeze(ast.child, inputLength, checkFrozen);
			return;
		case 'SCOPED_FILTER':
			if (checkFrozen) assertValueExprFrozen(ast.expr);
			return;
		case 'PROPERTY_FILTER':
			if (checkFrozen && ast.valueExpr) assertValueExprFrozen(ast.valueExpr);
			return;
		case 'LOGICAL':
			if (checkFrozen) expect(Object.isFrozen(ast.children)).toBe(true);
			for (const c of ast.children) {
				assertAstSpansAndFreeze(c, inputLength, checkFrozen);
			}
			return;
	}
}

function assertValueExprFrozen(expr: ValueExprAST): void {
	expect(Object.isFrozen(expr)).toBe(true);
	if (expr.type === 'VALUE_LEAF') {
		expect(Object.isFrozen(expr.matcher)).toBe(true);
	} else if (expr.type === 'VALUE_NOT') {
		assertValueExprFrozen(expr.child);
	} else {
		expect(Object.isFrozen(expr.children)).toBe(true);
		for (const c of expr.children) assertValueExprFrozen(c);
	}
}

function collectExpectedPropertyKeysFromTree(ast: SearchAST, acc = new Set<string>()): Set<string> {
	if (ast.type === 'PROPERTY_FILTER') {
		const k = ast.key.trim().toLowerCase();
		if (!isVirtualFileKey(k)) acc.add(k);
	} else if (ast.type === 'NOT') {
		collectExpectedPropertyKeysFromTree(ast.child, acc);
	} else if (ast.type === 'LOGICAL') {
		for (const c of ast.children) collectExpectedPropertyKeysFromTree(c, acc);
	}
	return acc;
}

describe('Phase 4 parser, AST normalizer, literal decoder & fuzz invariants', () => {
	const cfgRes = initEngineConfig({
		timeZone: 'America/New_York',
		propertyTypes: {
			score: 'number',
			priority: 'number',
			meeting: 'datetime',
			due: 'date',
			done: 'checkbox',
			status: 'text',
		},
	});
	if (!cfgRes.ok) throw new Error('Expected valid config');
	const resolvedConfig = cfgRes.config;
	const printableAstArb = buildPrintableExecutableAstArb(resolvedConfig, PINNED_REF_MS);

	it('Invariant 5: printable executable AST round-trip (normalizeAST(parseQuery(printAST(ast)).ast) === normalizeAST(ast)) and normalizeAST idempotence', async () => {
		await assertProperty(
			'search/parser__printable-ast-roundtrip-and-normalize-idempotence',
			fc.property(printableAstArb, (ast) => {
				const norm1 = normalizeAST(ast);
				const norm2 = normalizeAST(norm1);
				// 1. normalizeAST idempotence
				expect(norm2).toEqual(norm1);

				// 2. Print + parse round-trip
				const printed = printAST(ast);
				const parsed = parseQuery(printed, resolvedConfig);
				expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
				expect(parsed.ast).not.toBeNull();

				const normParsed = normalizeAST(parsed.ast!);
				expect(normParsed).toEqual(norm1);
			}),
		);
	});

	it('Invariant 1b & 4.2.7: deepFreezeAST freezes all reachable nodes/arrays/matchers/spans and collectReferencedPropertyKeys collects exact non-virtual keys', async () => {
		await assertProperty(
			'search/ast-utils__deep-freeze-and-referenced-property-keys',
			fc.property(printableAstArb, (ast) => {
				const printed = printAST(ast);
				const parsed = parseQuery(printed, resolvedConfig);
				expect(parsed.ast).not.toBeNull();

				const frozen = deepFreezeAST(parsed.ast!);
				assertAstSpansAndFreeze(frozen, printed.length, true);

				const actualKeys = collectReferencedPropertyKeys(frozen);
				const expectedKeys = collectExpectedPropertyKeysFromTree(frozen);
				expect(actualKeys).toEqual(expectedKeys);
				for (const vk of VIRTUAL_FILE_KEYS_LIST) {
					expect(actualKeys.has(vk)).toBe(false);
				}
			}),
		);
	});

	it('Section 3.4 Rule 2: decodeQuotedString round-trips arbitrary strings in both double and single quotes and preserves unknown escapes', async () => {
		const nonSpecialEscapeCharArb = fc
			.string({ minLength: 1, maxLength: 1 })
			.filter((ch) => !['"', "'", '\\', 'n', 'r', 't', '\r', '\n'].includes(ch));

		await assertProperty(
			'search/literals__quoted-string-escape-roundtrip',
			fc.property(fc.string({ maxLength: 64 }), nonSpecialEscapeCharArb, (rawStr, unkCh) => {
				const dbl = encodeDoubleQuoted(rawStr);
				const sgl = encodeSingleQuoted(rawStr);

				const dblLex = SearchLexer.tokenize(dbl);
				expect(dblLex.errors).toEqual([]);
				expect(dblLex.tokens).toHaveLength(1);
				expect(decodeQuotedString(dblLex.tokens[0]!.image)).toBe(rawStr);

				const sglLex = SearchLexer.tokenize(sgl);
				expect(sglLex.errors).toEqual([]);
				expect(sglLex.tokens).toHaveLength(1);
				expect(decodeQuotedString(sglLex.tokens[0]!.image)).toBe(rawStr);

				// Unknown escape \c is preserved literally as \ + c
				const withUnknownEscape = `"\\${unkCh}"`;
				expect(decodeQuotedString(withUnknownEscape)).toBe(`\\${unkCh}`);
			}),
		);
	});

	it('Invariant 2b & Fuzz Totality: parseQuery never throws on arbitrary or adversarial strings, gates ast === null on error diagnostics, and emits valid JSON-safe SourceSpans', async () => {
		const tokenFragmentArb = fc.constantFrom(
			'(',
			')',
			'[',
			']',
			':',
			'=',
			'!=',
			'>=',
			'<=',
			'>',
			'<',
			'AND',
			'OR',
			'NOT',
			'-',
			'-draft',
			'- 5',
			'#tag/sub',
			'headings:',
			'links:[[Note|Alias]]',
			'links:[[]]',
			'links:[[|Alias]]',
			'["" = 1]',
			'[score >= -10.5]',
			'[score = - 5]',
			'/regex/im',
			'/bad/flags',
			'"quoted"',
			'"unclosed',
			'2026-10-22..2026',
			'@today-7d..@today',
			' ',
			'\n',
		);

		const adversarialQueryArb = fc.oneof(
			fc.string({ maxLength: 120 }),
			fc
				.array(tokenFragmentArb, { minLength: 1, maxLength: 20 })
				.map((parts) => parts.join('')),
			fc
				.integer({ min: 1, max: 40 })
				.map((depth) => `${'('.repeat(depth)}a${')'.repeat(depth)}`),
			fc.integer({ min: 1, max: 40 }).map((depth) => `${'-'.repeat(depth)}a`),
			fc.integer({ min: 4090, max: 4105 }).map((len) => 'x'.repeat(len)),
		);

		await assertProperty(
			'search/parser__fuzz-totality-error-gating-and-span-integrity',
			fc.property(adversarialQueryArb, (input) => {
				const res = parseQuery(input, resolvedConfig);

				// 1. Error gating: ast is null iff at least one error diagnostic is present,
				//    and when ast is null, only error diagnostics are returned
				const hasError = res.diagnostics.some((d) => d.severity === 'error');
				if (hasError) {
					expect(res.ast).toBeNull();
					expect(res.diagnostics.every((d) => d.severity === 'error')).toBe(true);
				} else {
					expect(res.ast).not.toBeNull();
					assertAstSpansAndFreeze(res.ast!, input.length, false);
				}

				// 2. Every diagnostic has no undefined fields and a valid safe-integer SourceSpan
				for (const diag of res.diagnostics) {
					for (const val of Object.values(diag)) {
						expect(val).not.toBeUndefined();
					}
					expect(diag.span).not.toBeNull();
					if (diag.span) {
						assertValidSpan(diag.span, input.length);
					}
				}

				// 3. JSON round-trip equivalence
				expect(JSON.parse(JSON.stringify(res))).toEqual(res);
			}),
		);
	});
});
