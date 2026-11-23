import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeAndValidateTargetPath, TargetPathClaimRegistry } from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

const ILLEGAL_CHAR_RE = /[\\:*?"<>|]/;

function hasAnyControlChar(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

const safeSegmentArb = fc
	.tuple(
		fc.constantFrom('a', 'b', 'c', 'N', 'P', '2', '9', 'Note', 'Area', 'Sprint'),
		fc.stringMatching(/^[a-zA-Z0-9 _-]{0,10}$/),
		fc.constantFrom('a', 'b', '1', '2', 'x', 'z'),
	)
	.map(([head, mid, tail]) => `${head}${mid}${tail}`.trim());

const safeTargetPathArb = fc
	.tuple(
		fc.boolean(),
		fc.array(safeSegmentArb, { minLength: 1, maxLength: 4 }),
		fc.constantFrom('', '.md', '.MD'),
	)
	.map(([leadingSlash, segs, ext]) => `${leadingSlash ? '/' : ''}${segs.join('/')}${ext}`);

describe('target-path property invariants', () => {
	it('no traversal, leading slash, dot-segment, control/illegal char, configDir, or ◊Rhizome/logs path ever survives normalizeAndValidateTargetPath', async () => {
		const adversarialArb = fc.oneof(
			fc.string({ maxLength: 60 }),
			safeTargetPathArb,
			fc.tuple(safeSegmentArb, safeSegmentArb).map(([a, b]) => `${a}/../${b}`),
			fc.tuple(safeSegmentArb, safeSegmentArb).map(([a, b]) => `mock-config/${a}/${b}`),
			fc.tuple(safeSegmentArb, safeSegmentArb).map(([a, b]) => `.dotdir/${a}/${b}`),
			fc.tuple(safeSegmentArb).map(([a]) => `◊Rhizome/logs/${a}`),
			fc
				.tuple(
					safeSegmentArb,
					fc.constantFrom('\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\0'),
				)
				.map(([a, bad]) => `Notes/${a}${bad}x`),
		);

		await assertProperty(
			'templates/target-path__safety-invariants',
			fc.property(adversarialArb, (candidate) => {
				const res = normalizeAndValidateTargetPath(candidate, { configDir: 'mock-config' });
				if (!res.ok) {
					expect(res.diagnostic.code).toBe('INVALID_TARGET_PATH');
					return;
				}
				const p = res.path;
				expect(p.length).toBeGreaterThan(3);
				expect(p.startsWith('/')).toBe(false);
				expect(p.endsWith('.md')).toBe(true);
				expect(p.includes('//')).toBe(false);
				expect(ILLEGAL_CHAR_RE.test(p)).toBe(false);
				expect(hasAnyControlChar(p)).toBe(false);
				const lower = p.toLowerCase();
				expect(lower.startsWith('mock-config/')).toBe(false);
				expect(lower.startsWith('◊rhizome/logs/')).toBe(false);
				for (const seg of p.split('/')) {
					expect(seg.length).toBeGreaterThan(0);
					expect(seg === '.' || seg === '..').toBe(false);
					expect(seg.startsWith('.')).toBe(false);
				}
			}),
			{ numRuns: 300 },
		);
	});

	it('TargetPathClaimRegistry guarantees pairwise case-insensitive uniqueness across K blocks and existing vault paths, plus intra-block idempotence', async () => {
		const existingArb = fc.array(
			safeTargetPathArb.map((raw) => {
				const v = normalizeAndValidateTargetPath(raw);
				return v.ok ? v.path : 'Existing.md';
			}),
			{ maxLength: 8 },
		);

		const blockHistoryArb = fc.array(
			fc.array(
				safeTargetPathArb.map((raw) => {
					const v = normalizeAndValidateTargetPath(raw);
					return v.ok ? v.path : 'Note.md';
				}),
				{ minLength: 1, maxLength: 4 },
			),
			{ minLength: 1, maxLength: 6 },
		);

		await assertProperty(
			'templates/target-path__collision-disjointness-and-idempotence',
			fc.property(existingArb, blockHistoryArb, (existingPaths, blocksHistory) => {
				const registry = new TargetPathClaimRegistry(existingPaths);
				const existingLower = new Set(existingPaths.map((p) => p.toLowerCase()));
				const finalClaims: string[] = [];

				for (let blockIdx = 0; blockIdx < blocksHistory.length; blockIdx++) {
					const calls = blocksHistory[blockIdx]!;
					let current = '';
					for (const requested of calls) {
						current = registry.claim(blockIdx, requested);
						// Re-claiming the resolved path within the same block is idempotent
						expect(registry.claim(blockIdx, current)).toBe(current);
					}
					finalClaims.push(current);
				}

				const seenFinalLower = new Set<string>();
				for (const claimed of finalClaims) {
					const lower = claimed.toLowerCase();
					expect(existingLower.has(lower)).toBe(false);
					expect(seenFinalLower.has(lower)).toBe(false);
					seenFinalLower.add(lower);
				}
			}),
			{ numRuns: 250 },
		);
	});
});
