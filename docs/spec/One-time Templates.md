# One-time Rhizome Templates

## Terminology

Obsidian terms such as note, wiki-link, transclusion, callout, frontmatter, and vault are assumed to be understood. Syntax elements used in Rhizome will always be written as `inline code`. All other specific terms will be written in plain text using CamelCase.

- **Rhizome** is the Obsidian plugin that this spec helps define.
- **RhizomeCodeBlock** is a top-level fenced code block with the language `rhizome` or `rhizome-sample` assigned to it. They are contained in notes. RhizomeCodeBlocks do not support nested rendering; thus, a nested RhizomeCodeBlock is literal template content, not an executable template itself (enforced at the DOM boundary so any `rhizome` or `rhizome-sample` block mounted inside an ancestor rendered Rhizome container renders as inert code without executing). The `-sample` suffix only activates the authoring and diagnostics workbench during reactive rendering; during one-time TemplateTriggers, `rhizome` and `rhizome-sample` blocks execute identically. Rhizome is a LiquidJS derivative that uses layouts (`{% layout %}`) and partials (`{% render %}`). Layout and partial code are stored raw, in that the layout or partial note itself is treated as the body of a RhizomeCodeBlock.
- **TabMode** is an optional mutually exclusive flag (`active` or `closed`) following the language name on the opening fence of a RhizomeCodeBlock (for example, ` ```rhizome active ` or ` ```rhizome-sample closed `):
  - Omitted (default): opens a newly created or edited TargetNote in an unfocused background tab (if not already open).
  - `active`: opens the TargetNote and gives its editor focus at the end of the TemplateTrigger.
  - `closed`: creates or edits the TargetNote on disk without opening a tab.
  - When multiple InsertBlocks are concatenated into a single note, `active` wins if any InsertBlock carries `active`, and `closed` applies only if all InsertBlocks carry `closed`.
- **FolderLadder** is a graceful-degradation resolution order used to determine a default parent folder for new note creation. It first tries the selected folder reported by the Notebook Navigator plugin; if that cannot be determined, it uses Obsidian's core _Files and links_ default location for new notes; if that cannot be determined, it uses the parent folder of ActiveNote; if that cannot be determined, it uses the vault root. Any candidate folder inside TemplateDirectory, partials, layouts, Obsidian's configuration directory, or Rhizome's diagnostic logs folder is skipped. Rhizome settings allow the user to choose at which rung this ladder begins.
- **TargetPath** is the initial default vault-relative path used for new note creation. It combines the parent folder resolved from FolderLadder with the file name `"Untitled.md"`.
- **Template** is a note stored inside TemplateDirectory that contains one or more RhizomeCodeBlocks.
- **TemplateDirectory** is a dedicated directory configured in Rhizome settings that holds Template notes. Notes in TemplateDirectory are excluded from vault query indexing.
- **TemplateTrigger** is the command, link activation, or reactive rendering pass that causes Rhizome to evaluate a Template or RhizomeCodeBlock.
- **TemplatePicker** is an Obsidian FuzzySuggestModal that allows the user to pick a single eligible Template from TemplateDirectory. Escaping out of TemplatePicker cancels the TemplateTrigger with no vault or editor changes.
- **ActiveTemplate** is the Template note selected (via TemplateMapping or TemplatePicker, or ActiveNote during CollectTemplateInputs) for execution by a TemplateTrigger.
- **TemplateMapping** is a user-configured association in Rhizome settings between a vault folder and a Template. During note-creating triggers (NewNoteFromTemplate in default mode and NewNoteFromUnresolvedLink), if the parent folder of the initial TargetNote has an eligible TemplateMapping, Rhizome uses the mapped Template as ActiveTemplate without opening TemplatePicker. TemplateMapping never applies to InsertTemplateAtSelections.
- **ActiveNote** is the note open and focused in the workspace when a TemplateTrigger is initiated, if any. Its normalized metadata is exposed in template scope as `{{activeNote}}` (or `null` when no note is active).
- **TargetNote** is a `.md` Markdown vault note created or edited via `{% targetPath %}` (or default TargetPath) during a one-time TemplateTrigger.
- **ThisNote** is the note whose normalized metadata backs `this` and `@this` during the evaluation of a RhizomeCodeBlock:
  - For a CreateBlock targeting a path that does not yet exist (and for NewNoteFromUnresolvedLink, as well as reactive previews of a Template inside TemplateDirectory), ThisNote is a virtual representation of TargetNote that dynamically updates in memory as `{% targetPath %}` and `{% frontmatter %}` execute.
  - For a CreateBlock using `prepend` and/or `append` whose TargetNote already exists on disk (or was staged earlier in the same pass), ThisNote is initialized from that existing TargetNote's normalized metadata and dynamically updates in memory as `{% frontmatter %}` executes.
  - For an InsertBlock in InsertTemplateAtSelections and for a ReactiveInsertBlock outside TemplateDirectory, ThisNote is the hosting note (ActiveNote).
