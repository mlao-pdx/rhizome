import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	compileQuery,
	evaluateVault,
	normalizeAST,
	oracleEvaluateVault,
	resolveQueryPropertyType,
	VIRTUAL_FILE_KEYS_LIST,
	type PropertyOperator,
	type ResolvedEngineConfig,
	type SearchAST,
	type ValueExprAST,
} from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';
import {
	booleanAlgebraASTs,
	boundedCompositionsArb,
	distributionASTs,
	logicalAST as logical,
	type DistributionTarget,
} from '../support/search-algebra';
import {
	normalizedVaultArb,
	printableExecutableAstArb,
	printableScopedFilterArb,
	printableValueExprArb,
	queryCaseArb,
} from '../support/search-arbitraries';
import {
	evaluationCaseArb,
	evaluatorConfig,
	evaluatorQuery,
} from '../support/search-evaluator-documents';
import { printableTemporalLiteralArb } from '../support/search-leaf-arbitraries';
import { printAST } from '../support/search-printer';

const evaluators = [evaluateVault, oracleEvaluateVault] as const;
const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

function prepare(ast: SearchAST, config: ResolvedEngineConfig, referenceTimeMs: number) {
	return evaluatorQuery(printAST(ast), config, referenceTimeMs);
}

const algebraCaseArb = evaluationCaseArb.chain((sample) => {
	const config = evaluatorConfig(sample.timeZone);
	const astArb = printableExecutableAstArb(config, sample.referenceTimeMs).filter(
		(ast) => ast.type !== 'MATCH_ALL',
	);
	const compositionsArb = boundedCompositionsArb(
		fc.tuple(astArb, astArb).map(([a, b]) => booleanAlgebraASTs(a, b)),
	);
	return fc.tuple(normalizedVaultArb(config), compositionsArb).map(([docs, asts]) => ({
		config,
		docs,
		asts,
		referenceTimeMs: sample.referenceTimeMs,
	}));
});

const timestampCaseArb = fc
	.record({
		timeZone: fc.constantFrom('UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Apia'),
		referenceTimeMs: fc.integer({
			min: Date.parse('2024-01-01T00:00:00Z'),
			max: Date.parse('2028-12-31T23:59:59.999Z'),
		}),
	})
	.chain((sample) => {
		const config = evaluatorConfig(sample.timeZone);
		return fc
			.tuple(
				normalizedVaultArb(config),
				printableTemporalLiteralArb(config, sample.referenceTimeMs),
				fc.constantFrom('file.mtime', 'file.ctime'),
			)
			.map(([docs, literal, key]) => ({ ...sample, config, docs, literal, key }));
	});

function distributionCaseArb(kind: 'scope' | 'property') {
	return evaluationCaseArb.chain((sample) => {
		const config = evaluatorConfig(sample.timeZone);
		const targetArb: fc.Arbitrary<DistributionTarget> =
			kind === 'scope'
				? printableScopedFilterArb(config)
				: fc
						.constantFrom(
							...Object.keys(config.propertyTypes),
							'aliases',
							'tags',
							'unknown',
							' SCORE ',
							'Due Date',
							...VIRTUAL_FILE_KEYS_LIST,
						)
						.map((rawKey) => ({
							type: 'PROPERTY_FILTER' as const,
							operator: ':' as const,
							key: rawKey.trim().toLowerCase(),
							rawKey,
						}));
		const astsArb = targetArb.chain((target) => {
			const valueArb =
				target.type === 'PROPERTY_FILTER' &&
				resolveQueryPropertyType(target.key, config.propertyTypes) === 'checkbox'
					? fc.constantFrom('true', 'false').map((value): ValueExprAST => ({
							type: 'VALUE_LEAF',
							matcher: { kind: 'string', value, quoted: false },
						}))
					: printableValueExprArb;
			return boundedCompositionsArb(
				fc.tuple(valueArb, valueArb).map(([a, b]) => distributionASTs(target, a, b)),
			);
		});
		return fc.tuple(normalizedVaultArb(config), astsArb).map(([docs, asts]) => ({
			config,
			docs,
			asts,
			referenceTimeMs: sample.referenceTimeMs,
		}));
	});
}

