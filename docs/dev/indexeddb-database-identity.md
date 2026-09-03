# IndexedDB database identity

Normative source for how this template names, scopes, and verifies its
Dexie/IndexedDB databases. Code (`src/adapters/dexie-persistence-adapter.ts`,
`src/adapters/persistence-db-name.ts`, `src/adapters/database-identity.ts`)
and the `dexie-persistence-adapter` skill cite this document instead of
restating it, so the three cannot drift.

## Why naming is non-trivial: origin partitioning

IndexedDB is partitioned by **origin**, not by vault or plugin. Obsidian
(Electron) presents one origin, so every plugin of every vault on the
machine shares a single IndexedDB namespace. A plugin cannot ask "my"
database — it can only compute a name and hope the database at that name
belongs to the current vault. Naming and identity below exist to make that
hope checkable.

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

## Address vs identity

The design separates two questions that a naive scheme conflates:

- **Address** — where is this vault's database? A _deterministic, derivable_
  name computed from facts available on every install.
- **Identity** — is the database at that address really ours? A _persisted,
  random_ vault-instance id compared against a record stored inside the
  database itself.

The address finds the database; the identity decides whether its contents
may be **reused**. A mismatch never merges, migrates, or repairs — it
invalidates the whole database (delete and recreate).

## The address pattern

```
{pluginId}/{databaseId}/{vaultRootHash}
```

| Component       | Value                                                      | Responsibility                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginId`      | `manifest.id`                                              | Partitions databases between plugins in the shared origin.                                                                                                                                                                                          |
| `databaseId`    | logical dataset name; `"cache"` in this template           | Partitions multiple logical datasets of one plugin. **Stable like `manifest.id`**: the value encodes the invariant that the pattern is scoped to rebuildable vault-local data; renaming it orphans every existing user database.                    |
| `vaultRootHash` | `sha256(normalisedVaultRoot).slice(0, 12)` (`node:crypto`) | Scopes the database to the vault's filesystem location **without** embedding the raw path in the name. Normalisation strips trailing separators only — never lowercasing, which would wrongly merge distinct vaults on a case-sensitive filesystem. |

The vault root comes from `FileSystemAdapter.getBasePath()`. The plugin is
desktop-only (`manifest.json` sets `isDesktopOnly: true`), so the vault
adapter is a `FileSystemAdapter` at runtime; `main.ts` narrows to it with
`instanceof`. Note that `getFullPath()`/`getBasePath()` are declared on the
concrete adapter classes (`FileSystemAdapter`, `CapacitorAdapter`), **not**
on the `DataAdapter` interface — code typed against `DataAdapter` alone
cannot call them. `app.appId` is deliberately **not** used as a vault
identifier: it is not part of the public typings.

## Why the name excludes the identity

The address must stay derivable from facts that survive uninstall. Uninstall
removes `data.json` — where the identity lives — but leaves the database. If
the name embedded the identity, a reinstall could never recompute it, and
the surviving database would be permanently orphaned. With a pure address,
reinstall rediscovers the database by name, runs the identity check, and
reclaims (reuse) or rebuilds (recreate) it.

## The identity record

`vaultInstanceId` is a `randomUUID()` value minted once per vault instance.
It is persisted in **two** places with distinct roles:

- **`data.json`** (authoritative, under a separate top-level key — not
  inside the user-settings object). Deleting IndexedDB never mints a new id:
  the same vault instance keeps the same id.
- **The database's `identity` table** (continuity check). A singleton record
  decides whether the database contents may be reused. It is _not_ a second
  authority.

Shape (`src/adapters/database-identity.ts`):

```ts
interface DatabaseIdentityRecord {
	key: 'identity';
	format: 1;
	vaultInstanceId: string;
}
```

`format` is checked strictly (`=== 1`): a future format bump makes old
records invalid, which self-heals via recreate rather than requiring a
migration.

## Verification table

`decideBootstrapAction` implements exactly this table
(`persistedValid` = `data.json` holds a valid id; a database that exists but
fails to open counts as **present** and untrusted):

| Persisted identity | Database at address | Database identity | Action                           |
| ------------------ | ------------------- | ----------------- | -------------------------------- |
| missing/malformed  | absent              | —                 | mint id first, then **create**   |
| present            | absent              | —                 | **create**                       |
| present            | present             | equal             | **reuse**                        |
| present            | present             | different         | **recreate**                     |
| present            | present             | missing/malformed | **recreate**                     |
| missing/malformed  | present             | any               | mint id first, then **recreate** |

`create` opens a database that does not yet exist; `recreate` deletes the
database first, then creates it. Existence is determined via the
**injected** `IDBFactory.databases()`; deletion via the Dexie **instance**
`db.delete()`. The statics `Dexie.exists()`/`Dexie.delete()` bypass any
injected `indexedDB` and hit the ambient global — they must never be used.

## Creation and crash-consistency ordering

1. Read `vaultInstanceId` from `data.json`; if invalid, mint one with
   `randomUUID()` and **persist it before any database work** — the
   authoritative identity must be durable before the database exists.
2. Determine existence at the derived address.
3. If present, open and read the `identity` singleton. Application tables
   are **never read before identity verification succeeds.**
4. Apply the decided action. On `create`/`recreate`, the identity record is
   the **first write**, before any application row.

Crash consistency follows from the ordering, not from any journaling:

- Interrupted after persisting the id → next attempt creates/validates
  against it.
- Interrupted after creating a database but before its identity record is
  durable → next attempt sees a missing identity and recreates.
- Interrupted mid-delete → next attempt detects the same mismatch and
  retries.

If the delete of an untrusted database fails or is blocked, the adapter must
fail visibly (a `Notice`, an `error`-level log, a rejected promise) and
refuse the database until reload — it must never read application tables
from a database it could not verify and could not replace.

## Remaining lifecycle limitation

A database at **another** location's `vaultRootHash` — left behind by moving
or copying the vault — can be neither verified nor safely deleted: it may
belong to a live copy of the vault. Such databases **MUST NOT** be
auto-deleted. This is accepted, not worked around: reinstall already
self-heals the common case (rediscovery by address at the current location),
and manual reclamation is a user action.
