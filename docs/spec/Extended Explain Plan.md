# `rhizome-sample` Codeblock & Unified Explain Workbench — Design Specification

## 1. Motivation & Goals

As Rhizome's query language (graph traversal arrows `->` / `<-`, hop quantifiers, `{ ... }` subqueries, `@query.<name>` wave dependencies) and template language (`| lookup`, `| link_paths`, `| group_by`, `| tree`, `| table`, `{% layout %}`, `{% render %}`) grow more expressive, an inline `{% query <name> explain %}` modifier is no longer the right diagnostic primitive:

1. **Inline `explain` mutates template output:** Emitting an explain plan directly into the template stream at the `{% query %}` declaration site breaks surrounding layouts, tables, and partials.
2. **Markdown footnote collisions & callout fragility:** Multiple `explain` outputs emit colliding `[^1]` definitions, and Markdown footnotes do not render reliably across Obsidian blockquote callout boundaries.
3. **Blindness at the Query–Template seam:** Users most frequently get lost _between_ queries (`@query.<name>` waves) and _inside_ Liquid pipelines (`| lookup`, `| where`, `{% render %}` scope isolation)—places a single-query static explain cannot see.
4. **Heavy-render fear while authoring:** Iterating on a codeblock in a large vault risks triggering massive Liquid renders, Chromium table layout stalls, or 200 KB PrismJS syntax-highlighting hangs.

### Solution Overview

Replace the per-query `explain` tag option with a dedicated second fenced codeblock flavor: **`rhizome-sample`**.

- **` ```rhizome `** — Production rendering mode. Executes full queries (subject to `cutoff:`), renders the template output directly, and surfaces compact `[!danger]` callouts only on compile/render errors (plus `[!warning]-` on runtime `cutoff` truncation).
- **` ```rhizome-sample `** — Live authoring & diagnostic workbench. Evaluates the full query DAG in memory, renders the template against a deterministic, referentially-aware sample (`100` base records, up to `500` with referential-integrity top-up), and presents:
  1. An isolated, collapsible **Sample Preview** of the rendered Markdown,
  2. A collapsible **Generated Markdown Source** inspector (plain text / bounded highlighting),
  3. Per-query **Query Explain Plan** callouts ordered by execution wave,
  4. A static English **Template Explain Plan** callout (with inside-out layout resolution, isolated partial scope boxes, and `Emitter`-measured extrapolated size badges), and
  5. A context-filtered **Concepts Reference** callout at the bottom.

---

## 2. Retirements & Removals (Pre-Release Greenfield Cleanup)

Because Rhizome is pre-release with no legacy installed base:

