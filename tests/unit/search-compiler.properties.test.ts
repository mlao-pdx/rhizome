import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	BUILT_IN_SCOPES,
	compileQuery,
	initEngineConfig,
	levenshteinDistance,
	MAX_QUERY_LENGTH,
	MAX_SAFE_EPOCH_MS,
	MAX_SYNTACTIC_DEPTH,
	normalizeAST,
	parseTemporalExpr,
	resolveQueryPropertyType,
	suggestScopeHint,
	validateRegexLiteral,
	VIRTUAL_FILE_KEYS_LIST,
	type LeafMatcher,
	type PropertyFilterNode,
	type PropertyOperator,
	type ResolvedEngineConfig,
	type ScopedFilterNode,
	type SearchAST,
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

function printAST(ast: SearchAST, parentOp?: 'AND' | 'OR' | 'NOT'): string {
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
					operator: ':',
					valueExpr,
				}));
			}

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

function createTestResolvedConfig(): ResolvedEngineConfig {
	const res = initEngineConfig({
		timeZone: 'America/New_York',
		propertyTypes: {
			score: 'number',
			priority: 'number',
			meeting: 'datetime',
			due: 'date',
			modified: 'date',
			sprint: 'date',
			status: 'text',
			done: 'checkbox',
		},
	});
	if (!res.ok) throw new Error('Expected valid test config');
	return res.config;
}

function assertValueExprDeepFrozen(expr: ValueExprAST): void {
	expect(Object.isFrozen(expr)).toBe(true);
	expect(() => {
		(expr as { type: string }).type = 'MUTATED';
	}).toThrow(TypeError);
	if (expr.type === 'VALUE_LEAF') {
		expect(Object.isFrozen(expr.matcher)).toBe(true);
		expect(() => {
			(expr.matcher as { kind: string }).kind = 'MUTATED';
		}).toThrow(TypeError);
	} else if (expr.type === 'VALUE_NOT') {
		assertValueExprDeepFrozen(expr.child);
	} else {
		expect(Object.isFrozen(expr.children)).toBe(true);
		expect(() => {
			(expr.children as ValueExprAST[]).push({
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: 'x', quoted: false },
			});
		}).toThrow(TypeError);
		for (const c of expr.children) assertValueExprDeepFrozen(c);
	}
}

function assertAstDeepFrozen(ast: SearchAST): void {
	expect(Object.isFrozen(ast)).toBe(true);
	expect(() => {
		(ast as { type: string }).type = 'MUTATED';
	}).toThrow(TypeError);
	if ('span' in ast && ast.span) {
		expect(Object.isFrozen(ast.span)).toBe(true);
	}
	switch (ast.type) {
		case 'MATCH_ALL':
			return;
		case 'TEXT_MATCH':
			expect(Object.isFrozen(ast.matcher)).toBe(true);
			expect(() => {
				(ast.matcher as { kind: string }).kind = 'MUTATED';
			}).toThrow(TypeError);
			return;
		case 'NOT':
			assertAstDeepFrozen(ast.child);
			return;
		case 'SCOPED_FILTER':
			assertValueExprDeepFrozen(ast.expr);
			return;
		case 'PROPERTY_FILTER':
			if (ast.valueExpr) assertValueExprDeepFrozen(ast.valueExpr);
			return;
		case 'LOGICAL':
			expect(Object.isFrozen(ast.children)).toBe(true);
			expect(() => {
				(ast.children as SearchAST[]).push({ type: 'MATCH_ALL' });
			}).toThrow(TypeError);
			for (const c of ast.children) assertAstDeepFrozen(c);
			return;
	}
}

function countDocTextMatchNodes(ast: SearchAST): number {
	switch (ast.type) {
		case 'TEXT_MATCH':
			return 1;
		case 'NOT':
			return countDocTextMatchNodes(ast.child);
		case 'LOGICAL':
			return ast.children.reduce((sum, c) => sum + countDocTextMatchNodes(c), 0);
		default:
			return 0;
	}
}

