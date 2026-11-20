export const SENTINEL_SCHEMA_VERSION = 1;
export const RENDER_SENTINEL_STORE_NAME = 'render_sentinels';

const IDB_OPEN_TIMEOUT_MS = 1_500;

export type RenderSentinelStatus = 'running' | 'ok' | 'probation' | 'quarantined';

export interface PersistedRenderSentinelRecord {
	readonly hash: string;
	readonly status: RenderSentinelStatus;
	readonly sessionId: string;
	readonly records: number;
	readonly outputChars: number;
	readonly outputLines: number;
	readonly lastOkDurationMs: number | null;
	readonly lastOkChars: number | null;
	readonly lastOkLines: number | null;
	readonly updatedAt: number;
}

function getDefaultIdbFactory(): IDBFactory | null {
	if (typeof window !== 'undefined' && 'indexedDB' in window && window.indexedDB) {
		return window.indexedDB;
	}
	return null;
}

/**
 * Zero-dependency IndexedDB wrapper for persisting device-local codeblock render crash
 * sentinels across Obsidian sessions (`rhizome-sentinels-<appId>`).
 *
 * @remarks
 * (design, 2026-11-20) Isolated in its own IndexedDB database (`rhizome-sentinels-<appId>`)
 * rather than sharing `BodyScanIdbStore` (`rhizome-<appId>`) so schema bumps or downgrade
 * `VersionError` resets never interfere with the body scan cache. Write-ahead `put()`
 * resolves strictly on `tx.oncomplete` so Chromium's storage process commits `'running'`
 * before `MarkdownRenderer.render` begins heavy DOM layout or PrismJS work.
 */
export class RenderSentinelIdbStore {
	private readonly dbName: string;
	private readonly schemaVersion: number;
	private readonly idbFactory: IDBFactory | null;
	private dbPromise: Promise<IDBDatabase | null> | null = null;
	private closed = false;

	constructor(
		dbName: string,
		idbFactory: IDBFactory | null = getDefaultIdbFactory(),
		schemaVersion: number = SENTINEL_SCHEMA_VERSION,
	) {
		this.dbName = dbName;
		this.idbFactory = idbFactory;
		this.schemaVersion = schemaVersion;
	}

	async getAll(): Promise<PersistedRenderSentinelRecord[]> {
		const db = await this.getDb();
		if (!db) {
			return [];
		}
		return new Promise<PersistedRenderSentinelRecord[]>((resolve) => {
			try {
				const tx = db.transaction(RENDER_SENTINEL_STORE_NAME, 'readonly');
				const store = tx.objectStore(RENDER_SENTINEL_STORE_NAME);
				const req = store.getAll();
				req.onsuccess = () => {
					const raw = Array.isArray(req.result) ? req.result : [];
					resolve(raw as PersistedRenderSentinelRecord[]);
				};
				req.onerror = () => resolve([]);
			} catch {
				resolve([]);
			}
		});
	}

	async put(record: PersistedRenderSentinelRecord): Promise<void> {
		const db = await this.getDb();
		if (!db) {
			return;
		}
		return new Promise<void>((resolve) => {
			try {
				const tx = db.transaction(RENDER_SENTINEL_STORE_NAME, 'readwrite');
				const store = tx.objectStore(RENDER_SENTINEL_STORE_NAME);
				store.put(record);
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			} catch {
				resolve();
			}
		});
	}

	async delete(hash: string): Promise<void> {
		const db = await this.getDb();
		if (!db) {
			return;
		}
		return new Promise<void>((resolve) => {
			try {
				const tx = db.transaction(RENDER_SENTINEL_STORE_NAME, 'readwrite');
				const store = tx.objectStore(RENDER_SENTINEL_STORE_NAME);
				store.delete(hash);
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			} catch {
				resolve();
			}
		});
	}

