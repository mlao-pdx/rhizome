import type { ExtractedTaskInput } from '@core/scanner';
import type { InlinePropertyInput } from '@core/search';

export const SCANNER_SCHEMA_VERSION = 1;
export const BODY_SCAN_STORE_NAME = 'body_text_cache';

export interface PersistedBodyScanRecord {
	readonly path: string;
	readonly mtime: number;
	readonly size: number;
	readonly bodyDigest: string;
	readonly inlineProperties: readonly InlinePropertyInput[];
	readonly tasks: readonly ExtractedTaskInput[];
}

function getDefaultIdbFactory(): IDBFactory | null {
	if (typeof window !== 'undefined' && 'indexedDB' in window && window.indexedDB) {
		return window.indexedDB;
	}
	return null;
}

/**
 * Zero-dependency wrapper around browser `indexedDB` for persisting raw `BodyScanResult`
 * records across Obsidian sessions.
 *
 * @remarks
 * Uses `SCANNER_SCHEMA_VERSION` as the native IndexedDB version integer: bumping the
 * schema version triggers `onupgradeneeded`, which drops and recreates the
 * `'body_text_cache'` object store at the engine level without deserializing stale
 * records. Downgrades that raise `VersionError` automatically delete and recreate the
 * database.
 */
export class BodyScanIdbStore {
	private readonly dbName: string;
	private readonly schemaVersion: number;
	private readonly idbFactory: IDBFactory | null;
	private dbPromise: Promise<IDBDatabase | null> | null = null;
	private closed = false;

	constructor(
		dbName: string,
		idbFactory: IDBFactory | null = getDefaultIdbFactory(),
		schemaVersion: number = SCANNER_SCHEMA_VERSION,
	) {
		this.dbName = dbName;
		this.idbFactory = idbFactory;
		this.schemaVersion = schemaVersion;
	}

	async getAll(): Promise<PersistedBodyScanRecord[]> {
		const db = await this.getDb();
		if (!db) {
			return [];
		}
		return new Promise<PersistedBodyScanRecord[]>((resolve) => {
			try {
				const tx = db.transaction(BODY_SCAN_STORE_NAME, 'readonly');
				const store = tx.objectStore(BODY_SCAN_STORE_NAME);
				const req = store.getAll();
				req.onsuccess = () => {
					const raw = Array.isArray(req.result) ? req.result : [];
					resolve(raw as PersistedBodyScanRecord[]);
				};
				req.onerror = () => resolve([]);
			} catch {
				resolve([]);
			}
		});
	}

	async flushBatch(
		puts: readonly PersistedBodyScanRecord[],
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
				const tx = db.transaction(BODY_SCAN_STORE_NAME, 'readwrite');
				const store = tx.objectStore(BODY_SCAN_STORE_NAME);
				for (const path of deletes) {
					store.delete(path);
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
				const tx = db.transaction(BODY_SCAN_STORE_NAME, 'readwrite');
				const store = tx.objectStore(BODY_SCAN_STORE_NAME);
				store.clear();
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			} catch {
				resolve();
			}
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
		return new Promise<IDBDatabase | null>((resolve) => {
			let req: IDBOpenDBRequest;
			try {
				req = factory.open(this.dbName, this.schemaVersion);
			} catch {
				resolve(null);
				return;
			}

			req.onupgradeneeded = () => {
				const db = req.result;
				if (db.objectStoreNames.contains(BODY_SCAN_STORE_NAME)) {
					db.deleteObjectStore(BODY_SCAN_STORE_NAME);
				}
				db.createObjectStore(BODY_SCAN_STORE_NAME, { keyPath: 'path' });
			};

			req.onsuccess = () => {
				const db = req.result;
				if (this.closed) {
					db.close();
					resolve(null);
					return;
				}
				db.onversionchange = () => {
					db.close();
					this.dbPromise = null;
				};
				resolve(db);
			};

			req.onerror = () => {
				const errName = req.error?.name;
				if (allowVersionReset && errName === 'VersionError') {
					try {
						const delReq = factory.deleteDatabase(this.dbName);
						delReq.onsuccess = () => {
							void this.openWithFallback(factory, false).then(resolve);
						};
						delReq.onerror = () => resolve(null);
						delReq.onblocked = () => resolve(null);
						return;
					} catch {
						resolve(null);
						return;
					}
				}
				resolve(null);
			};

			req.onblocked = () => resolve(null);
		});
	}
}