1. **Remove `explain` from `{% query %}`:**
   - Remove the `explain` keyword option from `parseQueryTagArgs`, `ExtractedQueryBlock`, and `QueryBlockTag.render()`.
   - `{% query <name> [cutoff: <int>] %} ... {% endquery %}` becomes a pure Pass-1 declaration tag that emits **nothing** into the template output stream during Pass 2.
   - If a user writes `{% query tasks explain %}`, `parseQueryTagArgs` rejects `explain` with an actionable hint directing them to switch the codeblock fence to ` ```rhizome-sample `.
2. **Standardize Query Compile Errors in ` ```rhizome `:**
   - Previously, `QueryBlockTag.render()` fell back to `env.explainQuery(...)` inline when a query failed compilation (`!hasPayloadKey`).
   - Instead, when one or more queries fail compilation in ` ```rhizome `, format concise `[!danger] Query Error` callouts (matching `formatTemplateDiagnosticsMarkdown` with 1-based line/column, source file provenance, `‼️...‼️` caret snippets, and fix hints) rather than dumping a full explain plan and concept reference into the note.
3. **Remove Markdown Footnotes (`[^N]`) from Explain Output:**
   - Retire `FootnoteRegistry` inline `[^N]` markers and definitions from explain plans.
   - Surface type/interval/timezone metadata inline where concise, and collect non-trivial concept explanations into the single deduplicated **Concepts Reference** callout at the bottom of `rhizome-sample`.
4. **Reshape `explainQuery` for Internal Workbench Use:**
   - Refactor `explainQuery` / `explainVaultQuery` as needed to return structured sections + referenced concept keys (or callout-ready Markdown) without external console-testing constraints.

---

## 3. Editor, Cache & Crash-Sentinel Integration

### 3.1 CodeMirror 6 Highlighting & Linting Parity

- Update `findRhizomeCodeBlocks` (`src/adapters/codemirror/rhizome-code-blocks.ts`) from `/^rhizome(?:\s|$)/i` to `/^rhizome(?:-sample)?(?:\s|$)/i`.
- `rhizome-sample` receives 100% verbatim syntax highlighting, `@codemirror/lint` squiggles, and hover diagnostic tooltips while editing.

### 3.2 Flavor-Scoped Caching & Crash Quarantine (`RenderSentinelStore`)

- Register `rhizome-sample` via `this.registerMarkdownCodeBlockProcessor('rhizome-sample', ...)`.
- Include the codeblock flavor (`'rhizome'` vs `'rhizome-sample'`) in:
  1. **`computeCodeBlockSentinelHash`** (`RenderSentinelStore`):
     - `rhizome-sample` **neither bypasses nor relaxes** crash quarantine, `TEMPLATE_RENDER_LIMIT_MS` (`5,000 ms`), `TEMPLATE_MEMORY_LIMIT` (`32 MB`), or `MAX_TEMPLATE_OUTPUT_CHARS` (`3.25 MiB`). A pathological template loop such as `{% for i in (1..99999999) %}` is still caught and quarantined.
     - Because the flavor is part of the hash, if a heavy ` ```rhizome ` block is quarantined due to 12,000 records stalling DOM layout, changing the fence to ` ```rhizome-sample ` hashes to a fresh identity—giving the block a safe new life on ~100 sampled records so the author can diagnose and fix it.
  2. **`CodeBlockRenderCache`**:
     - Key Pass-2 render cache entries by codeblock flavor so switching between `rhizome` and `rhizome-sample` (or mounting both in the same note) never cross-pollutes cached renders. (Pass-1 AST cache may remain shared since template/query parsing is identical.)

---

## 4. Deterministic Referentially-Aware Sampling (`100` Base, `500` Ceiling)

### 4.1 Full In-Memory Query Evaluation First

1. Execute `runVaultQuery` **unsampled** across all topological DAG waves against `NormalizedDocumentCache` and `VaultGraphSnapshot`.
2. Why:
   - Preserves 100% exact `@query.<name>` semantics across multi-wave graph traversals (`->`, `<-`).
   - Captures exact full match counts (`YYYY` in `sampled XXX of YYYY`) and complete vault property coercion diagnostics across all matched notes.

### 4.2 Effective Limit Precedence (`cutoff` vs. Sample)

- For each query `Q` with full match count `M` and configured `cutoff` (`DEFAULT_QUERY_CUTOFF = 5_000`, or explicit `cutoff: C`, where `0` means unlimited):
  - Let `effectiveCutoff = cutoff > 0 ? cutoff : Infinity`.
  - **Smallest limit wins:**
    - If `effectiveCutoff <= sampleTarget` (e.g., user explicitly wrote `cutoff: 25` or `cutoff: 80` and `M > effectiveCutoff`), truncate at `effectiveCutoff` in vault order and **emit the standard runtime cutoff `[!warning]-` callout** inside the preview (since `cutoff:` is the active binding constraint).
    - Otherwise, sampling governs (`rhizome-sample` mode): **suppress** the runtime `cutoff` banner inside the Sample Preview (since sampling is already explicit everywhere in `rhizome-sample`), **but** flag in the Query & Template Explain Plans if `M > effectiveCutoff` so the user knows `rhizome` will hit the cutoff in production.

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
  1. Collect a **single static snapshot set** `LinkedPaths: Set<string>` across the `Base_i` sets of **all** queries in the codeblock (do _not_ cascade from augmented sets, keeping the algorithm order-independent across query declarations):
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
│      └── <div class="rhizome-sample-rendered">
│            (Isolated MarkdownRenderer.render() with its own MarkdownRenderChild;
│             renders exact, unwrapped template output identical to `rhizome`)
│          </div>
│
├── 2. <details class="rhizome-sample-section rhizome-sample-source">   [closed by default]
│      ├── <summary> Generated Markdown Source · <lines> lines · <size>  [Copy] </summary>
│      └── <pre class="rhizome-sample-raw"><code>...</code></pre>
│            (Plain textContent by default — or Markdown syntax-highlighted only when
│             below safe char/line thresholds — so PrismJS can never hang the session;
│             exposes raw `|` table pipes, indentation, and blank lines)
│
└── 3. <div class="rhizome-sample-explains">
         (Separate MarkdownRenderer.render() hosting the Explain Callout Stack:)
         ├── Query Explain Callouts (one per query, in topological DAG wave order)
         ├── Template Explain Plan Callout (single unified callout)
         └── Concepts Reference Callout (single deduplicated callout, when non-empty)
```

