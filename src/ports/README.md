# `src/ports/`

Port interfaces: contracts defined by `src/core`'s needs, not by any
particular technology. Each port is a plain TypeScript interface with
**zero imports from `obsidian` or `dexie`** — that is the entire point of
this directory.

See `docs/dev/tsdoc-conventions.md` for the doc-comment format (`@see`/
`@remarks`) used on the interfaces below.

## Why

`src/core` (domain logic) must never import `obsidian` or `dexie` at
runtime. Ports are the seam that makes that possible: core depends on a
port interface, and an adapter — living outside `src/core`/`src/ports` —
implements that interface against the real Obsidian API or Dexie schema.

## Current ports

| Port              | Wraps                                       | Notes                                                                                |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PersistencePort` | Dexie/IndexedDB schema                      | Dexie is the project's chosen API layer over IndexedDB — nothing uses raw IndexedDB. |
| `LoggerPort`      | vault-file writes for developer diagnostics | Opt-in, silent by default — see below.                                               |

## Current adapters

`src/adapters/` holds implementations, living outside `src/core`/`src/ports`
per the rule below: `ObsidianLoggerAdapter` implements `LoggerPort`, and
`DexiePersistenceAdapter` implements `PersistencePort`.

## `LoggerPort` design rationale

Diagnostics logging is a second, independent axis from `__DEV__`:
`__DEV__` strips dev-only code from the production bundle entirely, so it
can never help a real user capture a real bug; `LoggerPort` ships in the
production bundle and is silent by default until a user opts in.

The log lives inside the vault (not the OS filesystem or a network
endpoint) so a non-technical user can find and attach it to a bug report,
and so nothing is transmitted over a network.

The log files are segmented Markdown notes (`◊Rhizome/logs/<epoch>.md`)
carrying `◊InternalRhizome: { "001": "Do not index or query." }` frontmatter
so Rhizome's query and indexing processes skip them while users can inspect
the Markdown table directly in Obsidian.

Vault-derived content in a log line must be wrapped in `‼️...‼️` markers
by the calling code before reaching `log()`; structural information
(timings, counts, diagnostic codes) is never wrapped. The formatter outputs
both a shape-redacted `Description` column (with `‼️` stripped and sensitive
characters masked) and an unredacted `‼️Description‼️` column (preserving
`‼️...‼️` markers so the user can delete the column in Obsidian or spot-redact
individual spans). This is a caller convention, not something the port or
adapter detects automatically.

The logger is hand-written against `LoggerPort` rather than adopting a
logging library, because no such library ships an Obsidian-vault
transport (one would be hand-written regardless) and a facade over
another logger would just duplicate the seam `LoggerPort` already
provides.

## Logging contract for new routines

Every call to `logger.log(level, message, meta)` produces a 7-column
Markdown table row (`| Timestamp | Level | Source | Duration | Count | Description | ‼️Description‼️ |`).
`meta` is typed as `LogEntryMeta` so TypeScript enforces mandatory fields at
compile time:

| Column                | Populated By                                      | Requirement                                             | Guidelines for New Routines                                                                                                                                                                                                                                                                                                |
| :-------------------- | :------------------------------------------------ | :------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Timestamp`**       | Adapter (`new Date().toISOString()`)              | **Mandatory** (automatic)                               | Captured synchronously when `log()` is invoked.                                                                                                                                                                                                                                                                            |
| **`Level`**           | `level` argument (`'debug' \| 'warn' \| 'error'`) | **Mandatory**                                           | Use `'debug'` for lifecycle transitions and normal completion summaries, `'warn'` for recoverable user/vault data or query issues, and `'error'` for unexpected failures.                                                                                                                                                  |
| **`Source`**          | `meta.source`                                     | **Mandatory** (compile-time required on `LogEntryMeta`) | Use a short subsystem or dotted `<domain>.<routine>` identifier (e.g. `'lifecycle'`, `'datastore'`, `'db.bootstrap'`, `'db.persistence'`, `'query.types'`, `'query.config'`, `'query.compile'`, `'query.run'`, `'query.diagnose'`, `'query.explain'`).                                                                     |
| **`Duration`**        | `meta.durationMs`                                 | **Optional** (rendered as `<n> ms` or empty cell)       | **Include** on any bounded or timed operation (vault scans, query runs, diagnoses, explanations, batch indexing/migrations). **Omit** on instantaneous state transitions or single-point errors where elapsed time is not meaningful.                                                                                      |
| **`Count`**           | `meta.count`                                      | **Optional** (rendered as `<n>` or empty cell)          | **Include** whenever the routine processes, emits, or summarizes a countable set (e.g. notes scanned, diagnostics emitted, property types loaded, records written). **Omit** when no primary cardinality applies.                                                                                                          |
| **`Description`**     | `message` + extra `meta` keys (redacted)          | **Mandatory** (`message`, derived automatically)        | Concise human-readable summary. Any `‼️...‼️` spans in `message` or extra `meta` values/keys have their `‼️` markers stripped and sensitive characters shape-redacted (`X`/`x` for uppercase/lowercase letters, `9` for digits, `·` for non-ASCII symbols/emojis except `◊`, while preserving punctuation and whitespace). |
| **`‼️Description‼️`** | `message` + extra `meta` keys (unredacted)        | **Mandatory** (derived automatically)                   | Preserves the unredacted text with `‼️...‼️` markers intact so the user can either delete the `‼️Description‼️` column in Obsidian or spot-redact individual `‼️...‼️` spans. When an entry contains no `‼️...‼️` spans, `Description` and `‼️Description‼️` are identical.                                                |

### Sensitivity & special `meta` keys

- **Wrap all vault-derived strings in `‼️...‼️`** before passing them in `message` or `meta` (note paths, filenames, user property keys/values, query names, query strings, user-supplied timezone strings).
- **Never wrap structural/internal identifiers** in `‼️...‼️` (diagnostic codes like `SYNTAX_ERROR` or `DOC_INVALID_PROPERTY_VALUE`, counts, booleans, plugin version strings).
- **Query strings (`meta.query`):** When a query expression is passed under the reserved key `meta.query` (wrapped in `‼️...‼️`), `Description` applies syntax-aware query redaction (`redactQuerySyntax`) for syntactically valid queries (preserving Rhizome grammar operators, built-in scope names, virtual/built-in property keys (`file.*`, `tags`, `aliases`), and relative `@` date anchors while masking user identifiers, custom property keys, literals, and numeric offsets), and falls back to character-class redaction (`redactSensitiveText`) when the query fails parsing with a `SYNTAX_ERROR`.

## Non-blocking adapters

Ports carry no performance contract themselves — that's the adapter's
job. `PersistencePort` adapters must not block the calling path — batch
writes, use IndexedDB transactions appropriately, and never synchronously
wait on I/O inside a call that core logic expects to return quickly.

## Rules

- **No implementations here.** Adapters are a separate concern (`LoggerPort`'s
  adapter is the first example).
- **No `obsidian` or `dexie` imports.** These interfaces exist so
  `src/core` never has to import either. Enforced by the
  `no-restricted-imports` rule in `eslint.config.mts` — see
  `src/core/README.md`#enforcement.
- Port shapes are expected to grow as the domain logic they serve grows —
  treat these as living contracts, not finished APIs.
