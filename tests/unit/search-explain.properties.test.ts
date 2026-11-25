import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyzeQueryExplain, initEngineConfig } from '../../src/core/search';
import { buildConceptsReferenceCallout, buildQueryExplainCallouts } from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';
import { printableExecutableAstArb } from '../support/search-arbitraries';
import { printAST } from '../support/search-printer';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

function createTestConfig() {
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
	if (!res.ok) throw new Error('Expected valid config');
	return res.config;
}

const DUMMY_SPAN = Object.freeze({ startOffset: 0, endOffset: 1, startLine: 1, startColumn: 1 });

describe('analyzeQueryExplain & Query Explain Callout property invariants', () => {
	const config = createTestConfig();

	it('produces footnote-free bullets, balanced code fences, and at most one Mermaid diagram per codeblock for any printable executable AST', () =>
		assertProperty(
			'core/search/explain-plan__printable-executable-ast-footnote-free-and-fences',
			fc.property(printableExecutableAstArb(config, PINNED_REF_MS), (ast) => {
				const query = printAST(ast);
				const analysis = analyzeQueryExplain(query, config, PINNED_REF_MS);

				expect(analysis.executable).toBe(true);
				expect(analysis.errorCount).toBe(0);
				expect(analysis.astBullets.length).toBeGreaterThan(0);

				const calloutsRes = buildQueryExplainCallouts({
					queries: [
						{
							name: 'q1',
							query,
							cutoff: 5_000,
							explicitCutoff: false,
							headerSpan: DUMMY_SPAN,
							bodySpan: DUMMY_SPAN,
							fullSpan: DUMMY_SPAN,
							file: null,
						},
					],
					resolvedConfig: config,
					referenceTimeMs: PINNED_REF_MS,
					isNewNoteMode: false,
					metricsByName: new Map([
						[
							'q1',
							{
								matchedCount: 5,
								sampledCount: 5,
								baseStrideCount: 5,
								referentialTopUpCount: 0,
								downsampled: false,
								effectiveCutoff: 5_000,
								cutoffBound: false,
								exceedsProductionCutoff: false,
							},
						],
					]),
				});
				const conceptsMd = buildConceptsReferenceCallout(
					calloutsRes.triggeredConcepts,
					PINNED_REF_MS,
					config.timeZone,
				);
				const fullMd = [...calloutsRes.callouts, conceptsMd].filter(Boolean).join('\n\n');

				// Zero footnote syntax anywhere in the rendered callouts
				expect(fullMd).not.toMatch(/\[\^\d+\]/);

				// Mermaid Gantt appears at most once across the entire stack
				const mermaidMatches = fullMd.match(/```mermaid/g) ?? [];
				expect(mermaidMatches.length).toBeLessThanOrEqual(1);

				// Balanced code fences inside callout lines
				const fenceCount = (fullMd.match(/^>\s*```/gm) ?? []).length;
				expect(fenceCount % 2).toBe(0);
			}),
		));

	it('never throws on arbitrary raw query strings, timezones, or referenceTimeMs values', () =>
		assertProperty(
			'core/search/explain-plan__arbitrary-input-never-throws',
			fc.property(
				fc.string({ maxLength: 300 }),
				fc.oneof(
					fc.constant('UTC'),
					fc.constant('America/New_York'),
					fc.constant('Invalid/Zone'),
					fc.string({ maxLength: 20 }),
				),
				fc.oneof(
					fc.constant(PINNED_REF_MS),
					fc.integer({ min: -1_000_000_000, max: 2_000_000_000_000 }),
					fc.constant(Number.NaN),
					fc.constant(Number.POSITIVE_INFINITY),
				),
				(rawQuery, tz, refMs) => {
					const analysis = analyzeQueryExplain(
						rawQuery,
						{ timeZone: tz, propertyTypes: { priority: 'number' } },
						refMs,
					);
					expect(typeof analysis.executable).toBe('boolean');
					expect(analysis.astBullets.join('\n')).not.toMatch(/\[\^\d+\]/);
				},
			),
		));
});
