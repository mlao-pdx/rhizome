import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import {
	type PersistedRenderSentinelRecord,
	RENDER_SENTINEL_STORE_NAME,
	RenderSentinelIdbStore,
} from '../../src/adapters/render-sentinel-idb';
import {
	computeCodeBlockSentinelHash,
	MAX_SENTINEL_RECORDS,
	RenderSentinelStore,
	SENTINEL_OK_TTL_MS,
} from '../../src/adapters/render-sentinel-store';

function createFakeSentinelIdbFactory() {
	const databases = new Map<
		string,
		{
			version: number;
			stores: Map<string, Map<string, PersistedRenderSentinelRecord>>;
		}
	>();
	let deleteDatabaseCount = 0;

	const factory = {
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
					stores: new Map<string, Map<string, PersistedRenderSentinelRecord>>(),
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
						const map = new Map<string, PersistedRenderSentinelRecord>();
						state.stores.set(storeName, map);
						return {};
					},
					transaction: (storeName: string, _mode: string) => {
						const storeMap =
							state.stores.get(storeName) ??
							new Map<string, PersistedRenderSentinelRecord>();
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
								put: (rec: PersistedRenderSentinelRecord) => {
									storeMap.set(
										rec.hash,
										JSON.parse(
											JSON.stringify(rec),
										) as PersistedRenderSentinelRecord,
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
		getRawStore(dbName: string): Map<string, PersistedRenderSentinelRecord> | undefined {
			return databases.get(dbName)?.stores.get(RENDER_SENTINEL_STORE_NAME);
		},
	};

	return factory;
}

const fakeApp = { appId: 'vault-alpha' } as unknown as App;

describe('RenderSentinelStore & RenderSentinelIdbStore', () => {
	it('quarantines an untested orphaned running record on the first crash and logs a template.sentinel warning', async () => {
		const idbFactory = createFakeSentinelIdbFactory();
		const dbName = 'rhizome-sentinels-vault-alpha';
		const hash = computeCodeBlockSentinelHash(
			'notes/crash.md',
			'{{ query.q | table }}',
			new Map(),
		);

		// Session 1: starts heavy render and crashes before finishRunning
		const store1 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 'session-1',
			nowFn: () => 1_000,
		});
		await store1.markRunning(hash, {
			records: 15_000,
			outputChars: 900_000,
			outputLines: 15_002,
		});
		expect(idbFactory.getRawStore(dbName)?.get(hash)?.status).toBe('running');

		// Session 2: restarts and reconciles orphan
		const warnLogs: Array<{ level: string; meta: Record<string, unknown> }> = [];
		const store2 = new RenderSentinelStore(
			fakeApp,
			{
				log: (level, _msg, meta) => {
					warnLogs.push({ level, meta });
				},
			},
			{
				idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
				sessionId: 'session-2',
				nowFn: () => 2_000,
			},
		);
		await store2.hydrate();

		const quarantined = store2.getQuarantined(hash);
		expect(quarantined).toBeDefined();
		expect(quarantined?.status).toBe('quarantined');
		expect(quarantined?.records).toBe(15_000);
		expect(idbFactory.getRawStore(dbName)?.get(hash)?.status).toBe('quarantined');
		expect(warnLogs).toHaveLength(1);
		expect(warnLogs[0]?.level).toBe('warn');
		expect(warnLogs[0]?.meta['source']).toBe('template.sentinel');
	});

	it('grants one probation retry (wiping lastOk) when a previously healthy block crashes at <= 1.5x scale, then quarantines on a second consecutive crash', async () => {
		const idbFactory = createFakeSentinelIdbFactory();
		const dbName = 'rhizome-sentinels-vault-alpha';
		const hash = 'deadbeef00000001';

		// Session 1: succeeds once, establishing lastOk baseline
		const s1 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's1',
			nowFn: () => 1_000,
		});
		await s1.markRunning(hash, { records: 5_000, outputChars: 100_000, outputLines: 5_000 });
		await s1.finishRunning(hash, {
			committed: true,
			durationMs: 120,
			stats: { records: 5_000, outputChars: 100_000, outputLines: 5_000 },
		});
		expect(s1.getRecord(hash)?.status).toBe('ok');

		// Session 2: user quits app mid-render at 1.2x scale (<= 1.5x)
		const s2 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's2',
			nowFn: () => 2_000,
		});
		await s2.hydrate();
		await s2.markRunning(hash, { records: 6_000, outputChars: 120_000, outputLines: 6_000 });

		// Session 3: reconciled to probation with wiped lastOk; crashes a second time!
		const s3 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's3',
			nowFn: () => 3_000,
		});
		await s3.hydrate();
		expect(s3.getQuarantined(hash)).toBeUndefined();
		const probRec = s3.getRecord(hash);
		expect(probRec?.status).toBe('probation');
		expect(probRec?.lastOkDurationMs).toBeNull();
		expect(probRec?.lastOkChars).toBeNull();
		expect(probRec?.lastOkLines).toBeNull();

		await s3.markRunning(hash, { records: 6_000, outputChars: 120_000, outputLines: 6_000 });

		// Session 4: second consecutive crash -> quarantined!
		const s4 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's4',
			nowFn: () => 4_000,
		});
		await s4.hydrate();
		expect(s4.getQuarantined(hash)?.status).toBe('quarantined');

		// Clicking Retry promotes quarantined -> probation
		await s4.promoteToProbation(hash);
		expect(s4.getQuarantined(hash)).toBeUndefined();
		expect(s4.getRecord(hash)?.status).toBe('probation');
	});

	it('quarantines immediately on the first crash when output explodes past 1.5x of lastOk', async () => {
		const idbFactory = createFakeSentinelIdbFactory();
		const dbName = 'rhizome-sentinels-vault-alpha';
		const hash = 'deadbeef00000002';

		const s1 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's1',
			nowFn: () => 1_000,
		});
		await s1.markRunning(hash, { records: 5_000, outputChars: 100_000, outputLines: 5_000 });
		await s1.finishRunning(hash, {
			committed: true,
			durationMs: 90,
			stats: { records: 5_000, outputChars: 100_000, outputLines: 5_000 },
		});

		// Vault grows 5x -> crashes at 500,000 chars (> 150,000)
		const s2 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's2',
			nowFn: () => 2_000,
		});
		await s2.hydrate();
		await s2.markRunning(hash, { records: 25_000, outputChars: 500_000, outputLines: 25_000 });

		const s3 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's3',
			nowFn: () => 3_000,
		});
		await s3.hydrate();
		expect(s3.getQuarantined(hash)?.status).toBe('quarantined');
	});

	it('handles concurrent same-session split-pane runs and clean unmounts safely', async () => {
		const idbFactory = createFakeSentinelIdbFactory();
		const dbName = 'rhizome-sentinels-vault-alpha';
		const hash = 'deadbeef00000003';

		const store = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 'live-session',
			nowFn: () => 10_000,
		});

		// Split-pane: Pane A commits, Pane B unmounts mid-flight
		await store.markRunning(hash, { records: 6_000, outputChars: 90_000, outputLines: 6_000 });
		await store.markRunning(hash, { records: 6_000, outputChars: 90_000, outputLines: 6_000 });

		await store.finishRunning(hash, {
			committed: true,
			durationMs: 85,
			stats: { records: 6_000, outputChars: 90_000, outputLines: 6_000 },
		});
		// Still running until Pane B finishes
		expect(store.getRecord(hash)?.status).toBe('running');

		await store.finishRunning(hash, { committed: false });
		expect(store.getRecord(hash)?.status).toBe('ok');
		expect(store.getRecord(hash)?.lastOkDurationMs).toBe(85);

		// Clean unmount on an untracked hash deletes the temporary running record
		const untrackedHash = 'deadbeef00000004';
		await store.markRunning(untrackedHash, {
			records: 5_500,
			outputChars: 70_000,
			outputLines: 5_500,
		});
		await store.finishRunning(untrackedHash, { committed: false });
		expect(store.getRecord(untrackedHash)).toBeUndefined();
		expect(idbFactory.getRawStore(dbName)?.has(untrackedHash)).toBe(false);
	});

	it('prunes ok entries older than 30 days, enforces the 256-record LRU cap by status tier, and recovers from VersionError', async () => {
		const idbFactory = createFakeSentinelIdbFactory();
		const dbName = 'rhizome-sentinels-vault-alpha';
		const idb1 = new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory, 1);

		const baseNow = 100_000_000_000;
		const expiredOk: PersistedRenderSentinelRecord = {
			hash: 'expired-ok',
			status: 'ok',
			sessionId: 'old',
			records: 5_000,
			outputChars: 70_000,
			outputLines: 5_000,
			lastOkDurationMs: 50,
			lastOkChars: 70_000,
			lastOkLines: 5_000,
			updatedAt: baseNow - SENTINEL_OK_TTL_MS - 1_000,
		};

		const records: PersistedRenderSentinelRecord[] = [expiredOk];
		// Seed 255 quarantined + 5 fresh ok = 260 live records (> 256 cap)
		for (let i = 0; i < 255; i++) {
			records.push({
				hash: `quar-${i}`,
				status: 'quarantined',
				sessionId: 'old',
				records: 10_000,
				outputChars: 200_000,
				outputLines: 10_000,
				lastOkDurationMs: null,
				lastOkChars: null,
				lastOkLines: null,
				updatedAt: baseNow - 50_000 + i,
			});
		}
		for (let i = 0; i < 5; i++) {
			records.push({
				hash: `fresh-ok-${i}`,
				status: 'ok',
				sessionId: 'old',
				records: 5_000,
				outputChars: 80_000,
				outputLines: 5_000,
				lastOkDurationMs: 40,
				lastOkChars: 80_000,
				lastOkLines: 5_000,
				updatedAt: baseNow - 1_000 + i,
			});
		}
		await idb1.flushBatch(records, []);

		const store = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory, 1),
			sessionId: 'hydrate-session',
			nowFn: () => baseNow,
		});
		await store.hydrate();

		// Expired 'ok' pruned, and oldest 4 fresh 'ok' evicted before any 'quarantined' entry!
		expect(store.size).toBe(MAX_SENTINEL_RECORDS);
		expect(store.getRecord('expired-ok')).toBeUndefined();
		expect(store.getRecord('fresh-ok-0')).toBeUndefined();
		expect(store.getRecord('fresh-ok-3')).toBeUndefined();
		expect(store.getRecord('fresh-ok-4')?.status).toBe('ok');
		expect(store.getQuarantined('quar-0')).toBeDefined();

		// Simulate schema bump to v2 followed by downgrade back to v1 -> VersionError auto-reset
		const idbV2 = new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory, 2);
		await idbV2.getAll();
		const idbDowngrade = new RenderSentinelIdbStore(
			dbName,
			idbFactory as unknown as IDBFactory,
			1,
		);
		const afterDowngrade = await idbDowngrade.getAll();
		expect(afterDowngrade).toEqual([]);
		expect(idbFactory.deleteDatabaseCount).toBe(1);
	});

	it('guards promoteToProbation to quarantined records, restores active runs on clean dispose, and closes late blocked IDB connections', async () => {
		const idbFactory = createFakeSentinelIdbFactory();
		const dbName = 'rhizome-sentinels-vault-alpha';
		const hash = 'deadbeef00000099';

		const s1 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's1',
			nowFn: () => 1_000,
		});
		await s1.markRunning(hash, { records: 5_000, outputChars: 100_000, outputLines: 5_000 });
		await s1.finishRunning(hash, {
			committed: true,
			durationMs: 75,
			stats: { records: 5_000, outputChars: 100_000, outputLines: 5_000 },
		});

		// promoteToProbation must NOT downgrade a healthy 'ok' record
		await s1.promoteToProbation(hash);
		expect(s1.getRecord(hash)?.status).toBe('ok');
		expect(s1.getRecord(hash)?.lastOkDurationMs).toBe(75);

		// Start a new active run and call dispose() (clean plugin unload) mid-render:
		// must restore the 'ok' baseline in IDB so next startup does NOT treat it as a crash!
		await s1.markRunning(hash, { records: 20_000, outputChars: 500_000, outputLines: 20_000 });
		const untracked = 'deadbeef0000009a';
		await s1.markRunning(untracked, {
			records: 8_000,
			outputChars: 90_000,
			outputLines: 8_000,
		});
		s1.dispose();
		await new Promise((r) => {
			queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => r(undefined))));
		});

		const s2 = new RenderSentinelStore(fakeApp, undefined, {
			idbStore: new RenderSentinelIdbStore(dbName, idbFactory as unknown as IDBFactory),
			sessionId: 's2',
			nowFn: () => 2_000,
		});
		await s2.hydrate();
		expect(s2.getRecord(hash)?.status).toBe('ok');
		expect(s2.getRecord(untracked)).toBeUndefined();

		// Late onsuccess after onblocked closes the leaked DB connection immediately
		let closedLateDb = false;
		const blockedThenSuccessFactory = {
			open: () => {
				const req: Record<string, unknown> = {
					result: null,
					onsuccess: null,
					onblocked: null,
					onerror: null,
				};
				queueMicrotask(() => {
					(req.onblocked as (() => void) | null)?.();
					req.result = {
						close: () => {
							closedLateDb = true;
						},
					};
					(req.onsuccess as (() => void) | null)?.();
				});
				return req as unknown as IDBOpenDBRequest;
			},
			deleteDatabase: () => ({}) as unknown as IDBOpenDBRequest,
		};
		const blockedIdb = new RenderSentinelIdbStore(
			'blocked-db',
			blockedThenSuccessFactory as unknown as IDBFactory,
		);
		expect(await blockedIdb.getAll()).toEqual([]);
		await Promise.resolve();
		expect(closedLateDb).toBe(true);
	});
});