	async flushBatch(
		puts: readonly PersistedRenderSentinelRecord[],
		deletes: readonly string[],
	): Promise<void> {
		if (puts.length === 0 && deletes.length === 0) {
			return;
		}
		const db = await this.getDb();
		if (!db) {
			return;
		}
		return new Promise<void>((resolve) => {
			try {
				const tx = db.transaction(RENDER_SENTINEL_STORE_NAME, 'readwrite');
				const store = tx.objectStore(RENDER_SENTINEL_STORE_NAME);
				for (const hash of deletes) {
					store.delete(hash);
				}
				for (const record of puts) {
					store.put(record);
				}
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			} catch {
				resolve();
			}
		});
	}

	async clear(): Promise<void> {
		const db = await this.getDb();
		if (!db) {
			return;
		}
		return new Promise<void>((resolve) => {
			try {
				const tx = db.transaction(RENDER_SENTINEL_STORE_NAME, 'readwrite');
				const store = tx.objectStore(RENDER_SENTINEL_STORE_NAME);
				store.clear();
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			} catch {
				resolve();
			}
		});
	}

	flushAndClose(
		puts: readonly PersistedRenderSentinelRecord[],
		deletes: readonly string[],
	): void {
		if (puts.length === 0 && deletes.length === 0) {
			this.close();
			return;
		}
		void this.flushBatch(puts, deletes).finally(() => {
			this.close();
		});
	}

	close(): void {
		this.closed = true;
		const p = this.dbPromise;
		this.dbPromise = null;
		if (p) {
			void p.then((db) => {
				try {
					db?.close();
				} catch {
					// Ignore close errors on shutdown
				}
			});
		}
	}

	private getDb(): Promise<IDBDatabase | null> {
		if (this.closed || !this.idbFactory) {
			return Promise.resolve(null);
		}
		this.dbPromise ??= this.openWithFallback(this.idbFactory, true);
		return this.dbPromise;
	}

	private openWithFallback(
		factory: IDBFactory,
		allowVersionReset: boolean,
	): Promise<IDBDatabase | null> {
		const hasWin = typeof window !== 'undefined';
		return new Promise<IDBDatabase | null>((resolve) => {
			let settled = false;
			let timeoutId: number | null = hasWin
				? window.setTimeout(() => {
						timeoutId = null;
						this.dbPromise = null;
						settle(null);
					}, IDB_OPEN_TIMEOUT_MS)
				: null;

			const settle = (db: IDBDatabase | null): void => {
				if (settled) {
					if (db) {
						try {
							db.close();
						} catch {
							// Ignore close errors on late connection
						}
					}
					return;
				}
				settled = true;
				if (timeoutId !== null && hasWin) {
					window.clearTimeout(timeoutId);
					timeoutId = null;
				}
				resolve(db);
			};

			let req: IDBOpenDBRequest;
			try {
				req = factory.open(this.dbName, this.schemaVersion);
			} catch {
				this.dbPromise = null;
				settle(null);
				return;
			}

			req.onupgradeneeded = () => {
				const db = req.result;
				if (db.objectStoreNames.contains(RENDER_SENTINEL_STORE_NAME)) {
					db.deleteObjectStore(RENDER_SENTINEL_STORE_NAME);
				}
				db.createObjectStore(RENDER_SENTINEL_STORE_NAME, { keyPath: 'hash' });
			};

			req.onsuccess = () => {
				const db = req.result;
				if (this.closed || settled) {
					try {
						db.close();
					} catch {
						// Ignore close errors
					}
					settle(null);
					return;
				}
				db.onversionchange = () => {
					db.close();
					this.dbPromise = null;
				};
				settle(db);
			};

			req.onerror = () => {
				const errName = req.error?.name;
				if (allowVersionReset && errName === 'VersionError' && !settled) {
					try {
						const delReq = factory.deleteDatabase(this.dbName);
						delReq.onsuccess = () => {
							if (settled || this.closed) {
								settle(null);
								return;
							}
							void this.openWithFallback(factory, false).then(settle);
						};
						delReq.onerror = () => {
							this.dbPromise = null;
							settle(null);
						};
						delReq.onblocked = () => {
							this.dbPromise = null;
							settle(null);
						};
						return;
					} catch {
						this.dbPromise = null;
						settle(null);
						return;
					}
				}
				this.dbPromise = null;
				settle(null);
			};

			req.onblocked = () => {
				this.dbPromise = null;
				settle(null);
			};
		});
	}
}
