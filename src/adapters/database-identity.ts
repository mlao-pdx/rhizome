import { randomUUID } from 'node:crypto';

/**
 * Pure identity and bootstrap-decision helpers for the Dexie persistence
 * adapter. Split out with zero `obsidian`/`dexie` import so this logic is
 * unit-testable without mocking anything — the same split
 * `logger-format.ts` uses for the logger adapter.
 *
 * @see docs/dev/indexeddb-database-identity.md
 */

/** Primary key of the singleton identity record in the `identity` table. */
export const IDENTITY_KEY = 'identity';

/**
 * Schema version of `DatabaseIdentityRecord`. Checked strictly on read: a
 * future bump makes old records invalid, which self-heals via recreate
 * rather than requiring a migration.
 */
export const IDENTITY_RECORD_FORMAT = 1;

/**
 * The singleton record stored in a persistence database's `identity`
 * table. Decides whether the database contents may be reused; it is a
 * continuity check, not a second authority — `data.json` is authoritative
 * for `vaultInstanceId`.
 */
export interface DatabaseIdentityRecord {
	readonly key: typeof IDENTITY_KEY;
	readonly format: typeof IDENTITY_RECORD_FORMAT;
	readonly vaultInstanceId: string;
}

/** True when `value` is a syntactically valid vault-instance identity. */
export function isValidVaultInstanceId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/**
 * True when `value` is a well-formed `DatabaseIdentityRecord`: correct
 * `key`, exactly the current `format`, and a valid `vaultInstanceId`.
 * Rejects a wrong or absent `format` so a future format bump self-heals
 * via recreate.
 */
export function isValidIdentityRecord(value: unknown): value is DatabaseIdentityRecord {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		candidate.key === IDENTITY_KEY &&
		candidate.format === IDENTITY_RECORD_FORMAT &&
		isValidVaultInstanceId(candidate.vaultInstanceId)
	);
}

/** Mints a fresh vault-instance identity (UUID v4, via `node:crypto`). */
export function mintVaultInstanceId(): string {
	return randomUUID();
}

/** The action bootstrap takes on the database at the derived address. */
export type BootstrapDatabaseAction = 'create' | 'reuse' | 'recreate';

export interface BootstrapDecision {
	/** Mint and persist a `vaultInstanceId` before any database work. */
	readonly mintFirst: boolean;
	readonly database: BootstrapDatabaseAction;
}

export interface BootstrapFacts {
	/** Valid persisted `vaultInstanceId` from `data.json`; `undefined` when missing or malformed. */
	readonly persistedId: string | undefined;
	/**
	 * Whether a database exists at the derived address. A database that
	 * exists but fails to open still counts as present: it must be deleted
	 * before recreation, not silently overwritten.
	 */
	readonly databasePresent: boolean;
	/** Raw identity record read from the database; `undefined` when absent or unreadable (open failure). */
	readonly storedIdentity: unknown;
}

/**
 * Implements the bootstrap decision table from
 * `docs/dev/indexeddb-database-identity.md`. `create` opens a database
 * that does not yet exist; `recreate` deletes first, then creates;
 * `reuse` keeps the verified database and its contents.
 */
export function decideBootstrapAction(facts: BootstrapFacts): BootstrapDecision {
	const mintFirst = facts.persistedId === undefined;
	if (!facts.databasePresent) {
		return { mintFirst, database: 'create' };
	}
	if (
		facts.persistedId !== undefined &&
		isValidIdentityRecord(facts.storedIdentity) &&
		facts.storedIdentity.vaultInstanceId === facts.persistedId
	) {
		return { mintFirst: false, database: 'reuse' };
	}
	return { mintFirst, database: 'recreate' };
}
