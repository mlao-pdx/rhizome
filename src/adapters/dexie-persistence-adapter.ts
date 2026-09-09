import { Dexie, type DexieOptions, type Table } from 'dexie';
import type { LoggerPort } from '@ports/logger-port';
import type { ExampleRecord, PersistencePort } from '@ports/persistence-port';
import { derivePersistenceDbName } from './persistence-db-name';

/**
 * The Dexie-backed `PersistencePort` adapter. `PluginDatabase` declares the
 * schema; `DexiePersistenceAdapter` implements the port, owns the lazy
 * open-only bootstrap, and applies one uniform error policy: errors log
 * and rethrow.
 *
 * @see docs/dev/indexeddb-database-identity.md
 */

/**
 * The plugin's IndexedDB schema: the application table(s) — this example
 * declares a single `records` table. Replace `ExampleRecord` with the row
 * shapes the plugin actually persists.
 *
 * @remarks
 * (design, 2026-09-01) `fake-indexeddb` is never imported here: tests
 * inject a fresh `IDBFactory` through `DexieOptions` instead of patching
 * globals, so production code stays free of the shim (enforced by the
 * `no-restricted-imports` rule in `eslint.config.mts`).
 */
export class PluginDatabase extends Dexie {
	records!: Table<ExampleRecord, number>;

	constructor(name: string, options?: DexieOptions) {
		super(name, options);
		this.version(1).stores({
			records: 'id',
		});
	}
}

/** The ambient IndexedDB globals, injectable for tests. */
export interface AmbientIndexedDb {
	readonly indexedDB: IDBFactory;
	readonly IDBKeyRange: typeof IDBKeyRange;
}

/**
 * Dexie implementation of `PersistencePort` over rebuildable derived
 * cache. Storage opens lazily on first use — construction performs no I/O
 * — so wiring in `main.ts` keeps startup light.
 *
 * @remarks
 * (design, 2026-09-09) Bootstrap is open-only: the address embeds this
 * vault's scope (Obsidian's per-vault appId, or a hash of the vault root),
 * so a database at this name could only have been created by this vault
 * instance on this machine and is trusted on sight — Dexie creates it on
 * demand when absent. No existence checks and no delete paths exist
 * anymore; if one is ever added, it must go through the injected factory,
 * never the `Dexie.exists()`/`Dexie.delete()` statics, which take no
 * options and would bypass the injected fake in tests (and any future
 * injection) entirely. The retired verification machinery is tombstoned in
 * `docs/spec/decisions.md` (Rev 0.1).
 */
export class DexiePersistenceAdapter implements PersistencePort {
	readonly dbName: string;

	private readonly ambient: AmbientIndexedDb | undefined;
	private readonly logger: LoggerPort;

	private resolvedAmbient: AmbientIndexedDb | undefined;
	private bootstrapPromise: Promise<PluginDatabase> | undefined;
	private db: PluginDatabase | undefined;
	private closed = false;

	constructor(
		pluginId: string,
		databaseId: string,
		vaultScope: string,
		logger: LoggerPort,
		ambient?: AmbientIndexedDb,
	) {
		this.dbName = derivePersistenceDbName({ pluginId, databaseId, vaultScope });
		this.ambient = ambient;
		this.logger = logger;
	}

	/**
	 * The IndexedDB pair this adapter opens databases against: the injected
	 * one, else the ambient globals.
	 *
	 * @remarks
	 * (design, 2026-09-01) Resolved lazily so construction touches no
	 * globals — the lifecycle test constructs the adapter under Node, where
	 * the ambient API does not exist, and bootstrap never runs there. When a
	 * pair is injected (all adapter tests) the `??` short-circuits, so the
	 * ambient fallback is only ever evaluated in the real Obsidian renderer
	 * where `indexedDB`/`IDBKeyRange` exist.
	 */
	private resolveAmbient(): AmbientIndexedDb {
		this.resolvedAmbient ??= this.ambient ?? { indexedDB, IDBKeyRange };
		return this.resolvedAmbient;
	}

	get(id: number): Promise<ExampleRecord | undefined> {
		return this.withDb('get', (db) => db.records.get(id));
	}

	put(record: ExampleRecord): Promise<void> {
		return this.withDb('put', async (db) => {
			await db.records.put(record);
		});
	}

	delete(id: number): Promise<void> {
		return this.withDb('delete', (db) => db.records.delete(id));
	}

	putMany(records: readonly ExampleRecord[]): Promise<void> {
		return this.withDb('putMany', async (db) => {
			// Explicit 'rw' transaction: either every record lands or none
			// do. Never await a non-Dexie promise inside the scope —
			// IndexedDB auto-commits and throws TransactionInactiveError.
			await db.transaction('rw', db.records, () => db.records.bulkPut([...records]));
		});
	}

	/**
	 * Empties every application row. Nothing else survives: the database
	 * carries no bookkeeping of its own.
	 */
	clear(): Promise<void> {
		return this.withDb('clear', (db) => db.records.clear());
	}

	/**
	 * Closes the open connection, if any, and resets the memoized bootstrap
	 * promise. Idempotent.
	 */
	close(): void {
		this.closed = true;
		this.bootstrapPromise = undefined;
		if (this.db !== undefined) {
			this.db.close();
			this.db = undefined;
		}
	}

	private bootstrap(): Promise<PluginDatabase> {
		if (this.closed) {
			return Promise.reject(new Error('Persistence adapter is closed'));
		}
		this.bootstrapPromise ??= this.doBootstrap().catch((error) => {
			// Ordinary failures may retry on the next call: clear the memo
			// so a transient open failure is not cached forever.
			this.bootstrapPromise = undefined;
			throw error;
		});
		return this.bootstrapPromise;
	}

	private async doBootstrap(): Promise<PluginDatabase> {
		const db = this.openDatabase();
		await db.open();
		if (this.closed) {
			// close() raced the bootstrap: don't leak the connection.
			db.close();
			throw new Error('Persistence adapter closed during bootstrap');
		}
		this.db = db;
		return db;
	}

	private openDatabase(): PluginDatabase {
		const ambient = this.resolveAmbient();
		return new PluginDatabase(this.dbName, {
			indexedDB: ambient.indexedDB,
			IDBKeyRange: ambient.IDBKeyRange,
		});
	}

	/**
	 * Uniform error policy: log at `error`, then rethrow. The port is a
	 * data contract — swallowing errors would invent recovery policy the
	 * caller cannot know. Vault-derived values (the database name embeds
	 * the vault's appId or a hash of the vault root) are wrapped in
	 * guillemets per `LoggerPort`'s redaction contract; the raw vault path
	 * itself never appears.
	 */
	private async withDb<T>(
		operation: string,
		use: (db: PluginDatabase) => Promise<T>,
	): Promise<T> {
		try {
			const db = await this.bootstrap();
			return await use(db);
		} catch (error) {
			this.logger.log('error', `IndexedDB ${operation} failed on «${this.dbName}»`, {
				error: String(error),
			});
			throw error;
		}
	}
}
