## Principles

These are the design principles considered when making choices whether and
how to implement features. While not absolute, any deviation should be
well-reasoned.

### 1. Idiomatic whenever possible

Use Obsidian's preferred access and change patterns and official APIs. Treat
frontmatter as user-facing UI: go through `Vault.process()` and
`FileManager.processFrontMatter()` rather than raw `Vault.modify()`, prefer
`Vault.trash()` over `Vault.delete()`, and use the `Editor` API for the
active file instead of string-manipulating its content.

### 2. Judge, don't sentence

Don't block the user over ambiguous input — a typo is not a crime, and you
can't tell a typo from an intentional technique. Surface findings through a
log, a Notice, or a dashboard, and keep going. Exception: a plugin whose
stated purpose is validation or enforcement may block, but it must document
that behaviour up front.

### 3. Vault is truth

All input comes from the vault or from the user. Uninstalling the plugin
removes only its own settings, never user content. There is no external
source of truth to sync toward or reconcile against.

### 4. Embrace chaos

Make sense of the vault as it is, not as you wish it were. Be rigid only
about the narrow structure the plugin itself needs — its own frontmatter
fields, its own files — and permissive about everything else.

### 5. Opt-in first

Touch only what the user asked to touch. No mind-reading, no anticipatory
writes, no "helpful" edits to files the user didn't mention.

### 6. Read forgivingly, write critically

Match liberally when reading; be pedantic and cautious when writing.
Normalize paths, tolerate parse errors on the way in, and use atomic,
idempotent write paths on the way out.

### 7. Never worse than manual

No automated write may leave the vault in a state worse than an honest
manual edit would have. If a multi-step process cannot reliably roll back, it
may fail mid-way only if the vault remains in a state the user can recover
from by hand. The underlying assumption is that the feature's value warrants
this escape hatch.

---

These principles map onto the rationale behind Obsidian's plugin review
guidelines — offline-by-default operation, least surprise, and recoverable
writes. Deviations must be well-reasoned and recorded in the PR or a
decision record.
