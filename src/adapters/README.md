# `src/adapters/`

Adapter implementations of the interfaces declared in `src/ports/`. This is
where `obsidian` and `dexie` runtime imports are allowed — the
`no-restricted-imports` override in `eslint.config.mts` only targets
`src/core/**` and `src/ports/**` (see `src/core/README.md`#enforcement,
`src/ports/README.md`). The inverse guard lives there too:
`fake-indexeddb` is banned under `src/**` — the test shim reaches Dexie
only through the `DexieOptions` injection point, wired in from `tests/`.

See `docs/dev/tsdoc-conventions.md` for the doc-comment format (`@see`/
`@remarks`) used throughout this directory.

## Current adapters

| Adapter                   | Implements        | Wraps                                                                                                                       |
| ------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ObsidianLoggerAdapter`   | `LoggerPort`      | `Vault.adapter` (`DataAdapter`), under a `_<manifest.id>/logs/` folder derived at runtime                                   |
| `DexiePersistenceAdapter` | `PersistencePort` | Dexie over IndexedDB, at an address scoped to the plugin and vault location — see `docs/dev/indexeddb-database-identity.md` |

## Pure helpers

Logic split out of the adapters with zero `obsidian`/`dexie` import so it is
unit-testable without mocking anything:

- `logger-format.ts` — formatting/level-filtering for the logger adapter.
- `persistence-db-name.ts` — derives the persistence database address
  (`{pluginId}/{databaseId}/{vaultRootHash}`).
- `database-identity.ts` — the identity record shape/validation, id
  minting, and the bootstrap decision table.
- `database-bootstrap.ts` — the identity-verified bootstrap sequence the
  Dexie adapter runs lazily on first use.
- `plugin-data-store.ts` — owns the `data.json` shape (settings plus
  `vaultInstanceId`) and is the only caller of `Plugin.saveData`.

See `src/ports/README.md` for the design rationale.
