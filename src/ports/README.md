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

| Port              | Wraps                                       | Notes                                                                                 |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PersistencePort` | Dexie/IndexedDB schema                      | Dexie is the template's chosen API layer over IndexedDB — nothing uses raw IndexedDB. |
| `LoggerPort`      | vault-file writes for developer diagnostics | Opt-in, silent by default — see below.                                                |

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

The log file is plain text, not markdown, so Obsidian never indexes it as
a note and any markdown processing the eventual plugin adds will not pick
it up.

Vault-derived content in a log line must be wrapped in guillemets
(`«...»`) by the calling code before reaching `log()`; structural
information (timings, counts, stack traces) is never wrapped. This is a
caller convention, not something the port or adapter detects
automatically.

The logger is hand-written against `LoggerPort` rather than adopting a
logging library, because no such library ships an Obsidian-vault
transport (one would be hand-written regardless) and a facade over
another logger would just duplicate the seam `LoggerPort` already
provides.

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
