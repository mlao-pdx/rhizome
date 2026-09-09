# IndexedDB database naming

Normative source for how Rhizome names and scopes its Dexie/IndexedDB
databases. Code (`src/adapters/persistence-db-name.ts`,
`src/adapters/dexie-persistence-adapter.ts`, `src/main.ts`) and the
`dexie-persistence-adapter` skill cite this document instead of restating
it, so they cannot drift. The decisions behind the current scheme — and the
tombstone of the identity-verification machinery it replaced — are recorded
in `docs/spec/decisions.md` (Rev 0.1).

## Why naming is non-trivial: origin partitioning

IndexedDB is partitioned by **origin**, not by vault or plugin. Obsidian
desktop (Electron) presents one origin, so every plugin of every vault on
the machine shares a single IndexedDB namespace. Mobile webviews are also
one origin per app (`capacitor://localhost` / `https://localhost`), so all
vaults on a device share one namespace there too. A plugin cannot ask for
"my" database — it can only compute a name that scopes precisely enough
that whatever is found at it must be its own.

## Lifecycle mismatch: IndexedDB vs plugin data

| Aspect                 | `data.json` (plugin data)     | IndexedDB                                |
| ---------------------- | ----------------------------- | ---------------------------------------- |
| Scope                  | one file per vault per plugin | one namespace per origin (all vaults)    |
| Location               | inside the vault              | outside the vault (OS-level app storage) |
| Removed on uninstall   | yes                           | **no** — survives plugin removal         |
| Syncs with the vault   | however the user syncs files  | never                                    |
| Copying/moving a vault | travels with it               | stays at the old machine/location        |

The consequences that shape everything below:

- A database can **outlive** the plugin installation that created it.
- A copied or moved vault leaves databases behind that may still belong to
  a **live** copy of the vault.
- Nothing in IndexedDB may ever be a source of truth — it is rebuildable
  derived cache (design principle 3: vault is truth).

## The address pattern

```
{pluginId}/{databaseId}/{vaultScope}
```

| Component    | Value                                                      | Responsibility                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginId`   | `manifest.id`                                              | Partitions databases between plugins in the shared origin.                                                                                                                                     |
| `databaseId` | logical dataset name; `"cache"` in this plugin             | Partitions multiple logical datasets of one plugin. **Stable like `manifest.id`**: renaming it orphans every existing user database.                                                           |
| `vaultScope` | validated `app.appId`, else `sha256-hex-12(vaultRootPath)` | Scopes the database to this vault **instance** on this machine. Derived in `deriveVaultScope` (`src/adapters/persistence-db-name.ts`), awaited in `main.ts` before the adapter is constructed. |

`main.ts` reads the vault root from the typed adapter classes:
`FileSystemAdapter.getBasePath()` (desktop) or
`CapacitorAdapter.getFullPath('')` (mobile) — `getFullPath()`/`getBasePath()`
are declared on the concrete adapter classes, **not** on the `DataAdapter`
interface, so code typed against `DataAdapter` alone cannot call them. Both
classes are runtime-exported on both platforms, so `instanceof` narrowing is
safe. An adapter that is neither yields no vault root; without an appId,
`deriveVaultScope` throws rather than ever opening an unscoped database.

## Why appId

`app.appId` is Obsidian's own per-vault instance id: the vault-registry key
(desktop: `~/Library/Application Support/obsidian/obsidian.json`), a 16-char
hex id persisted **outside the vault**. It is stable across restarts,
survives plugin uninstall (so the old "the name must stay derivable after
uninstall" argument holds even better than for a path hash), and is
machine-local. Obsidian itself namespaces all of its per-vault storage by
appId — IndexedDB `${appId}-cache`, `-sync`, `-backup`, `-webview`;
localStorage keys `${appId}-*`; the webview partition
`persist:vault-${appId}` — so this is both precedent and a collision
constraint: our name must keep the `{pluginId}/{databaseId}/` prefix.

appId is **not** in the public typings (`obsidian.d.ts`). It is accessed
through a local `ExtendedApp` cast in `main.ts` and validated at runtime as
a non-empty string — its format is never constrained, because uniqueness,
not shape, is the requirement for an undocumented value.

## The fallback

When the appId is missing, empty, or not a string, `deriveVaultScope`
hashes the vault root instead:

- **Base-path sources**: `FileSystemAdapter.getBasePath()` (desktop),
  `CapacitorAdapter.getFullPath('')` (mobile).
- **Normalisation**: trailing `/` and `\` separators stripped only —
  deliberately **no** lowercasing, which would wrongly merge distinct
  vaults on a case-sensitive filesystem.
- **Hash**: `sha256(normaliseVaultRoot(path))` via the ambient Web
  `crypto.subtle` (available in the desktop renderer, both mobile webview
  schemes, and Node ≥18 in tests — no Node builtins anywhere in `src/`),
  hex-encoded and truncated to 12 characters. Lowercase hex, not base64:
  legible, copy-pastable, and free of `+`/`/`/`=` metacharacters.

The fallback's guarantee is **weaker**, and that is accepted: it scopes by
location, so successive vault instances at one path share a database. The
worst case is a stale rebuildable cache — never a source of truth.

If neither an appId nor a vault root is available, `deriveVaultScope`
throws a descriptive error. An unscoped (or literal-`"undefined"`) database
name must never be produced; a visible failure at load is correct.

## Bootstrap = open

A database at this address could only have been created by this vault
instance on this machine, so it is **trusted on sight**. Bootstrap reduces
to: derive the name → open (Dexie creates the database on demand) → use.
There is no existence check, no content verification, and no delete path.
The retired verification machinery — the `identity` table, the
`vaultInstanceId` in `data.json`, the bootstrap decision table, the
crash-consistency ordering, and the untrusted-delete latch — is tombstoned
in `docs/spec/decisions.md` (Rev 0.1, "Persistence database naming").

## Remaining lifecycle limitation

Databases orphaned at an old scope **MUST NOT** be auto-deleted: they may
belong to a live copy of the vault elsewhere, and everything here is
rebuildable cache anyway. Orphaning happens when:

- a vault is **moved or renamed** (the desktop registry keys by path, so
  the vault gets a new appId → fresh database);
- a vault is **removed from and re-added to** the vault list (new registry
  entry → new appId → fresh database);
- a vault is **copied to another machine** (appIds are machine-local);
- a database was created under the **pre-Rev-0.1 legacy name**
  (`rhizome/cache/<12-hex path hash>`). Under appId scoping (the normal
  case) the rename orphans it. Under the path-hash fallback the name
  components are **identical** — the fallback digest is the same
  `sha256-hex-12` of the same normalised path the legacy scheme computed —
  so the legacy database is **reused on sight**: its rows are the same
  vault's rebuildable cache, and its retired `identity` store lingers
  inert (never read, never reconciled, never deleted). Both outcomes are
  accepted — the plugin is pre-release, so no user is affected — and in
  neither case is a legacy database auto-deleted.

Manual reclamation is a user action: DevTools → Application → IndexedDB,
delete the database at the old name.
