import { editorInfoField, type App, type TFile as ObsidianTFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import {
	attachBacklinks,
	BacklinkIndex,
	projectBacklinks,
	type BacklinkSnapshot,
} from '../../src/adapters/backlink-index';
import { createRhizomeAnalysisCache } from '../../src/adapters/codemirror/rhizome-analysis-cache';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import {
	hasInternalRhizomeFlag,
	initEngineConfig,
	INTERNAL_RHIZOME_CODES,
} from '../../src/core/search';
import type { LoggerPort } from '../../src/ports/logger-port';
import { createMockApp, TFile } from '../support/mock-obsidian-app';

type MockTFile = ObsidianTFile & { deleted?: boolean };

function makeFile(path: string): MockTFile {
	const slashIdx = path.lastIndexOf('/');
	const name = slashIdx === -1 ? path : path.slice(slashIdx + 1);
	const dotIdx = name.lastIndexOf('.');
	const file = new TFile() as unknown as MockTFile;
	file.path = path;
	file.name = name;
	file.basename = dotIdx === -1 ? name : name.slice(0, dotIdx);
	file.extension = dotIdx === -1 ? '' : name.slice(dotIdx + 1);
	file.parent = {
		path: slashIdx === -1 ? '' : path.slice(0, slashIdx),
	} as ObsidianTFile['parent'];
	file.stat = { ctime: 1700000000000, mtime: 1700000000000, size: 100 };
	return file;
}

function internalCache(): { frontmatter: Record<string, unknown> } {
	return {
		frontmatter: {
			'◊InternalRhizome': { [INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY]: 'Do not index.' },
		},
	};
}

function ignoredBy(cacheByPath: Map<string, unknown>): (file: ObsidianTFile) => boolean {
	return (file) =>
		hasInternalRhizomeFlag(
			(cacheByPath.get(file.path) as { frontmatter?: Record<string, unknown> } | undefined)
				?.frontmatter,
			INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
		);
}

const noIgnore = (): boolean => false;

function snapshotOf(
	entries: Array<[ObsidianTFile, Array<[ObsidianTFile, number]>]>,
): BacklinkSnapshot {
	const map = new Map<ObsidianTFile, Map<ObsidianTFile, number>>();
	for (const [target, sources] of entries) {
		map.set(target, new Map(sources));
	}
	return map;
}

describe('BacklinkIndex', () => {
	it('inverts resolvedLinks for Markdown targets only and retains non-Markdown sources', () => {
		const target = makeFile('notes/target.md');
		const other = makeFile('notes/other.md');
		const mdSource = makeFile('notes/source.md');
		const canvasSource = makeFile('boards/source.canvas');
		const app = createMockApp({
			files: [target, other, mdSource, canvasSource],
			resolvedLinks: {
				'notes/source.md': { 'notes/target.md': 2 },
				'boards/source.canvas': { 'notes/target.md': 1 },
				'notes/other.md': { 'notes/target.canvas': 1, 'missing.md': 4 },
			},
		});

		const index = new BacklinkIndex(app as App, noIgnore);
		const snapshot = index.snapshot();

		expect([...snapshot.keys()]).toEqual([target]);
		expect([...snapshot.get(target)!]).toEqual([
			[mdSource, 2],
			[canvasSource, 1],
		]);
		expect(snapshot.has(other)).toBe(false);
	});

	it('excludes ignored Markdown sources and targets', () => {
		const target = makeFile('notes/target.md');
		const ignoredSource = makeFile('logs/log.md');
		const ignoredTarget = makeFile('logs/private.md');
		const normalSource = makeFile('notes/source.md');
		const cacheByPath = new Map<string, unknown>([
			[ignoredSource.path, internalCache()],
			[ignoredTarget.path, internalCache()],
		]);
		const app = createMockApp({
			files: [target, ignoredSource, ignoredTarget, normalSource],
			fileCache: cacheByPath,
			resolvedLinks: {
				'logs/log.md': { 'notes/target.md': 1 },
				'notes/source.md': { 'notes/target.md': 1, 'logs/private.md': 1 },
			},
		});

		const index = new BacklinkIndex(app as App, ignoredBy(cacheByPath));
		const snapshot = index.snapshot();

		expect([...snapshot.keys()]).toEqual([target]);
		expect([...snapshot.get(target)!]).toEqual([[normalSource, 1]]);
	});

	it('filters deleted and newly ignored sources at projection time', () => {
		const target = makeFile('notes/target.md');
		const deleted = makeFile('notes/deleted.md');
		const ignored = makeFile('notes/ignored.md');
		const app = createMockApp({
			files: [target, deleted, ignored],
			resolvedLinks: {
				'notes/deleted.md': { 'notes/target.md': 1 },
				'notes/ignored.md': { 'notes/target.md': 2 },
			},
		});
		const ignoredPaths = new Set<string>();
		const index = new BacklinkIndex(app as App, (file) => ignoredPaths.has(file.path));
		const snapshot = index.snapshot();

		expect(projectBacklinks(snapshot, target, () => false)).toHaveLength(2);

		deleted.deleted = true;
		ignoredPaths.add(ignored.path);

		expect(projectBacklinks(snapshot, target, (file) => ignoredPaths.has(file.path))).toEqual(
			[],
		);
	});

	it('sorts count descending then path ascending by UTF-16 code units', () => {
		const target = makeFile('notes/target.md');
		const a = makeFile('notes/a.md');
		const b = makeFile('notes/b.md');
		const c = makeFile('notes/c.md');
		const z = makeFile('notes/Z.md');
		const app = createMockApp({
			files: [target, a, b, c, z],
			resolvedLinks: {
				'notes/a.md': { 'notes/target.md': 1 },
				'notes/b.md': { 'notes/target.md': 1 },
				'notes/c.md': { 'notes/target.md': 3 },
				'notes/Z.md': { 'notes/target.md': 1 },
			},
		});
		const index = new BacklinkIndex(app as App, noIgnore);
		const refs = projectBacklinks(index.snapshot(), target, noIgnore);

		expect(refs.map((r) => r.path)).toEqual([
			'notes/c.md',
			'notes/Z.md',
			'notes/a.md',
			'notes/b.md',
		]);
	});

	it('rebuild() reports structural changes and preserves old snapshots', () => {
		const target = makeFile('notes/target.md');
		const source = makeFile('notes/source.md');
		const resolvedLinks: Record<string, Record<string, number>> = {
			'notes/source.md': { 'notes/target.md': 1 },
		};
		const app = createMockApp({
			files: [target, source],
			resolvedLinks,
		});
		const index = new BacklinkIndex(app as App, noIgnore);
		const first = index.snapshot();

		expect(index.rebuild()).toBe(false);

		resolvedLinks['notes/source.md'] = { 'notes/target.md': 5 };
		expect(index.rebuild()).toBe(true);
		expect([...first.get(target)!]).toEqual([[source, 1]]);
		expect([...index.snapshot().get(target)!]).toEqual([[source, 5]]);
		expect(index.revision).toBe(2);

		resolvedLinks['notes/source.md'] = {};
		expect(index.rebuild()).toBe(true);
		expect(index.snapshot().size).toBe(0);
	});

	it('reflects renames through projection without rebuilding', () => {
		const target = makeFile('notes/target.md');
		const source = makeFile('notes/old-name.md');
		const resolvedLinks: Record<string, Record<string, number>> = {
			'notes/old-name.md': { 'notes/target.md': 2 },
		};
		const app = createMockApp({ files: [target, source], resolvedLinks });
		const index = new BacklinkIndex(app as App, noIgnore);
		const snapshot = index.snapshot();

		expect(projectBacklinks(snapshot, target, noIgnore)).toEqual([
			{ path: 'notes/old-name.md', count: 2 },
		]);

		source.path = 'notes/new-name.md';
		resolvedLinks['notes/new-name.md'] = resolvedLinks['notes/old-name.md']!;
		delete resolvedLinks['notes/old-name.md'];

		expect(projectBacklinks(snapshot, target, noIgnore)).toEqual([
			{ path: 'notes/new-name.md', count: 2 },
		]);
		expect(index.rebuild()).toBe(false);
	});

	it('builds lazily, rebuilds after dispose, and returns a fresh 13th field via attachBacklinks', () => {
		const target = makeFile('notes/target.md');
		const source = makeFile('notes/source.md');
		const app = createMockApp({
			files: [target, source],
			resolvedLinks: { 'notes/source.md': { 'notes/target.md': 1 } },
		});
		const index = new BacklinkIndex(app as App, noIgnore);
		const getFiles = vi.spyOn((app as App).vault, 'getFiles');

		expect(index.isBuilt).toBe(false);
		expect(getFiles).not.toHaveBeenCalled();

		index.snapshot();
		expect(index.isBuilt).toBe(true);
		expect(getFiles).toHaveBeenCalledTimes(1);

		index.snapshot();
		expect(getFiles).toHaveBeenCalledTimes(1);

		index.dispose();
		expect(index.isBuilt).toBe(false);
		index.snapshot();
		expect(getFiles).toHaveBeenCalledTimes(2);

		const doc = { file: { path: target.path }, backlinks: undefined } as never;
		expect(attachBacklinks(doc, index.snapshot(), target, noIgnore).backlinks).toEqual([
			{ path: 'notes/source.md', count: 1 },
		]);
	});

	it('treats a missing resolvedLinks map as an empty snapshot', () => {
		const target = makeFile('notes/target.md');
		const app = createMockApp({ files: [target] }) as App;
		(app.metadataCache as { resolvedLinks?: unknown }).resolvedLinks = undefined;
		const index = new BacklinkIndex(app, noIgnore);

		expect(index.snapshot()).toEqual(snapshotOf([]));
	});

	describe('reconcile & hasSourceChanged', () => {
		it('returns false on no-op reconcile without bumping revision', () => {
			const target = makeFile('notes/target.md');
			const app = createMockApp({ files: [target] });
			const index = new BacklinkIndex(app as App, noIgnore);
			index.snapshot();

			expect(index.reconcile()).toBe(false);
			expect(index.revision).toBe(1);
		});

		it('detects whether a source’s resolvedLinks entry changed via hasSourceChanged', () => {
			const target = makeFile('notes/target.md');
			const source = makeFile('notes/source.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/target.md': 1 },
			};
			const app = createMockApp({ files: [target, source], resolvedLinks });
			const index = new BacklinkIndex(app as App, noIgnore);
			expect(index.hasSourceChanged('notes/source.md')).toBe(true);

			index.snapshot();
			expect(index.hasSourceChanged('notes/source.md')).toBe(false);
			expect(index.hasSourceChanged('notes/target.md')).toBe(false);

			resolvedLinks['notes/target.md'] = {};
			expect(index.hasSourceChanged('notes/target.md')).toBe(false);

			resolvedLinks['notes/source.md'] = { 'notes/target.md': 2 };
			expect(index.hasSourceChanged('notes/source.md')).toBe(true);
		});

		it('logs affected targets and changes on reconcile', () => {
			const a = makeFile('notes/a.md');
			const b = makeFile('notes/b.md');
			const source = makeFile('notes/source.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/a.md': 1 },
			};
			const app = createMockApp({ files: [a, b, source], resolvedLinks });
			const log = vi.fn();
			const logger: LoggerPort = { log };
			const index = new BacklinkIndex(app as App, noIgnore, logger);
			index.snapshot();
			log.mockClear();

			resolvedLinks['notes/source.md'] = { 'notes/b.md': 2 };
			expect(index.reconcile()).toBe(true);
			expect(log).toHaveBeenCalledWith(
				'debug',
				'Reconciled backlink index',
				expect.objectContaining({
					source: 'query.backlinks',
					sourceCount: 1,
					count: 2,
					changed: true,
				}),
			);
			const meta = log.mock.calls[0]?.[2] as { durationMs?: unknown };
			expect(typeof meta.durationMs).toBe('number');
		});

		it('moves a link between targets and matches a full rebuild', () => {
			const a = makeFile('notes/a.md');
			const b = makeFile('notes/b.md');
			const source = makeFile('notes/source.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/a.md': 1 },
			};
			const app = createMockApp({ files: [a, b, source], resolvedLinks });
			const index = new BacklinkIndex(app as App, noIgnore);
			expect([...index.snapshot().keys()]).toEqual([a]);

			resolvedLinks['notes/source.md'] = { 'notes/b.md': 2 };
			expect(index.reconcile()).toBe(true);
			expect([...index.snapshot().keys()]).toEqual([b]);
			expect([...index.snapshot().get(b)!]).toEqual([[source, 2]]);
			expect(index.rebuild()).toBe(false);
		});

		it('detects a target move when both targets have the same source mix', () => {
			const a = makeFile('notes/a.md');
			const b = makeFile('notes/b.md');
			const source = makeFile('notes/source.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/a.md': 1 },
			};
			const app = createMockApp({ files: [a, b, source], resolvedLinks });
			const index = new BacklinkIndex(app as App, noIgnore);
			index.snapshot();

			resolvedLinks['notes/source.md'] = { 'notes/b.md': 1 };
			expect(index.reconcile()).toBe(true);
			expect(index.snapshot()).toEqual(new BacklinkIndex(app as App, noIgnore).snapshot());
			expect([...index.snapshot().keys()]).toEqual([b]);
		});

		it('reports no change when sources and targets are untouched, even with ignored log files present', () => {
			const target = makeFile('notes/target.md');
			const source = makeFile('notes/source.md');
			const logFile = makeFile('◊Rhizome/logs/1700000000000.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/target.md': 1 },
			};
			const app = createMockApp({ files: [target, source, logFile], resolvedLinks });
			const index = new BacklinkIndex(
				app as App,
				(file) => file.path === '◊Rhizome/logs/1700000000000.md',
			);
			index.snapshot();

			expect(index.reconcile()).toBe(false);
			expect(index.revision).toBe(1);
		});

		it('drops a deleted source and restores it when it comes back', () => {
			const target = makeFile('notes/target.md');
			const source = makeFile('notes/source.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/target.md': 1 },
			};
			const app = createMockApp({ files: [target, source], resolvedLinks });
			const index = new BacklinkIndex(app as App, noIgnore);
			index.snapshot();

			source.deleted = true;
			expect(index.reconcile()).toBe(true);
			expect(index.snapshot().size).toBe(0);

			source.deleted = false;
			expect(index.reconcile()).toBe(true);
			expect([...index.snapshot().get(target)!.keys()]).toEqual([source]);
		});

		it('removes and restores ignored sources and targets', () => {
			const target = makeFile('notes/target.md');
			const source = makeFile('notes/source.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/target.md': 1 },
			};
			const ignoredPaths = new Set<string>();
			const app = createMockApp({ files: [target, source], resolvedLinks });
			const index = new BacklinkIndex(app as App, (file) => ignoredPaths.has(file.path));
			index.snapshot();

			ignoredPaths.add('notes/target.md');
			expect(index.reconcile()).toBe(true);
			expect(index.snapshot().size).toBe(0);

			ignoredPaths.delete('notes/target.md');
			expect(index.reconcile()).toBe(true);
			expect([...index.snapshot().get(target)!.keys()]).toEqual([source]);

			ignoredPaths.add('notes/source.md');
			expect(index.reconcile()).toBe(true);
			expect(index.snapshot().size).toBe(0);
		});

		it('removes a deleted target even when its own link record did not change', () => {
			const target = makeFile('notes/target.md');
			const source = makeFile('notes/source.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/target.md': 1 },
			};
			const app = createMockApp({ files: [target, source], resolvedLinks });
			const index = new BacklinkIndex(app as App, noIgnore);
			expect(index.snapshot().size).toBe(1);

			target.deleted = true;
			expect(index.reconcile()).toBe(true);
			expect(index.snapshot().size).toBe(0);
			expect(index.rebuild()).toBe(false);
		});

		it('reflects source and target renames through projection', () => {
			const target = makeFile('notes/target.md');
			const source = makeFile('notes/source.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/source.md': { 'notes/target.md': 1 },
			};
			const app = createMockApp({ files: [target, source], resolvedLinks });
			const index = new BacklinkIndex(app as App, noIgnore);
			index.snapshot();

			source.path = 'notes/source-renamed.md';
			resolvedLinks['notes/source-renamed.md'] = resolvedLinks['notes/source.md']!;
			delete resolvedLinks['notes/source.md'];
			index.reconcile();
			expect(projectBacklinks(index.snapshot(), target, noIgnore)).toEqual([
				{ path: 'notes/source-renamed.md', count: 1 },
			]);

			target.path = 'notes/target-renamed.md';
			resolvedLinks['notes/source-renamed.md'] = { 'notes/target-renamed.md': 1 };
			index.reconcile();
			expect(projectBacklinks(index.snapshot(), target, noIgnore)).toEqual([
				{ path: 'notes/source-renamed.md', count: 1 },
			]);
			expect(index.rebuild()).toBe(false);
		});

		it('handles a 5,000-note bulk rename in a 20,000-note vault without rebuilding snapshot while advancing projectionRevision', () => {
			const total = 20_000;
			const moved = 5_000;
			const files: MockTFile[] = [];
			const resolvedLinks: Record<string, Record<string, number>> = {};

			for (let i = 0; i < total; i++) {
				files.push(makeFile(`inbox/n${i}.md`));
			}
			for (let i = 0; i < total; i++) {
				const targetIdx = (i + 1) % total;
				resolvedLinks[`inbox/n${i}.md`] = { [`inbox/n${targetIdx}.md`]: 1 };
			}

			const app = createMockApp({ files, resolvedLinks }) as App;
			const index = new BacklinkIndex(app, noIgnore);
			const initialSnapshot = index.snapshot();
			expect(index.revision).toBe(1);
			expect(index.projectionRevision).toBe(1);

			// Move first 5,000 notes in-place and update resolvedLinks keys/targets
			for (let i = 0; i < moved; i++) {
				files[i]!.path = `archive/n${i}.md`;
			}
			const updatedLinks: Record<string, Record<string, number>> = {};
			for (let i = 0; i < total; i++) {
				const srcPath = files[i]!.path;
				const dstPath = files[(i + 1) % total]!.path;
				updatedLinks[srcPath] = { [dstPath]: 1 };
			}
			(
				app.metadataCache as { resolvedLinks: Record<string, Record<string, number>> }
			).resolvedLinks = updatedLinks;

			const t0 = performance.now();
			const structuralChanged = index.reconcile();
			const elapsedMs = performance.now() - t0;

			expect(structuralChanged).toBe(false);
			expect(index.snapshot()).toBe(initialSnapshot);
			expect(index.revision).toBe(1);
			expect(index.projectionRevision).toBe(2);
			expect(elapsedMs).toBeLessThan(250);

			expect(projectBacklinks(index.snapshot(), files[1]!, noIgnore)).toEqual([
				{ path: 'archive/n0.md', count: 1 },
			]);

			// Subsequent no-op reconcile keeps both revision and projectionRevision stable
			expect(index.reconcile()).toBe(false);
			expect(index.projectionRevision).toBe(2);
		});

		it('invalidates createRhizomeAnalysisCache host resolution when projectionRevision advances on source rename', () => {
			const host = makeFile('notes/host.md');
			const linker = makeFile('notes/alpha-linker.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/alpha-linker.md': { 'notes/host.md': 1 },
			};
			const fileCaches = new Map<string, unknown>([
				[host.path, { frontmatter: {} }],
				[linker.path, { frontmatter: {} }],
			]);
			const app = createMockApp({
				files: [host, linker],
				fileCache: fileCaches,
				resolvedLinks,
			}) as App;
			const index = new BacklinkIndex(app, noIgnore);
			const docCache = new NormalizedDocumentCache(app);
			const cfgRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
			if (!cfgRes.ok) throw new Error('Expected valid config');

			const analysisCache = createRhizomeAnalysisCache(app, index, docCache, cfgRes.config);
			const mockView = {
				state: {
					field: (f: unknown) => (f === editorInfoField ? { file: host } : undefined),
				},
			} as never;
			const codeBlock = '{% query q %}backlinks:@this.backlinks.path{% endquery %}';

			// Initial analysis primes hostResolutionCache at revision=1, projectionRevision=1
			const ensureFreshSpy = vi.spyOn(docCache, 'ensureFresh');
			const first = analysisCache.getCachedAnalysis(codeBlock, mockView);
			expect(first.diagnostics).toEqual([]);
			expect(index.revision).toBe(1);
			expect(index.projectionRevision).toBe(1);
			expect(ensureFreshSpy).toHaveBeenCalledTimes(1);

			// Calling again with a distinct codeblock while backlink projectionRevision is unchanged hits hostResolutionCache
			analysisCache.getCachedAnalysis(
				'{% query q2 %}backlinks:@this.backlinks.path{% endquery %}',
				mockView,
			);
			expect(ensureFreshSpy).toHaveBeenCalledTimes(1);

			// Rename linking source in-place and reconcile: structural revision stays 1, projectionRevision becomes 2
			linker.path = 'notes/zeta-linker.md';
			resolvedLinks['notes/zeta-linker.md'] = { 'notes/host.md': 1 };
			delete resolvedLinks['notes/alpha-linker.md'];
			expect(index.reconcile()).toBe(false);
			expect(index.revision).toBe(1);
			expect(index.projectionRevision).toBe(2);

			const second = analysisCache.getCachedAnalysis(codeBlock, mockView);
			expect(second.diagnostics).toEqual([]);
			expect(ensureFreshSpy).toHaveBeenCalledTimes(2);
		});

		it('handles empty/NaN resolvedLinks records, key-order permutations, and count/target deltas in reconcile and hasSourceChanged', () => {
			const a = makeFile('notes/a.md');
			const b = makeFile('notes/b.md');
			const t = makeFile('notes/t.md');
			const u = makeFile('notes/u.md');
			const resolvedLinks: Record<string, Record<string, number>> = {
				'notes/a.md': { 'notes/t.md': 1, 'notes/u.md': 2 },
				'notes/b.md': { 'notes/t.md': Number.NaN },
			};
			const app = createMockApp({ files: [a, b, t, u], resolvedLinks }) as App;
			const index = new BacklinkIndex(app, noIgnore);
			index.snapshot();

			expect(index.hasSource('notes/a.md')).toBe(true);
			expect(index.hasSource('notes/b.md')).toBe(false);

			// Reversed key order + empty/NaN record is treated as unchanged
			resolvedLinks['notes/a.md'] = {
				'notes/u.md': 2,
				'notes/a-missing.md': Number.NaN,
				'notes/t.md': 1,
			};
			resolvedLinks['notes/b.md'] = {};
			expect(index.hasSourceChanged('notes/a.md')).toBe(false);
			expect(index.hasSourceChanged('notes/b.md')).toBe(false);
			expect(index.reconcile()).toBe(false);

			// Changing count or moving target updates only affected targets
			resolvedLinks['notes/a.md'] = { 'notes/u.md': 3 };
			expect(index.hasSourceChanged('notes/a.md')).toBe(true);
			expect(index.reconcile()).toBe(true);
			expect(projectBacklinks(index.snapshot(), t, noIgnore)).toEqual([]);
			expect(projectBacklinks(index.snapshot(), u, noIgnore)).toEqual([
				{ path: 'notes/a.md', count: 3 },
			]);
		});
	});
});
