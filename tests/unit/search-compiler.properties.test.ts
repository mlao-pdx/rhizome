import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	BUILT_IN_SCOPES,
	compileQuery,
	initEngineConfig,
	levenshteinDistance,
	MAX_SAFE_EPOCH_MS,
	normalizeAST,
	suggestScopeHint,
	type ResolvedEngineConfig,
	type SearchAST,
	type ValueExprAST,
} from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';
import { printableExecutableAstArb } from '../support/search-arbitraries';
import { printAST } from '../support/search-printer';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

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
		for (const child of expr.children) assertValueExprDeepFrozen(child);
	}
}

function assertAstDeepFrozen(ast: SearchAST): void {
	expect(Object.isFrozen(ast)).toBe(true);
	expect(() => {
		(ast as { type: string }).type = 'MUTATED';
	}).toThrow(TypeError);
	if ('span' in ast && ast.span) expect(Object.isFrozen(ast.span)).toBe(true);
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
			for (const child of ast.children) assertAstDeepFrozen(child);
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
			return ast.children.reduce((sum, child) => sum + countDocTextMatchNodes(child), 0);
		default:
			return 0;
	}
}

describe('Invariant 1b & 5: Printable Executable AST Round-Trip & Deep Freeze via compileQuery', () => {
	const resolvedConfig = createTestResolvedConfig();
	const executableAstArb = printableExecutableAstArb(resolvedConfig, PINNED_REF_MS);

	it('compiles every printed executable AST with executable === true, deeply frozen PreparedQuery/AST, and identical normalizeAST', async () => {
		await assertProperty(
			'search/compiler__printable-executable-ast-roundtrip-and-deep-freeze',
			fc.property(executableAstArb, (ast) => {
				const printed = printAST(ast);
				const compiled = compileQuery(printed, resolvedConfig, PINNED_REF_MS);
				expect(
					compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
				).toEqual([]);
				expect(compiled.executable).toBe(true);
				expect(compiled.ast).not.toBeNull();
				expect(compiled.prepared).not.toBeNull();
				expect(Object.isFrozen(compiled.prepared)).toBe(true);
				expect(compiled.prepared?.ast).toBe(compiled.ast);
				expect(compiled.prepared?.resolvedConfig).toBe(resolvedConfig);
				expect(compiled.prepared?.referenceTimeMs).toBe(PINNED_REF_MS);
				assertAstDeepFrozen(compiled.ast!);
				expect(normalizeAST(compiled.ast!)).toEqual(normalizeAST(ast));
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
				const hasError = res.diagnostics.some(
					(diagnostic) => diagnostic.severity === 'error',
				);
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
				for (const diagnostic of res.diagnostics) {
					expect(diagnostic.hint === null || typeof diagnostic.hint === 'string').toBe(
						true,
					);
					expect(diagnostic.span === null || typeof diagnostic.span === 'object').toBe(
						true,
					);
					if (diagnostic.span !== null) {
						expect(Number.isSafeInteger(diagnostic.span.startOffset)).toBe(true);
						expect(Number.isSafeInteger(diagnostic.span.endOffset)).toBe(true);
						expect(diagnostic.span.startOffset).toBeGreaterThanOrEqual(0);
						expect(diagnostic.span.endOffset).toBeGreaterThanOrEqual(
							diagnostic.span.startOffset,
						);
						expect(diagnostic.span.endOffset).toBeLessThanOrEqual(input.length);
						expect(diagnostic.span.startLine).toBeGreaterThanOrEqual(1);
						expect(diagnostic.span.startColumn).toBeGreaterThanOrEqual(1);
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
			'file.modified',
			'file.size',
			'file.extension',
		);
		const compOpArb = fc.constantFrom('=', '!=', '<', '>', '<=', '>=');
		await assertProperty(
			'search/compiler__short-circuit-precedence-and-negation-invariance',
			fc.property(propKeyArb, compOpArb, fc.boolean(), (key, op, negate) => {
				const wrap = (query: string): string => (negate ? `NOT (${query})` : query);
				const invalidRegexRes = compileQuery(
					wrap(`[${key} ${op} /unclosed(/]`),
					resolvedConfig,
					PINNED_REF_MS,
				);
				expect(invalidRegexRes.executable).toBe(false);
				expect(invalidRegexRes.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
					'SYNTAX_ERROR',
				]);
				const validRegexRes = compileQuery(
					wrap(`[${key} ${op} /^abc$/i]`),
					resolvedConfig,
					PINNED_REF_MS,
				);
				expect(validRegexRes.executable).toBe(false);
				expect(validRegexRes.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
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
					expect(levenshteinDistance(a, a)).toBe(0);
					expect(levenshteinDistance(a, b) === 0).toBe(a === b);
					expect(levenshteinDistance(a, b)).toBe(levenshteinDistance(b, a));
					expect(levenshteinDistance(a, c)).toBeLessThanOrEqual(
						levenshteinDistance(a, b) + levenshteinDistance(b, c),
					);
					for (const scope of BUILT_IN_SCOPES) {
						const typo = `x${scope.canonicalName}`;
						if (!resolvedConfig.getScope(typo)) {
							const hint = suggestScopeHint(typo, resolvedConfig);
							expect(hint).not.toBeNull();
							expect(hint?.startsWith('Did you mean "')).toBe(true);
						}
					}
					const res = compileQuery(fuzzQuery, resolvedConfig, PINNED_REF_MS);
					if (res.executable && res.ast) {
						const textDiagCount = res.diagnostics.filter(
							(diagnostic) =>
								diagnostic.code === 'HINT_BARE_TEXT_NO_BODY' ||
								diagnostic.code === 'WARN_LOWERCASE_BOOLEAN' ||
								diagnostic.code === 'WARN_DANGEROUS_SPACED_HYPHEN',
						).length;
						expect(textDiagCount).toBe(countDocTextMatchNodes(res.ast));
					}
				},
			),
		);
	});
});
