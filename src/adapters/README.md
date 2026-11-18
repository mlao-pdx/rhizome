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

| Adapter                                  | Implements          | Wraps                                                                                                                                                                         |
| ---------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ObsidianLoggerAdapter`                  | `LoggerPort`        | `Vault.adapter` (`DataAdapter`), writing segmented Markdown tables under `◊Rhizome/logs/<epoch>.md`                                                                           |
| `normalized-document-cache.ts`           | `DocumentCachePort` | Metadata-only `NormalizedDocument` map keyed by stat plus an opaque `CachedMetadata`/link-resolution revision; reconciles every live Markdown note at pass start              |
| `backlink-index.ts`                      | —                   | `MetadataCache.resolvedLinks` inverted to Markdown targets, reconciled against live vault files and `resolvedLinks` at pass start                                             |
| `vault-query-runner.ts`                  | —                   | `App.vault` (`getMarkdownFiles`, `adapter.read` on `types.json`) and `App.metadataCache` (`getFileCache`, `getFirstLinkpathDest`) to run search queries against the vault     |
| `active-query-roster.ts`                 | —                   | `runVaultQuery` to maintain active reactive `plugin.query(..., onUpdate)` subscribers, deduplicate query strings across subscribers, and diff payload hashes on vault changes |
| `codeblock-render-cache.ts`              | —                   | Bounded per-note Pass 1 (`ParsedRhizomeTemplate`) and Pass 2 (`TemplateRenderResult`) cache so remounting unchanged `rhizome` codeblocks reuses the cached render             |
| `rhizome-codeblock.ts`                   | —                   | `MarkdownRenderer.render` and `MarkdownRenderChild` to execute `renderRhizomeTemplate` inside fenced `rhizome` Markdown codeblocks                                            |
| `codemirror/rhizome-editor-extension.ts` | —                   | CodeMirror 6 `ViewPlugin` to highlight Liquid + query DSL syntax inside fenced `rhizome` codeblocks, composed with the lint source                                            |
| `codemirror/rhizome-analysis-cache.ts`   | —                   | Bounded per-extension analysis and host-document caches shared by the token highlighter and the lint source; reads each view's `editorInfoField`                              |
| `codemirror/rhizome-lint.ts`             | —                   | `@codemirror/lint` `linter` source and diagnostic tooltip DOM for fenced `rhizome` codeblocks                                                                                 |
| `codemirror/rhizome-code-blocks.ts`      | —                   | Line-based fence scanning that locates `rhizome` codeblock bodies for the editor extension                                                                                    |

## Pure helpers

Logic split out of the adapters with zero `obsidian` import so it is
unit-testable without mocking anything:

- `logger-format.ts` — formatting/level-filtering for the logger adapter.
- `plugin-data-store.ts` — owns the `data.json` shape (`settings`) and is
  the only caller of `Plugin.saveData`.

See `src/ports/README.md` for the design rationale.