- **SelectorExpression** is a Rhizome value or pipeline expression `<expression> [| <filters>]` (supporting parenthesized `(groupExpression)` wherever grouping is needed) optionally followed by `as <target.path>` when binding a deep path in `{{input}}` or `{{frontmatter}}`.
- **PositionMarkers** (`◊prepend` and `◊append`) are whole-block markers inside a TargetNote (matched outside fenced code blocks) targeted by `{% targetPath %}` edit modes:
  - Replacing a `◊prepend` marker inserts `◊prepend\n<rendered>` so `◊prepend` stays at the top of the stack for subsequent runs. If `prepend` is requested on a TargetNote containing zero `◊prepend` markers, an implicit `◊prepend` position immediately after leading YAML frontmatter (top of body) is used.
  - Replacing an `◊append` marker inserts `<rendered>\n◊append` so `◊append` stays at the bottom of the stack for subsequent runs. If `append` is requested on a TargetNote containing zero `◊append` markers, an implicit `◊append` position at EOF is used.
- `{% targetPath <expression> [if_missing | [prepend] [append]] %}` is a Rhizome tag that sets or overrides the vault-relative `.md` path of the current block's TargetNote (appending `.md` automatically if omitted) without changing ActiveTemplate:
  - **Omitted mode (default):** Always stages creating a new note, resolving case-insensitive collisions against existing vault entries and prior claims in the same run by appending `" 1"`, `" 2"`, etc. to the base name.
  - `if_missing` (mutually exclusive with `prepend` and `append`): Stages creating TargetNote at the exact path if it does not yet exist on disk or in the current run; if TargetNote already exists, the current CreateBlock becomes a no-op.
  - `prepend` and/or `append` (combinable with each other; mutually exclusive with `if_missing`): Overrides collision renaming into create-or-edit mode at the exact path. If TargetNote does not yet exist, creates TargetNote with the rendered content and corresponding PositionMarkers (`◊prepend` prepended above for `prepend`; `◊append` appended below for `append`). If TargetNote already exists (on disk or staged earlier in the same run), inserts the block's rendered content once at every matching PositionMarker in TargetNote (`◊prepend` for `prepend`, `◊append` for `append`, or both when `prepend append` is specified, using the implicit top-of-body / EOF positions when explicit markers are absent).
