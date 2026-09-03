import { createHash } from 'node:crypto';

/**
 * Pure naming helpers for the Dexie persistence adapter
 * (`dexie-persistence-adapter.ts`). Split out with zero `obsidian`/`dexie`
 * import so this logic is unit-testable without mocking anything — the
 * same split `logger-format.ts` uses for the logger adapter.
 *
 * @see docs/dev/indexeddb-database-identity.md
 */

/** Length of the `vaultRootHash` component of a persistence database address. */
export const VAULT_ROOT_HASH_LENGTH = 12;

/**
 * Strips trailing separators from a vault root path.
 *
 * @remarks
 * (design, 2026-09-01) Trailing-separator stripping only — deliberately
 * **no** lowercasing, which would wrongly merge distinct vaults on a
 * case-sensitive filesystem. Handles both `/` and `\` terminators so a
 * Windows vault root and a macOS/Linux one normalise the same way.
 */
export function normaliseVaultRoot(vaultRootPath: string): string {
	return vaultRootPath.replace(/[/\\]+$/, '');
}

/**
 * Derives the IndexedDB **address** for this plugin's persistence
 * database: `{pluginId}/{databaseId}/{vaultRootHash}`, where
 * `vaultRootHash` is `sha256(normalisedVaultRoot).slice(0, 12)`.
 *
 * @see docs/dev/indexeddb-database-identity.md
 * @remarks
 * (design, 2026-09-01) The address is a pure function of facts available
 * on every install, and contains no identity: a reinstall must be able to
 * recompute it after uninstall removed `data.json`, so the surviving
 * database can be rediscovered and reclaimed. The vault root enters only
 * as a hash so the user's filesystem path never appears in the database
 * name.
 */
export function derivePersistenceDbName(input: {
	pluginId: string;
	databaseId: string;
	vaultRootPath: string;
}): string {
	const hash = createHash('sha256')
		.update(normaliseVaultRoot(input.vaultRootPath))
		.digest('hex')
		.slice(0, VAULT_ROOT_HASH_LENGTH);
	return `${input.pluginId}/${input.databaseId}/${hash}`;
}
