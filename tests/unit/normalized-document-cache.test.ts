import type { App, CachedMetadata, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { BodyScanCache } from '../../src/adapters/body-scan-cache';
import { BodyScanIdbStore } from '../../src/adapters/body-scan-idb';
import { createMemoizedLinkResolver } from '../../src/adapters/link-resolver-memo';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import { runVaultQuery } from '../../src/adapters/vault-query-runner';
import { digestNormalizedDocument } from '../../src/core/cache/doc-digest';
import {
	getInternalFileEpochMs,
	INTERNAL_RHIZOME_CODES,
	normalizeObsidianMetadata,
} from '../../src/core/search';
import { expectDeepFrozen, makeConfig } from '../support/cache-fixtures';
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
		expect(result.changed).toBe(true);
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

	it('uses O(1) link signature fast-path when a note has no links or embeds and detects link resolution changes', () => {
		const plain = makeFile('notes/plain.md');
		const linked = makeFile('notes/linked.md');
		const resolvedLinks: Record<string, Record<string, number>> = {
			'notes/plain.md': { 'Targets/Ghost.md': 1 },
			'notes/linked.md': { 'Targets/Roadmap.md': 1 },
		};
		const caches = new Map<string, CachedMetadata | null>([
			[plain.path, { frontmatter: { status: 'active' } }],
			[
				linked.path,
				{
					frontmatter: {},
					links: [{ link: 'Roadmap', original: '[[Roadmap]]', position: {} }],
				} as unknown as CachedMetadata,
			],
		]);
		const { cache } = setup([plain, linked], caches, resolvedLinks);
		const config = makeConfig();

		cache.reconcile([plain, linked], config, resolver);
		expect(cache.getKey(plain.path)!.revision.endsWith(':0')).toBe(true);
		expect(cache.getKey(linked.path)!.revision.endsWith(':0')).toBe(false);
		expect(cache.hasLinkResolutionChanged(plain)).toBe(false);
		expect(cache.hasLinkResolutionChanged(linked)).toBe(false);

		// Changing resolvedLinks for a note without links in its CachedMetadata does not mark it stale
		resolvedLinks['notes/plain.md'] = { 'Targets/Other.md': 1 };
		expect(cache.hasLinkResolutionChanged(plain)).toBe(false);

		// Changing resolvedLinks for a note with links marks it stale
		resolvedLinks['notes/linked.md'] = { 'Elsewhere/Roadmap.md': 1 };
		expect(cache.hasLinkResolutionChanged(linked)).toBe(true);
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

	it('rebindDocumentLinks preserves non-link fields and unchanged links by reference when only resolvedLinks changes', () => {
		const file = makeFile('notes/hub.md');
		const metadata = {
			frontmatter: { status: 'active', due: '2026-11-15' },
			links: [
				{ link: 'Stable', original: '[[Stable]]', position: {} },
				{ link: 'Moved', original: '[[Moved]]', position: {} },
				{ link: '#Section', original: '[[#Section]]', position: {} },
			],
			tags: [{ tag: '#work', position: {} }],
		} as unknown as CachedMetadata;
		const resolvedLinks: Record<string, Record<string, number>> = {
			'notes/hub.md': { 'Targets/Stable.md': 1, 'Inbox/Moved.md': 1 },
		};
		let movedDest = 'Inbox/Moved.md';
		const dynamicResolver = vi.fn((raw: string) =>
			raw === 'Moved' ? movedDest : `Targets/${raw}.md`,
		);
		const { cache } = setup([file], new Map([[file.path, metadata]]), resolvedLinks);
		const config = makeConfig({ due: 'date' });

		cache.reconcile([file], config, dynamicResolver);
		const before = cache.get('notes/hub.md')!;
		expect(before.links.map((l) => l.resolvedPath)).toEqual([
			'Targets/Stable.md',
			'Inbox/Moved.md',
			'notes/hub.md',
		]);

		// Target moves without touching hub.md's CachedMetadata or stat
		movedDest = 'Archive/Moved.md';
		resolvedLinks['notes/hub.md'] = { 'Targets/Stable.md': 1, 'Archive/Moved.md': 1 };
		dynamicResolver.mockClear();

		const rec = cache.reconcile([file], config, dynamicResolver);
		expect(rec.stats.update).toBe(1);
		const after = cache.get('notes/hub.md')!;
		expectDeepFrozen(after);

		// Self-subpath link (#Section) never invokes resolveLinkPath
		expect(dynamicResolver).not.toHaveBeenCalledWith('#Section', 'notes/hub.md');
		expect(after.links.map((l) => l.resolvedPath)).toEqual([
			'Targets/Stable.md',
			'Archive/Moved.md',
			'notes/hub.md',
		]);

		// Reference preservation of all non-link subtrees and unchanged NormalizedLink elements
		expect(after.file).toBe(before.file);
		expect(after.properties).toBe(before.properties);
		expect(after.propertyOccurrences).toBe(before.propertyOccurrences);
		expect(after.tags).toBe(before.tags);
		expect(after.links[0]).toBe(before.links[0]);
		expect(after.links[2]).toBe(before.links[2]);
		expect(after.links[1]).not.toBe(before.links[1]);

		const cold = normalizeObsidianMetadata(file, metadata, config, [], dynamicResolver);
		expect(digestNormalizedDocument(after)).toBe(digestNormalizedDocument(cold));
	});

	it('rebindMovedDocument matches cold normalization bit-for-bit, reuses properties, and registers internalFileEpochMs', async () => {
		const ctime = 1_700_000_000_000;
		const mtime = 1_700_086_400_000;
		const file = makeFile('Inbox/draft.md', mtime);
		file.stat = { ctime, mtime, size: 240 };

		const metadata = {
			frontmatter: {
				priority: 'not-a-number',
				due: '2026-11-20',
				aliases: ['Draft Alias'],
			},
			headings: [
				{
					heading: 'Plan',
					level: 2,
					position: {
						start: { line: 4, col: 0, offset: 40 },
						end: { line: 4, col: 10, offset: 50 },
					},
				},
			],
			blocks: {
				b1: {
					id: 'b1',
					position: {
						start: { line: 6, col: 0, offset: 60 },
						end: { line: 6, col: 25, offset: 85 },
					},
				},
			},
			links: [
				{
					link: '#Plan',
					original: '[[#Plan]]',
					position: {
						start: { line: 5, col: 0, offset: 51 },
						end: { line: 5, col: 9, offset: 60 },
					},
				},
				{
					link: './Sibling',
					original: '[[./Sibling]]',
					position: {
						start: { line: 6, col: 0, offset: 60 },
						end: { line: 6, col: 13, offset: 73 },
					},
				},
			],
			tags: [
				{
					tag: '#project',
					position: {
						start: { line: 5, col: 10, offset: 55 },
						end: { line: 5, col: 18, offset: 63 },
					},
				},
			],
		} as unknown as CachedMetadata;

		const caches = new Map<string, CachedMetadata | null>([[file.path, metadata]]);
		const app = createMockApp({ files: [file], fileCache: caches }) as App;
		(
			app.metadataCache as unknown as {
				getFirstLinkpathDest: (raw: string, src: string) => { path: string } | null;
			}
		).getFirstLinkpathDest = (raw, src) => ({
			path: src.startsWith('Archive/')
				? `Archive/${raw.replace('./', '')}.md`
				: `Inbox/${raw.replace('./', '')}.md`,
		});

		const bodyCache = new BodyScanCache(
			app,
			undefined,
			new BodyScanIdbStore('move-rebind-test', null),
			() => mtime + 1000,
		);
		bodyCache.ingestFromText(
			file,
			'\n\n\n\n## Plan\n[[#Plan]] #project\n[owner:: [[Alice]]] - [ ] Ship it ^b1',
			metadata,
		);

		const cache = new NormalizedDocumentCache(app, undefined, bodyCache);
		const config = makeConfig({ priority: 'number', due: 'date' });
		const linkMemo = createMemoizedLinkResolver(app);

		cache.reconcile([file], config, linkMemo.resolveLinkPath);
		const before = cache.get('Inbox/draft.md')!;

		// Move & rename file in-place (exact Obsidian runtime behavior)
		const oldPath = file.path;
		file.path = 'Archive/final.md';
		file.name = 'final.md';
		file.basename = 'final';
		file.parent = { path: 'Archive' } as TFile['parent'];
		caches.delete(oldPath);
		caches.set(file.path, metadata);
		bodyCache.rename(oldPath, file.path);
		cache.rename(oldPath, file.path);
		linkMemo.clear();

		const rec = cache.reconcile([file], config, linkMemo.resolveLinkPath);
		expect(rec.stats.add).toBe(1);
		const moved = cache.get('Archive/final.md')!;
		expectDeepFrozen(moved);

		// Intrinsic structures reused by reference
		expect(moved.properties).toBe(before.properties);
		expect(moved.propertyOccurrences).toBe(before.propertyOccurrences);
		expect(moved.aliases).toBe(before.aliases);
		expect(moved.tags).toBe(before.tags);
		expect(moved.file.created).toBe(before.file.created);

		// WeakMap epoch side-table registered for new NormalizedFileInfo
		expect(getInternalFileEpochMs(moved.file)).toEqual({ ctime, mtime });

		// Matches cold normalizeObsidianMetadata bit-for-bit across all 17 fields + diagnostics
		const cold = normalizeObsidianMetadata(
			file,
			metadata,
			config,
			bodyCache.getInlineProperties(file.path),
			linkMemo.resolveLinkPath,
			bodyCache.getTasks(file.path),
		);
		expect(digestNormalizedDocument(moved)).toBe(digestNormalizedDocument(cold));
		expect(moved.diagnostics).toEqual(cold.diagnostics);

		// Temporal query against file.created / file.modified evaluates accurately on rebound doc
		const queryRes = await runVaultQuery(
			app,
			{ recent: '[file.modified: >= 2023-11-15]' },
			{ timeZone: 'UTC', referenceTimeMs: mtime, cache },
		);
		expect(queryRes['recent']?.map((m) => m.file.path)).toEqual(['Archive/final.md']);
	});

	it('produces identical order-independent link signatures across resolvedLinks key permutations', () => {
		const file = makeFile('notes/perm.md');
		const metadata = {
			frontmatter: {},
			links: [
				{ link: 'A', original: '[[A]]', position: {} },
				{ link: 'B', original: '[[B]]', position: {} },
			],
		} as unknown as CachedMetadata;
		const resolvedLinks: Record<string, Record<string, number>> = {
			'notes/perm.md': { 'Targets/A.md': 1, 'Targets/B.md': 2 },
		};
		const { cache } = setup([file], new Map([[file.path, metadata]]), resolvedLinks);
		const config = makeConfig();

		cache.reconcile([file], config, resolver);
		const rev1 = cache.getKey(file.path)!.revision;

		// Replace record with reversed insertion order and identical entries
		resolvedLinks['notes/perm.md'] = { 'Targets/B.md': 2, 'Targets/A.md': 1 };
		const next = cache.reconcile([file], config, resolver);
		expect(next.stats.hits).toBe(1);
		expect(next.stats.update).toBe(0);
		expect(cache.getKey(file.path)!.revision).toBe(rev1);
	});

	it('time-slices reconcileAsync, clears memo on yield, revalidates mutated files, and retains progress on supersession', async () => {
		const files = Array.from({ length: 6 }, (_, i) => makeFile(`notes/n${i}.md`));
		const caches = new Map<string, CachedMetadata | null>(
			files.map((f, i) => [f.path, { frontmatter: { idx: i } }]),
		);
		const { cache } = setup(files, caches);
		const config = makeConfig();

		let supersedeFlag = false;
		let yieldCalls = 0;
		const firstPass = await cache.reconcileAsync(files, config, resolver, {
			sliceBudgetMs: 0,
			onYield: () => {
				yieldCalls++;
				if (yieldCalls === 2) {
					// Mutate n4 (deleted) and n5 (ignored) mid-flight, then supersede on next slice
					files[4]!.deleted = true;
					caches.set(files[5]!.path, {
						frontmatter: {
							'◊InternalRhizome': {
								[INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY]: 'skip',
							},
						},
					});
					supersedeFlag = true;
				}
			},
			shouldSupersede: () => supersedeFlag,
		});

		expect(firstPass.superseded).toBe(true);
		expect(yieldCalls).toBeGreaterThanOrEqual(2);
		expect(firstPass.stats.add).toBeGreaterThan(0);
		const committedAfterFirst = cache.size;
		expect(committedAfterFirst).toBeGreaterThan(0);

		// Follow-up pass reuses already-committed entries as hits and skips deleted/ignored files
		const secondPass = await cache.reconcileAsync(files, config, resolver, {
			sliceBudgetMs: 0,
		});
		expect(secondPass.superseded).toBe(false);
		expect(secondPass.stats.hits).toBe(committedAfterFirst);
		expect(cache.get('notes/n4.md')).toBeUndefined();
		expect(cache.get('notes/n5.md')).toBeUndefined();
		expect(cache.size).toBe(4);
	});

	it('includes notes renamed or created during a reconcileAsync yield in direct runVaultQuery results', async () => {
		const hitFile = makeFile('inbox/already-warm.md');
		const coldA = makeFile('inbox/cold-a.md');
		const coldB = makeFile('inbox/cold-b.md');
		const liveFiles = [hitFile, coldA, coldB];
		const caches = new Map<string, CachedMetadata | null>([
			[hitFile.path, { tags: [{ tag: '#ship', position: {} as never }] }],
			[coldA.path, { frontmatter: {} }],
			[coldB.path, { frontmatter: {} }],
		]);

		const app = createMockApp({
			files: liveFiles,
			markdownFiles: liveFiles,
			fileCache: caches,
		}) as App;
		const cache = new NormalizedDocumentCache(app);
		const config = makeConfig();

		// Warm hitFile before the cold files are added so hitFile is classified as a hit at pass start
		cache.reconcile([hitFile], config, resolver);
		expect(cache.get('inbox/already-warm.md')).toBeDefined();

		const origReconcileAsync = cache.reconcileAsync.bind(cache);
		let mutatedOnYield = false;
		vi.spyOn(cache, 'reconcileAsync').mockImplementation((files, cfg, resFn, opts) =>
			origReconcileAsync(files, cfg, resFn, {
				...opts,
				sliceBudgetMs: 0,
				onYield: () => {
					opts?.onYield?.();
					if (!mutatedOnYield) {
						mutatedOnYield = true;
						// Rename already-classified hitFile in place AND add a brand-new note mid-yield
						const oldMeta = caches.get(hitFile.path)!;
						caches.delete(hitFile.path);
						hitFile.path = 'archive/renamed-warm.md';
						hitFile.name = 'renamed-warm.md';
						hitFile.basename = 'renamed-warm';
						hitFile.parent = { path: 'archive' } as TFile['parent'];
						caches.set(hitFile.path, oldMeta);

						const addedMidYield = makeFile('archive/new-arrival.md');
						caches.set(addedMidYield.path, {
							tags: [{ tag: '#ship', position: {} as never }],
						});
						liveFiles.push(addedMidYield);
					}
				},
			}),
		);

		const result = await runVaultQuery(
			app,
			{ shipped: '#ship' },
			{ timeZone: 'UTC', referenceTimeMs: 1_700_000_000_000, cache },
		);

		expect(mutatedOnYield).toBe(true);
		expect(cache.get('inbox/already-warm.md')).toBeUndefined();
		expect(result['shipped']?.map((m) => m.file.path).sort()).toEqual([
			'archive/new-arrival.md',
			'archive/renamed-warm.md',
		]);
	});
});
