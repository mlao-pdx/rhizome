import { describe, expect, it } from 'vitest';

import { digestNormalizedDocument } from '../../src/core/cache/doc-digest';
import { makeConfig, makeDoc } from '../support/cache-fixtures';

describe('digestNormalizedDocument', () => {
	it('is stable across repeated normalization of the same frontmatter', () => {
		const a = makeDoc({ frontmatter: { alpha: 1, beta: 'x', Gamma: true } });
		const b = makeDoc({ frontmatter: { alpha: 1, beta: 'x', Gamma: true } });

		expect(digestNormalizedDocument(a)).toBe(digestNormalizedDocument(b));
	});

	it('ignores the adapter-attached backlinks field', () => {
		const doc = makeDoc({ frontmatter: { status: 'active' } });
		const before = digestNormalizedDocument(doc);
		doc.backlinks = [{ path: 'notes/source.md', count: 2 }];

		expect(digestNormalizedDocument(doc)).toBe(before);
	});

	it('changes when metadata, links, resolution, or the config fingerprint changes', () => {
		const base = makeDoc({
			links: [{ link: 'Roadmap' }],
			frontmatter: { priority: 1 },
		});
		const baseDigest = digestNormalizedDocument(base);

		expect(digestNormalizedDocument(makeDoc({ frontmatter: { priority: 2 } }))).not.toBe(
			baseDigest,
		);
		expect(
			digestNormalizedDocument(makeDoc({ links: [{ link: 'Roadmap' }], tags: ['#tag'] })),
		).not.toBe(baseDigest);
		expect(
			digestNormalizedDocument(
				makeDoc({
					links: [{ link: 'Roadmap' }],
					frontmatter: { priority: 1 },
					resolve: () => null,
				}),
			),
		).not.toBe(baseDigest);
		expect(
			digestNormalizedDocument(
				makeDoc({
					links: [{ link: 'Roadmap' }],
					frontmatter: { priority: 1 },
					config: makeConfig({ priority: 'number' }),
				}),
			),
		).not.toBe(baseDigest);
	});

	it('is independent of object identity and array reference reuse', () => {
		const first = makeDoc({ frontmatter: { status: 'a' }, links: [{ link: 'B' }] });
		const second = makeDoc({ frontmatter: { status: 'a' }, links: [{ link: 'B' }] });

		expect(first).not.toBe(second);
		expect(digestNormalizedDocument(first)).toBe(digestNormalizedDocument(second));
	});
});