describe('Invariant 1b & 5: Printable Executable AST Round-Trip & Deep Freeze via compileQuery', () => {
	const resolvedConfig = createTestResolvedConfig();
	const executableAstArb = buildPrintableExecutableAstArb(resolvedConfig, PINNED_REF_MS);

	it('compiles every printed executable AST with executable === true, deeply frozen PreparedQuery/AST, and identical normalizeAST', async () => {
		await assertProperty(
			'search/compiler__printable-executable-ast-roundtrip-and-deep-freeze',
			fc.property(executableAstArb, (ast) => {
				const printed = printAST(ast);
				const compiled = compileQuery(printed, resolvedConfig, PINNED_REF_MS);

				expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
				expect(compiled.executable).toBe(true);
				expect(compiled.ast).not.toBeNull();
				expect(compiled.prepared).not.toBeNull();
				expect(Object.isFrozen(compiled.prepared)).toBe(true);
				expect(compiled.prepared?.ast).toBe(compiled.ast);
				expect(compiled.prepared?.resolvedConfig).toBe(resolvedConfig);
				expect(compiled.prepared?.referenceTimeMs).toBe(PINNED_REF_MS);

				assertAstDeepFrozen(compiled.ast!);
				expect(normalizeAST(compiled.ast!)).toEqual(normalizeAST(ast));

				// Diagnostics POJO JSON round-trip check
				expect(JSON.parse(JSON.stringify(compiled.diagnostics))).toEqual(
					compiled.diagnostics,
				);
			}),
		);
	});
});

