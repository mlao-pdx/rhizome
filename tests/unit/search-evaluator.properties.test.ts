import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	collectReferencedPropertyKeys,
	evaluateDoc,
	evaluateVault,
	normalizeAST,
	oracleEvaluateDoc,
	oracleEvaluateVault,
	parseTemporalExpr,
} from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';
import {
	documentInputArb,
	evaluationCaseArb,
	evaluatorConfig,
	evaluatorQuery,
	evaluatorVault,
	referenceTimeArb,
	timeZoneArb,
} from '../support/search-evaluator-documents';
import {
	executableQueryArb,
	logicalQuery,
	rootQueryArb,
	temporalLiteralArb,
} from '../support/search-evaluator-queries';

const evaluators = [evaluateVault, oracleEvaluateVault] as const;

describe('Phase 6 evaluator invariants', () => {
	it('Invariant 8: production and oracle reports and document predicates agree on generated queries and vaults', async () => {
		await assertProperty(
			'search/evaluator__oracle-differential-equivalence',
			fc.property(evaluationCaseArb, rootQueryArb, (sample, input) => {
				const config = evaluatorConfig(sample.timeZone);
				const docs = evaluatorVault(sample.documents, config);
				const prepared = evaluatorQuery(input, config, sample.referenceTimeMs);
				const actual = evaluateVault(docs, prepared);
				const expected = oracleEvaluateVault(docs, prepared);
				expect(actual.matches.map((doc) => doc.file.path)).toEqual(
					expected.matches.map((doc) => doc.file.path),
				);
				expect(actual.propertyDiagnostics).toEqual(expected.propertyDiagnostics);
				for (const doc of docs)
					expect(evaluateDoc(doc, prepared)).toBe(oracleEvaluateDoc(doc, prepared));
				expect(evaluateVault(docs, prepared)).toEqual(actual);
			}),
		);
	});

	it('Invariant 2a: reports are JSON-safe and evaluating cold or warm documents preserves their JSON content', async () => {
		await assertProperty(
			'search/evaluator__report-json-and-nonmutation',
			fc.property(evaluationCaseArb, rootQueryArb, (sample, input) => {
				const config = evaluatorConfig(sample.timeZone);
				const expectedJson = JSON.stringify(evaluatorVault(sample.documents, config));
				const prepared = evaluatorQuery(input, config, sample.referenceTimeMs);
				const astJson = JSON.stringify(prepared.ast);
				for (const evaluate of evaluators) {
					for (const warm of [false, true]) {
						const docs = evaluatorVault(sample.documents, config);
						for (const doc of docs) {
							const descriptor = Object.getOwnPropertyDescriptor(doc, 'aliases');
							expect(Object.prototype.hasOwnProperty.call(descriptor, 'get')).toBe(
								false,
							);
						}
						if (warm) expect(JSON.stringify(docs)).toBe(expectedJson);
						const report = evaluate(docs, prepared);
						expect(JSON.parse(JSON.stringify(report))).toEqual(report);
						for (const diag of report.propertyDiagnostics) {
							for (const value of Object.values(diag))
								expect(value).not.toBeUndefined();
						}
						expect(JSON.stringify(docs)).toBe(expectedJson);
						expect(JSON.stringify(prepared.ast)).toBe(astJson);
					}
				}
			}),
		);
	});

	it('preserves input identity, order and multiplicity, and projects diagnostics independently of matching or short-circuiting', async () => {
		await assertProperty(
			'search/evaluator__ordered-matches-and-diagnostic-projection',
			fc.property(evaluationCaseArb, executableQueryArb, (sample, input) => {
				const config = evaluatorConfig(sample.timeZone);
				const docs = evaluatorVault(sample.documents, config).flatMap((doc) => [doc, doc]);
				const query = evaluatorQuery(input, config, sample.referenceTimeMs);
				const keys = collectReferencedPropertyKeys(query.ast);
				const diagnostics = docs
					.flatMap((doc) => doc.diagnostics)
					.filter((diag) => keys.has(diag.propertyKey));
				for (const [evaluate, evaluateSingle] of [
					[evaluateVault, evaluateDoc],
					[oracleEvaluateVault, oracleEvaluateDoc],
				] as const) {
					for (const source of [
						input,
						logicalQuery('OR', input, `NOT (${input})`),
						logicalQuery('AND', input, `NOT (${input})`),
					]) {
						const prepared = evaluatorQuery(source, config, sample.referenceTimeMs);
						const report = evaluate(docs, prepared);
						const expected = docs.filter((doc) => evaluateSingle(doc, prepared));
						expect(report.matches).toHaveLength(expected.length);
						report.matches.forEach((doc, index) => expect(doc).toBe(expected[index]));
						expect(report.propertyDiagnostics).toEqual(diagnostics);
					}
				}
			}),
		);
	});

	it('queries with the same normalized AST retain identical reports under associative regrouping', async () => {
		await assertProperty(
			'search/evaluator__normalized-query-equivalence',
			fc.property(
				evaluationCaseArb,
				executableQueryArb,
				executableQueryArb,
				executableQueryArb,
				fc.constantFrom('AND' as const, 'OR' as const),
				(sample, a, b, c, op) => {
					const config = evaluatorConfig(sample.timeZone);
					const docs = evaluatorVault(sample.documents, config);
					const left = evaluatorQuery(
						logicalQuery(op, logicalQuery(op, a, b), c),
						config,
						sample.referenceTimeMs,
					);
					const right = evaluatorQuery(
						logicalQuery(op, a, logicalQuery(op, b, c)),
						config,
						sample.referenceTimeMs,
					);
					expect(normalizeAST(left.ast)).toEqual(normalizeAST(right.ast));
					for (const evaluate of evaluators)
						expect(evaluate(docs, left)).toEqual(evaluate(docs, right));
				},
			),
		);
	});

	it('Invariant 6d: actual virtual timestamp filters partition boundary instants and implement interval containment', async () => {
		await assertProperty(
			'search/evaluator__virtual-timestamp-partitioning',
			fc.property(
				timeZoneArb,
				referenceTimeArb,
				temporalLiteralArb,
				documentInputArb,
				(timeZone, referenceTimeMs, literal, source) => {
					const config = evaluatorConfig(timeZone);
					const parsed = parseTemporalExpr(literal, {
						allowYearOnly: true,
						allowRelative: true,
						timeZone,
						referenceTimeMs,
					});
					if (!parsed.ok)
						throw new Error(`Generated invalid temporal literal: ${literal}`);
					const { start, end } = parsed.interval;
					const times = [start - 1, start, end - 1, end, referenceTimeMs];
					const operators = ['<', '=', '>', '>=', '<=', '!='] as const;
					for (const [inputKey, virtualKey] of [
						['mtime', 'modified'],
						['ctime', 'created'],
					] as const) {
						const docs = evaluatorVault(
							times.map((time) => ({ ...source, [inputKey]: time })),
							config,
						);
						const queries = new Map(
							operators.map((op) => [
								op,
								evaluatorQuery(
									`[file.${virtualKey} ${op} ${literal}]`,
									config,
									referenceTimeMs,
								),
							]),
						);
						for (const evaluate of evaluators) {
							const results = new Map(
								operators.map((op) => [
									op,
									new Set(evaluate(docs, queries.get(op)!).matches),
								]),
							);
							for (const doc of docs) {
								const matches = (op: (typeof operators)[number]) =>
									results.get(op)!.has(doc);
								const t = doc.file[virtualKey];
								expect([matches('<'), matches('='), matches('>')]).toEqual([
									t < start,
									t >= start && t < end,
									t >= end,
								]);
								expect(
									Number(matches('<')) +
										Number(matches('=')) +
										Number(matches('>')),
								).toBe(1);
								expect(matches('=')).toBe(matches('>=') && matches('<='));
								expect(matches('!=')).toBe(!matches('='));
							}
						}
					}
				},
			),
		);
	});
});