describe('Phase 7 AST-driven search invariants', () => {
	it('Invariant 5: shared printable ASTs compile, round-trip, and normalize idempotently', async () => {
		const config = evaluatorConfig('America/New_York');
		await assertProperty(
			'search/phase7__printable-executable-ast-roundtrip',
			fc.property(printableExecutableAstArb(config, PINNED_REF_MS), (ast) => {
				const compiled = compileQuery(printAST(ast), config, PINNED_REF_MS);
				expect(compiled.executable).toBe(true);
				expect(compiled.ast).not.toBeNull();
				expect(normalizeAST(compiled.ast!)).toEqual(normalizeAST(ast));
				expect(normalizeAST(normalizeAST(ast))).toEqual(normalizeAST(ast));
			}),
		);
	});

	it('Invariant 6d: AST timestamp comparisons partition documents and interval equality is conjunctive', async () => {
		await assertProperty(
			'search/phase7__virtual-timestamp-partitioning',
			fc.property(timestampCaseArb, ({ config, docs, literal, key, referenceTimeMs }) => {
				const filter = (operator: PropertyOperator): SearchAST => ({
					type: 'PROPERTY_FILTER',
					key,
					rawKey: key,
					operator,
					valueExpr: {
						type: 'VALUE_LEAF',
						matcher: { kind: 'string', value: literal, quoted: false },
					},
				});
				const less = prepare(filter('<'), config, referenceTimeMs);
				const equal = prepare(filter('='), config, referenceTimeMs);
				const greater = prepare(filter('>'), config, referenceTimeMs);
				const greaterEqual = prepare(filter('>='), config, referenceTimeMs);
				const lessEqual = prepare(filter('<='), config, referenceTimeMs);
				const equalViaBounds = prepare(
					logical('AND', [filter('>='), filter('<=')]),
					config,
					referenceTimeMs,
				);
				for (const evaluate of evaluators) {
					const lessMatches = new Set(evaluate(docs, less).matches);
					const equalMatches = evaluate(docs, equal).matches;
					const equalSet = new Set(equalMatches);
					const greaterMatches = new Set(evaluate(docs, greater).matches);
					expect(lessMatches.size + equalSet.size + greaterMatches.size).toBe(
						docs.length,
					);
					for (const doc of docs) {
						expect(
							Number(lessMatches.has(doc)) +
								Number(equalSet.has(doc)) +
								Number(greaterMatches.has(doc)),
						).toBe(1);
					}
					expect(equalMatches).toEqual(evaluate(docs, equalViaBounds).matches);
					const greaterEqualMatches = new Set(evaluate(docs, greaterEqual).matches);
					const lessEqualMatches = new Set(evaluate(docs, lessEqual).matches);
					expect(equalMatches).toEqual(
						docs.filter(
							(doc) => greaterEqualMatches.has(doc) && lessEqualMatches.has(doc),
						),
					);
				}
			}),
		);
	});

	it('Invariant 7: AST complementarity and both De Morgan laws hold for both evaluators', async () => {
		await assertProperty(
			'search/phase7__boolean-algebra',
			fc.property(algebraCaseArb, ({ config, docs, asts, referenceTimeMs }) => {
				const tautology = prepare(asts.tautology, config, referenceTimeMs);
				const contradiction = prepare(asts.contradiction, config, referenceTimeMs);
				const notAnd = prepare(asts.notAnd, config, referenceTimeMs);
				const orNot = prepare(asts.orNot, config, referenceTimeMs);
				const notOr = prepare(asts.notOr, config, referenceTimeMs);
				const andNot = prepare(asts.andNot, config, referenceTimeMs);
				for (const evaluate of evaluators) {
					expect(evaluate(docs, tautology).matches).toEqual(docs);
					expect(evaluate(docs, contradiction).matches).toEqual([]);
					expect(evaluate(docs, notAnd).matches).toEqual(evaluate(docs, orNot).matches);
					expect(evaluate(docs, notOr).matches).toEqual(evaluate(docs, andNot).matches);
				}
			}),
		);
	});

	it.each(['scope', 'property'] as const)(
		'Invariant 7: AST %s OR distributes and AND is contained in separate existential matches',
		async (kind) => {
			await assertProperty(
				`search/phase7__${kind}-existential-distribution`,
				fc.property(
					distributionCaseArb(kind),
					({ config, docs, asts, referenceTimeMs }) => {
						const combinedOr = prepare(asts.combinedOr, config, referenceTimeMs);
						const separateOr = prepare(asts.separateOr, config, referenceTimeMs);
						const combinedAnd = prepare(asts.combinedAnd, config, referenceTimeMs);
						const separateAnd = prepare(asts.separateAnd, config, referenceTimeMs);
						for (const evaluate of evaluators) {
							expect(evaluate(docs, combinedOr).matches).toEqual(
								evaluate(docs, separateOr).matches,
							);
							const superset = new Set(evaluate(docs, separateAnd).matches);
							for (const doc of evaluate(docs, combinedAnd).matches)
								expect(superset.has(doc)).toBe(true);
						}
					},
				),
			);
		},
	);

	it('Invariant 8: AST queries are differentially equivalent, ordered, JSON-safe, and reusable', async () => {
		await assertProperty(
			'search/phase7__oracle-differential-equivalence',
			fc.property(queryCaseArb, ({ docs, prepared }) => {
				const actual = evaluateVault(docs, prepared);
				const expected = oracleEvaluateVault(docs, prepared);
				expect(actual.matches.map((doc) => doc.file.path)).toEqual(
					expected.matches.map((doc) => doc.file.path),
				);
				expect(actual.propertyDiagnostics).toEqual(expected.propertyDiagnostics);
				const matched = new Set(actual.matches);
				expect(actual.matches).toEqual(docs.filter((doc) => matched.has(doc)));
				expect(JSON.parse(JSON.stringify(actual))).toEqual(actual);
				expect(evaluateVault(docs, prepared)).toEqual(actual);
			}),
		);
	});
});