- **CreateBlock** is a RhizomeCodeBlock in ActiveTemplate whose compiled template tree (including any referenced `{% layout %}` or `{% render %}` files) contains at least one `{% targetPath %}` tag. CreateBlocks are processed independently in document order. If all `{% targetPath %}` tags in a CreateBlock are bypassed at runtime (for example, inside an untaken `{% if %}` branch) or skipped via `if_missing`, that CreateBlock becomes a no-op for the current run rather than falling back to an InsertBlock.
- **InsertBlock** is a RhizomeCodeBlock whose compiled template tree contains no `{% targetPath %}` tag. Multiple InsertBlocks in an ActiveTemplate are processed as one logical InsertBlock: rendered in document order (sharing heading state, merging staged `{% frontmatter %}`, and tracking `{% cursor %}` offsets across the combined output) and concatenated with `\n\n` into a single Markdown result before being applied.
- `{{created}}` is a read-only array in template scope containing the normalized virtual note objects (including final resolved `file.path` and `file.basename`) of all non-skipped CreateBlocks already staged earlier in the current ActiveTemplate pass.
- `{{input}}` is a read-only nested record exposed on the shared root template state (`{{input.<deep.path>}}`) holding all user values collected via `{% prompt %}` and `{% suggest %}` across the current ActiveTemplate pass (propagating across `{% if %}` branches, `{% layout %}` files, `{% render %}` partials, and sibling blocks within that pass without colliding with or being shadowed by local `{% assign %}` variables):
  - Each canonical dotted target path in `{{input}}` begins in an internal untouched state (distinct from `null`, `""`, `false`, or `0`).
  - Compatible re-encounters skip prompting (first-satisfied-wins); incompatible re-encounters that re-prompt overwrite `input.<deep.path>` (last-executed-wins). Setting a scalar on a path that previously held a nested object (or setting a child path beneath a path that previously held a scalar) overwrites that subtree and clears any invalidated ancestor or descendant touched markers.
- **Selection** is a CodeMirror 6 selection range consisting of an anchor and a head within ActiveNote. If anchor and head are equal, the Selection is zero-width (a cursor).
- **Selections** is the non-empty array of one or more CodeMirror 6 Selection ranges in ActiveNote captured when the TemplateTrigger starts, sorted in ascending document order.
- `{{selections}}` is an array of strings representing the selected text of each Selection in Selections (`""` for each zero-width Selection).
- `{{selection}}` is a string representing the text of the current Selection being evaluated (or the first Selection when evaluating NewNoteFromTemplate).
- `{{clipboard}}` is a string representing the text contents of the system clipboard, read lazily only if ActiveTemplate references `clipboard`.
- `{% cursor %}` or `{% cursor <expression> %}` is a Rhizome tag that emits `""` (when given no expression) or the rendered `<expression>` text, and records an anchor-to-head Selection spanning that emitted text so CodeMirror 6 places the cursor or selection(s) there when the target Markdown editor receives focus.
- `{% heading <level> %}` (and contextual heading state): Only initial host/selection context and explicit `{% heading %}` tags set or advance the active heading level; hardcoded raw `#` headings written in template content pass through verbatim without altering heading state. Initial heading depth is:
  - The surrounding heading depth of the hosting note immediately preceding the code block for any ReactiveInsertBlock (including when viewing a Template note reactively, allowing authors to test heading shifts by placing placeholder headings above a block).
  - The surrounding heading depth of ActiveNote at each individual Selection for InsertBlocks in InsertTemplateAtSelections (carried across concatenated InsertBlocks).
  - `0` for standalone note creation or `{% targetPath %}` edits (CreateBlocks, promoted InsertBlocks in NewNoteFromTemplate, and NewNoteFromUnresolvedLink).
- `{% frontmatter <arg>, ... %}` is a Rhizome tag that accumulates structured frontmatter mutations on the shared block state (evaluated left-to-right with last-executed-wins precedence, updating virtual `this` immediately) to be written atomically via Obsidian's `FileManager.processFrontMatter()`. Each `<arg>` may evaluate to:
  - A `"<SelectorExpression> as <key.path>"` string (or array of such strings).
  - A plain key-value record (such as `note.properties` or `note.properties | pick: "author", "year"`), copying all entries in the record (including merged frontmatter and inline properties when `.properties` is passed).
  - An array of `[key, value]` tuples or `{ key, value }` entry objects.
  - A normalized note object (`VaultQueryMatch`, such as `{% frontmatter source_note %}`), which copies **only** frontmatter-sourced metadata (`source === 'frontmatter'` entries from `propertyLocations`, `tagLocations`, and `aliasLocations`, plus `cssclasses`) so pairing `{% frontmatter source_note %}` with `{{ source_note | body }}` clones a note's frontmatter without duplicating inline `[key:: value]` properties or prose `#tags` into YAML.
