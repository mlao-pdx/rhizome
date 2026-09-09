---
name: dexie-persistence-adapter
description: Dexie/IndexedDB schema and transaction patterns scoped to the PersistencePort adapter (src/adapters, never src/core or src/ports). Load when implementing or reviewing the Dexie-backed PersistencePort adapter — schema declaration, atomic multi-table transactions, TypeScript Table typing, or schema versioning/migration.
---

# Dexie persistence adapter

Scope: this skill is **only** for the `PersistencePort` Dexie adapter
implementation (outside `src/core/**` and `src/ports/**`). It is not a
general Dexie tutorial — for anything beyond schema/transactions/typing/
versioning, consult the linked docs directly.

`dexie@^4.4.4` (see `package.json`). Type reference (link, don't embed):
`https://unpkg.com/dexie@4.4.4/dist/dexie.d.ts`. Full index for future ad-hoc
lookups: `https://dexie.org/llms.txt`.

## Architecture boundary — read this first

`eslint.config.mts` enforces `no-restricted-imports` on `src/core/**` and
`src/ports/**`: neither may import `dexie` (or `obsidian`) at runtime. Core
algorithms depend only on `PersistencePort` (`src/ports/persistence-port.ts`);
this skill's patterns belong in the adapter module that implements that
interface, never inside `src/core` or `src/ports` themselves.

The inverse guard applies to the test shim and to Node builtins:
`fake-indexeddb` and `node:*` are banned under `src/**` by a second
`no-restricted-imports` block. The shim reaches Dexie only through the
`{ indexedDB, IDBKeyRange }` pair passed into `DexiePersistenceAdapter`'s
constructor (forwarded to `PluginDatabase` as `DexieOptions`) — never by
patching globals, and never from production code. Node builtins are
unavailable in mobile webviews; use Web APIs (`crypto.subtle`).

## Schema declaration matching the adapter

The shipped schema (`src/adapters/dexie-persistence-adapter.ts`) declares
one application table (`records`, the example):

```ts
import { Dexie, type DexieOptions, type Table } from 'dexie';
import type { ExampleRecord } from '@ports/persistence-port';

export class PluginDatabase extends Dexie {
	records!: Table<ExampleRecord, number>;

	constructor(name: string, options?: DexieOptions) {
		super(name, options);
		this.version(1).stores({
			records: 'id',
		});
	}
}
```

- Only list _indexed_ properties in `.stores()` — not every field on the row.
  Non-indexed fields still round-trip through `add`/`put`/`get` normally.
- IndexedDB (and therefore Dexie) can only index `number`, `string`, `Date`,
  arrays of indexable keys, and typed arrays/`ArrayBuffer` — never `boolean`,
  `null`, `undefined`, or a plain object. A field typed `T | undefined` is
  simply unindexed for rows where it's absent (sparse index), not an error.
- The schema holds application data only — no bookkeeping table. The
  database is trusted on sight (vault-scoped name, see below), so there is
  nothing to verify and nothing that must survive `clear()`. Replace
  `ExampleRecord`/`records` with your plugin's real row shapes.
- Dexie 4 auto-detects schema changes on load; incrementing `version()` on a
  pure additive change is optional but still best practice (saves ~1ms on
  open). Only a genuine schema edit needs the version bump below.

## Database naming — pointer, not restatement

The database **address** (`{pluginId}/{databaseId}/{vaultScope}`, where the
vault scope is Obsidian's per-vault `appId` or a `sha256-hex-12` hash of the
vault root) is normative in `docs/dev/indexeddb-database-identity.md`. Read
that document before touching `persistence-db-name.ts` or anything that
renames a database. Two rules from it that shape adapter code directly:

- `databaseId` (`"cache"` in `main.ts`) is stable like `manifest.id` —
  renaming it orphans every user's database.
- Bootstrap is open-only: Dexie **creates the database on demand** at the
  derived address, and a database found there is trusted (its name is
  vault-instance-scoped). There is no existence check and no delete path —
  and if one is ever added, never use the `Dexie.exists()`/`Dexie.delete()`
  statics: they take no options and hit the ambient global, bypassing any
  injected fake.

## Atomic transaction pattern

When a write spans multiple tables and any in-memory value must be resolved
before the write is durable (e.g. a computed id or derived field), resolve it
**in memory first**, then commit the full write in a single atomic Dexie
transaction — `PersistencePort` must never receive a write before that value
is known, and a partially-written row must never be observable to a reader.

```ts
async function putMany(db: PluginDatabase, records: readonly ExampleRecord[]): Promise<void> {
	await db.transaction('rw', db.records, () => db.records.bulkPut([...records]));
}
```

- List every table the callback touches as an argument — a table used inside
  the callback but not declared in the transaction call fails with "Table
  ... not included in parent transaction".
- IndexedDB auto-commits a transaction as soon as it goes a tick without use;
  never `await` an unrelated async API (network, `setTimeout`, a non-Dexie
  promise library) inside the transaction scope, or you'll get
  `TransactionInactiveError`. Stay on native/Dexie promises throughout.
- A bulk rewrite across many rows (e.g. moving many records between
  parents) is deliberately an _ordinary_ transaction across the affected
  rows, not a special-cased background job — don't build separate
  migration machinery for that case.

## TypeScript typing conventions

- Subclass `Dexie`, declare each table as `Table<RowType, KeyType>`, and
  assign it in the constructor via `.stores()` — see the schema example
  above. Table names on the class must exactly match the keys passed to
  `.stores()`.
- Prefer a plain `Table<T, K>` here over `EntityTable`: `PersistencePort`'s
  rows are plain data (see `persistence-port.ts`'s "shape, not contract" /
  "no implementation lives here" doc comment), not class instances with
  methods, so `EntityTable`'s model-binding features aren't needed.
- Do not reach for `dexie-cloud-addon` syntax (`@id` primary keys, realms as
  a _sync_ concept). Dexie Cloud is an unrelated optional add-on — don't
  confuse an app-domain column (e.g. an owner/grouping id specific to your
  domain model) with one of Dexie Cloud's own reserved columns.

## Testing pattern

Tests import the shim **as values** and inject a fresh instance per test —
each `new IDBFactory()` is its own isolated storage, so no unique database
names or teardown are needed:

```ts
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const factory = new IDBFactory();
const adapter = new DexiePersistenceAdapter(
	pluginId,
	databaseId,
	vaultScope, // validated appId, or the path-hash fallback — see persistence-db-name.ts
	logger,
	{ indexedDB: factory, IDBKeyRange },
);
```

Never import `fake-indexeddb/auto` (global patching) — the lint guard and
the injection point exist precisely so tests and production share one code
path with no ambient mutation.

## Schema versioning

```ts
// Adding a column/table: edit the *existing* version block and bump the
// number. Do NOT stack version blocks (that's a legacy Dexie 1/2 pattern).
this.version(2).stores({
	records: 'id, value, lastSeenMs', // added column
	// ...unchanged tables can be omitted only if their definition truly
	// didn't change AND you're not using an upgrade() migrator — when in
	// doubt, repeat the full table list for clarity.
});

// Changing a column's meaning (not just adding one) needs an upgrade():
this.version(3)
	.stores({ records: 'id, value, lastSeenAtMs' })
	.upgrade((tx) =>
		tx.table('records').toCollection().modify((row) => {
			row.lastSeenAtMs = row.lastSeenMs; // migrate old -> new field
			delete row.lastSeenMs;
		}),
	);
```

- `upgrade()` callbacks only ever migrate _forward_; Dexie 4 supports schema
  downgrade detection, but there's no downgrade counterpart to `upgrade()` —
  a downgraded schema version triggers a clear/rebuild path instead.
- Remember the cache invariant before reaching for migrations: everything in
  IndexedDB is rebuildable derived cache. When a migration is more work than
  a rebuild, bumping the database address or the schema version and
  rebuilding is the intended escape hatch — see
  `docs/dev/indexeddb-database-identity.md`.
- Sources for schema/versioning/transaction detail beyond this skill:
  `https://dexie.org/docs/Dexie/Dexie.version()`,
  `https://dexie.org/docs/Dexie/Dexie.transaction()`, and the index at
  `https://dexie.org/llms.txt`.
