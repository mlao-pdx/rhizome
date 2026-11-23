# `rhizome-sample` Codeblock & Unified Explain Workbench — Design Specification

## 1. Motivation & Goals

As Rhizome's query language (graph traversal arrows `->` / `<-`, hop quantifiers, `{ ... }` subqueries, `@query.<name>` wave dependencies) and template language (`| lookup`, `| link_paths`, `| group_by`, `| tree`, `| table`, `{% layout %}`, `{% render %}`, `{% targetPath %}`, `{% frontmatter %}`) grow more expressive, an inline `{% query <name> explain %}` modifier is no longer the right diagnostic primitive:

1. **Inline `explain` mutates template output:** Emitting an explain plan directly into the template stream at the `{% query %}` declaration site breaks surrounding layouts, tables, and partials.
2. **Markdown footnote collisions & callout fragility:** Multiple `explain` outputs emit colliding `[^1]` definitions, and Markdown footnotes do not render reliably across Obsidian blockquote callout boundaries.
3. **Blindness at the Query–Template seam:** Users most frequently get lost _between_ queries (`@query.<name>` waves), across **virtual `@this` mutations & lazy Pass-2 `@this` queries** when authoring templates inside `templatesFolder`, and _inside_ Liquid pipelines (`| lookup`, `| where`, `{% frontmatter %}` selectors, `{% render %}` scope isolation)—places a single-query static explain cannot see.
4. **Heavy-render fear while authoring:** Iterating on a codeblock in a large vault risks triggering massive Liquid renders, Chromium table layout stalls, or 200 KB PrismJS syntax-highlighting hangs.

### Solution Overview

Replace the per-query `explain` tag option with a dedicated second fenced codeblock flavor: **`rhizome-sample`**.

Across Rhizome's three execution surfaces (`◊.trigger: 'dynamicCodeblock' | 'newNote' | 'atCursor'`):

- **` ```rhizome ` (`dynamicCodeblock` & `templatesFolder` live preview)** — Production rendering mode. Executes full queries (subject to `cutoff:`), renders the template output directly (using non-mutating `newNote` simulation when mounted inside `templatesFolder`), and surfaces compact `[!danger]` callouts only on compile/render errors (plus `[!warning]-` on runtime `cutoff` truncation).
- **` ```rhizome-sample ` (Live authoring & diagnostic workbench)** — Evaluates the full query DAG in memory (including hybrid Pass-1.5 static + Pass-2 lazy `@this` queries when authoring inside `templatesFolder`), renders the template against a deterministic, referentially-aware sample (`100` base records, up to `500` with referential-integrity top-up), and presents:
  1. An isolated, collapsible **Sample Preview** of the rendered Markdown (plus a **Simulated Note Banner** for `targetPath`, `tabMode`, and staged `frontmatter` when inside `templatesFolder`),
  2. A collapsible **Generated Markdown Source** inspector (synthesizing leading `--- ... ---` YAML frontmatter when `hasFrontmatterMutations` is active in `templatesFolder`, with plain text / bounded highlighting),
  3. Per-query **Query Explain Plan** callouts ordered by Pass-1.5 execution wave followed by Pass-2 lazy `@this` queries,
  4. A static English **Template Explain Plan** callout (with inside-out layout resolution, isolated partial scope boxes, `{% targetPath %}` / `{% frontmatter %}` state semantics, and `Emitter`-measured extrapolated size badges), and
  5. A context-filtered **Concepts Reference** callout at the bottom.
- **Run-once template commands (`newNote` via _Create note from template_ & `atCursor` via _Insert from template_)** — Discover and execute both ` ```rhizome ` and ` ```rhizome-sample ` top-level blocks inside `templatesFolder` identically as full, unsampled production renders with zero workbench chrome, so template authors can leave template notes in `rhizome-sample` mode permanently while running them directly.

---

## 2. Retirements, Pass-2 `{% query %}` Role & Mode-Specific Error Handling

Because Rhizome is pre-release with no legacy installed base:

1. **Remove `explain` from `{% query %}` while Preserving Pass-2 Lazy Evaluation:**
   - Remove the `explain` keyword option from `parseQueryTagArgs` and `ExtractedQueryBlock`, and remove inline `env.explainQuery(...)` emission from `QueryBlockTag.render()`.
   - `{% query <name> [cutoff: <int>] %} ... {% endquery %}` emits **zero characters to `emitter`** during Pass 2, while **preserving** `QueryBlockTag.render(ctx)`'s Pass-2 lazy query execution hook (`env.lazyQueryNames` / `env.runLazyQuery` updating `env.payload` and `state.rootRecord['query']` against `TemplateTargetState.virtualDoc` in `newNote` mode).
   - If a user writes `{% query tasks explain %}`, `parseQueryTagArgs` rejects `explain` (`INVALID_QUERY_TAG_ARGS`) with an actionable hint directing them to switch the codeblock fence to ` ```rhizome-sample `.
   - Update `docs/language-principles.md` §15 ("Explain Yourself") during implementation to reference ` ```rhizome-sample ` instead of `{% query name explain %}`.