- `{% prompt <type>: "<SelectorExpression> as var.path", ... %}` is a Rhizome tag evaluated dynamically during Pass 2 rendering:
  - `<type>` is one of `text`, `multiline`, `number`, `checkbox`, `date`, or `datetime`; `<SelectorExpression>` evaluates to the field's initial default value; field labels are humanized from `var.path`.
  - Any field whose `var.path` is already touched in the current ActiveTemplate pass with a compatible `<type>` (`text` also satisfies `multiline`) is omitted from the modal regardless of its default value. If all fields in the tag are omitted, no modal opens. If a field is re-presented due to an incompatible `<type>`, the existing value is pre-filled if coercible.
  - Remaining fields in the tag are presented together in a single form modal; submitted values are stored at `input.<var.path>` (marking each path touched) and the tag emits `""`. Escaping out of the modal cancels the entire TemplateTrigger.
- `{% suggest "<SelectorExpression> as var.path", ... %}` is a Rhizome tag evaluated sequentially during Pass 2 rendering:
  - `<SelectorExpression>` yields the candidate list (scalars are wrapped in a single-element array; normalized note objects display their note basename/path in the modal while binding the full note object to `input.<var.path>`).
  - If `var.path` is already touched in the current ActiveTemplate pass and its current value is a member of the evaluated candidate list (matched by `file.path` for note objects or strict equality for scalars/temporals), the modal is skipped; otherwise an Obsidian FuzzySuggestModal is presented, storing the chosen value at `input.<var.path>` (marking it touched) and emitting `""`. Escaping out of any modal cancels the entire TemplateTrigger.
- `| body` (`{{ note_or_path | body[: exclusions...] }}`) is an asynchronous Pass 2 Liquid filter (disallowed inside synchronous collection-filter selector strings such as `where` / `sort_by` / `group_by` and synchronous inline `` `◊` `` spans so queries remain strictly cache-sized) that reads a Markdown note's body on demand and returns cleaned Markdown text (collapsing runs of 3+ blank lines left by stripped blocks down to `\n\n`):
  - **Mandatory frontmatter removal:** Leading YAML frontmatter (`--- ... ---`) is always stripped.
  - **Reactive cycle prevention:** When `| body` executes inside a ReactiveInsertBlock (detected via unshadowable state on `TemplateTargetState`), `rhizome` and `rhizome-sample` fenced code blocks are stripped automatically; in one-time TemplateTriggers, they are preserved unless excluded by `language` or `codeblock`.
  - **Configurable exclusions** (passed in any order as quoted exclusion names and/or `key: "value"` arguments):
    - `language: "rhizome, rhizome-sample, dataview, tasks"` — Excludes fenced code blocks matching the listed languages.
    - `"codeblock"` or `codeblock: "mermaid"` — Excludes all fenced and indented code blocks _except_ fenced blocks matching the listed languages (if both `language` and `codeblock` are supplied, `rhizome-sample` and the linter emit a warning and the **last** specified argument wins at runtime).
    - `"codeinline"` — Excludes inline backtick code spans.
    - `"callout"` — Excludes Obsidian `> [!type]` callouts while preserving non-callout blockquotes.
    - `"blockquotes"` — Excludes non-callout `> ...` blockquotes while preserving callouts.
    - `"table"` — Excludes Markdown tables.
    - `"math"` — Excludes fenced/block `$$ ... $$` math sections.
    - `"mathinline"` — Excludes inline `$ ... $` math spans.
    - `"comments"` or `comments: "obsidian, html"` — Excludes comments (`obsidian` for `%% ... %%`, `html` for `<!-- ... -->`; defaults to **both** when `"comments"` is given without narrowing).
    - `"lists"` — Excludes bulleted and numbered lists.
    - `heading: "Title1, Title2"` — Excludes each matching heading (case-insensitive trimmed title match, fence-aware) and all content beneath it up to the next heading of the same or higher hierarchy level.
    - `"transclusions"` or `transclusions: "notes, media"` — Excludes embedded `![[...]]` / `![](...)` transclusions (`notes` for Markdown notes, `media` for non-note attachments/images; defaults to **both** when `"transclusions"` is given without narrowing).
    - `"tasks"` — Excludes individual task lines (and their deeper-indented child lines), leaving sibling non-task list items intact when part of a mixed list.

