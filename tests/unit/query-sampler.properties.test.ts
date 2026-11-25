import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	BASE_SAMPLE_SIZE,
	MAX_SAMPLE_SIZE,
	sampleStaticQueryBatch,
	type ExtractedQueryBlock,
} from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

const SPAN = Object.freeze({ startOffset: 0, endOffset: 1, startLine: 1, startColumn: 1 });

describe('query-sampler property invariants', () => {
	it('is deterministic, bounded by min(M, MAX_SAMPLE_SIZE, effectiveCutoff), duplicate-free, and strictly order-preserving', () =>
		assertProperty(
			'templates/query-sampler__deterministic-bounded-order-preserving',
			fc.property(
				fc.integer({ min: 0, max: 1_200 }),
				fc.oneof(fc.constant(5_000), fc.constant(0), fc.integer({ min: 1, max: 600 })),
				fc.array(fc.integer({ min: 0, max: 1_199 }), { maxLength: 600 }),
				(matchCount, cutoff, linkedTargets) => {
					const hubLinks = linkedTargets.map((idx) => ({
						resolvedPath: `N/${idx}.md`,
					}));
					const rows = Array.from({ length: matchCount }, (_, idx) => ({
						idx,
						file: { path: `N/${idx}.md` },
					}));
					const blocks: ExtractedQueryBlock[] = [
						{
							name: 'hub',
							query: '#hub',
							cutoff: 5_000,
							explicitCutoff: false,
							headerSpan: SPAN,
							bodySpan: SPAN,
							fullSpan: SPAN,
							file: null,
						},
						{
							name: 'items',
							query: '#item',
							cutoff,
							explicitCutoff: cutoff !== 5_000,
							headerSpan: SPAN,
							bodySpan: SPAN,
							fullSpan: SPAN,
							file: null,
						},
					];
					const payload = {
						hub: [{ file: { path: 'Hub.md' }, links: hubLinks }],
						items: rows,
					};

					const run1 = sampleStaticQueryBatch(blocks, payload);
					const run2 = sampleStaticQueryBatch(blocks, payload);

					const sampled1 = run1.sampledPayload['items'] as Array<{ idx: number }>;
					const sampled2 = run2.sampledPayload['items'] as Array<{ idx: number }>;

					// Determinism
					expect(sampled1.map((r) => r.idx)).toEqual(sampled2.map((r) => r.idx));

					// Input immutability
					expect(rows).toHaveLength(matchCount);

					// Exact upper bound
					const effectiveCutoff = cutoff > 0 ? cutoff : Number.POSITIVE_INFINITY;
					const hardCeiling = Math.min(matchCount, MAX_SAMPLE_SIZE, effectiveCutoff);
					expect(sampled1.length).toBeLessThanOrEqual(hardCeiling);
					if (matchCount <= Math.min(BASE_SAMPLE_SIZE, effectiveCutoff)) {
						expect(sampled1.length).toBe(matchCount);
					}

					// Strict vault index ordering & zero duplicates
					for (let i = 1; i < sampled1.length; i++) {
						expect(sampled1[i]!.idx).toBeGreaterThan(sampled1[i - 1]!.idx);
					}
				},
			),
		));
});