2. **Unified Query & Template Error Contract across All Four Modes:**
   - Previously, `maskQueryBlockBodies` blanked query interiors during Pass 1 and `QueryBlockTag.render()` fell back to writing `env.explainQuery(...)` inline when `!hasPayloadKey` while `renderParsedRhizomeTemplate` returned `ok: true`.
   - Instead, in production modes, any query compilation failure (Pass-1.5 static or Pass-2 lazy) short-circuits rendering with `TemplateRenderResult.ok = false` (no partial Pass-2 body output), structured `TemplateDiagnostic` items mapped to `ExtractedQueryBlock.bodySpan` and `file`, and concise `[!danger] Query Error` callouts in `res.markdown` (matching `formatTemplateDiagnosticsMarkdown` with 1-based line/column, source file provenance, `‼️...‼️` caret snippets, and fix hints):
     - **`dynamicCodeblock` (` ```rhizome `):** Renders `res.markdown` (`[!danger]` template or query error callouts).
     - **`newNote` (`executeCreateNoteFromTemplate`):** All-or-nothing preflight—any `!res.ok` (template syntax/render error or query compile error) aborts with **zero** vault file or folder writes and opens `TemplateErrorModal` with a 1-click **Open template** jump.
     - **`atCursor` (`executeInsertFromTemplate`):** Removes `TemplateErrorModal` (`src/adapters/template-runner.ts`); always collects `res.markdown` across blocks (including `[!danger]` template or query error callouts, matching `dynamicCodeblock` display) and inserts the `\n\n`-joined Markdown via a single idiomatic `editor.replaceSelection(joinedMarkdown)` call so one Undo (`Cmd+Z` / `Ctrl+Z`) reverts the entire insertion.
     - **`rhizome-sample` workbench:** Does **not** short-circuit Pass 2 on query compile errors; binds failed queries to `[]` so healthy queries and the template body still render in Sample Preview while surfacing `[!danger]+ Query '<name>' — <N> error(s) (Not executable)` in the Explain Callout Stack.
3. **Remove Markdown Footnotes (`[^N]`) from Explain Output:**
   - Retire `FootnoteRegistry` inline `[^N]` markers and definitions from explain plans.
   - Surface type/interval/timezone metadata inline where concise, and collect non-trivial concept explanations into the single deduplicated **Concepts Reference** callout at the bottom of `rhizome-sample`.
4. **Reshape `explainQuery` for Internal Workbench Use:**
   - Refactor `explainQuery` / `explainVaultQuery` as needed to return structured sections + referenced concept keys (or callout-ready Markdown) without external console-testing constraints.

---

## 3. Shared Fence Scanner, Runner Parity, Caching & Crash Quarantine

### 3.1 Shared Top-Level Fence Scanner, Editor & Runner Parity

- Update `RHIZOME_INFO_RE` in `src/core/templates/template-blocks.ts` from `/^rhizome(?:\s|$)/i` to `/^rhizome(?:-sample)?(?:\s|$)/i`, and expose `flavor: 'rhizome' | 'rhizome-sample'` on `FenceScanState`, `TopLevelRhizomeBlock`, and `FencedRhizomeBlock` (`src/adapters/codemirror/rhizome-code-blocks.ts`).
- `findRhizomeCodeBlocks` (CodeMirror 6), `discoverExecutableTemplates` (`TemplatePickerModal`), and `prepareTemplateSession` (`template-runner.ts`) all recognize both `rhizome` and `rhizome-sample` fences:
  - In the editor, `rhizome-sample` receives 100% verbatim CM6 syntax highlighting, `@codemirror/lint` squiggles, and hover diagnostic tooltips.
  - During run-once `newNote` (`executeCreateNoteFromTemplate`) and `atCursor` (`executeInsertFromTemplate`) execution, `rhizome-sample` blocks inside `templatesFolder` execute as full, unsampled production `rhizome` blocks without workbench UI.

### 3.2 Flavor-Scoped Caching, `isTemplatePreview` & Crash Quarantine (`RenderSentinelStore`)

- Register `rhizome-sample` via `this.registerMarkdownCodeBlockProcessor('rhizome-sample', ...)`.
- **Simulated `newNote` Preview inside `templatesFolder` (`isTemplatePreview`):**
  - When a `rhizome-sample` codeblock is mounted in a note inside `templatesFolder` (`isTemplatePreview = isPathInTemplatesFolder(sourcePath, folderConfig)`—specifically `templatesFolder`, distinct from `isPathInTemplateFolders` which covers `templatesFolder`, `partialsFolder`, and `layoutsFolder` for index exclusion), it constructs the non-mutating `newNote` preview runtime context (`buildNewNotePreviewRuntimeContext`: `trigger: 'newNote'`, `template` metadata snapshot with `template.folders.*`, and a fresh per-block `TargetPathClaimRegistry` seeded against on-disk vault files).
  - **Multi-block isolation boundary:** Each mounted `rhizome-sample` codeblock runs an independent `MarkdownPostProcessor` lifecycle with its own `TargetPathClaimRegistry` against existing vault files (cross-block unsaved claims only pair up during `executeCreateNoteFromTemplate`). Never introduce shared mutable global claim state across independent DOM mounts.
- **Caching & Crash Quarantine:**
  1. **`computeCodeBlockSentinelHash`** (`RenderSentinelStore`):
     - Include `flavor` (`'rhizome'` vs `'rhizome-sample'`) in the sentinel hash. `rhizome-sample` **neither bypasses nor relaxes** crash quarantine, `TEMPLATE_RENDER_LIMIT_MS` (`5,000 ms`), `TEMPLATE_MEMORY_LIMIT` (`32 MB`), or `MAX_TEMPLATE_OUTPUT_CHARS` (`3.25 MiB`). A pathological template loop such as `{% for i in (1..99999999) %}` is still caught and quarantined.
     - Because `flavor` is part of the hash, if a heavy ` ```rhizome ` block is quarantined due to 12,000 records stalling DOM layout, changing the fence to ` ```rhizome-sample ` hashes to a fresh identity—giving the block a safe new life on ~100 sampled records so the author can diagnose and fix it.
  2. **`CodeBlockRenderCache`**:
     - Outside `templatesFolder` (`!isTemplatePreview`), key Pass-2 render cache entries by `flavor` so switching between `rhizome` and `rhizome-sample` (or mounting both in the same note) never cross-pollutes cached renders. (Pass-1 AST cache remains shared since template/query parsing is identical.)
     - Inside `templatesFolder` (`isTemplatePreview`), **bypass `CodeBlockRenderCache`** (matching `rhizome`) because live `template.folders.*` rung resolution and on-disk collision checks depend on live workspace/vault directory state.

---

## 4. Deterministic Referentially-Aware Sampling (`100` Base, `500` Ceiling)

### 4.1 Unsampled In-Memory Evaluation & Hybrid Static + Lazy Partitioning

1. **Standard Single-Stage Flow (`trigger: 'dynamicCodeblock'`):**
   - Execute `runVaultQuery` **unsampled** across all topological DAG waves in Pass 1.5 against `NormalizedDocumentCache` and `VaultGraphSnapshot`, recording full matched document paths in `uncutQueryPaths`, exact match counts (`YYYY` in `sampled XXX of YYYY`), and complete vault property coercion diagnostics before applying two-phase RI sampling (§4.3).
2. **Hybrid Static + Lazy Pass-2 Flow (`trigger: 'newNote'` in `isTemplatePreview`):**
   - `partitionNewNoteQueries` splits extracted queries into Pass-1.5 `staticQueries` (no direct `@this` or transitive `@query.<lazy>` dependency) and Pass-2 `lazyQueryNames` (depends on `@this` or transitively on another lazy query), pre-seeding `query.<lazyName> = Object.freeze([])` before Pass 2.
   - **Stage A — Pass-1.5 `staticQueries`:** Execute `staticQueries` unsampled; store full pre-cutoff matched paths in `uncutQueryPaths` (`extractMatchedDocumentPaths`, preserving exact `@query.<name>` wave inputs for downstream lazy queries); run Phase-1 stride (`<= 100`) and Phase-2 RI top-up (`<= 500`) across `staticQueries`, retaining `LinkedPaths` seeded from their `Base_i` sets.
   - **Stage B — Pass-2 `lazyQueryNames` (`QueryBlockTag.render`):** As Liquid control flow reaches each lazy `@this` query (after preceding `{% targetPath %}` / `{% frontmatter %}` mutations have updated `state.virtualDoc`), execute it unsampled against current `state.virtualDoc` and `uncutQueryPaths` (`priorQueryPaths`); record its full matched paths in `uncutQueryPaths`, capture its full match count `M`, coercion diagnostics, and active virtual `@this` snapshot; then apply `effectiveCutoff` vs. Phase-1 stride (`<= 100`) + Phase-2 RI top-up (`<= 500` against `LinkedPaths`, contributing `Base_lazy`'s links to `LinkedPaths` for any subsequent lazy queries) before binding `state.rootRecord['query'][name]`.

### 4.2 Effective Limit Precedence (`cutoff` vs. Sample)

- For each static or lazy query `Q` with full match count `M` and configured `cutoff` (`DEFAULT_QUERY_CUTOFF = 5_000`, or explicit `cutoff: C`, where `0` means unlimited):
  - Let `effectiveCutoff = cutoff > 0 ? cutoff : Infinity`.
  - **Smallest limit wins** (identical precedence for Pass-1.5 `calloutsMarkdown` and Pass-2 `env.lazyCutoffCallouts`):
    - If `effectiveCutoff <= sampleTarget` (e.g., user explicitly wrote `cutoff: 25` or `cutoff: 80` and `M > effectiveCutoff`), truncate at `effectiveCutoff` in vault order and **emit the standard runtime cutoff `[!warning]-` callout** inside the Sample Preview (since `cutoff:` is the active binding constraint).
    - Otherwise, sampling governs (`rhizome-sample` mode): **suppress** the runtime `cutoff` banner inside the Sample Preview (including `env.lazyCutoffCallouts`), **but** flag in the Query & Template Explain Plans if `M > effectiveCutoff` so the user knows `rhizome` / `newNote` / `atCursor` will hit the cutoff in production.

### 4.3 Two-Phase Data-Driven Referential Integrity (RI) Sampling

Sampling focuses strictly on **vault data relationships** (links, embeds, backlinks), never on query AST topology or Liquid template predicates:

- **Constants:**
  - `BASE_SAMPLE_SIZE = 100`
  - `MAX_SAMPLE_SIZE = 500` (allowing up to `400` RI top-up records per query)

- **Phase 1 — Deterministic Base Stride Sample (`<= 100`):**
  - For every query `Q_i` with full matched list `Full_i` (already in deterministic vault / `file.path` order):
    - If `Full_i.length <= effectiveSampleCap` (where `effectiveSampleCap = min(BASE_SAMPLE_SIZE, effectiveCutoff)`):
      `Base_i = Full_i` (exact; not downsampled).
    - Else: pick `N = effectiveSampleCap` evenly spaced indices across `Full_i`:
      `idx(k) = Math.floor(((k + 0.5) * Full_i.length) / N)` for `k = 0 .. N - 1`.
  - Properties: 100% deterministic (stable across `ActiveQueryRoster` nudges; zero `Math.random()` jitter), O(N), spans folders across the entire vault (~1% stride), and naturally preserves base-rate proportions (e.g., if 50% of matched tasks have links and 50% are orphans, ~50 of the 100 sampled tasks have links and ~50 are orphans).

- **Phase 2 — Static Link Pool & RI Top-Up (`<= 500`):**
  1. Collect `LinkedPaths: Set<string>` from the `Base_i` sets (single static snapshot across all Pass-1.5 `staticQueries` without cascading from augmented sets, keeping static waves order-independent; in `isTemplatePreview`, each reached Pass-2 lazy query checks `LinkedPaths` and contributes `Base_lazy`'s links for later lazy queries):
     - Every non-empty `link.resolvedPath` in `doc.links`
     - Every non-empty `embed.resolvedPath` in `doc.embeds`
     - Every `backlink.file.path` in `doc.backlinks`
  2. For each downsampled query `Q_i` (`Full_i.length > Base_i.length`) whose `effectiveCutoff > Base_i.length`:
     - Let `remainingCapacity = min(MAX_SAMPLE_SIZE, effectiveCutoff) - Base_i.length` (up to `400`).
     - Scan `Full_i` in vault order to build `RI_i`: all records `doc` in `Full_i` where `doc.file.path` is in `LinkedPaths` **and** `doc` is not already in `Base_i`.
     - If `RI_i.length <= remainingCapacity`, add all of `RI_i` to `Sample_i`.
     - Else, deterministic-stride sample `remainingCapacity` records from `RI_i` and add them to `Sample_i`.
     - **Re-sort `Sample_i` back into original `Full_i` vault order** so downstream Liquid rendering sees an unadulterated vault-ordered array.

- **Non-Goal (No Template-Predicate Cherry-Picking):**
  - Do **not** inspect Liquid `{% if %}` / `| where` expressions to cherry-pick matching records into the sample. Doing so would mask _Select vs. Shape_ anti-patterns (filtering 10,000 records in Liquid instead of `{% query %}`).

---

## 5. Workbench DOM Architecture & Visual Hierarchy

To prevent user template output (unclosed code fences, broken HTML tables, headings, blockquotes) from corrupting the explain UI—and because headings inside child `MarkdownRenderer.render()` calls do not get Obsidian's page-level fold chevrons—`rhizome-sample` constructs isolated DOM containers inside `el`:

```text
el (.rhizome-sample-workbench)
├── 1. <details open class="rhizome-sample-section rhizome-sample-preview">
│      ├── <summary> Sample Preview · <lines> lines · <size> </summary>
│      ├── <div class="rhizome-sample-note-banner">   [only when isTemplatePreview === true]
│      │     (Compact Simulated Note Banner: resolved `targetPath` with collision suffix,
│      │      `tabMode` badge [`active` | `background` | `closed`], and staged `frontmatter`
│      │      property summary when `hasFrontmatterMutations` is true; keeps Sample Preview
│      │      mounted even when `result.markdown` is empty [`0 lines · 0 B` body])
│      │   </div>
│      └── <div class="rhizome-sample-rendered">
│            (Isolated MarkdownRenderer.render() with its own MarkdownRenderChild;
│             renders exact, unwrapped template body output identical to `rhizome`)
│          </div>
│
├── 2. <details class="rhizome-sample-section rhizome-sample-source">   [closed by default]
│      ├── <summary> Generated Markdown Source · <lines> lines · <size>  [Copy] </summary>
│      └── <pre class="rhizome-sample-raw"><code>...</code></pre>
│            (When `isTemplatePreview && result.hasFrontmatterMutations` is true, prepends
│             synthesized `---\n<stringifyYaml(result.frontmatter)>---\n` via Obsidian's
│             built-in `stringifyYaml` above `result.markdown` — after verifying serialized
│             frontmatter + Markdown stays within `MAX_TEMPLATE_OUTPUT_CHARS` — so both
│             inspection and `[Copy]` reflect the full generated note; remains mounted when
│             `result.markdown === ''` if `isTemplatePreview` has metadata. Plain textContent
│             by default — or Markdown syntax-highlighted only when the combined YAML +
│             Markdown string is below safe char/line thresholds — so PrismJS can never hang
│             the session)
│
└── 3. <div class="rhizome-sample-explains">
         (Separate MarkdownRenderer.render() hosting the Explain Callout Stack:)
         ├── Query Explain Callouts (Pass-1.5 waves first, then Pass-2 lazy `@this` queries)
         ├── Template Explain Plan Callout (single unified callout)
         └── Concepts Reference Callout (single deduplicated callout, when non-empty)
```

### 5.1 Callout Severity & Default Fold State Rules

Only **errors (`[!danger]+`)** start expanded. Healthy (`[!check]-`), warning (`[!warning]-`), and reference (`[!info]-`) callouts start **collapsed** with crisp, high-signal summary titles:

| Section                | Condition                                                                                                         | Callout Header & Fold State                                                                                         |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| **Sample Preview**     | Valid template render (including `0 B` body when `isTemplatePreview` is active)                                   | `<details open>` (expanded; omitted or replaced if Pass 1 template syntax failed)                                   |
| **Generated Source**   | Valid template render (including YAML-only or `0 B` body in `isTemplatePreview`)                                  | `<details>` (collapsed by default; line/byte metrics reflect combined synthesized YAML + Markdown body when staged) |
| **Query Explain**      | Compile / DAG cycle / unknown `@query` error                                                                      | `> [!danger]+ Query \`<name>\` — <N> error(s) (Not executable)`                                                     |
| **Query Explain**      | Pass-2 lazy `@this` query inside an untaken `{% if %}` / `{% unless %}` / `{% case %}` branch                     | `> [!info]- Query \`<name>\` — Skipped (branch not entered in sample)`                                              |
| **Query Explain**      | Executed query with `0` matched records                                                                           | `> [!warning]- Query \`<name>\` — 0 records matched`                                                                |
| **Query Explain**      | Exceeds `cutoff`, has query lint warnings, or has vault property coercion warnings                                | `> [!warning]- Query \`<name>\` — sampled <S> of <M> records · exceeds <C> cutoff` _(or relevant warning summary)_  |
| **Query Explain**      | Healthy (`> 0` matches, within cutoff, 0 warnings)                                                                | `> [!check]- Query \`<name>\` — <all M \| sampled S of M> records`                                                  |
| **Template Explain**   | Pass 1 syntax error or Pass 2 runtime error (e.g., `INVALID_TARGET_PATH`, runtime `INVALID_FRONTMATTER_TAG_ARGS`) | `> [!danger]+ Template Explain Plan — <Syntax \| Runtime> error`                                                    |
| **Template Explain**   | Sample or extrapolated `rhizome` output crosses standby/sentinel/limit thresholds, or static/mode warnings exist  | `> [!warning]- Template Explain Plan — <summary & extrapolated size / mode warning>`                                |
| **Template Explain**   | Healthy & within normal render thresholds                                                                         | `> [!check]- Template Explain Plan — <lines> lines, <size> ([~<extrapolated>] est. full)`                           |
| **Concepts Reference** | `>= 1` non-trivial concepts used                                                                                  | `> [!info]- Concepts Reference (<N> topics)`                                                                        |

---

## 6. Query Explain Plan Contents

Rendered one callout per `{% query %}` in **execution stage & wave order**—blocked/cyclic queries first (so `[!danger]+` errors sit directly beneath the preview), followed by Pass-1.5 static DAG waves (`Pass 1.5 · Wave 1`, `Pass 1.5 · Wave 2`), followed by Pass-2 lazy queries (`Pass 2 Lazy — depends on virtual @this` / `@query.<lazy>`):

1. **Header Metadata:**
   - Provenance: inline line number in root codeblock, or clickable `[[Partial/path.md]]` + line number when declared inside a layout/partial.
   - Execution Stage & Wave: `Pass 1.5 · Wave <W>` (with `@query.<name>` dependencies) or `Pass 2 Lazy — depends on virtual @this` (and any upstream `@query.<name>` dependencies).
   - **Virtual `@this` Snapshot (executed Pass-2 lazy queries):** Displays the active virtual `@this` state captured at `QueryBlockTag.render(ctx)` time—resolved `this.file.path` (and derived `this.file.*` fields from `{% targetPath %}`) alongside all non-empty frontmatter-derived fields re-normalized by preceding `{% frontmatter %}` tags (`this.properties`, `this.tags`, `this.aliases`, `this.cssclasses`, and frontmatter wikilinks in `this.links`).
   - **Untaken Conditional Lazy Queries:** If a Pass-2 lazy query inside `{% if %}` / `{% unless %}` / `{% case %}` was never reached during Pass 2 (`query.<name>` remains pre-seeded as `[]`), render `> [!info]- Query '<name>' — Skipped (branch not entered in sample)` with its static AST breakdown rather than `[!warning]- 0 records matched`.
   - Record counts: `Matched <M> records` (and if sampled: `Sampled <S> records (<B> stride + <R> referential top-up)`).
   - Cutoff status: active `cutoff` (`5,000` default, explicit `N`, or `Unlimited`) + explicit warning if `M > cutoff` under production execution.
   - Active `@now`, `@today` half-open window, and IANA timezone.
2. **Logic Breakdown:**
   - Progressive-shrinking plain-English AST explanation (without `[^N]` footnote clutter), including resolved `@this` values (host or virtual `@this` snapshot) and `@query.<name>` wave projections.
3. **Compile, Index-Exclusion & Vault Data Diagnostics:**
   - Query syntax/validation/lint diagnostics with caret snippets (`‼️...‼️`) and fix hints.
   - **Template-Folder Index Exclusion Hint:** Notes inside `templatesFolder`, `partialsFolder`, and `layoutsFolder` are excluded from vault indexing and query results (`isPathInTemplateFolders`); emit an actionable hint whenever a query's path filter targets one of those excluded folders.
   - **Queried Property Coercion Diagnostics** (from `QueriedPropertyDiagnosticsAggregator`): surfaces vault notes where a property referenced by this query failed `number`/`date`/`datetime`/`checkbox` coercion (Principle #7 & #15), capped cleanly if numerous.

---

## 7. Template Explain Plan Design

### 7.1 Core Principle: Static English Explanation, Not Code Regurgitation or Loop Unrolling

The Template Explain Plan walks the **Pass-1 LiquidJS AST** across the root codeblock, layouts, and partials to explain _what the code actually means and does_ in plain English **without executing/unrolling runtime iterations**:

- **Header Summary & Extrapolation:**
  - Parse ms, Query ms (Pass 1.5 + Pass 2 lazy), Liquid render ms, DOM render ms.
  - Execution context: `◊.trigger` (`dynamicCodeblock` vs. simulated `newNote`), host/virtual `@this` path, detected host heading offset `H0`–`H6` for `{% heading %}`, and pinned `@now` & timezone.
  - When `isTemplatePreview` is active (`templatesFolder`): resolved `template.folders.{notebookNavigator, obsidianFiles, activeNote, default}` ladder, active `newNoteDefaultFolderRung` setting, and final `targetPath`, `tabMode`, and staged `frontmatter` summary.
  - Measured sample body output (`lines`, `size`, plus staged YAML frontmatter size when `hasFrontmatterMutations` is true) and **plain linear extrapolation** to the post-cutoff `rhizome` record count (and uncapped count if `M > cutoff`), guarded by loop/collection-emission presence so static header-only templates are not falsely multiplied.
  - Explicit warning if measured sample output (combined staged YAML + Markdown body, even with `0` query records, e.g., `(1..50000)`) or extrapolated full output will trigger Rhizome's `"Please stand-by"` callouts, crash-sentinel tracking, or hard 3.25 MiB / 32 MB / 5,000 ms limits.

- **Query Placement & Loop/Conditional Rules:**
  - **Loops (`QUERY_IN_LOOP_ERROR`):** Pass 1 (`validateQueriesNotInLoop`) rejects **all** `{% query %}` blocks inside direct loops (`{% for %}`, `{% tablerow %}`, `{% render '...' for ... %}`), and rejects **lazy `@this` queries** inside indirect loop partials (a loop calling a non-`for` `{% render 'sub' %}`), surfacing a `[!danger]+` Pass-1 error.
  - **Static Pass-1.5 Queries:** Each static `{% query <name> %}` node renders as a one-line pointer:
    `Query definition: <name> (evaluated in Pass 1.5, Wave <W> — see Query '<name>' above).`
    If placed inside a conditional (`{% if %}` / `{% unless %}` / `{% case %}`) or inside an indirect non-`for` partial invoked from a loop, emit a `[!warning]-` note that static queries are extracted in Pass 1 and execute once unconditionally in Pass 1.5.
  - **Lazy Pass-2 `@this` Queries (`newNote` mode):** Render as:
    `Query definition: <name> (evaluated lazily in Pass 2 against current virtual @this — see Query '<name>' above).`
    Explain that lazy queries inside conditionals evaluate **conditionally** only if control flow enters the branch (remaining pre-seeded `[]` when skipped).

- **Target-State Tags & File Property Aliases:**
  - **`{% targetPath <expr> [active | closed] %}`** (`INVALID_TARGET_PATH_ARGS` in Pass 1; `INVALID_TARGET_PATH` in Pass 2): Explain the path expression, post-creation `tabMode` (`background` default, `active`, or `closed`), collision-safe claiming (`TargetPathClaimPort`), and virtual `this.file.*` re-normalization—noting that file creation and virtual `this.file.*` updates apply exclusively in `newNote` mode (when a template is run via `atCursor`, `{% targetPath %}` only updates in-memory `{{ targetPath }}` while inserting the rendered body at the cursor). When used in `dynamicCodeblock` outside `templatesFolder`, emit a `[!warning]-` mode-mismatch warning noting that `{% targetPath %}` only updates in-memory `{{ targetPath }}` (no file is created or renamed, and `this` is unchanged).
  - **`{% frontmatter <selectors...> %}`** (`INVALID_FRONTMATTER_TAG_ARGS`): Explain each `<source> [| <filters>] [as <target>]` selector—including literal and temporal-offset sources (`'open' as status`, `true as published`, `today + 7d as due`, parsed with `{ allowLiterals: true, strict: true }` requiring explicit `as <target>` on literals), **last-executed-wins** `overwriteDeepTargetValue` semantics (contrasted with `| pick` / `| aggregate`'s array-merging `writeDeepTargetValue`), YAML-safe serialization (`serializeFrontmatterValue`), and virtual `this` (`this.properties`, `this.tags`, `this.aliases`, `this.cssclasses`, and frontmatter `this.links`) re-normalization—noting that frontmatter persistence and virtual `this` updates apply exclusively in `newNote` mode (when run via `atCursor`, `{% frontmatter %}` only updates in-memory `{{ frontmatter }}` without mutating the host note's frontmatter or `this`). When used in `dynamicCodeblock` outside `templatesFolder`, emit a `[!warning]-` mode-mismatch warning noting that `{% frontmatter %}` only updates in-memory `{{ frontmatter }}` and never mutates the host note's frontmatter.
  - **Non-Enumerable `NormalizedFileInfo` Aliases (`file.ext`, `file.ctime`, `file.mtime`):** Explain them as shorthand aliases for canonical `file.extension`, `file.created`, and `file.modified`, noting that because they are non-enumerable own properties, `| json` and `| table` serialize only canonical enumerable keys.

- **English Pipeline & Tag Semantics:**
  - Translate Rhizome filter pipelines (`where`, `reject`, `lookup`, `link_paths`, `sort_by`, `group_by`, `aggregate`, `pick`, `table`, `list`, `tree`, `heading`, temporal comparisons/formatting) into concise English describing data-shape transformations, key-matching rules, and missing/null attribute behavior.

### 7.2 Inside-Out `{% layout %}` Resolution

Layouts invert control flow relative to how source is written. To show what _actually_ happens:

- Resolve `{% layout %}` chains from the **outermost layout inward**.
- Inline each child `{% block <name> %}` override directly into the corresponding slot of the parent layout (marking whether each slot used the child override or the layout's default content).
- Flag any orphaned child nodes outside `{% block %}` tags that LiquidJS silently discards when a layout is active.
- Layouts are never deduplicated (a render chain has a single active layout spine).

### 7.3 `{% render %}` Isolated Scope Boxes, Shadowing & Complexity-Gated Fan-Out

Because Pass 1 enforces static filenames and an acyclic partial graph (DAG), partial calls are statically bounded:

1. **Inset Visual Scope Box & Shared `TemplateTargetState`:**
   - Expanded partials render inside a nested callout box (e.g., `> > [!abstract] Partial [[Partials/row.md]] (isolated scope)`) visually signaling scope isolation.
   - Header lists all passed bindings (`param ← callerExpr`, or `for <collection> as <ident>`) and notes that built-in root `globals` (`query`, `this`, `◊`, `template`, `targetPath`, `frontmatter`, `vault`, `tz`, `language`, `platform`, and relative temporal anchors) remain accessible while caller `{% assign %}` and `{% for %}` variables are isolated.
   - Document that `{% targetPath %}` and `{% frontmatter %}` inside an isolated partial still mutate the shared block-level `TemplateTargetState` (attached via `TEMPLATE_TARGET_STATE_SYMBOL` on `ctx.globals` and preserved across `ctx.spawn()`), while evaluating `<source>` selector expressions against the partial's isolated `ctx`.
2. **Static Variable & Mode Diagnostics:**
   - **Root `globals` Allowlist:** Include `'◊'`, `'template'`, `'targetPath'`, and `'frontmatter'` in the root `globals` allowlist so reading them inside a partial never triggers false Unbound Outer Variable warnings.
   - **Shadowing:** Highlight (_bold/italic_ + note) any bound partial parameter or inner `{% assign %}` / loop variable that shadows an outer caller variable, global query name, or root global (`template`, `targetPath`, `frontmatter`, etc.).
   - **Null `template` Warning in `dynamicCodeblock`:** Statically flag `template.*` reads when rendered in `dynamicCodeblock` outside `templatesFolder` (where `template` is `null`), explaining that `template` is populated in `newNote`, `atCursor`, and `templatesFolder` previews.
   - **Unbound Outer Variable Trap:** Statically detect free variables read inside the partial that are neither passed as `{% render %}` arguments, assigned locally, nor present in `globals`, _but do exist in the caller's lexical scope_—warning at the call site that the variable evaluates to `nil` due to scope isolation.
3. **Complexity-Gated Fan-Out & Runtime Error Pinpointing:**
   - Classify a partial as **Simple** if its AST contains no conditionals (`if`/`unless`/`case`), no loops (`for`/`tablerow`), and no nested `render` tags; otherwise classify it as **Complex**.
   - **1st static occurrence** of any partial: **Always expand** its inset scope box in full.
   - **2nd+ static occurrences:**
     - **Complex partials:** Expand in context at each call site (up to a generous safety ceiling such as `16` total expansions to guard against pathological diamond macros).
     - **Simple partials:** Emit a single compact reference line that **always** lists the clickable `[[Partials/name.md]]` link, **all inputs passed at that call site**, any `targetPath` / `frontmatter` mutations performed by the partial, any call-site-specific static scope/shadowing warnings, and its size badge.
     - **Runtime Error Override:** Track the active `{% render %}` call-site stack during Pass 2. If a Pass-2 runtime error is thrown inside a partial through a specific 2nd+ call site, **force-expand** that failing call site's inset box so the error snippet and the exact offending call-site inputs are shown together in place.

### 7.4 Zero-Mutation Size Extrapolation Badges (`[~1.2 KB]`) via `BoundedEmitter`

Instead of injecting and stripping `%%◊ id %%` comments in the Markdown string (which would corrupt `{% capture %}` string lengths and filter inputs):

1. **AST-Keyed `Emitter` Delta Measurement:**
   - Extend the `renderTemplates` hook in `src/core/templates/render-limits.ts` (selectively enabled during `rhizome-sample` Pass 2) to record `emitter.buffer.length` deltas (`after - before`) on `'root'` and `'layout'` emitters per AST `Template` node `(file, begin, end)`.
   - Zero string mutation, immune to skipped conditional branches, safe with `{% capture %}`, and naturally hierarchical across nested loops, partials, and output pipelines.
   - Zero-output state tags (`{% query %}`, `{% targetPath %}`, `{% frontmatter %}`) write `0` characters to `'root'` / `'layout'` emitters and **never** display `[~0 B]` badges. However, serialized `frontmatter` size (and combined `stringifyYaml(result.frontmatter)` + `result.markdown` length) **must** still be charged against `MAX_TEMPLATE_OUTPUT_CHARS` (`3.25 MiB`) during Pass-2 staging and before `stringifyYaml` synthesis—aborting with the template output-limit diagnostic on overflow while reporting staged YAML size alongside Markdown body metrics in `isTemplatePreview`.
2. **Extrapolation & Compact Formatting:**
   - For root/block-level loops and collection-emitting expressions (`{{ ... | table }}`, `| list`, `| tree`, `| json`), scale measured sample chars by the driving query's full-to-sample ratio `min(matched, effectiveCutoff) / sampled` (or `1` when unsampled) and append a terse inline size badge: **`[~1.2 KB]`**.
   - **Number format rule:** At most 3 digits before the decimal point and at most 1 digit after (`B` → `KB` → `MB` using `1024` steps matching `codeblock-callouts.ts`); step up to the next unit whenever the value reaches **`>= 500`** (e.g., `499 B`, `0.5 KB`, `12.4 KB`, `499.9 KB`, `0.5 MB`). No extra inline prose on the badge itself.

---

## 8. Context-Filtered Concepts Reference Callout

Placed at the very bottom (`> [!info]- Concepts Reference (<N> topics)`), collapsed by default, and **omitted entirely if 0 concept topics were triggered**:

- Only include explanations for **non-obvious or Rhizome-specific semantics actually used** in the codeblock's queries or templates—never paste basic Liquid/Markdown primers (e.g., omit standard `for`, `if`, string casing filters).
- **Candidate Concept Cards (included on demand, grouped to avoid repetition):**
  1. **Half-Open Temporal Intervals (`[start, end)`) & Timezone Anchoring** _(includes the Mermaid Gantt interval comparison diagram — emitted at most once across the entire codeblock)_ — triggered when date/datetime properties, temporal literals, or `@today`/`@now` comparisons appear in queries or templates.
  2. **Graph Traversal Arrows & Hop Quantifiers (`->`, `<-`, `->1..3`, `->*`)** — triggered by `SCOPE_GRAPH_FILTER` or `PROPERTY_GRAPH_FILTER`.
  3. **Cross-Query Wave References (`@query.<name>`)** — triggered when a query references `@query.<name>`.
  4. **Property Type Coercion & Missing/Chaos Values** — consolidated card covering Obsidian `types.json` coercion, multi-value existential matching, and missing/null attribute behavior across query and template comparisons.
  5. **Template Graph Joins (`| lookup` & `| link_paths`)** — triggered when `lookup` or `link_paths` is used, explaining canonical key matching and raw-wikilink vs. `resolvedPath` alignment.
  6. **Relative Heading Promotion (`{% heading %}` & `| heading`)** — triggered when heading tags/filters are used.
  7. **Partial Scope Isolation & Layout Slot Inheritance** — triggered when `{% render %}` or `{% layout %}` is used.
  8. **Template Modes, Virtual `this` & Lazy `@this` Queries (`◊.trigger`, `{% targetPath %}`, `{% frontmatter %}`)** — triggered when `{% targetPath %}`, `{% frontmatter %}`, `◊.trigger`, `template.*`, or `isTemplatePreview` (`isPathInTemplatesFolder`) is active; covers simulated `newNote` previews inside `templatesFolder`, `newNote`-only persistence & virtual `this` re-normalization vs. `atCursor` / `dynamicCodeblock` in-memory-only behavior, the `template.folders.*` graceful-degradation ladder, collision-safe path claiming, Pass-1.5 static vs. Pass-2 lazy `@this` query partitioning, and template-folder index exclusion (`isPathInTemplateFolders`).
