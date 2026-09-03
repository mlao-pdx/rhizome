# `src/core/`

Domain logic with **zero runtime imports from `obsidian` or `dexie`**.
Everything here depends only on interfaces in `src/ports/` (via the
`@ports/*` alias), never on the Obsidian API or a specific persistence
technology directly.

## What belongs here

Pure algorithms and domain logic that must stay swappable and
unit-testable against fakes: business rules and derivations that
take/return plain data and depend only on `@ports/*` interfaces, never on
a concrete adapter. If it can be unit-tested with an in-memory fake
instead of the real Obsidian API or a real Dexie database, it belongs
here.

## What does not belong here

- Anything that touches `metadataCache`, `vault`, or Dexie directly — that
  is adapter code, living outside `src/core`/`src/ports`.
- UI/consumer code (CodeMirror view plugins, sidebars, modals) — those
  depend on the Obsidian API directly and belong outside `src/core`.

## Enforcement

`eslint.config.mts` enforces this boundary via a `no-restricted-imports`
override on `src/core/**` and `src/ports/**`. A runtime import of `obsidian`
or `dexie` (or their subpaths) fails `npm run lint` / CI — never suppress
this rule with `eslint-disable`.

See `src/ports/README.md` for the full port/adapter boundary rationale. See
`docs/dev/tsdoc-conventions.md` for the doc-comment format used throughout
this codebase.
