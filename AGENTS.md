# Obsidian Plugin Template — Agent Guide

## Project overview

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
- Desktop-only plugin (`manifest.json` sets `isDesktopOnly: true`). Node/
  Electron APIs are fine to use. Mobile is explicitly out of scope: not
  tested, not designed for, and not a goal for the foreseeable future. A
  Git-backed feature set is likewise explicitly out of scope.
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

**Don't**

- Introduce network calls without an obvious user-facing reason and
  documentation.
- Ship features that require cloud services without clear disclosure and
  explicit opt-in.
- Store or transmit vault contents unless essential and consented.
- Assign a default hotkey to any command (`Command.hotkeys`). This project
  never ships default hotkeys — binding any key is entirely the user's
  prerogative, configured by them in Obsidian's Hotkeys settings.

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
- Creating or revising a decision record (rev-tagged IBIS diagrams
  recording a design decision's reasoning and history, with `wins over`
  supersession and `thus` consequence edges): load the
  `spec-decision-records` skill.
