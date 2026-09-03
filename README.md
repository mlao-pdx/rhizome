# Obsidian Sample Plugin

An empty Obsidian plugin template with a hexagon architecture:
`src/core` (pure domain logic) and `src/ports` (technology-agnostic
interfaces) never import `obsidian` or `dexie` at runtime; `src/adapters`
implements those ports against the real Obsidian API and Dexie. The
template retains Vitest (unit + property/fast-check tiers), Prettier,
ESLint (including the boundary rule enforcing the hexagon), esbuild,
`__DEV__`-gated dev-only code, Husky git hooks, license auditing, and the
TSDoc `@remarks` convention.

> **Status: template.** Not in the community plugin catalogue.

## Using this template

This repo is a template: fork it, then work through this checklist before
your first release. Every item replaces an intentional placeholder.

- [ ] `manifest.json` — set `id` (unique, kebab-case, and stable forever:
      never rename it after release), `name`, `description`, and `author`.
- [ ] `package.json` — set `name`, `description`, and `keywords`, and add
      `repository`/`bugs`/`homepage` fields.
- [ ] `LICENSE` — set the copyright holder and year (and refresh
      `THIRD-PARTY-NOTICES.md` if the dependency set or licences change).
- [ ] `src/settings.ts` — rename `MyPlugin`, `MyPluginSettings`, and
      `SampleSettingTab`, and remove or repurpose the sample `exampleSetting`
      field/UI ("Settings #1" / "It's a secret").
- [ ] Protect the default branch: create a branch ruleset with
      "Block force pushes" and "Restrict deletions" (see "Protecting the
      default branch" below).
- [ ] Delete this checklist section once done.

### Protecting the default branch

GitHub warns that your main branch isn't protected. For a solo repo the fix is
a branch ruleset that blocks force pushes and deletions only — no pull-request
or status-check requirements, so it doesn't slow down working directly on the
default branch.

1. Open the repo's **Settings → Rules → Rulesets** (or visit
   `https://github.com/<owner>/<repo>/settings/rules`).
2. Click **New ruleset → New branch ruleset**.
3. Set:
   - **Ruleset name** — anything, e.g. `protect-main`
   - **Enforcement status** — `Active`
   - **Target branches** — **Add target → Include default branch**
   - **Block force pushes** — on
   - **Restrict deletions** — on
   - leave everything else (pull requests, status checks, signed commits,
     linear history) off
4. Click **Create**.

Verify: GitHub's "main branch isn't protected" warning disappears from the
repo's front page. Two caveats:

- Rulesets are available on the Free plan for public repositories; a private
  repository may need a paid plan.
- With "Block force pushes" on, admins cannot rename the default branch until
  they bypass or delete the ruleset, so remove it first if you ever rename
  `main`.

See [Design principles](docs/principles.md) for the 7 guiding choices this template ships with.

## Persistence

The template ships [Dexie](https://dexie.org) as its persistence layer —
the supported API over IndexedDB, never raw IndexedDB used directly.
`src/ports/persistence-port.ts` is the technology-agnostic shape
`src/core` depends on; `src/adapters/dexie-persistence-adapter.ts`
implements it (see the `dexie-persistence-adapter` skill for schema and
transaction patterns). Everything persisted is a rebuildable derived
cache — never a source of truth — in a database addressed to this plugin
and this vault location and verified against a per-vault identity; see
`docs/dev/indexeddb-database-identity.md` for the naming/identity scheme.
A plugin generated from this template that persists nothing can delete the
port, the persistence adapter modules in `src/adapters/`
(`dexie-persistence-adapter.ts`, `database-bootstrap.ts`,
`database-identity.ts`, `persistence-db-name.ts`), the `dexie` dependency
and the `fake-indexeddb` devDependency, and the persistence wiring in
`src/main.ts`; one that persists anything does so through Dexie.

## Support policy

- A desktop-only plugin template. No mobile support, on any OS.

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
