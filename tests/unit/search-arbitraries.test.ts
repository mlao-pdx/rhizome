import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	compileQuery,
	evaluateVault,
	MAX_QUERY_LENGTH,
	MAX_SYNTACTIC_DEPTH,
	oracleEvaluateVault,
	type SearchAST,
	type ValueExprAST,
} from '../../src/core/search';
import {
	booleanAlgebraASTs,
	boundedCompositionsArb,
	distributionASTs,
} from '../support/search-algebra';
import { printableExecutableAstArb } from '../support/search-arbitraries';
import {
	documentInputArb,
	evaluatorConfig,
	evaluatorQuery,
	evaluatorVault,
} from '../support/search-evaluator-documents';
import { computeSyntacticDepth, printAST } from '../support/search-printer';

const REFERENCE_TIME_MS = Date.parse('2026-10-22T15:30:00.000Z');

describe('printable executable AST generator', () => {
	it('samples only bounded executable queries', () => {
		const config = evaluatorConfig('America/New_York');
		const samples = fc.sample(printableExecutableAstArb(config, REFERENCE_TIME_MS), {
			numRuns: 200,
			seed: 7,
		});
		for (const ast of samples) {
			const query = printAST(ast);
			expect(query.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
			expect(computeSyntacticDepth(ast)).toBeLessThanOrEqual(MAX_SYNTACTIC_DEPTH);
			expect(compileQuery(query, config, REFERENCE_TIME_MS).executable).toBe(true);
		}
	});

	it('preserves property OR distribution but only AND containment across separate values', () => {
		const config = evaluatorConfig('UTC');
		const input = fc.sample(documentInputArb, { numRuns: 1, seed: 7 })[0]!;
		const docs = evaluatorVault(
			[
				{
					...input,
					cacheMissing: false,
					frontmatter: [['labels', ['alpha', 'beta']]],
					inline: [],
				},
			],
			config,
		);
		const leaf = (value: string): ValueExprAST => ({
			type: 'VALUE_LEAF',
			matcher: { kind: 'string', value, quoted: false },
		});
		const asts = distributionASTs(
			{ type: 'PROPERTY_FILTER', key: 'labels', rawKey: 'labels', operator: ':' },
			leaf('alpha'),
			leaf('beta'),
		);
		const prepare = (ast: SearchAST) =>
			evaluatorQuery(printAST(ast), config, REFERENCE_TIME_MS);
		for (const evaluate of [evaluateVault, oracleEvaluateVault]) {
			expect(evaluate(docs, prepare(asts.combinedOr)).matches).toEqual(docs);
			expect(evaluate(docs, prepare(asts.separateOr)).matches).toEqual(docs);
			expect(evaluate(docs, prepare(asts.combinedAnd)).matches).toEqual([]);
			expect(evaluate(docs, prepare(asts.separateAnd)).matches).toEqual(docs);
		}
	});

	it.each(['length', 'depth'] as const)(
		'rejects algebra compositions exceeding the %s limit despite valid operands',
		(limit) => {
			const config = evaluatorConfig('UTC');
			const leaf = (value: string): SearchAST => ({
				type: 'TEXT_MATCH',
				matcher: { kind: 'string', value, quoted: true },
				rawText: value,
			});
			const safe = leaf('work');
			let oversized = leaf('x'.repeat(MAX_QUERY_LENGTH / 2));
			if (limit === 'depth') {
				oversized = safe;
				for (let depth = 0; depth < MAX_SYNTACTIC_DEPTH; depth++) {
					oversized = { type: 'NOT', syntax: '-', child: oversized };
				}
			}
			expect(compileQuery(printAST(oversized), config, REFERENCE_TIME_MS).executable).toBe(
				true,
			);
			const invalid = booleanAlgebraASTs(oversized, safe);
			expect(
				Object.values(invalid).some(
					(ast) => !compileQuery(printAST(ast), config, REFERENCE_TIME_MS).executable,
				),
			).toBe(true);
			const valid = booleanAlgebraASTs(safe, safe);
			const samples = fc.sample(boundedCompositionsArb(fc.constantFrom(invalid, valid)), {
				numRuns: 20,
				seed: 7,
			});
			for (const asts of samples) {
				expect(asts).toBe(valid);
				for (const ast of Object.values(asts)) {
					expect(printAST(ast).length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
					expect(computeSyntacticDepth(ast)).toBeLessThanOrEqual(MAX_SYNTACTIC_DEPTH);
					expect(compileQuery(printAST(ast), config, REFERENCE_TIME_MS).executable).toBe(
						true,
					);
				}
			}
		},
	);
});