### Render Budgets and Triggers

- **InteractiveRenderBudget** is the tighter time, memory, and output-character ceiling applied to ReactiveInsertBlocks, CollectTemplateInputs, InsertTemplateAtSelections, and NewNoteFromUnresolvedLink (including write-ahead crash-sentinel quarantine and standby callouts on ReactiveInsertBlocks prior to un-virtualized DOM rendering).
- **LongFormRenderBudget** is the elevated time, memory, and output-character ceiling (scaled for desktop vs. mobile memory constraints) applied to all NewNoteFromTemplate renders (both CreateBlocks and promoted concatenated InsertBlocks), whose output is written directly to vault files without mounting an un-virtualized code-block DOM widget.

The following are the TemplateTriggers:

- **ReactiveInsertBlock** is any RhizomeCodeBlock rendered reactively in place by Obsidian's Markdown renderer (whether the hosting note resides outside or inside TemplateDirectory) under InteractiveRenderBudget:
  - It never opens modals or writes files. TabMode flags (`active`, `closed`), `{% cursor %}`, `{{selections}}`, `{{selection}}`, and `{{clipboard}}` are runtime no-ops (emitting non-blocking diagnostics in `rhizome-sample` explain plans). Outside TemplateDirectory, `{% targetPath %}` and `{% frontmatter %}` are no-ops; inside TemplateDirectory, `{% targetPath %}` and `{% frontmatter %}` update in-memory virtual `this`, `{{targetPath}}`, and `{{frontmatter}}` for previewing without touching disk. `{% prompt %}`, `{% suggest %}`, `{{input}}`, and `{{created}}` are no-ops unless an ephemeral snapshot has been populated for that Template file via CollectTemplateInputs.
  - Healthy committed renders expose a hover-revealed copy button (offset beside Obsidian's edit-block button in Live Preview and shown on hover in Reading View; hidden during standby, error, or quarantine states) that copies the committed rendered Markdown string directly to the system clipboard.
- **CollectTemplateInputs** is a Rhizome authoring command (registered via `checkCallback` and available whenever ActiveNote is a Template in TemplateDirectory, regardless of whether a Source tab or Reading tab is focused) that flushes any unsaved editor buffer for ActiveNote, executes a full top-to-bottom in-memory pass across ActiveNote's RhizomeCodeBlocks under InteractiveRenderBudget with interactive `{% prompt %}` and `{% suggest %}` modals enabled (creating or modifying zero vault files), stores the resulting `{{input}}` and simulated `{{created}}` snapshot in memory keyed by `ActiveNote.path` (until all workspace leaves for that Template close or the user resets it), and refreshes all open reactive panes for that Template while preserving tab focus. If a prior test snapshot already exists for `ActiveNote.path`, CollectTemplateInputs starts with a fresh untouched map and fresh `{{created}}` array while seeding initial modal UI defaults from the prior snapshot.
- **NewNoteFromTemplate** is a Rhizome command that creates or updates (`prepend` / `append`) one or more `.md` notes from ActiveTemplate under LongFormRenderBudget (using TemplateMapping when present, or opening TemplatePicker; a companion _Create new note from chosen template_ command always opens TemplatePicker even in mapped folders).
- **InsertTemplateAtSelections** is a Rhizome command that evaluates an ActiveTemplate chosen via TemplatePicker once per Selection in ActiveNote under InteractiveRenderBudget, executing any CreateBlocks and replacing each Selection with the concatenated InsertBlocks.
- **NewNoteFromUnresolvedLink** is a Rhizome trigger (invoked on activating an unresolved wiki-link or markdown link in ActiveNote, or via the editor command/context menu on an unresolved link) that creates the missing `.md` note from an eligible single-note ActiveTemplate under InteractiveRenderBudget so the link resolves.

## Compilation and Pass-Order Rules

1. **Pass 1 (Static Parse & Validation):** Rhizome parses the root RhizomeCodeBlock alongside all transitively referenced `{% layout %}` and `{% render %}` files, extracting `{% query %}` blocks, validating `{% targetPath %}` mode flags, and validating that neither `{% query %}`, `{% prompt %}`, nor `{% suggest %}` appears inside a direct loop (`{% for %}`, `{% tablerow %}`, `{% render ... for %}`) or an indirect loop (a partial transitively invoked from inside a loop).
2. **Pass 1.5 (Static Queries):** All extracted non-`@this` queries execute against the in-memory vault cache, populating `query.*` before Pass 2 begins.
3. **Pass 2 (Bounded Async Rendering & Modal Clock Pausing):**
   - `{% prompt %}` and `{% suggest %}` are allowed inside conditionals (`{% if %}`, `{% elsif %}`, `{% unless %}`, `{% case %}`), `{% layout %}` files, and non-loop `{% render %}` partials, executing only when control flow reaches them.
   - While any `{% prompt %}` or `{% suggest %}` modal is awaiting user input, the Pass 2 render-timeout clock (`ctx.renderLimit`) is paused so user think-time never counts toward InteractiveRenderBudget or LongFormRenderBudget.
   - _Layout ordering note:_ Because LiquidJS evaluates bare top-level expressions in a child template (`STORE` pass) before executing its `{% layout %}` file (`OUTPUT` pass), child templates that read `{{input.<deep.path>}}` values collected by a `{% layout %}` must place those dependent expressions inside named `{% block %}` tags.

## One-Time Render Template

All one-time TemplateTriggers pin a single reference timestamp across the entire execution and preflight all work in memory before performing any vault or editor writes. If any block fails validation/rendering or the user cancels any modal (`Esc`), the entire TemplateTrigger aborts with zero files created and zero edits applied.

### NewNoteFromTemplate

1. Set the initial default TargetNote path to TargetPath (resolved via FolderLadder + `"Untitled.md"`).
2. Determine ActiveTemplate:
   1. When invoked in default mode, look up the parent folder of TargetPath in TemplateMapping. If a mapping exists, set ActiveTemplate to the mapped Template.
   2. Otherwise (or when invoked in explicit picker mode), prompt the user with TemplatePicker to choose ActiveTemplate.
3. Initialize a single ActiveTemplate pass with a fresh `{{input}}` (all paths untouched), `{{created}} = []`, a path-claim and staged-note registry, `{{activeNote}}`, lazy `{{clipboard}}`, `{{selections}}`, and `{{selection}}` (first Selection's text, or `""`).
4. Preflight blocks under LongFormRenderBudget:
   1. **If ActiveTemplate contains one or more CreateBlocks:** Ignore all InsertBlocks and preflight each CreateBlock independently in document order:
      - Bind `this` and `@this` to the virtual TargetNote initialized at TargetPath, with initial heading depth `0`.
      - Render through Pass 1, Pass 1.5, and Pass 2:
        - Reached `{% prompt %}` and `{% suggest %}` tags update shared `{{input}}` (skipping satisfied touched paths and pausing the timeout clock while modals are open).
        - Reached `{% targetPath %}` tags validate the `.md` path without changing ActiveTemplate:
          - Default mode claims a case-insensitively unique path (`" 1"`, `" 2"`, etc.) and binds virtual `this` to that new TargetNote.
          - `if_missing` checks whether the exact path already exists on disk or was already staged in step 4.1; if it exists, marks the CreateBlock as skipped; otherwise claims the exact path.
          - `prepend` and/or `append` targets the exact path; if the note already exists on disk or was staged earlier in step 4.1, binds `this` and `@this` to that existing/staged TargetNote's normalized metadata.
        - Reached `{% frontmatter %}` tags update staged frontmatter and re-normalize `this`.
        - `| body` reads and cleans referenced note bodies on demand (preserving non-excluded `rhizome` blocks in one-time mode).
        - Reached `{% cursor %}` tags record body-relative selection offsets.
      - If no `{% targetPath %}` executed at runtime (for example, skipped by `{% if %}`) or `if_missing` matched an existing note, discard that CreateBlock as a no-op; otherwise stage the CreateBlock (creating a new virtual note or applying its `◊prepend` / `◊append` whole-block edits onto the staged/existing TargetNote) and append the resulting virtual note metadata to `{{created}}`.
   2. **If ActiveTemplate contains zero CreateBlocks:** Render all InsertBlocks in document order as one concatenated `.md` note targeting a collision-resolved TargetPath from step 1 (`"Untitled.md"`, `"Untitled 1.md"`, etc.), sharing `{{input}}`, carrying heading state starting at `0`, merging staged `{% frontmatter %}` in order, recording `{% cursor %}` offsets across the concatenated output, resolving combined TabMode (`active` wins if any block carries `active`; `closed` applies if all carry `closed`), and joining rendered markdown with `\n\n`.
5. If step 4 fails (other than user modal cancellation, which aborts silently), cancel the TemplateTrigger, notify the user, and log the diagnostic error.
6. Commit each staged TargetNote in order:
   1. For newly created notes, re-verify the claimed path, create any missing parent folders, and write the rendered content via `vault.create()`. For existing notes modified via `prepend` and/or `append`, apply the PositionMarker insertions atomically via `Vault.process()` (or via the `Editor` API if that note is the currently focused active editor).
   2. If `{% frontmatter %}` staged any entries for that TargetNote, write/merge them via `FileManager.processFrontMatter()`.
   3. Open tabs according to TabMode:
      - `closed`: do not open a new tab.
      - Default (no TabMode flag): open in an unfocused background tab if not already open.
      - `active`: open (or reveal) the tab; only the **last** staged TargetNote marked `active` receives focus.
7. If a TargetNote marked `active` received focus in step 6.3 and recorded one or more `{% cursor %}` ranges, compute their post-frontmatter document offsets and set the CodeMirror 6 Selections in that editor (otherwise place the caret at the start of the inserted/created body).
8. Release control back to the user.

### InsertTemplateAtSelections

1. Require an ActiveNote with an active Markdown editor; otherwise `InsertTemplateAtSelections` is unavailable.
2. Prompt the user with TemplatePicker to select an ActiveTemplate that contains at least one InsertBlock (Templates with zero InsertBlocks are omitted from TemplatePicker; TemplateMapping is never used here).
3. Sort Selections in ascending document order and initialize trigger-wide shared state: pinned reference timestamp, initial default TargetPath (resolved via FolderLadder + `"Untitled.md"`), `{{activeNote}}` bound from ActiveNote, lazy `{{clipboard}}`, full `{{selections}}` array, and a shared path-claim / staged-note registry.
4. For each Selection in Selections, run an independent ActiveTemplate pass under InteractiveRenderBudget:
   1. Reset `{{input}}` (all paths untouched) and `{{created}} = []` for this Selection, and bind `{{selection}}` to this Selection's text.
   2. Preflight each CreateBlock in ActiveTemplate independently in document order using the CreateBlock rules in `NewNoteFromTemplate` step 4.1 (binding `this` and `@this` to each CreateBlock's virtual or existing TargetNote with initial heading depth `0`, resolving default collision paths, `if_missing`, or `prepend`/`append` via the shared registry without changing ActiveTemplate, staging `{% frontmatter %}` and `{% cursor %}`, and appending each non-skipped TargetNote for this Selection to `{{created}}`). CreateBlocks run regardless of Selection width unless guarded by a template conditional such as `{% if selection != "" %}`.
   3. Preflight all InsertBlocks in ActiveTemplate in document order as one concatenated insertion against `this` and `@this` bound to ActiveNote, starting heading depth at ActiveNote's surrounding heading level immediately preceding this Selection, sharing this Selection's `{{input}}` and `{{created}}`, merging staged `{% frontmatter %}`, joining rendered markdown with `\n\n`, and recording any `{% cursor %}` offsets within the joined replacement.
5. If any iteration in step 4 fails (other than user modal cancellation), cancel the TemplateTrigger, notify the user, and log the diagnostic error.
6. Commit all staged work across all Selections:
   1. Commit every staged CreateBlock's TargetNote in order (creating new files or applying `prepend`/`append` edits, applying staged `{% frontmatter %}` via `FileManager.processFrontMatter()`, and opening tabs per TabMode where `closed` opens no tab, default opens unfocused, and only the final `active` CreateBlock across the entire trigger is slated for focus).
   2. Replace all Selections in ActiveNote with their respective concatenated InsertBlock markdown in a single atomic CodeMirror 6 `changeByRange` transaction so a single Undo reverts all insertions, and map any recorded InsertBlock `{% cursor %}` ranges across the updated ranges (defaulting to zero-width cursors at the end of each inserted span when no `{% cursor %}` was used).
   3. If InsertBlocks staged any `{% frontmatter %}` entries across the Selections, merge them in Selection order onto ActiveNote via `FileManager.processFrontMatter()` after the editor transaction settles and adjust ActiveNote's Selections for any YAML length delta.
   4. Focus resolution: if one or more staged CreateBlocks had the `active` TabMode flag, focus the **last** such CreateBlock's tab and apply its `{% cursor %}` Selections; otherwise keep focus in ActiveNote with ActiveNote's updated Selections.
7. Release control back to the user.

### NewNoteFromUnresolvedLink

1. Resolve the `.md` TargetNote path from the activated unresolved link in ActiveNote:
   1. If the link target contains a folder path, normalize that path (with `.md`) as TargetNote.
   2. If the link target is a bare base name, combine the parent folder of TargetPath (from FolderLadder) with `<baseName>.md` as TargetNote.
2. Verify TargetNote does not already exist on disk (including case-insensitive path collisions):
   - Do **not** append numeric collision suffixes (`" 1"`), because doing so would leave the activated unresolved link in ActiveNote unresolved. If an existing non-note file or folder obstructs TargetNote, notify the user and cancel the TemplateTrigger; if a matching Markdown note already exists at that target, open it and stop.
3. Determine ActiveTemplate:
   - An ActiveTemplate is eligible for `NewNoteFromUnresolvedLink` only if it produces a single `.md` note—specifically, either **zero CreateBlocks** (one or more InsertBlocks concatenated as one) or **exactly one CreateBlock and zero InsertBlocks** (multi-CreateBlock and mixed CreateBlock + InsertBlock Templates are omitted from TemplatePicker).
   - Look up the parent folder of TargetNote in TemplateMapping. If an eligible mapped Template exists, use it; if a mapped Template is ineligible, notify the user and fall back to TemplatePicker; if no mapping exists, prompt with TemplatePicker.
4. Preflight ActiveTemplate under InteractiveRenderBudget with a fresh `{{input}}`, initial heading depth `0`, `this` and `@this` bound to the virtual TargetNote from step 1, and `{{activeNote}}` bound to the note where the link was activated:
   1. If ActiveTemplate contains a single CreateBlock, treat every `{% targetPath %}` tag inside it as a no-op so TargetNote remains locked to the `.md` unresolved link's path; otherwise render and join all InsertBlocks with `\n\n` (recording `{% cursor %}` offsets across the joined output).
   2. Evaluate `{% prompt %}`, `{% suggest %}` (updating `{{input}}` with the render-timeout clock paused), `{% frontmatter %}`, `| body`, `{{selections}}`, `{{selection}}`, `{{clipboard}}`, and `{% cursor %}` during Pass 2 rendering.
5. If step 4 fails (other than user modal cancellation), cancel the TemplateTrigger, notify the user, and log the diagnostic error.
6. Ensure parent folders exist, create TargetNote with the rendered body markdown, and apply any staged `{% frontmatter %}` entries via `FileManager.processFrontMatter()`.
7. Handle tab opening and focus according to TabMode (where `active` wins if any concatenated InsertBlock carries `active`, and `closed` applies if all blocks carry `closed`):
   - `closed`: leave TargetNote closed on disk (the link in ActiveNote resolves in place).
   - Default (no TabMode flag): open TargetNote in a new unfocused background tab, keeping focus in ActiveNote.
   - `active`: open TargetNote, give its editor focus, and place CodeMirror 6 Selections at any recorded `{% cursor %}` ranges (adjusted for serialized frontmatter length).
8. Release control back to the user.
