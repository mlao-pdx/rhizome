# Rhizome

An index and template engine for Obsidian.

Built on a hexagon architecture: `src/core` (pure domain logic) and
`src/ports` (technology-agnostic interfaces) never import `obsidian` or
`dexie` at runtime; `src/adapters` implements those ports against the real
Obsidian API and Dexie. Rhizome retains Vitest (unit + property/fast-check
tiers), Prettier, ESLint (including the boundary rule enforcing the
hexagon), esbuild, `__DEV__`-gated dev-only code, Husky git hooks, license
auditing, and the TSDoc `@remarks` convention.

> **Status: pre-release.** Not yet in the community plugin catalogue.

See [Design principles](docs/principles.md) for the 7 guiding choices this project ships with.

## Persistence

Rhizome ships [Dexie](https://dexie.org) as its persistence layer —
the supported API over IndexedDB, never raw IndexedDB used directly.
`src/ports/persistence-port.ts` is the technology-agnostic shape
`src/core` depends on; `src/adapters/dexie-persistence-adapter.ts`
implements it (see the `dexie-persistence-adapter` skill for schema and
transaction patterns). Everything persisted is a rebuildable derived
cache — never a source of truth — in a database addressed to this plugin
and this vault location and verified against a per-vault identity; see
`docs/dev/indexeddb-database-identity.md` for the naming/identity scheme.
Everything Rhizome persists goes through this port and adapter — nothing
touches raw IndexedDB.

## Support policy

- A desktop-only plugin. No mobile support, on any OS.

## Testing

Unit tests run on [Vitest](https://vitest.dev/); exploratory property tests
run on [fast-check](https://fast-check.dev/).

```sh
npm test               # run unit tests once
npm run test:watch     # run unit tests in watch mode
npm run test:coverage  # unit tests with a local coverage report (./coverage/)
```

There are two tiers of test files:

- `*.test.ts` — fast, deterministic unit/regression tests. CI-enforced (runs
  in `lint.yml`) and required by the `pre-push` git hook.
- `*.properties.test.ts` — [fast-check](https://fast-check.dev/) property
  tests. **Local-only**: never run in CI or by any git hook. This is a
  solo, low-budget project, so CI is kept fast and deterministic; property
  tests are exploratory and can be slow or (rarely) flaky by nature.

Run property tests locally with:

```sh
npm run test:properties
npm run test:properties:watch
```

### Promoting a fast-check finding to a permanent regression

When a property test fails, it writes a JSON "finding" describing the
failing counterexample to `.fast-check-findings/<id>.json` (git-ignored,
local debugging artifact only) instead of only printing to the console.

1. Run `npm run test:properties` locally.
2. A failing property writes `.fast-check-findings/<id>.json`.
3. Run `npm run test:promote`, and pick the finding from the list. This
   automatically appends an entry for it to `docs/dev/fast-check-log.md`
   (tracked, append-only) — recording the finding is not lost even if the
   scratch JSON file is deleted or dismissed.
4. Copy the printed regression template into the matching `*.test.ts` file,
   fill in the assertion, and confirm it fails against the current code.
5. Fix the implementation until the new regression test (and the original
   property test) pass.
6. Delete the finding via the promote script's prompt (or manually).

Conventions:

- `assertProperty(id, property)`'s `id` is a stable, unique slug:
  `<module-path>__<short-description>`, e.g.
  `smoke/clamp__result-within-bounds`.
- Once real `src/core` modules exist, colocate their shared fast-check
  arbitraries in a `<module>.arbitraries.ts` file next to the module,
  imported from both its `.test.ts` and `.properties.test.ts`.

## Linting

Lint runs on [ESLint](https://eslint.org/); config lives in
`eslint.config.mts`.

- `eslint-plugin-obsidianmd`'s recommended config is the base ruleset
  (Obsidian API usage best-practices).
- `eslint-config-prettier` disables stylistic rules that Prettier owns —
  don't fight Prettier formatting via ESLint; run `npm run format` instead.
- `src/core/**` and `src/ports/**` have a project-specific
  `no-restricted-imports` rule banning `obsidian`/`dexie` imports (see
  `src/core/README.md` for the architectural rationale). This is the one
  rule an LLM contributor must never suppress with `eslint-disable` —
  fix the import boundary instead.
- TypeScript strictness flags (`noUnusedLocals`, `noUnusedParameters`,
  `verbatimModuleSyntax`) already do lint-adjacent work — `tsc` (run via
  `npm run typecheck` or `npm run build`) catches things ESLint won't.

## Licence

0BSD — see [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Credits

Scaffolded from [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) (0BSD).
