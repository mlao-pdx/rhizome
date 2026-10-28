import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { explainQuery, initEngineConfig } from '../../src/core/search';
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

describe('explainQuery property invariants', () => {
	const config = createTestConfig();

	it('always produces all 3 Diátaxis sections and balanced code fences for any printable executable AST', () =>
		assertProperty(
			'core/search/explain-plan__printable-executable-ast-sections-and-fences',
			fc.property(printableExecutableAstArb(config, PINNED_REF_MS), (ast) => {
				const query = printAST(ast);
				const md = explainQuery(query, config, PINNED_REF_MS);

				expect(md).toContain('# Query Explain Plan');
				expect(md).toContain('## Explanation — How This Query Matches Notes');
				expect(md).toContain('## Reference — Execution Context & Resolution');
				expect(md).toContain('## Troubleshooting & Diagnostics');
				expect(md).toContain('**Status**: **Executable**');
				expect(md).toContain('```mermaid\nflowchart TD');

				const fenceCount = (md.match(/^```/gm) ?? []).length;
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
					const md = explainQuery(
						rawQuery,
						{ timeZone: tz, propertyTypes: { priority: 'number' } },
						refMs,
					);
					expect(typeof md).toBe('string');
					expect(md).toContain('## Explanation — How This Query Matches Notes');
					expect(md).toContain('## Reference — Execution Context & Resolution');
					expect(md).toContain('## Troubleshooting & Diagnostics');
				},
			),
		));
});
