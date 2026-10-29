import * as fc from 'fast-check';
import {
	MAX_QUERY_LENGTH,
	MAX_SYNTACTIC_DEPTH,
	resolveQueryPropertyType,
	VIRTUAL_FILE_KEYS_LIST,
	type LeafMatcher,
	type NormalizedDocument,
	type ObsidianPropertyType,
	type PreparedQuery,
	type PropertyFilterNode,
	type PropertyOperator,
	type ResolvedEngineConfig,
	type ScopedFilterNode,
	type SearchAST,
	type TextMatchNode,
	type ValueExprAST,
} from '../../src/core/search';
import {
	documentInputArb,
	evaluationCaseArb,
	evaluatorConfig,
	evaluatorQuery,
	evaluatorVault,
} from './search-evaluator-documents';
import {
	buildCustomValueExprArb,
	buildValueExprArb,
	printableTemporalLiteralArb,
	quotedValueArb,
	rhsLeafMatcherArb,
	structuralRegexMatcherArb,
	unquotedIdentifierArb,
	unsignedLeafMatcherArb,
} from './search-leaf-arbitraries';
import { computeSyntacticDepth, printAST, printValueExprAST } from './search-printer';

export const printableValueExprArb = buildValueExprArb(2);

export function printableScopedFilterArb(
	resolvedConfig: ResolvedEngineConfig,
): fc.Arbitrary<ScopedFilterNode> {
	const scopeNames = Array.from(
		new Set(
			resolvedConfig
				.getAllScopeNames()
				.map((name) => resolvedConfig.getScope(name)!.canonicalName),
		),
	);
	return fc
		.tuple(
			fc.constantFrom(...scopeNames),
			fc.boolean(),
			fc.oneof(
				rhsLeafMatcherArb.map((matcher) => ({
					type: 'VALUE_LEAF' as const,
					matcher,
				})),
				printableValueExprArb,
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
			return { type: 'SCOPED_FILTER' as const, scope, rawScope: scope, expr };
		});
}

export const unsignedNumberLiteralArb = fc
	.tuple(
		fc.integer({ min: 0, max: 99999 }),
		fc.option(fc.integer({ min: 0, max: 999 }), { nil: null }),
	)
	.map(([integer, fraction]) => `${integer}${fraction !== null ? `.${fraction}` : ''}`);

export const signedNumberLiteralArb = fc
	.tuple(fc.boolean(), unsignedNumberLiteralArb)
	.map(([negative, numStr]) => (negative && Number(numStr) > 0 ? `-${numStr}` : numStr));

export function printableColonValueExprArb(
	propType: ObsidianPropertyType,
	resolvedConfig: ResolvedEngineConfig,
	refMs: number,
): fc.Arbitrary<ValueExprAST> {
	const temporalLiteralArb = printableTemporalLiteralArb(resolvedConfig, refMs);
	if (propType === 'checkbox') {
		const boolLeafArb: fc.Arbitrary<LeafMatcher> = fc
			.constantFrom('true', 'false')
			.map((value) => ({
				kind: 'string' as const,
				value,
				quoted: false,
			}));
		return buildCustomValueExprArb(boolLeafArb, 1);
	}
	if (propType === 'number') {
		const numLeafArb: fc.Arbitrary<LeafMatcher> = fc.oneof(
			signedNumberLiteralArb.map((value) => ({
				kind: 'string' as const,
				value,
				quoted: false,
			})),
			structuralRegexMatcherArb,
		);
		return buildCustomValueExprArb(numLeafArb, 1);
	}
	if (propType === 'date' || propType === 'datetime') {
		const tempLeafArb: fc.Arbitrary<LeafMatcher> = fc.oneof(
			temporalLiteralArb.map((value) => ({
				kind: 'string' as const,
				value,
				quoted: false,
			})),
			structuralRegexMatcherArb,
		);
		return buildCustomValueExprArb(tempLeafArb, 1);
	}
	return fc.oneof(
		rhsLeafMatcherArb.map((matcher): ValueExprAST => ({
			type: 'VALUE_LEAF',
			matcher,
		})),
		printableValueExprArb,
	);
}

