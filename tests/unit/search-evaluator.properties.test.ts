import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	collectReferencedPropertyKeys,
	evaluateDoc,
	evaluateVault,
	normalizeAST,
	normalizeObsidianMetadata,
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
				const hostDoc = docs[0] ?? null;
				const prepared = evaluatorQuery(input, config, sample.referenceTimeMs, hostDoc);
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
									`[file.${virtualKey}: ${op} ${literal}]`,
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
							for (let i = 0; i < docs.length; i++) {
								const doc = docs[i]!;
								const t = times[i]!;
								const matches = (op: (typeof operators)[number]) =>
									results.get(op)!.has(doc);
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

	it('Graph Differential Invariant: multi-source reverse BFS + residual simple-path evaluator matches forward-DFS oracle across arbitrary cyclic/self-linked vaults and @query.* waves', async () => {
		const nodePaths = ['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md', 'n5.md'] as const;
		const edgeSpecArb = fc.record({
			from: fc.integer({ min: 0, max: nodePaths.length - 1 }),
			to: fc.integer({ min: 0, max: nodePaths.length - 1 }),
			kind: fc.constantFrom(
				'prose' as const,
				'up' as const,
				'related' as const,
				'embed' as const,
			),
		});
		const nodeTagsArb = fc.array(fc.subarray(['goal', 'project', 'task'], { maxLength: 2 }), {
			minLength: nodePaths.length,
			maxLength: nodePaths.length,
		});
		const arrowArb = fc.constantFrom(
			'->',
			'<-',
			'->*',
			'<-*',
			'->0..*',
			'<-0..*',
			'->..2',
			'<-..3',
			'->2..3',
			'<-2..4',
			'->3..3',
		);
		const targetArb = fc.constantFrom(
			'{ #goal }',
			'{ #project }',
			'{ #task }',
			'{}',
			'@this',
			'@query.wave0',
			'{ links -> { #goal } }',
		);
		const graphFilterArb = fc.oneof(
			fc
				.tuple(fc.constantFrom('links', 'embeds', 'backlinks'), arrowArb, targetArb)
				.map(([s, a, t]) => `${s} ${a} ${t}`),
			fc
				.tuple(fc.constantFrom('up', 'related'), arrowArb, targetArb)
				.map(([k, a, t]) => `[${k} ${a} ${t}]`),
			fc.constantFrom(
				'tag:@query.wave0.tags',
				'[file.basename: = @query.wave0.file.basename]',
			),
		);
		const compoundGraphQueryArb = fc.oneof(
			graphFilterArb,
			graphFilterArb.map((q) => `NOT (${q})`),
			fc
				.tuple(
					fc.constantFrom('AND' as const, 'OR' as const),
					graphFilterArb,
					graphFilterArb,
				)
				.map(([op, l, r]) => `(${l}) ${op} (${r})`),
		);

		await assertProperty(
			'search/evaluator__graph-reachability-oracle-equivalence',
			fc.property(
				nodeTagsArb,
				fc.array(edgeSpecArb, { maxLength: 18 }),
				fc.option(fc.integer({ min: 0, max: nodePaths.length - 1 }), { nil: null }),
				compoundGraphQueryArb,
				(tagsPerNode, edges, hostIdx, queryStr) => {
					const config = evaluatorConfig('UTC');
					const validPaths = new Set<string>(nodePaths);
					const resolveLinkPath = (rawTarget: string) =>
						validPaths.has(rawTarget) ? rawTarget : null;

					const docs = nodePaths.map((p, idx) => {
						const outgoing = edges.filter((e) => e.from === idx);
						const upTargets = outgoing
							.filter((e) => e.kind === 'up')
							.map((e) => nodePaths[e.to]!);
						const relTargets = outgoing
							.filter((e) => e.kind === 'related')
							.map((e) => nodePaths[e.to]!);
						const proseTargets = outgoing
							.filter((e) => e.kind === 'prose')
							.map((e) => nodePaths[e.to]!);
						const embedTargets = outgoing
							.filter((e) => e.kind === 'embed')
							.map((e) => nodePaths[e.to]!);

						return normalizeObsidianMetadata(
							{
								path: p,
								name: p,
								basename: p.replace(/\.md$/, ''),
								extension: 'md',
								parent: { path: '/' },
								stat: { ctime: 1700000000000, mtime: 1700000000000, size: 100 },
							},
							{
								frontmatter: {
									tags: tagsPerNode[idx]!,
									...(upTargets.length > 0
										? { up: upTargets.map((t) => `[[${t}]]`) }
										: {}),
									...(relTargets.length > 0
										? { related: relTargets.map((t) => `[[${t}]]`) }
										: {}),
								},
								frontmatterLinks: [
									...upTargets.map((t, i) => ({ link: t, key: `up.${i}` })),
									...relTargets.map((t, i) => ({
										link: t,
										key: `related.${i}`,
									})),
								],
								links: proseTargets.map((t) => ({ link: t })),
								embeds: embedTargets.map((t) => ({ link: t })),
							},
							config,
							[],
							resolveLinkPath,
						);
					});

					const hostDoc = hostIdx !== null ? docs[hostIdx]! : null;
					const wave0Prepared = evaluatorQuery(
						'#project',
						config,
						1700000000000,
						hostDoc,
					);
					const wave0Matches = evaluateVault(docs, wave0Prepared).matches;
					const prior = new Map([['wave0', wave0Matches]]);

					const prepared = evaluatorQuery(queryStr, config, 1700000000000, hostDoc);
					const actual = evaluateVault(docs, prepared, prior).matches.map(
						(d) => d.file.path,
					);
					const expected = oracleEvaluateVault(docs, prepared, prior).matches.map(
						(d) => d.file.path,
					);
					expect(actual).toEqual(expected);
				},
			),
		);
	});
});
