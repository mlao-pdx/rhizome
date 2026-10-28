import * as fc from 'fast-check';
import {
	parseTemporalExpr,
	validateRegexLiteral,
	type LeafMatcher,
	type ResolvedEngineConfig,
	type ValueExprAST,
} from '../../src/core/search';

export const unquotedIdentifierArb: fc.Arbitrary<string> = fc
	.tuple(
		fc.constantFrom('a', 'b', 'c', 'note', 'work', 'sprint', 'draft', 'project', 'alpha', '_x'),
		fc.stringMatching(/^[a-zA-Z0-9_-]{0,8}$/),
	)
	.map(([head, tail]) => `${head}${tail}`)
	.filter((value) => !['AND', 'OR', 'NOT'].includes(value));

export const quotedValueArb: fc.Arbitrary<string> = fc.oneof(
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

export const regexAtomArb: fc.Arbitrary<string> = fc.oneof(
	fc.constantFrom('note', 'sprint', 'work', '[a-z]', '[0-9]', '\\.', '\\/', '\\-'),
	fc.stringMatching(/^[a-zA-Z0-9]{1,6}$/),
);

export const structuralRegexMatcherArb: fc.Arbitrary<Extract<LeafMatcher, { kind: 'regex' }>> = fc
	.tuple(
		fc.boolean(),
		fc.array(regexAtomArb, { minLength: 1, maxLength: 3 }),
		fc.boolean(),
		fc.subarray(['i', 'm', 's', 'u'], { minLength: 0, maxLength: 3 }),
	)
	.map(([caret, atoms, dollar, flagList]) => ({
		kind: 'regex' as const,
		pattern: `${caret ? '^' : ''}${atoms.join('')}${dollar ? '$' : ''}`,
		flags: flagList.join(''),
	}))
	.filter((matcher) => validateRegexLiteral(matcher.pattern, matcher.flags) !== null);

export const unsignedLeafMatcherArb: fc.Arbitrary<LeafMatcher> = fc.oneof(
	unquotedIdentifierArb.map((value) => ({ kind: 'string' as const, value, quoted: false })),
	quotedValueArb.map((value) => ({ kind: 'string' as const, value, quoted: true })),
	structuralRegexMatcherArb,
);

export const rhsLeafMatcherArb: fc.Arbitrary<LeafMatcher> = fc.oneof(
	unsignedLeafMatcherArb,
	unquotedIdentifierArb.map((value) => ({
		kind: 'string' as const,
		value: `-${value}`,
		quoted: false,
	})),
);

export function buildCustomValueExprArb(
	leafMatcherArb: fc.Arbitrary<LeafMatcher>,
	maxDepth: number,
): fc.Arbitrary<ValueExprAST> {
	const leafArb: fc.Arbitrary<ValueExprAST> = leafMatcherArb.map((matcher) => ({
		type: 'VALUE_LEAF' as const,
		matcher,
	}));
	if (maxDepth <= 0) return leafArb;
	const subArb = buildCustomValueExprArb(leafMatcherArb, maxDepth - 1);
	const notArb: fc.Arbitrary<ValueExprAST> = fc
		.tuple(fc.constantFrom('NOT' as const, '!' as const), subArb)
		.map(([syntax, child]) => ({ type: 'VALUE_NOT' as const, syntax, child }));
	const logicalArb: fc.Arbitrary<ValueExprAST> = fc
		.tuple(
			fc.constantFrom('AND' as const, 'OR' as const),
			fc.array(subArb, { minLength: 2, maxLength: 3 }),
		)
		.map(([operator, children]) => ({ type: 'VALUE_LOGICAL' as const, operator, children }));
	return fc.oneof({ weight: 3, arbitrary: leafArb }, notArb, logicalArb);
}

export function buildValueExprArb(maxDepth: number): fc.Arbitrary<ValueExprAST> {
	return buildCustomValueExprArb(unsignedLeafMatcherArb, maxDepth);
}

export function printableTemporalLiteralArb(
	resolvedConfig: ResolvedEngineConfig,
	refMs: number,
): fc.Arbitrary<string> {
	return fc
		.constantFrom(
			'2024',
			'2025-06',
			'2026',
			'2026-10',
			'2026-10-22',
			'2027-03-14',
			'2028-12-31',
			'2026-10-22T14:00:00Z',
			'2024-01-01..2028-12-31',
			'2026-01-01..2026-10-22',
			'@now',
			'@today',
			'@yesterday',
			'@thisweek',
			'@thismonth',
			'@thisyear..@today',
			'@today-7d..@today',
		)
		.filter(
			(literal) =>
				parseTemporalExpr(literal, {
					allowYearOnly: true,
					allowRelative: true,
					timeZone: resolvedConfig.timeZone,
					referenceTimeMs: refMs,
				}).ok,
		);
}
