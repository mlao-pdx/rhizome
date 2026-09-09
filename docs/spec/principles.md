These are the design principles considered when making choices whether and how to implement features. While not absolute, any deviation should be well-reasoned.

These principles map onto the rationale behind Obsidian's plugin review guidelines — offline-by-default operation, least surprise, and recoverable writes. Deviations must be well-reasoned and recorded in a decision record.

### 1. Vault is truth

All input comes from the vault or from the user. Uninstalling the plugin removes only its own settings, never user content. There is no external source of truth to sync toward or reconcile against.

### 2. Idiomatic whenever possible

Use the preferred access and change patterns and official APIs of Obsidian, or any other tool we openly rely upon. E.g. Treat frontmatter as user-facing UI: go through `Vault.process()` and `FileManager.processFrontMatter()` rather than raw `Vault.modify()`, prefer `Vault.trash()` over `Vault.delete()`, and use the `Editor` API for the active file instead of string-manipulating its content.

### 3. Judge, don't sentence

Don't block the user over ambiguous input — a typo is not a crime, and we cannot tell a typo from an intentional technique. Surface findings through a log, a Notice, or a dashboard. Keep going, but do not fail silently or invisibly.
Exception: a feature whose stated purpose is validation or enforcement may block, but it must document that behavior up front.

### 4. Embrace chaos, through minimal flexibility.

Make sense of the vault as it is, not as we wish it were. Be opinionated about the narrow structure we adopts for our own data — its own frontmatter fields, its own files — and permissive about everything else. Only provide settings where interaction with the vault, or third-party tools is required.

### 5. Opt-in first

Touch only what the user asked to touch. No mind-reading, no anticipatory writes, no "helpful" edits to files the user didn't mention.

### 6. Read forgivingly, write critically

Match liberally when reading; be pedantic and cautious when writing. Normalize paths, tolerate parse errors on the way in, and use atomic, idempotent write paths on the way out.

### 7. Never worse than manual

No automated write may leave the vault in a state worse than an honest manual edit would have. If a multi-step process cannot reliably roll back, it may fail mid-way only if the vault remains in a state the user can recover from by hand. The underlying assumption is that a feature's value warrants this escape hatch.

### 8. Adhere to the hexagon architecture

Built on a hexagon architecture: `src/core` (pure domain logic) and `src/ports` (technology-agnostic interfaces) never import `obsidian` or `dexie` at runtime; `src/adapters` implements those ports against the real Obsidian API and Dexie. Rhizome retains Vitest (unit + property/fast-check tiers), Prettier, ESLint (including the boundary rule enforcing the hexagon), esbuild, `__DEV__`-gated dev-only code, Husky git hooks, license auditing, and the TSDoc `@remarks` convention. `@remarks` is solely to document the design _intent_ of a function or class and its design.
