# `src/adapters/`

Adapter implementations of the interfaces declared in `src/ports/`. This is
where `obsidian` runtime imports and browser `indexedDB` access are allowed — the
`no-restricted-imports` override in `eslint.config.mts` only targets
`src/core/**` and `src/ports/**` (see `src/core/README.md`#enforcement,
`src/ports/README.md`). The inverse guard lives there too:
`fake-indexeddb` is banned under `src/**` — the test shim reaches the adapter
only through an `IDBFactory` injection point, wired in from `tests/`.

See `docs/dev/tsdoc-conventions.md` for the doc-comment format (`@see`/
`@remarks`) used throughout this directory.

## Current adapters

| Adapter                                  | Implements   | Wraps                                                                                                                                                                         |
| ---------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ObsidianLoggerAdapter`                  | `LoggerPort` | `Vault.adapter` (`DataAdapter`), writing segmented Markdown tables under `◊Rhizome/logs/<epoch>.md`                                                                           |
| `vault-query-runner.ts`                  | —            | `App.vault` (`getMarkdownFiles`, `adapter.read` on `types.json`) and `App.metadataCache` (`getFileCache`, `getFirstLinkpathDest`) to run search queries against the vault     |
| `active-query-roster.ts`                 | —            | `runVaultQuery` to maintain active reactive `plugin.query(..., onUpdate)` subscribers, deduplicate query strings across subscribers, and diff payload hashes on vault changes |
| `rhizome-codeblock.ts`                   | —            | `MarkdownRenderer.render` and `MarkdownRenderChild` to execute `renderRhizomeTemplate` inside fenced `rhizome` Markdown codeblocks                                            |
| `codemirror/rhizome-editor-extension.ts` | —            | CodeMirror 6 `ViewPlugin` and `hoverTooltip` to highlight Liquid + query DSL syntax and render inline diagnostic tooltips inside fenced `rhizome` codeblocks                  |

## Pure helpers

Logic split out of the adapters with zero `obsidian` import so it is
unit-testable without mocking anything:

- `logger-format.ts` — formatting/level-filtering for the logger adapter.
- `plugin-data-store.ts` — owns the `data.json` shape (`settings`) and is
  the only caller of `Plugin.saveData`.

See `src/ports/README.md` for the design rationale.