### 5.1 Callout Severity & Default Fold State Rules

Only **errors (`[!danger]+`)** start expanded. Healthy (`[!check]-`), warning (`[!warning]-`), and reference (`[!info]-`) callouts start **collapsed** with crisp, high-signal summary titles:

| Section                | Condition                                                                                                         | Callout Header & Fold State                                                                                        |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| **Sample Preview**     | Valid template render                                                                                             | `<details open>` (expanded; omitted or replaced if Pass 1 template syntax failed)                                  |
| **Generated Source**   | Valid template render                                                                                             | `<details>` (collapsed by default)                                                                                 |
| **Query Explain**      | Compile / DAG cycle / unknown `@query` error                                                                      | `> [!danger]+ Query \`<name>\` — <N> error(s) (Not executable)`                                                    |
| **Query Explain**      | `0` matched records                                                                                               | `> [!warning]- Query \`<name>\` — 0 records matched`                                                               |
| **Query Explain**      | Exceeds `cutoff`, has query lint warnings, or has vault property coercion warnings                                | `> [!warning]- Query \`<name>\` — sampled <S> of <M> records · exceeds <C> cutoff` _(or relevant warning summary)_ |
| **Query Explain**      | Healthy (`> 0` matches, within cutoff, 0 warnings)                                                                | `> [!check]- Query \`<name>\` — <all M \| sampled S of M> records`                                                 |
| **Template Explain**   | Pass 1 syntax error or Pass 2 runtime error                                                                       | `> [!danger]+ Template Explain Plan — <Syntax \| Runtime> error`                                                   |
| **Template Explain**   | Sample or extrapolated `rhizome` output crosses standby/sentinel/limit thresholds, or static scope warnings exist | `> [!warning]- Template Explain Plan — <summary & extrapolated size warning>`                                      |
| **Template Explain**   | Healthy & within normal render thresholds                                                                         | `> [!check]- Template Explain Plan — <lines> lines, <size> ([~<extrapolated>] est. full)`                          |
| **Concepts Reference** | `>= 1` non-trivial concepts used                                                                                  | `> [!info]- Concepts Reference (<N> topics)`                                                                       |

---

## 6. Query Explain Plan Contents

Rendered one callout per `{% query %}` in **DAG Wave execution order** (Wave 1, Wave 2, ...; blocked/cyclic queries listed first so `[!danger]+` errors sit right under the preview):

1. **Header Metadata:**
   - Provenance: inline line number in root codeblock, or clickable `[[Partial/path.md]]` + line number when declared inside a layout/partial.
   - Execution Wave (`Wave 1`, `Wave 2 — depends on @query.projects`).
   - Record counts: `Matched <M> records` (and if sampled: `Sampled <S> records (<B> stride + <R> referential top-up)`).
   - Cutoff status: active `cutoff` (`5,000` default, explicit `N`, or `Unlimited`) + explicit warning if `M > cutoff` under `rhizome`.
   - Active `@now`, `@today` half-open window, and IANA timezone.
2. **Logic Breakdown:**
   - Progressive-shrinking plain-English AST explanation (without `[^N]` footnote clutter), including resolved `@this` values and `@query.<name>` wave projections.
