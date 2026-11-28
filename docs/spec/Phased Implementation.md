# Phased Implementation

The cleanest implementation order follows the **data and parser dependency graph**—building shared `@core` scanners and state primitives once up front so nothing has to be rewritten later, and isolating the two trickiest Obsidian UI surfaces (`NewNoteFromUnresolvedLink` interception and CodeMirror `!` atomic-caret math) at the end where they cannot block core functionality.

```
  [Phase 1: Unified Scanner + Classifier + Index Tag Excision]
                |                                   \
                v                                    v
  [Phase 2: Fence Modes, Budgets, Copy, & | body]   [Phase 6: Inline Property CM6
                |                                    Decorations, Linter & Sidebar]
                v                                    (independent after Phase 1!)
  [Phase 3: targetPath Edit Modes, frontmatter, cursor]
                |
                v
  [Phase 4: prompt, suggest, {{input}} & CollectTemplateInputs]
                |
                v
  [Phase 5: Triggers (NewNote -> InsertAtSelections -> Mapping -> UnresolvedLink)]
```

---

## Phase 1: Classifier Algebra, Unified Scanner, & Index Integration (`@core/scanner`, `@core/search`)

**Build first because three other features (`| body`, `%% ◊prepend %%`/`%% ◊append %%`, and `{% frontmatter source_note %}`) depend on it.**

1. Implement standalone `classify()` + unit and `fast-check` property tests (`P17–P34`, model-printer oracle).
2. Implement the single-pass **Unified Scanner** (`Frontmatter`, `FencedCode`, `IndentedCode`, `BlockComment`, `InlineCode`, `InlineComment`) + inline property parser (`single`, `pair`, `bare`) alongside legacy Dataview `[k:: v]` / `(k:: v)` fallback.
3. Wire §8 tag containment attribution, excision, and `\#` unescaping into `metadata-normalizer.ts`, adding `contexts` and `tags` to `NormalizedPropertyLocation` (and running `classify` on YAML frontmatter keys).

- _Payoff:_ Inline properties are immediately indexed, queryable, and hidden natively by Obsidian in Reading Mode/PDF even before Phase 6's Live Preview decorations exist.

---

## Phase 2: Codeblock Foundations, Render Budgets, & `| body` (`@core/templates`, `rhizome-codeblock.ts`)

**Low-risk upgrades to the existing engine that establish boundaries for everything after.**

1. Move `active` / `closed` `TabMode` onto the codeblock fence scanner (`template-blocks.ts`), removing trailing tab modes from `{% targetPath %}` (greenfield cleanup).
2. Add the 2-line `[data-rhizome-block]` DOM ancestor guard and the hover **Copy Markdown** button in `rhizome-codeblock.ts`, and remove the `headingLevel: 0` override on reactive `TemplateDirectory` previews in `codeblock-lifecycle.ts`.
3. Split `render-limits.ts` into `InteractiveRenderBudget` and `LongFormRenderBudget`, and record unshadowable `isReactive` on `TemplateTargetState`.
4. Implement the async Pass 2 **`| body` filter** (reusing Phase 1's Unified Scanner for frontmatter, fences, indented code, and `%%...%%` comments, plus reactive `rhizome`-fence stripping and the remaining exclusions).

---

## Phase 3: Non-Interactive One-Time Tags & PositionMarkers (`@core/templates`)

**Pure Pass 1 / Pass 2 template mechanics—100% testable in Vitest without UI modals.**

1. Expand `{% frontmatter %}` (`frontmatter-tag.ts`) to accept plain records (`note.properties`), `[k, v]` pairs, and `VaultQueryMatch` objects (`source === 'frontmatter'` only).
2. Upgrade `{% targetPath %}` (`target-path-tag.ts` & `template-target-state.ts`) with `if_missing`, `prepend`, and `append`, implementing whole-block `%% ◊prepend %%` / `%% ◊append %%` replacement (using Phase 1's scanner so markers inside fences/block-comments are ignored) and binding `this` from existing notes on edit.
3. Implement `{% cursor [<expr>] %}` recording body-relative UTF-16 anchor/head offsets on `TemplateTargetState`, and expose `{{activeNote}}` and `{{created}}` in template context.

---

## Phase 4: Interactive Input Engine & `CollectTemplateInputs` (`@core/templates`, `src/ui`)

**Introduces async user interaction behind clean port callbacks before touching multi-file/editor commits.**

1. Extend `walkTemplateTreePass1` (`template-engine.ts`) to reject `{% prompt %}` and `{% suggest %}` inside direct and indirect loops, and add modal wait-time pausing to `ctx.renderLimit` (`render-limits.ts`).
2. Implement `{{input}}` deep-path state (`untouched -> touched`, subtree overwrite clearing, type-compatibility skipping for `{% prompt %}`, and candidate-membership skipping for `{% suggest %}`) on `TemplateTargetState`, updating `scope-analyzer.ts` (`BUILTIN_RHIZOME_ROOT_GLOBALS`).
3. Build the Obsidian `PromptModal` (`text`, `multiline`, `number`, `checkbox`, `date`, `datetime`) and `SuggestModal` UI classes.
4. Wire the **`CollectTemplateInputs`** authoring command (`checkCallback`, `view.save()` flush, ephemeral in-memory snapshot keyed by `file.path`, prior-snapshot default seeding, and leaf-close cleanup).

---

## Phase 5: One-Time Trigger Orchestration & `TemplateMapping` (`src/adapters/template-runner.ts`, `src/settings.ts`)

**Order from simplest vault commit to trickiest Obsidian UI hook:**

1. **`NewNoteFromTemplate`:** Wire `CreateBlock` vs. concatenated `InsertBlock` execution under `LongFormRenderBudget`, `Vault.process()` commits for `prepend`/`append`, post-`processFrontMatter` `{% cursor %}` selection placement, and `TemplateMapping` in `settings.ts` (+ the explicit-picker companion command).
2. **`InsertTemplateAtSelections`:** Add `{{selections}}` / `{{selection}}` and lazy `{{clipboard}}`, implement the sorted per-`Selection` loop (`"Frodo"` / `"Bilbo"`), single-Undo CM6 `changeByRange` replacement, `ActiveNote` frontmatter merge + YAML offset adjustment, and `TemplatePicker` eligibility filtering.
3. **`NewNoteFromUnresolvedLink` (last among triggers):** Isolate link-activation interception (Live Preview, Reading View, Mobile tap, and `editor-menu` command) into its own self-contained adapter once the template runner and `TemplateMapping` underneath it are completely stable.

---

## Phase 6: Inline Property Live Preview UX, Linter, Typing Aid, & Sidebar (`src/adapters/codemirror`, `src/ui`)

**Can be built last—or in parallel anytime after Phase 1—because nothing else depends on it.**

1. CM6 `inputHandler` typing aids (`%%.` / `%%!` closer pairing and `%%~^::%%%%%%` + `Tab` jump) and `@codemirror/lint` diagnostics (unclosed block-comment line-count warnings, `"no :: found"`, `text-after-header`).
2. CM6 `StateField` Live Preview decorations for `~`, `.` (interpunct widget + hover preview tooltip), `bare`, and the opt-in single-line plain-comment collapse toggle.
3. Collapsed `!` `atomicRanges` + single-caret-stop / bare-Backspace transaction filters and IME `compositionstart`/`compositionend` freeze.
4. Read-only Inline Properties Sidebar view with caret-line highlight and scroll-along.
