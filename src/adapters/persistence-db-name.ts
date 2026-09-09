/**
 * Pure naming helpers for the Dexie persistence adapter
 * (`dexie-persistence-adapter.ts`). Split out with zero `obsidian`/`dexie`
 * import so this logic is unit-testable without mocking anything — the
 * same split `logger-format.ts` uses for the logger adapter.
 *
 * @see docs/dev/indexeddb-database-identity.md
 */

/** Length of the fallback-hash `vaultScope` component of a persistence database address. */
export const VAULT_SCOPE_HASH_LENGTH = 12;

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
 * Derives the vault scope for the persistence database address: Obsidian's
 * per-vault `appId` when it is a valid non-empty string, else a SHA-256
 * hex digest of the normalised vault root, else throws.
 *
 * @see docs/dev/indexeddb-database-identity.md
 * @remarks
 * (design, 2026-09-09) Obsidian namespaces its own per-vault IndexedDB
 * stores by `app.appId` — the vault-registry id persisted outside the
 * vault — so reusing it follows precedent and keeps the address derivable
 * after uninstall. The value is undocumented, so it is validated only as
 * "non-empty string": uniqueness, not shape, is the requirement. When the
 * appId is unusable, the fallback hashes the normalised vault root with
 * the ambient Web `crypto.subtle` — available in the desktop renderer,
 * both mobile webview schemes, and Node ≥18 in tests — and keeps
 * `VAULT_SCOPE_HASH_LENGTH` lowercase hex chars: legible and free of
 * base64 `+`/`/`/`=` metacharacters. With neither available, throwing is
 * correct: an unscoped database name must never be produced.
 */
export async function deriveVaultScope(
	appId: unknown,
	vaultRootPath: string | undefined,
): Promise<string> {
	if (typeof appId === 'string' && appId.length > 0) {
		return appId;
	}
	if (vaultRootPath !== undefined) {
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(normaliseVaultRoot(vaultRootPath)),
		);
		return hexEncode(digest).slice(0, VAULT_SCOPE_HASH_LENGTH);
	}
	throw new Error(
		'Cannot derive the persistence database vault scope: no appId and no readable vault root path.',
	);
}

/**
 * Joins `pluginId`, `databaseId`, and `vaultScope` into the IndexedDB
 * **address** for this plugin's persistence database:
 * `{pluginId}/{databaseId}/{vaultScope}`. A pure sync join — scoping
 * hashing lives in `deriveVaultScope`, awaited in `main.ts` before the
 * adapter is constructed so the adapter's `readonly dbName` stays
 * synchronous.
 *
 * @see docs/dev/indexeddb-database-identity.md
 * @remarks
 * (design, 2026-09-09) The third component is the `vaultScope` derived by
 * `deriveVaultScope` — Obsidian's per-vault appId, or a hash of the vault
 * root — so the name is vault-derived and the raw path never appears in
 * it.
 *
 * SUPERSEDED (design, 2026-09-01): this function computed a
 * `vaultRootHash` by hashing the vault root internally via `node:crypto`
 * and had no `vaultScope` input.
 */
export function derivePersistenceDbName(input: {
	pluginId: string;
	databaseId: string;
	vaultScope: string;
}): string {
	return `${input.pluginId}/${input.databaseId}/${input.vaultScope}`;
}

function hexEncode(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