3. **Compile & Vault Data Diagnostics:**
   - Query syntax/validation/lint diagnostics with caret snippets (`‼️...‼️`) and fix hints.
   - **Queried Property Coercion Diagnostics** (from `QueriedPropertyDiagnosticsAggregator`): surfaces vault notes where a property referenced by this query failed `number`/`date`/`datetime`/`checkbox` coercion (Principle #7 & #15), capped cleanly if numerous.

---

## 7. Template Explain Plan Design

### 7.1 Core Principle: Static English Explanation, Not Code Regurgitation or Loop Unrolling

The Template Explain Plan walks the **Pass-1 LiquidJS AST** across the root codeblock, layouts, and partials to explain _what the code actually means and does_ in plain English **without executing/unrolling runtime iterations**:

- **Header Summary & Extrapolation:**
  - Parse ms, Query ms, Liquid render ms, DOM render ms.
  - Host context (`@this` path, detected host heading offset `H0`–`H6` for `{% heading %}`, pinned `@now` & timezone).
  - Measured sample output (`lines`, `size`) and **plain linear extrapolation** to the post-cutoff `rhizome` record count (and uncapped count if `M > cutoff`), guarded by loop/collection-emission presence so static header-only templates are not falsely multiplied.
  - Explicit warning if measured sample output (even with `0` query records, e.g., `(1..50000)`) or extrapolated full output will trigger Rhizome's `"Please stand-by"` callouts, crash-sentinel tracking, or hard 3.25 MiB / 32 MB / 5,000 ms limits.

- **Lightweight Query Declaration References:**
  - Because `{% query %}` blocks can appear anywhere lexically (top, middle, or inside a partial) yet always execute unconditionally in Pass 1 before template rendering begins, each `{% query <name> %}` node in the template walkthrough renders as a one-line pointer:
    `Query definition: <name> (evaluated in Pass 1, Wave <W> — see Query '<name>' above).`
  - If `{% query <name> %}` is placed inside a conditional (`{% if %}`) or loop (`{% for %}`), emit an explicit warning noting that `{% query %}` is extracted statically in Pass 1 and always executes once unconditionally.

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

1. **Inset Visual Scope Box:**
   - Expanded partials render inside a nested callout box (e.g., `> > [!abstract] Partial [[Partials/row.md]] (isolated scope)`) visually signaling scope isolation.
   - Header lists all passed bindings (`param ← callerExpr`, or `for <collection> as <ident>`) and notes that global queries / `this` / temporal anchors remain accessible while caller `{% assign %}` and `{% for %}` variables are isolated.
2. **Static Variable Diagnostics:**
   - **Shadowing:** Highlight (_bold/italic_ + note) any bound partial parameter or inner `{% assign %}` / loop variable that shadows an outer caller variable or global query name.
   - **Unbound Outer Variable Trap:** Statically detect free variables read inside the partial that are neither passed as `{% render %}` arguments, assigned locally, nor present in `globals`, _but do exist in the caller's lexical scope_—warning at the call site that the variable evaluates to `nil` due to scope isolation.
3. **Complexity-Gated Fan-Out & Runtime Error Pinpointing:**
   - Classify a partial as **Simple** if its AST contains no conditionals (`if`/`unless`/`case`), no loops (`for`/`tablerow`), and no nested `render` tags; otherwise classify it as **Complex**.
   - **1st static occurrence** of any partial: **Always expand** its inset scope box in full.
   - **2nd+ static occurrences:**
     - **Complex partials:** Expand in context at each call site (up to a generous safety ceiling such as `16` total expansions to guard against pathological diamond macros).
     - **Simple partials:** Emit a single compact reference line that **always** lists the clickable `[[Partials/name.md]]` link, **all inputs passed at that call site**, any call-site-specific static scope/shadowing warnings, and its size badge.
     - **Runtime Error Override:** Track the active `{% render %}` call-site stack during Pass 2. If a Pass-2 runtime error is thrown inside a partial through a specific 2nd+ call site, **force-expand** that failing call site's inset box so the error snippet and the exact offending call-site inputs are shown together in place.

### 7.4 Zero-Mutation Size Extrapolation Badges (`[~1.2 KB]`) via `BoundedEmitter`

Instead of injecting and stripping `%%◊ id %%` comments in the Markdown string (which would corrupt `{% capture %}` string lengths and filter inputs):

1. **AST-Keyed `Emitter` Delta Measurement:**
   - Extend the `renderTemplates` hook in `src/core/templates/render-limits.ts` (selectively enabled during `rhizome-sample` Pass 2) to record `emitter.buffer.length` deltas (`after - before`) on `'root'` and `'layout'` emitters per AST `Template` node `(file, begin, end)`.
   - Zero string mutation, immune to skipped conditional branches, safe with `{% capture %}`, and naturally hierarchical across nested loops, partials, and output pipelines.
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
