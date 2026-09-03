import type { PluginDatabase } from './dexie-persistence-adapter';
import { IDENTITY_KEY, IDENTITY_RECORD_FORMAT, decideBootstrapAction } from './database-identity';

/**
 * The lazy bootstrap that finds, verifies, and (re)creates the persistence
 * database before any application table is touched. Split out of
 * `dexie-persistence-adapter.ts` per AGENTS.md's file-size guidance; the
 * adapter keeps lifecycle and CRUD, this module owns the identity-check
 * ordering.
 *
 * @see docs/dev/indexeddb-database-identity.md
 */

/**
 * Thrown when the delete of an untrusted database fails or is blocked.
 * Carries the underlying error as `cause`.
 *
 * @remarks
 * (design, 2026-09-01) Distinguished from ordinary errors so the adapter
 * can apply the visible-failure path (Notice + log + reject + latch until
 * reload) instead of the uniform log-and-rethrow — a database that could
 * not be verified and could not be replaced must never be read.
 */
export class UntrustedDatabaseDeleteError extends Error {}

export interface BootstrapParameters {
	readonly dbName: string;
	readonly factory: IDBFactory;
	readonly ensureVaultInstanceId: () => Promise<string>;
	readonly openDatabase: () => PluginDatabase;
}

/**
 * Runs the bootstrap sequence and resolves an opened, identity-verified
 * database.
 *
 * @remarks
 * (design, 2026-09-01) Ordering, not journaling, provides crash
 * consistency: the authoritative identity is persisted before any database
 * work, and the database's identity record is the first write on
 * create/recreate. An interrupted bootstrap therefore always lands in a
 * state the next attempt can detect and act on. Application tables are
 * never read before verification succeeds.
 */
export async function bootstrapPersistenceDatabase(
	params: BootstrapParameters,
): Promise<PluginDatabase> {
	// Steps 1-2: a valid vaultInstanceId, persisted before any database work.
	const vaultInstanceId = await params.ensureVaultInstanceId();

	// Step 3: existence at the derived address, via the injected factory —
	// never the Dexie statics, which bypass it and hit the ambient global.
	const present = await databaseExists(params.factory, params.dbName);

	if (!present) {
		return createWithIdentity(params.openDatabase, vaultInstanceId);
	}

	// Step 4: present — read the identity singleton. An open failure means
	// present-and-untrusted; the application tables stay untouched.
	let storedIdentity: unknown;
	const probed = params.openDatabase();
	try {
		storedIdentity = await probed.identity.get(IDENTITY_KEY);
	} catch {
		storedIdentity = undefined;
	}

	const decision = decideBootstrapAction({
		persistedId: vaultInstanceId,
		databasePresent: true,
		storedIdentity,
	});
	if (decision.database === 'reuse') {
		return probed;
	}

	// Step 5 (recreate): delete first, then create. Deleting via the probed
	// instance lets Dexie close its own connection first, so the delete
	// cannot be blocked by it.
	try {
		await probed.delete();
	} catch (error) {
		throw new UntrustedDatabaseDeleteError(
			`Unable to delete an untrusted database («${params.dbName}»); refusing to use it.`,
			{ cause: error },
		);
	}
	return createWithIdentity(params.openDatabase, vaultInstanceId);
}

/**
 * Opens a fresh database and writes the identity record as the **first**
 * write, before any application row.
 */
async function createWithIdentity(
	openDatabase: () => PluginDatabase,
	vaultInstanceId: string,
): Promise<PluginDatabase> {
	const db = openDatabase();
	await db.identity.put({ key: IDENTITY_KEY, format: IDENTITY_RECORD_FORMAT, vaultInstanceId });
	return db;
}

async function databaseExists(factory: IDBFactory, dbName: string): Promise<boolean> {
	const databases = await factory.databases();
	return databases.some((info) => info.name === dbName);
}
