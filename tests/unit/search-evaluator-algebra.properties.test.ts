import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateVault, oracleEvaluateVault } from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';
import {
	evaluationCaseArb,
	evaluatorConfig,
	evaluatorQuery,
	evaluatorVault,
} from '../support/search-evaluator-documents';
import {
	colonPropertyArb,
	executableQueryArb,
	logicalQuery,
	scopeArb,
	valueExprArb,
} from '../support/search-evaluator-queries';

const evaluators = [evaluateVault, oracleEvaluateVault] as const;

describe('Phase 6 boolean algebra and existential quantifier invariants', () => {
	it('Invariant 7: document-level complementarity partitions the entire input vault', async () => {
		await assertProperty(
			'search/evaluator__boolean-complementarity',
			fc.property(evaluationCaseArb, executableQueryArb, (sample, a) => {
				const config = evaluatorConfig(sample.timeZone);
				const docs = evaluatorVault(sample.documents, config);
				const tautology = evaluatorQuery(
					logicalQuery('OR', a, `NOT (${a})`),
					config,
					sample.referenceTimeMs,
				);
				const contradiction = evaluatorQuery(
					logicalQuery('AND', a, `NOT (${a})`),
					config,
					sample.referenceTimeMs,
				);
				for (const evaluate of evaluators) {
					expect(evaluate(docs, tautology).matches).toEqual(docs);
					expect(evaluate(docs, contradiction).matches).toEqual([]);
				}
			}),
		);
	});

	it('Invariant 7: both De Morgan laws hold for nested executable document queries', async () => {
		await assertProperty(
			'search/evaluator__de-morgan-laws',
			fc.property(
				evaluationCaseArb,
				executableQueryArb,
				executableQueryArb,
				(sample, a, b) => {
					const config = evaluatorConfig(sample.timeZone);
					const docs = evaluatorVault(sample.documents, config);
					for (const evaluate of evaluators) {
						const matches = (query: string) =>
							evaluate(docs, evaluatorQuery(query, config, sample.referenceTimeMs))
								.matches;
						expect(matches(`NOT (${logicalQuery('AND', a, b)})`)).toEqual(
							matches(logicalQuery('OR', `NOT (${a})`, `NOT (${b})`)),
						);
						expect(matches(`NOT (${logicalQuery('OR', a, b)})`)).toEqual(
							matches(logicalQuery('AND', `NOT (${a})`, `NOT (${b})`)),
						);
					}
				},
			),
		);
	});

	it.each(['scope', 'property'] as const)(
		'Invariant 7: %s OR distributes over targets while AND only implies separate existential matches',
		async (kind) => {
			await assertProperty(
				`search/evaluator__${kind}-existential-distribution`,
				fc.property(
					evaluationCaseArb,
					kind === 'scope' ? scopeArb : colonPropertyArb,
					valueExprArb,
					valueExprArb,
					(sample, target, a, b) => {
						const config = evaluatorConfig(sample.timeZone);
						const docs = evaluatorVault(sample.documents, config);
						const render = (expr: string) =>
							kind === 'scope' ? `${target}:(${expr})` : `[${target}: (${expr})]`;
						const prepare = (query: string) =>
							evaluatorQuery(query, config, sample.referenceTimeMs);
						const combinedOr = prepare(render(logicalQuery('OR', a, b)));
						const separateOr = prepare(logicalQuery('OR', render(a), render(b)));
						const combinedAnd = prepare(render(logicalQuery('AND', a, b)));
						const separateAnd = prepare(logicalQuery('AND', render(a), render(b)));
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
});
