import { type App, type CachedMetadata, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { BodyScanCache } from '../../src/adapters/body-scan-cache';
import {
	BODY_SCAN_STORE_NAME,
	BodyScanIdbStore,
	type PersistedBodyScanRecord,
} from '../../src/adapters/body-scan-idb';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import { initEngineConfig } from '../../src/core/search';

/**
 * In-memory fake `IDBFactory` that simulates native IndexedDB versioning,
 * `onupgradeneeded`, `VersionError` on downgrade, and `getAll` / `put` / `delete` / `clear`.
 */
function createFakeIdbFactory() {
	const databases = new Map<
		string,
		{
			version: number;
			stores: Map<string, Map<string, PersistedBodyScanRecord>>;
		}
	>();
	let upgradeCount = 0;
	let deleteDatabaseCount = 0;

	const factory = {
		get upgradeCount() {
			return upgradeCount;
		},
		get deleteDatabaseCount() {
			return deleteDatabaseCount;
		},
		open(name: string, version = 1): IDBOpenDBRequest {
			const req: Record<string, unknown> = {
				result: null,
				error: null,
				onupgradeneeded: null,
				onsuccess: null,
				onerror: null,
				onblocked: null,
			};

			queueMicrotask(() => {
				const existing = databases.get(name);
				if (existing && version < existing.version) {
					req.error = { name: 'VersionError' };
					if (typeof req.onerror === 'function') {
						(req.onerror as () => void)();
					}
					return;
				}

				const needsUpgrade = !existing || version > existing.version;
				const state = existing ?? {
					version,
					stores: new Map<string, Map<string, PersistedBodyScanRecord>>(),
				};
				state.version = version;
				databases.set(name, state);

				const db = {
					objectStoreNames: {
						contains: (storeName: string) => state.stores.has(storeName),
					},
					deleteObjectStore: (storeName: string) => {
						state.stores.delete(storeName);
					},
					createObjectStore: (storeName: string) => {
						const map = new Map<string, PersistedBodyScanRecord>();
						state.stores.set(storeName, map);
						return {};
					},
					transaction: (storeName: string, _mode: string) => {
						const storeMap =
							state.stores.get(storeName) ??
							new Map<string, PersistedBodyScanRecord>();
						const tx: Record<string, unknown> = {
							oncomplete: null,
							onerror: null,
							onabort: null,
							objectStore: () => ({
								getAll: () => {
									const getReq: Record<string, unknown> = {
										result: [...storeMap.values()],
										onsuccess: null,
										onerror: null,
									};
									queueMicrotask(() => {
										if (typeof getReq.onsuccess === 'function') {
											(getReq.onsuccess as () => void)();
										}
									});
									return getReq;
								},
								put: (rec: PersistedBodyScanRecord) => {
									// Simulate IndexedDB structured clone stripping null prototype
									storeMap.set(
										rec.path,
										JSON.parse(JSON.stringify(rec)) as PersistedBodyScanRecord,
									);
								},
								delete: (key: string) => {
									storeMap.delete(key);
								},
								clear: () => {
									storeMap.clear();
								},
							}),
						};
						queueMicrotask(() => {
							if (typeof tx.oncomplete === 'function') {
								(tx.oncomplete as () => void)();
							}
						});
						return tx;
					},
					close: () => {},
					onversionchange: null,
				};

				req.result = db;
				if (needsUpgrade && typeof req.onupgradeneeded === 'function') {
					upgradeCount++;
					(req.onupgradeneeded as () => void)();
				}
				if (typeof req.onsuccess === 'function') {
					(req.onsuccess as () => void)();
				}
			});

			return req as unknown as IDBOpenDBRequest;
		},
		deleteDatabase(name: string): IDBOpenDBRequest {
			deleteDatabaseCount++;
			databases.delete(name);
			const req: Record<string, unknown> = {
				onsuccess: null,
				onerror: null,
				onblocked: null,
			};
			queueMicrotask(() => {
				if (typeof req.onsuccess === 'function') {
					(req.onsuccess as () => void)();
				}
			});
			return req as unknown as IDBOpenDBRequest;
		},
		getRawStore(dbName: string): Map<string, PersistedBodyScanRecord> | undefined {
			return databases.get(dbName)?.stores.get(BODY_SCAN_STORE_NAME);
		},
	};

	return factory;
}

interface MockVaultNote {
	path: string;
	mtime: number;
	size: number;
	content: string;
	cache?: CachedMetadata | null;
}

function makeTFile(n: MockVaultNote): TFile {
	const slashIdx = n.path.lastIndexOf('/');
	const name = slashIdx === -1 ? n.path : n.path.slice(slashIdx + 1);
	const dotIdx = name.lastIndexOf('.');
	const basename = dotIdx === -1 ? name : name.slice(0, dotIdx);
	const extension = dotIdx === -1 ? '' : name.slice(dotIdx + 1);
	return Object.assign(new TFile(), {
		path: n.path,
		name,
		basename,
		extension,
		parent: { path: slashIdx === -1 ? '/' : n.path.slice(0, slashIdx) },
		stat: { ctime: 1700000000000, mtime: n.mtime, size: n.size },
	});
}

describe('BodyScanCache & BodyScanIdbStore', () => {
	it('clamps future mtime via Math.min(mtime, now) and re-scans future-dated notes until wall-clock now catches up', async () => {
		let now = 1_700_000_000_000;
		const futureMtime = now + 60_000;
		const notes: MockVaultNote[] = [
			{
				path: 'notes/future.md',
				mtime: futureMtime,
				size: 40,
				content: '- [ ] Future task 📅 2026-09-01',
				cache: {},
			},
		];

		let cachedReadCalls = 0;
		const app = {
			vault: {
				getMarkdownFiles: () => notes.map(makeTFile),
				cachedRead: async (file: { path: string }) => {
					cachedReadCalls++;
					return notes.find((n) => n.path === file.path)?.content ?? '';
				},
			},
			metadataCache: {
				getFileCache: (file: { path: string }) =>
					notes.find((n) => n.path === file.path)?.cache ?? null,
			},
		} as unknown as App;

		const idb = new BodyScanIdbStore('test-future', null);
		const bodyCache = new BodyScanCache(app, undefined, idb, () => now);

		// Pass 1: now < futureMtime -> scanned, stored mtime clamped to `now`
		const pass1 = await bodyCache.reconcileVaultBodies();
		expect(pass1).toMatchObject({ scanned: 1, hits: 0, changed: 1 });
		expect(bodyCache.getEntry('notes/future.md')?.mtime).toBe(now);
		expect(cachedReadCalls).toBe(1);

		// Pass 2: still before futureMtime, and content edited without mtime advancing -> re-scanned because stored.mtime < futureMtime!
		now += 10_000;
		notes[0]!.content = '- [x] Future task 📅 2026-09-01';
		const pass2 = await bodyCache.reconcileVaultBodies();
		expect(pass2).toMatchObject({ scanned: 1, hits: 0, changed: 1 });
		expect(bodyCache.getTasks('notes/future.md')[0]?.completed).toBe(true);
		expect(bodyCache.getEntry('notes/future.md')?.mtime).toBe(now);
		expect(cachedReadCalls).toBe(2);

		// Pass 3: wall-clock now reaches futureMtime -> scanned once to lock in clampedMtime === futureMtime
		now = futureMtime + 1_000;
		const pass3 = await bodyCache.reconcileVaultBodies();
		expect(pass3).toMatchObject({ scanned: 1, hits: 0, changed: 0 });
		expect(bodyCache.getEntry('notes/future.md')?.mtime).toBe(futureMtime);
		expect(cachedReadCalls).toBe(3);

		// Pass 4: subsequent pass is now a clean cache hit (zero cachedRead calls!)
		const pass4 = await bodyCache.reconcileVaultBodies();
		expect(pass4).toMatchObject({ scanned: 0, hits: 1, changed: 0 });
		expect(cachedReadCalls).toBe(3);
	});

	it('gates bodyRev on bodyDigest so prose-only edits do not bump bodyRev, while task/property edits do', () => {
		const now = 1_700_000_000_000;
		const app = {
			vault: { getMarkdownFiles: () => [], cachedRead: async () => '' },
			metadataCache: { getFileCache: () => ({}) },
		} as unknown as App;

		const bodyCache = new BodyScanCache(
			app,
			undefined,
			new BodyScanIdbStore('test-gate', null),
			() => now,
		);

		const file1 = {
			path: 'notes/prose.md',
			stat: { ctime: now, mtime: now - 2000, size: 50 },
		};
		const changed1 = bodyCache.ingestFromText(
			file1,
			'Opening paragraph.\n[status:: draft]\n- [ ] Write tests',
		);
		expect(changed1).toBe(true);
		const rev1 = bodyCache.getBodyRevision('notes/prose.md');
		expect(rev1).toBeGreaterThan(0);

		// Edit trailing prose without altering [status:: draft] or the task line
		const file2 = {
			path: 'notes/prose.md',
			stat: { ctime: now, mtime: now - 1000, size: 80 },
		};
		const changed2 = bodyCache.ingestFromText(
			file2,
			'Opening paragraph.\n[status:: draft]\n- [ ] Write tests\nAdded more prose at the bottom.',
		);
		expect(changed2).toBe(false);
		expect(bodyCache.getBodyRevision('notes/prose.md')).toBe(rev1);
		expect(bodyCache.getEntry('notes/prose.md')?.mtime).toBe(now - 1000);
		expect(bodyCache.getEntry('notes/prose.md')?.size).toBe(80);

		// Now check off the task -> bodyDigest changes and bodyRev increments!
		const file3 = {
			path: 'notes/prose.md',
			stat: { ctime: now, mtime: now, size: 80 },
		};
		const changed3 = bodyCache.ingestFromText(
			file3,
			'Opening paragraph.\n[status:: draft]\n- [x] Write tests\nAdded more prose at the bottom.',
		);
		expect(changed3).toBe(true);
		expect(bodyCache.getBodyRevision('notes/prose.md')).toBeGreaterThan(rev1);
	});

	it('preserves newer live events during IndexedDB hydration and async cachedRead', async () => {
		const fakeIdb = createFakeIdbFactory();
		const dbName = 'rhizome-race';
		const now = 1_700_000_000_000;

		// Seed IndexedDB with an older record (mtime = now - 5000)
		const seedStore = new BodyScanIdbStore(dbName, fakeIdb as unknown as IDBFactory, 1);
		await seedStore.flushBatch(
			[
				{
					path: 'notes/live.md',
					mtime: now - 5000,
					size: 20,
					bodyDigest: 'old-digest',
					inlineProperties: [{ key: 'stage', value: 'old', source: 'dataview', line: 1 }],
					tasks: [],
				},
			],
			[],
		);

		let resolveSlowRead = (_text: string): void => {};
		const fileObj = makeTFile({
			path: 'notes/live.md',
			mtime: now - 2000,
			size: 30,
			content: '[stage:: stale-read]',
		});

		const app = {
			vault: {
				getMarkdownFiles: () => [fileObj],
				cachedRead: () =>
					new Promise<string>((resolve) => {
						resolveSlowRead = resolve;
					}),
			},
			metadataCache: {
				getFileCache: () => ({}),
			},
		} as unknown as App;

		const liveStore = new BodyScanIdbStore(dbName, fakeIdb as unknown as IDBFactory, 1);
		const bodyCache = new BodyScanCache(app, undefined, liveStore, () => now);

		// 1. Live metadataCache.on('changed') arrives BEFORE hydrateFromIndexedDB completes
		bodyCache.ingestFromText(
			{ path: 'notes/live.md', stat: { ctime: now, mtime: now - 1000, size: 25 } },
			'[stage:: fresh-live]',
		);
		expect(bodyCache.getInlineProperties('notes/live.md')[0]?.value).toBe('fresh-live');

		// 2. Hydrating from IndexedDB must NOT overwrite the newer live entry
		const hydratedCount = await bodyCache.hydrateFromIndexedDB();
		expect(hydratedCount).toBe(0);
		expect(bodyCache.getInlineProperties('notes/live.md')[0]?.value).toBe('fresh-live');

		// 3. Start reconcileVaultBodies for a miss, then inject a live event while cachedRead is in flight
		(fileObj as { stat: { mtime: number; size: number } }).stat = {
			mtime: now - 500,
			size: 30,
		};
		const reconcilePromise = bodyCache.reconcileVaultBodies();

		// While cachedRead is pending, a newer live event arrives
		bodyCache.ingestFromText(
			{ path: 'notes/live.md', stat: { ctime: now, mtime: now, size: 35 } },
			'[stage:: newest-live]',
		);
		resolveSlowRead('[stage:: stale-read]');
		await reconcilePromise;

		// Stale cachedRead must not overwrite the newer live event!
		expect(bodyCache.getInlineProperties('notes/live.md')[0]?.value).toBe('newest-live');
	});

	it('resets the object store on SCANNER_SCHEMA_VERSION upgrade and recovers from VersionError downgrade', async () => {
		const fakeIdb = createFakeIdbFactory();
		const dbName = 'rhizome-versioning';

		// Open at version 1 and write a record
		const v1 = new BodyScanIdbStore(dbName, fakeIdb as unknown as IDBFactory, 1);
		await v1.flushBatch(
			[
				{
					path: 'notes/a.md',
					mtime: 1000,
					size: 10,
					bodyDigest: 'd1',
					inlineProperties: [],
					tasks: [],
				},
			],
			[],
		);
		expect(await v1.getAll()).toHaveLength(1);
		v1.close();

		// Upgrade to version 2 -> onupgradeneeded drops and recreates the store (0 records)
		const v2 = new BodyScanIdbStore(dbName, fakeIdb as unknown as IDBFactory, 2);
		expect(await v2.getAll()).toHaveLength(0);
		await v2.flushBatch(
			[
				{
					path: 'notes/b.md',
					mtime: 2000,
					size: 20,
					bodyDigest: 'd2',
					inlineProperties: [],
					tasks: [],
				},
			],
			[],
		);
		expect(await v2.getAll()).toHaveLength(1);
		v2.close();

		// Downgrade back to version 1 -> catches VersionError, deletes DB, and reopens cleanly
		const v1Downgraded = new BodyScanIdbStore(dbName, fakeIdb as unknown as IDBFactory, 1);
		expect(await v1Downgraded.getAll()).toHaveLength(0);
		expect(fakeIdb.deleteDatabaseCount).toBe(1);
		v1Downgraded.close();
	});

	it('evicts DO_NOT_INDEX_OR_QUERY notes and propagates bodyRev into NormalizedDocumentCache', async () => {
		const fakeIdb = createFakeIdbFactory();
		const dbName = 'rhizome-evict';
		const now = 1_700_000_000_000;

		const notes: MockVaultNote[] = [
			{
				path: 'notes/work.md',
				mtime: now,
				size: 45,
				content: '[team:: platform]\n- [ ] Deploy service 📅 2026-10-01',
				cache: {},
			},
		];

		const app = {
			vault: {
				getMarkdownFiles: () => notes.map(makeTFile),
				cachedRead: async (file: { path: string }) =>
					notes.find((n) => n.path === file.path)?.content ?? '',
			},
			metadataCache: {
				getFileCache: (file: { path: string }) =>
					notes.find((n) => n.path === file.path)?.cache ?? null,
			},
		} as unknown as App;

		const idb = new BodyScanIdbStore(dbName, fakeIdb as unknown as IDBFactory, 1);
		const bodyCache = new BodyScanCache(app, undefined, idb, () => now);
		const docCache = new NormalizedDocumentCache(app, undefined, bodyCache);
		const cfgRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
		if (!cfgRes.ok) throw new Error('Expected valid config');

		// Reconcile document cache before body scan -> 0 tasks
		docCache.reconcile(notes.map(makeTFile), cfgRes.config, () => null);
		expect(docCache.get('notes/work.md')?.tasks).toHaveLength(0);

		// Run body scan -> bodyRev bumps, causing NormalizedDocumentCache.reconcile to update the doc!
		await bodyCache.reconcileVaultBodies();
		const recAfterScan = docCache.reconcile(notes.map(makeTFile), cfgRes.config, () => null);
		expect(recAfterScan.changed).toBe(true);
		expect(recAfterScan.stats.update).toBe(1);
		expect(docCache.get('notes/work.md')?.properties['team']).toBe('platform');
		expect(docCache.get('notes/work.md')?.tasks).toHaveLength(1);
		expect(docCache.get('notes/work.md')?.tasks[0]?.due).toBe('2026-10-01');

		// Mark note with ◊InternalRhizome 001 -> evicted from both BodyScanCache, IDB, and NormalizedDocumentCache
		notes[0]!.cache = {
			frontmatter: {
				'◊InternalRhizome': { '001': 'Do not index or query.' },
			},
		};
		await bodyCache.reconcileVaultBodies();
		expect(bodyCache.getEntry('notes/work.md')).toBeUndefined();
		expect(await idb.getAll()).toHaveLength(0);

		const recAfterIgnore = docCache.reconcile(notes.map(makeTFile), cfgRes.config, () => null);
		expect(recAfterIgnore.changed).toBe(true);
		expect(docCache.get('notes/work.md')).toBeUndefined();
	});
});