describe('Invariant 2b & 4b: Total Never-Throw Fuzzing, Compile Gate & POJO Diagnostic Invariants', () => {
	const resolvedConfig = createTestResolvedConfig();

	const tokenFragmentArb = fc.constantFrom(
		'AND',
		'OR',
		'NOT',
		'-',
		'(',
		')',
		'[',
		']',
		':',
		'=',
		'!=',
		'<',
		'>',
		'<=',
		'>=',
		'"hello"',
		'"true"',
		'/abc/i',
		'/foo(/',
		'/test/g',
		'[[Note|Alias]]',
		'#tag/sub',
		'file:test',
		'hedings:Action',
		'Items',
		'tags:work',
		'prop:status',
		'ext:md',
		'ext:pdf',
		'[score >= -10.5]',
		'[priority > high]',
		'[priority = /10/]',
		'[priority = /foo(/]',
		'[done < true]',
		'[done = "true"]',
		'[due = 2026-02-31]',
		'[due = 2026-10-15..2026-10-01]',
		'[due = @today..@today-7d]',
		'[status != done]',
		'and',
		'or',
		'not',
		' ',
	);

	const queryFuzzArb = fc.oneof(
		fc.string({ maxLength: 300 }),
		fc.array(tokenFragmentArb, { minLength: 1, maxLength: 25 }).map((parts) => parts.join(' ')),
	);

	const refTimeFuzzArb = fc.oneof(
		fc.constant(PINNED_REF_MS),
		fc.integer({ min: -MAX_SAFE_EPOCH_MS, max: MAX_SAFE_EPOCH_MS }),
		fc.constantFrom(
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			123.45,
			MAX_SAFE_EPOCH_MS + 1,
			-MAX_SAFE_EPOCH_MS - 1,
		),
	);

	it('never throws on arbitrary query strings and referenceTimeMs values, enforces global compile gate, and emits JSON-safe diagnostics', async () => {
		await assertProperty(
			'search/compiler__fuzz-compile-gate-and-pojo-diagnostics',
			fc.property(queryFuzzArb, refTimeFuzzArb, (input, refMs) => {
				const res = compileQuery(input, resolvedConfig, refMs);
				const hasError = res.diagnostics.some((d) => d.severity === 'error');

				if (hasError) {
					expect(res.executable).toBe(false);
					expect(res.ast).toBeNull();
					expect(res.prepared).toBeNull();
				} else {
					expect(res.executable).toBe(true);
					expect(res.ast).not.toBeNull();
					expect(res.prepared).not.toBeNull();
					expect(Object.isFrozen(res.prepared)).toBe(true);
					assertAstDeepFrozen(res.ast!);
				}

				for (const d of res.diagnostics) {
					expect(d.hint === null || typeof d.hint === 'string').toBe(true);
					expect(d.span === null || typeof d.span === 'object').toBe(true);
					if (d.span !== null) {
						expect(Number.isSafeInteger(d.span.startOffset)).toBe(true);
						expect(Number.isSafeInteger(d.span.endOffset)).toBe(true);
						expect(d.span.startOffset).toBeGreaterThanOrEqual(0);
						expect(d.span.endOffset).toBeGreaterThanOrEqual(d.span.startOffset);
						expect(d.span.endOffset).toBeLessThanOrEqual(input.length);
						expect(d.span.startLine).toBeGreaterThanOrEqual(1);
						expect(d.span.startColumn).toBeGreaterThanOrEqual(1);
					}
				}

				expect(JSON.parse(JSON.stringify(res.diagnostics))).toEqual(res.diagnostics);
			}),
		);
	});

	it('enforces Step 2 -> Step 4a -> Step 4b short-circuit precedence, negation non-suppression, and TextMatchNode lint partitioning', async () => {
		const propKeyArb = fc.constantFrom(
			'score',
			'priority',
			'meeting',
			'due',
			'status',
			'done',
			'file.mtime',
			'file.size',
			'file.ext',
		);
		const compOpArb = fc.constantFrom('=', '!=', '<', '>', '<=', '>=');

		await assertProperty(
			'search/compiler__short-circuit-precedence-and-negation-invariance',
			fc.property(propKeyArb, compOpArb, fc.boolean(), (key, op, negate) => {
				const wrap = (q: string): string => (negate ? `NOT (${q})` : q);

				// 1. Invalid regex leaf in comparison: ONLY SYNTAX_ERROR (never Step 4a/4b or HINT_PROP_NEQ_EXISTENCE)
				const invalidRegexRes = compileQuery(
					wrap(`[${key} ${op} /unclosed(/]`),
					resolvedConfig,
					PINNED_REF_MS,
				);
				expect(invalidRegexRes.executable).toBe(false);
				expect(invalidRegexRes.diagnostics.map((d) => d.code)).toEqual(['SYNTAX_ERROR']);

				// 2. Valid regex leaf in comparison: ONLY ERROR_INVALID_OPERATOR_FOR_TYPE (never Step 4b or HINT_PROP_NEQ_EXISTENCE)
				const validRegexRes = compileQuery(
					wrap(`[${key} ${op} /^abc$/i]`),
					resolvedConfig,
					PINNED_REF_MS,
				);
				expect(validRegexRes.executable).toBe(false);
				expect(validRegexRes.diagnostics.map((d) => d.code)).toEqual([
					'ERROR_INVALID_OPERATOR_FOR_TYPE',
				]);
			}),
		);
	});

	it('satisfies Levenshtein metric axioms, 1-edit scope suggestion recovery, and document-level TextMatchNode diagnostic partitioning', async () => {
		const shortAsciiArb = fc.stringMatching(/^[a-z]{0,8}$/);
		await assertProperty(
			'search/compiler__levenshtein-metric-and-text-match-lint-partition',
			fc.property(
				shortAsciiArb,
				shortAsciiArb,
				shortAsciiArb,
				queryFuzzArb,
				(a, b, c, fuzzQuery) => {
					// 1. Levenshtein metric space axioms
					expect(levenshteinDistance(a, a)).toBe(0);
					expect(levenshteinDistance(a, b) === 0).toBe(a === b);
					expect(levenshteinDistance(a, b)).toBe(levenshteinDistance(b, a));
					expect(levenshteinDistance(a, c)).toBeLessThanOrEqual(
						levenshteinDistance(a, b) + levenshteinDistance(b, c),
					);

					// 2. 1-character prefix insertion on any built-in scope name has edit distance 1 -> always suggests a scope
					for (const s of BUILT_IN_SCOPES) {
						const typo = `x${s.canonicalName}`;
						if (!resolvedConfig.getScope(typo)) {
							const hint = suggestScopeHint(typo, resolvedConfig);
							expect(hint).not.toBeNull();
							expect(hint?.startsWith('Did you mean "')).toBe(true);
						}
					}

					// 3. Exhaustive & mutually exclusive partitioning of document-level TextMatchNodes
					const res = compileQuery(fuzzQuery, resolvedConfig, PINNED_REF_MS);
					if (res.executable && res.ast) {
						const textNodeCount = countDocTextMatchNodes(res.ast);
						const textDiagCount = res.diagnostics.filter(
							(d) =>
								d.code === 'HINT_BARE_TEXT_NO_BODY' ||
								d.code === 'WARN_LOWERCASE_BOOLEAN' ||
								d.code === 'WARN_DANGEROUS_SPACED_HYPHEN',
						).length;
						expect(textDiagCount).toBe(textNodeCount);
					}
				},
			),
		);
	});
});
