# Rhizome — Agent Guide

## Project overview

- An index and template engine for Obsidian.
- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `src/main.ts`, compiled to `main.js`, loaded by Obsidian.

## Design principles

See `docs/principles.md` for the full text. In short: be idiomatic to Obsidian; judge but don't
sentence (inform, don't block, unless validation is the feature); vault is truth; embrace chaos
outside your narrow schema; opt-in before touching; read forgivingly/write critically; never leave
the vault worse than a manual edit would. Deviations must be well-reasoned.

## Coding conventions

- TypeScript with `"strict": true`.
- Keep `main.ts` minimal: only plugin lifecycle (`onload`, `onunload`,
  `addCommand` registration). Delegate feature logic to separate modules
  under `src/`.
- Split large files: if a file exceeds ~200-300 lines, break it into
  smaller, focused modules with a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Desktop and mobile plugin (`manifest.json` sets `isDesktopOnly: false`,
  `minAppVersion: "1.14.0"`). Runtime code bundled into `main.js` must not
  depend on Node.js (`node:*`), Electron, or desktop-only Obsidian APIs
  (`FileSystemAdapter`) without a cross-platform path. A Git-backed feature
  set is explicitly out of scope.
- Prefer `async/await` over promise chains; handle errors gracefully.
- Never commit build artifacts: `node_modules/`, `main.js`, and other
  generated output must never be tracked in Git.
- For example file structure and common task code patterns (adding a
  command, persisting settings, registering listeners), and UI copy/UX
  guidelines, load the `obsidian-plugin-patterns` skill.

## Security, privacy, and compliance

Follow Obsidian's Developer Policies and Plugin Guidelines. In particular:

- Default to local/offline operation. Only make network requests when
  essential to the feature.
- No hidden telemetry. Optional analytics or third-party calls require
  explicit opt-in, documented in `README.md` and in settings.
- Never execute remote code, fetch-and-eval scripts, or auto-update plugin
  code outside normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not
  access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Do not collect vault contents, filenames, or personal information unless
  absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the
  provided `register*` helpers so the plugin unloads safely.
- **Supply-chain security ([_Less is safer_](https://obsidian.md/blog/less-is-safer/)):**
  - **Minimize dependencies:** Prefer implementing small utilities in-house
    over adding third-party packages. Keep the dependency graph shallow,
    especially for runtime `dependencies` bundled into `main.js`.
  - **Pin exact versions and commit the lockfile:** All `dependencies` and
    `devDependencies` in `package.json` must be pinned to exact `x.y.z`
    versions (`save-exact=true` in `.npmrc`; no `^`, `~`, or range
    specifiers). `package-lock.json` is committed and authoritative
    (`npm ci`).
  - **Upgrade slowly and deliberately:** Do not rush to newly published
    package versions; allow a buffer window for the ecosystem to surface
    regressions or supply-chain compromises. Treat every upgrade like
    adding a new dependency: review the changelog and sub-dependency diff,
    run `npm run check:licenses` and the test suite, and update
    `THIRD-PARTY-NOTICES.md` if a production dependency changed.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Agent do/don't

**Do**

- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or
  intervals.
- Use `this.register*` helpers for everything that needs cleanup.
- Never change `manifest.json`'s `id` after release; treat it as a stable
  API.
- Pin exact package versions in `package.json` (`save-exact=true`) and run
  `npm run check:licenses` after adding or upgrading any dependency.

**Don't**

- Introduce network calls without an obvious user-facing reason and
  documentation.
- Ship features that require cloud services without clear disclosure and
  explicit opt-in.
- Store or transmit vault contents unless essential and consented.
- Assign a default hotkey to any command (`Command.hotkeys`). This project
  never ships default hotkeys — binding any key is entirely the user's
  prerogative, configured by them in Obsidian's Hotkeys settings.
- Add third-party packages for trivial utilities that can be written
  in-house, use semver range prefixes (`^`, `~`) in `package.json`, or
  upgrade/downgrade dependencies opportunistically (including via
  `npm audit fix --force`) without explicit user request and review.

## Git workflow

- Work directly on `main`. Do not create or switch to feature branches.
- All commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): subject`, e.g. `fix: correct macOS gitignore patterns`).
- Do not commit, push, amend commits, or otherwise alter Git history without
  the user initiating it. When completed changes form a logical unit of work
  that feels like a good commit point, suggest committing rather than asking
  for approval and waiting.
- Never use shell commit-message commands or `git commit -m "..."`. Compose
  commit messages through the normal interactive commit flow so they can
  be reviewed before finalizing.

## Where to look next

- Design principles: `docs/principles.md`.
- Example file structure, common task code snippets, UI copy/UX
  guidelines: `obsidian-plugin-patterns` skill.
- IndexedDB database naming and identity (address vs identity, the
  `{pluginId}/{databaseId}/{vaultRootHash}` pattern, verification and
  crash-consistency ordering): `docs/dev/indexeddb-database-identity.md`.
- Diagnostic logging contract for routines (`LoggerPort`, mandatory vs
  optional table columns, `meta.source` naming, `‼️...‼️` sensitivity
  markers, and `◊InternalRhizome` frontmatter flags):
  `src/ports/README.md` and `src/ports/logger-port.ts`.
- Creating or revising a decision record (rev-tagged IBIS diagrams
  recording a design decision's reasoning and history, with `wins over`
  supersession and `thus` consequence edges): load the
  `spec-decision-records` skill.
