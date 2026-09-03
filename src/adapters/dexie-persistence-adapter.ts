import { Notice } from 'obsidian';
import { Dexie, type DexieOptions, type Table } from 'dexie';
import type { LoggerPort } from '@ports/logger-port';
import type { ExampleRecord, PersistencePort } from '@ports/persistence-port';
import { UntrustedDatabaseDeleteError, bootstrapPersistenceDatabase } from './database-bootstrap';
import type { DatabaseIdentityRecord } from './database-identity';
import { derivePersistenceDbName } from './persistence-db-name';

/**
 * The Dexie-backed `PersistencePort` adapter. `PluginDatabase` declares the
 * schema; `DexiePersistenceAdapter` implements the port, owns the lazy
 * identity-verified bootstrap, and applies the error policy: ordinary
 * errors log-and-rethrow, an untrusted database that cannot be deleted
 * fails visibly and latches until reload.
 *
 * @see docs/dev/indexeddb-database-identity.md
 */

/**
 * The plugin's IndexedDB schema: one `identity` singleton table plus the
 * application table(s). The identity record is the first write on
 * create/recreate and must survive `clear()` — see
 * `docs/dev/indexeddb-database-identity.md`.
 *
 * @remarks
 * (design, 2026-09-01) `fake-indexeddb` is never imported here: tests
 * inject a fresh `IDBFactory` through `DexieOptions` instead of patching
 * globals, so production code stays free of the shim (enforced by the
 * `no-restricted-imports` rule in `eslint.config.mts`).
 */
export class PluginDatabase extends Dexie {
	identity!: Table<DatabaseIdentityRecord, string>;
	records!: Table<ExampleRecord, number>;

	constructor(name: string, options?: DexieOptions) {
		super(name, options);
		this.version(1).stores({
			identity: 'key',
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
 * and mints nothing — so wiring in `main.ts` keeps startup light.
 *
 * @remarks
 * (design, 2026-09-01) Existence checks use the injected factory's
 * `databases()` and deletion the Dexie **instance** `delete()`: the
 * `Dexie.exists()`/`Dexie.delete()` statics take no options and would
 * bypass the injected fake in tests (and any future injection) entirely.
 */
export class DexiePersistenceAdapter implements PersistencePort {
	readonly dbName: string;

	private readonly ambient: AmbientIndexedDb | undefined;
	private readonly ensureVaultInstanceId: () => Promise<string>;
	private readonly logger: LoggerPort;

	private resolvedAmbient: AmbientIndexedDb | undefined;
	private bootstrapPromise: Promise<PluginDatabase> | undefined;
	private latchedError: Error | undefined;
	private db: PluginDatabase | undefined;
	private closed = false;

	constructor(
		pluginId: string,
		databaseId: string,
		vaultRootPath: string,
		ensureVaultInstanceId: () => Promise<string>,
		logger: LoggerPort,
		ambient?: AmbientIndexedDb,
	) {
		this.dbName = derivePersistenceDbName({ pluginId, databaseId, vaultRootPath });
		this.ambient = ambient;
		this.ensureVaultInstanceId = ensureVaultInstanceId;
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
	 * Empties the application table only; the identity record survives.
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
		if (this.latchedError !== undefined) {
			return Promise.reject(this.latchedError);
		}
		this.bootstrapPromise ??= this.doBootstrap().catch((error) => {
			// Ordinary failures may retry on the next call; the latch check
			// above keeps the untrusted-delete failure sticky until reload.
			this.bootstrapPromise = undefined;
			throw error;
		});
		return this.bootstrapPromise;
	}

	private async doBootstrap(): Promise<PluginDatabase> {
		try {
			const db = await bootstrapPersistenceDatabase({
				dbName: this.dbName,
				factory: this.resolveAmbient().indexedDB,
				ensureVaultInstanceId: this.ensureVaultInstanceId,
				openDatabase: () => this.openDatabase(),
			});
			if (this.closed) {
				// close() raced the bootstrap: don't leak the connection.
				db.close();
				throw new Error('Persistence adapter closed during bootstrap');
			}
			this.db = db;
			return db;
		} catch (error) {
			if (error instanceof UntrustedDatabaseDeleteError) {
				this.latchedError = error;
				// Visible failure by design: diagnostics logging is off by
				// default, so a log alone would be invisible. The latch
				// keeps this the only Notice — no storm on repeated calls.
				new Notice(
					'Plugin cache database could not be replaced and will not be used. ' +
						'Reload the plugin to retry.',
				);
			}
			throw error;
		}
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
	 * caller cannot know. Vault-derived values (the database name embeds a
	 * hash of the vault root) are wrapped in guillemets per `LoggerPort`'s
	 * redaction contract; the raw vault path itself never appears.
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