function printablePropertyFilterArb(
	resolvedConfig: ResolvedEngineConfig,
	refMs: number,
): fc.Arbitrary<PropertyFilterNode> {
	const propKeys = [
		...Object.keys(resolvedConfig.propertyTypes),
		' SCORE ',
		'status',
		'category',
		'Due Date',
		...VIRTUAL_FILE_KEYS_LIST,
	];
	const temporalLiteralArb = printableTemporalLiteralArb(resolvedConfig, refMs);
	const propOperatorArb: fc.Arbitrary<PropertyOperator> = fc.constantFrom(
		'EXISTS',
		'EMPTY',
		':',
		'=',
		'!=',
		'<',
		'>',
		'<=',
		'>=',
	);

	return fc
		.tuple(fc.constantFrom(...propKeys), propOperatorArb)
		.chain(([rawKey, requestedOp]) => {
			const key = rawKey.trim().toLowerCase();
			const propType = resolveQueryPropertyType(key, resolvedConfig.propertyTypes);
			const op: PropertyOperator =
				propType === 'checkbox' && ['<', '>', '<=', '>='].includes(requestedOp)
					? '='
					: requestedOp;
			if (op === 'EXISTS' || op === 'EMPTY') {
				return fc.constant<PropertyFilterNode>({
					type: 'PROPERTY_FILTER',
					key,
					rawKey,
					operator: op,
				});
			}
			if (op === ':') {
				return printableColonValueExprArb(propType, resolvedConfig, refMs).map(
					(valueExpr) => ({
						type: 'PROPERTY_FILTER' as const,
						key,
						rawKey,
						operator: ':' as const,
						valueExpr,
					}),
				);
			}

			let matcherArb: fc.Arbitrary<LeafMatcher>;
			if (propType === 'number') {
				matcherArb = signedNumberLiteralArb.map((value) => ({
					kind: 'string' as const,
					value,
					quoted: false,
				}));
			} else if (propType === 'checkbox') {
				matcherArb = fc.constantFrom('true', 'false').map((value) => ({
					kind: 'string' as const,
					value,
					quoted: false,
				}));
			} else if (propType === 'date' || propType === 'datetime') {
				matcherArb = temporalLiteralArb.map((value) => ({
					kind: 'string' as const,
					value,
					quoted: false,
				}));
			} else {
				matcherArb = fc.oneof(
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
			return matcherArb.map((matcher) => ({
				type: 'PROPERTY_FILTER' as const,
				key,
				rawKey,
				operator: op,
				valueExpr: { type: 'VALUE_LEAF' as const, matcher },
			}));
		});
}

export function printableExecutableAstArb(
	resolvedConfig: ResolvedEngineConfig,
	refMs: number,
): fc.Arbitrary<SearchAST> {
	const textMatchArb: fc.Arbitrary<TextMatchNode> = unsignedLeafMatcherArb.map((matcher) => ({
		type: 'TEXT_MATCH' as const,
		matcher,
		rawText: printValueExprAST({ type: 'VALUE_LEAF', matcher }),
	}));
	const atomAstArb: fc.Arbitrary<SearchAST> = fc.oneof(
		printableScopedFilterArb(resolvedConfig),
		printablePropertyFilterArb(resolvedConfig, refMs),
		textMatchArb,
	);

	function buildAstRec(depth: number): fc.Arbitrary<SearchAST> {
		if (depth <= 0) return atomAstArb;
		const subArb = buildAstRec(depth - 1);
		const notArb: fc.Arbitrary<SearchAST> = fc
			.tuple(fc.constantFrom('NOT' as const, '!' as const), subArb)
			.map(([syntax, child]) => ({ type: 'NOT' as const, syntax, child }));
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

export function normalizedDocumentArb(
	resolvedConfig: ResolvedEngineConfig,
): fc.Arbitrary<NormalizedDocument> {
	return documentInputArb.map((input) => evaluatorVault([input], resolvedConfig)[0]!);
}

export function normalizedVaultArb(
	resolvedConfig: ResolvedEngineConfig,
): fc.Arbitrary<NormalizedDocument[]> {
	return fc
		.array(documentInputArb, { maxLength: 6 })
		.map((inputs) => evaluatorVault(inputs, resolvedConfig));
}

export const queryCaseArb: fc.Arbitrary<{
	config: ResolvedEngineConfig;
	prepared: PreparedQuery;
	docs: NormalizedDocument[];
	ast: SearchAST;
	query: string;
	referenceTimeMs: number;
}> = evaluationCaseArb.chain((sample) => {
	const config = evaluatorConfig(sample.timeZone);
	const docs = evaluatorVault(sample.documents, config);
	return printableExecutableAstArb(config, sample.referenceTimeMs).map((ast) => {
		const query = printAST(ast);
		return {
			config,
			docs,
			ast,
			query,
			prepared: evaluatorQuery(query, config, sample.referenceTimeMs),
			referenceTimeMs: sample.referenceTimeMs,
		};
	});
});
