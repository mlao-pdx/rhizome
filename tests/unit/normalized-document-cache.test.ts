import type { App, CachedMetadata, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import { digestNormalizedDocument } from '../../src/core/cache/doc-digest';
import { INTERNAL_RHIZOME_CODES } from '../../src/core/search';
import { makeConfig } from '../support/cache-fixtures';
import { createMockApp } from '../support/mock-obsidian-app';

interface MockFile extends TFile {
	deleted?: boolean;
}

function makeFile(path: string, mtime = 1_700_000_000_000): MockFile {
	const slashIdx = path.lastIndexOf('/');
	const name = slashIdx === -1 ? path : path.slice(slashIdx + 1);
	const dotIdx = name.lastIndexOf('.');
	return {
		path,
		name,
		basename: dotIdx === -1 ? name : name.slice(0, dotIdx),
		extension: dotIdx === -1 ? '' : name.slice(dotIdx + 1),
		parent: { path: slashIdx === -1 ? '' : path.slice(0, slashIdx) },
		stat: { ctime: mtime, mtime, size: 100 },
	} as unknown as MockFile;
}

function resolver(raw: string): string | null {
	return raw === 'Missing' ? null : `Targets/${raw}.md`;
}

function setup(
	files: MockFile[],
	caches: Map<string, CachedMetadata | null>,
	resolvedLinks: Record<string, Record<string, number>> = {},
) {
	const app = createMockApp({ files, fileCache: caches, resolvedLinks }) as App;
	const cache = new NormalizedDocumentCache(app);
	return { app, cache };
}

describe('NormalizedDocumentCache', () => {
	it('normalizes, freezes, and keys entries by stat plus opaque revision', () => {
		const file = makeFile('notes/a.md');
		const metadata = { frontmatter: { status: 'active' } } as CachedMetadata;
		const { app, cache } = setup([file], new Map([[file.path, metadata]]));
		const config = makeConfig();

		const result = cache.reconcile([file], config, resolver);
		expect(result.stats.add).toBe(1);

		const doc = cache.get('notes/a.md')!;
		expect(doc.properties['status']).toBeDefined();
		expect(Object.isFrozen(doc)).toBe(true);
		expect(Object.isFrozen(doc.properties)).toBe(true);
		expect(Object.isFrozen(doc.links)).toBe(true);
		expect('backlinks' in doc).toBe(false);

		const key = cache.getKey('notes/a.md')!;
		expect(key.fingerprint).toBe(config.normalizationFingerprint);

		// Same stat, new CachedMetadata object identity -> revision changes -> update.
		(app.metadataCache as unknown as { getFileCache: () => unknown }).getFileCache = () => ({
			frontmatter: { status: 'active' },
		});
		const next = cache.reconcile([file], config, resolver);
		expect(next.stats.update).toBe(1);
		expect(cache.getKey('notes/a.md')!.revision).not.toBe(key.revision);
	});

	it('ignores same-instant stat changes when identity and links are unchanged', () => {
		const file = makeFile('notes/a.md');
		const metadata = { frontmatter: {} } as CachedMetadata;
		const { cache } = setup([file], new Map([[file.path, metadata]]));
		const config = makeConfig();

		cache.reconcile([file], config, resolver);
		file.stat = { ...file.stat, mtime: file.stat.mtime + 1 };
		expect(cache.reconcile([file], config, resolver).stats.update).toBe(1);
		expect(cache.reconcile([file], config, resolver).stats.update).toBe(0);
	});

	it('re-normalizes when a source’s resolvedLinks signature changes without an event', () => {
		const file = makeFile('notes/a.md');
		const metadata = {
			frontmatter: {},
			links: [{ link: 'Roadmap', original: '[[Roadmap]]', position: {} }],
		} as unknown as CachedMetadata;
		const resolvedLinks: Record<string, Record<string, number>> = {
			'notes/a.md': { 'Targets/Roadmap.md': 1 },
		};
		const { cache } = setup([file], new Map([[file.path, metadata]]), resolvedLinks);
		const config = makeConfig();

		cache.reconcile([file], config, resolver);
		const before = cache.getKey('notes/a.md')!.revision;

		resolvedLinks['notes/a.md'] = { 'Elsewhere/Roadmap.md': 1 };
		const next = cache.reconcile([file], config, resolver);
		expect(next.stats.update).toBe(1);
		expect(cache.getKey('notes/a.md')!.revision).not.toBe(before);
	});

	it('drops notes that gain the ignore flag and never adds ignored notes', () => {
		const file = makeFile('notes/a.md');
		const metadata = { frontmatter: {} } as CachedMetadata;
		const caches = new Map<string, CachedMetadata | null>([[file.path, metadata]]);
		const { cache } = setup([file], caches);
		const config = makeConfig();

		cache.reconcile([file], config, resolver);
		expect(cache.get('notes/a.md')).toBeDefined();

		caches.set(file.path, {
			frontmatter: {
				'◊InternalRhizome': { [INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY]: 'do not' },
			},
		});
		const result = cache.reconcile([file], config, resolver);
		expect(result.stats.remove).toBe(1);
		expect(result.ignoredChanges.has(file.path)).toBe(true);
		expect(cache.get('notes/a.md')).toBeUndefined();
	});

	it('skips a note that fails normalization and keeps the pass alive', () => {
		const good = makeFile('notes/good.md');
		const bad = makeFile('notes/bad.md');
		bad.stat = { ctime: Number.NaN, mtime: Number.NaN, size: Number.NaN };
		const caches = new Map<string, CachedMetadata | null>([
			[good.path, { frontmatter: {} }],
			[bad.path, { frontmatter: {} }],
		]);
		const { app } = setup([good, bad], caches);
		const logger = { log: vi.fn() };
		const cached = new NormalizedDocumentCache(app, logger);

		const result = cached.reconcile([good, bad], makeConfig(), resolver);
		expect(result.stats.add).toBe(1);
		expect(cached.get(good.path)).toBeDefined();
		expect(cached.get(bad.path)).toBeUndefined();
		expect(logger.log).toHaveBeenCalled();
	});

	it('produces a stable digest across a reload', () => {
		const file = makeFile('notes/a.md');
		const metadata = {
			frontmatter: { status: 'active', priority: 2 },
			links: [{ link: 'Roadmap', original: '[[Roadmap]]', position: {} }],
			tags: [{ tag: '#work', position: {} }],
		} as unknown as CachedMetadata;
		const { app, cache } = setup([file], new Map([[file.path, metadata]]));
		const config = makeConfig({ priority: 'number' });

		cache.reconcile([file], config, resolver);
		const reloaded = new NormalizedDocumentCache(app);
		reloaded.reconcile([file], config, resolver);

		expect(reloaded.digest()).toBe(cache.digest());
		expect(reloaded.get('notes/a.md')).not.toBe(cache.get('notes/a.md'));
		expect(digestNormalizedDocument(reloaded.get('notes/a.md')!)).toBe(
			digestNormalizedDocument(cache.get('notes/a.md')!),
		);
	});

	it('finds dependent sources by raw target, basename, and resolved path', () => {
		const a = makeFile('notes/a.md');
		const b = makeFile('notes/b.md');
		const caches = new Map<string, CachedMetadata | null>([
			[
				a.path,
				{
					frontmatter: {},
					links: [
						{
							link: 'Projects/Roadmap',
							original: '[[Projects/Roadmap]]',
							position: {},
						},
					],
				} as unknown as CachedMetadata,
			],
			[
				b.path,
				{
					frontmatter: {},
					embeds: [
						{ link: 'Assets/pic.png', original: '![[Assets/pic.png]]', position: {} },
					],
				} as unknown as CachedMetadata,
			],
		]);
		const { cache } = setup([a, b], caches);

		cache.reconcile([a, b], makeConfig(), resolver);

		expect([...cache.dependentSources(['Roadmap.md'])]).toEqual([a.path]);
		expect([...cache.dependentSources(['Targets/Roadmap.md'])]).toEqual([a.path]);
		expect([...cache.dependentSources(['Assets/pic.png'])]).toEqual([b.path]);
		expect([...cache.dependentSources(['notes/unrelated.md'])]).toEqual([]);
	});

	it('drops the old path on rename and re-adds the new path on reconcile', () => {
		const file = makeFile('notes/old.md');
		const { cache } = setup([file], new Map([[file.path, { frontmatter: {} }]]));
		const config = makeConfig();
		cache.reconcile([file], config, resolver);

		cache.rename('notes/old.md', 'notes/new.md');
		expect(cache.get('notes/old.md')).toBeUndefined();

		file.path = 'notes/new.md';
		cache.reconcile([file], config, resolver);
		expect(cache.get('notes/new.md')?.file.path).toBe('notes/new.md');
	});
});
