import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { initEngineConfig } from '../../src/core/search';
import { analyzeRhizomeCodeBlock } from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

describe('Codeblock Analyzer Property Invariants', () => {
	const cfgRes = initEngineConfig({
		timeZone: 'UTC',
		propertyTypes: {
			score: 'number',
			due: 'date',
			done: 'checkbox',
		},
	});
	if (!cfgRes.ok) throw new Error('Expected valid config');
	const config = cfgRes.config;

	it('Span Validity & Ordering Invariant: analyzeRhizomeCodeBlock never throws and emits bounded, non-overlapping sorted token spans and sorted diagnostic spans', async () => {
		const fragmentArb = fc.constantFrom(
			'{% query q1 %}',
			'{%- query q2 explain -%}',
			'{% query %}',
			'{% query 9bad %}',
			'{% endquery %}',
			'{% endquery bad %}',
			'{% comment %}',
			'{% endcomment %}',
			'{% # inline comment %}',
			'tag:work',
			'[score: >= 10]',
			'[score: = "bad"]',
			'badscope:foo',
			'links:[[Note]]',
			'/regex/i',
			'"quoted"',
			'@today..@today-7d',
			'{{ q1.size | default: 0 }}',
			'{% for x in q1 %}{{ x.file.basename }}{% endfor %}',
			'{% if unclosed',
			'{{ unclosed',
			'\n',
		);

		const codeblockArb = fc.oneof(
			fc.string({ maxLength: 140 }),
			fc.array(fragmentArb, { minLength: 1, maxLength: 16 }).map((parts) => parts.join(' ')),
		);

		await assertProperty(
			'templates/analyzer__span-validity-and-non-decreasing-ordering',
			fc.property(codeblockArb, (source) => {
				const analysis = analyzeRhizomeCodeBlock(source, config, PINNED_REF_MS);

				let prevTokenEnd = 0;
				for (const tok of analysis.tokens) {
					expect(tok.startOffset).toBeGreaterThanOrEqual(0);
					expect(tok.endOffset).toBeGreaterThan(tok.startOffset);
					expect(tok.endOffset).toBeLessThanOrEqual(source.length);
					expect(tok.startOffset).toBeGreaterThanOrEqual(prevTokenEnd);
					prevTokenEnd = tok.endOffset;
				}

				let prevDiagStart = 0;
				let prevDiagEnd = 0;
				for (const diag of analysis.diagnostics) {
					expect(diag.startOffset).toBeGreaterThanOrEqual(0);
					expect(diag.endOffset).toBeGreaterThanOrEqual(diag.startOffset);
					expect(diag.endOffset).toBeLessThanOrEqual(source.length);
					expect(
						diag.startOffset > prevDiagStart ||
							(diag.startOffset === prevDiagStart && diag.endOffset >= prevDiagEnd),
					).toBe(true);
					prevDiagStart = diag.startOffset;
					prevDiagEnd = diag.endOffset;
				}
			}),
		);
	});
});
