# Rhizome Visualization (`| visualize`): Specification

## Terminology

Obsidian terms such as note, frontmatter, tag, and vault are assumed to be understood. Syntax elements used in Rhizome are written as `inline code`. Defined domain terms are written in plain text using CamelCase.

- **Rhizome** is the Obsidian plugin (`minAppVersion: "1.15.0"` for native Mermaid pan, zoom, and theme-color push-down).
- **VizFlavor** is one of the supported visual projection kinds rendered via Obsidian's built-in Mermaid engine: `graph`, `sankey`, `gantt`, `timeline`, `mindmap`, `bars`, `line`, `quadrant`, or `pie`.
- **FocusPath** is a positional `deep.path` selector argument passed to `| visualize` indicating an attribute the user wants prioritized in visual encoding, ordered from highest priority to lowest priority.
- **VizSlot** is a single invocation of `| visualize` within a RhizomeCodeBlock, identified at runtime by its `0`-based `vizIndex` during Pass 2 rendering and mounted in its own isolated child `MarkdownRenderChild` container in ReactiveInsertBlocks.
- **VizLockStore** is a bounded LRU map persisted in Rhizome's `data.json` (`lockedVisualizations[notePath][callKey] = VizFlavor`, where `callKey` hashes the code block source and `vizIndex`) that stores user-locked VizFlavor choices across reloads and Obsidian Sync without mutating vault Markdown.

## 1. Core Design Rules

1. **Data-first, Mermaid-as-backend:** Users express _what structure and attributes to project_; Rhizome generates synthetic collision-free node IDs (`N0`, `N1`, …), entity-escapes reserved Mermaid characters (`()`, `[]`, `"`, `;`, `#`, and keywords such as `end`), attaches clickable Obsidian `internal-link` classes where supported, and emits a standard fenced ` ```mermaid ` Markdown block.
2. **Theme push-down harmony:** Rhizome never emits hardcoded hex `style` or `classDef` color overrides, relying on Obsidian 1.15's native Light/Dark theme push-down. Special nodes (such as `focus:` or rollup sinks) are distinguished via Mermaid node geometry (`[["Focus"]]`, `(["Rollup"])`, `(("Hub"))`) and line styles (`-->`, `<-->`, `-.->`).
3. **Strict opt-in encoding (no "spare slot" guessing):** `| visualize` encodes only (a) structure already present in the piped input (`GroupByBucket` nesting, `TreeNode` hierarchy, `NormalizedTask` status/dates, `file.basename` labels) and (b) the explicit FocusPaths and named options passed to `| visualize`. Unmentioned note properties are never pulled in automatically; when a numeric weight is omitted, item count (`1` per item) is used.
4. **Synchronous Pass 2 purity:** `| visualize` operates purely on in-memory piped values and `ResolvedEngineConfig.propertyTypes`, checking `ctx.renderLimit` every `1,024` steps.

## 2. Accepted Input Shapes & Text-Segmentation Helpers

`| visualize` accepts any of the following piped inputs:

- **`VaultQueryMatch[]`:** Normalized note arrays from `query.*` or collection pipelines.
- **`GroupByBucket[]`:** Single-level or recursive multi-level `{ name, items, size, groups? }` hierarchies produced by `| group_by`.
- **`TreeNode[]`:** `{ item, children, depth, size }` hierarchies produced by `| tree`.
- **`NormalizedTask[]`:** Task arrays with `cleanText`, `done`, `statusType`, `priority`, `start`, `scheduled`, and `due`.
- **Plain records (`Record<string, unknown>[]`) and scalar sequences (`(number | string)[]`):** Including stringified numbers produced by Liquid `{% capture %}` + `| split:` inside partials, coerced via `parseFiniteRangeNumber`.

To support prose-analytics partials (such as sentence-cadence bar charts with `0` bars between paragraphs) without third-party dependencies, Rhizome also provides three synchronous locale-aware filters backed by JavaScript's built-in `Intl.Segmenter` (using the context's `language` global):

- `| paragraphs`: Splits cleaned Markdown text on paragraph boundaries into `string[]`.
- `| sentences`: Splits text (or maps `string[]`) into trimmed sentence strings via `Intl.Segmenter(..., { granularity: 'sentence' })`.
- `| words`: Splits text into word-like tokens via `Intl.Segmenter(..., { granularity: 'word' })` (filtering `isWordLike === true`).

## 3. Signature, Parameters, and Auto-Selection

```liquid
{{ input | visualize[: "<FocusPath1>", "<FocusPath2>", ...][, options...] }}
```

### 3.1 Named Options

- `as: "<VizFlavor>"` — Pins a specific VizFlavor in code (`"graph"`, `"sankey"`, `"gantt"`, `"timeline"`, `"mindmap"`, `"bars"`, `"line"`, `"quadrant"`, `"pie"`). When `as:` is present, interactive dropdown/lock chrome is suppressed.
- `depth: <int>` — Maximum hierarchy or path-segment depth to expand on `sankey`, `mindmap`, and nested `graph` subgraphs.
- `max_leaves: <int>` and `min_share: <0..1>` — Leaf-pruning controls on hierarchical flows (`sankey`): expands individual leaf items inside a bucket/folder when leaf count `<= max_leaves`, or individually expands only leaves whose weight is `>= min_share` of their parent's total weight, rolling remaining leaves into a single `"(N smaller items)"` sink node so total flow is conserved.
- `links: true | "<prop1>, <prop2>, ..."` — On `graph`, draws directed cross-note edges from `item.links` between nodes present in the diagram. When property names are given, filters strictly to links with matching `NormalizedLink.property` and labels each edge with `link.property` (collapsing reciprocal `A -> B` and `B -> A` edges with the same label into `<-->`).
- `edge_label: "property" | "alias" | "none"` — Controls edge naming on `links:` (`"property"` uses `link.property`; `"alias"` uses `link.displayText` when distinct from target name; `"none"` omits labels).
- `chain: "within" | "across" | "<FocusPath>"` (and optional `chain_label: "<text>"`) — Connects leaf items sequentially (`N_i --> N_{i+1}`) in sort order either `"within"` each lowest-level `GroupByBucket` or `"across"` the entire diagram.
- `focus: <note_or_path>` — Highlights the focal node (for example, `focus: this` on an `N`-hop `@this OR <->..N @this` ego query) using double-bordered `[["..."]]` geometry.
- `direction: "TD" | "LR" | "BT" | "RL"` — Orientation for `graph` (defaults to `"TD"` to match Obsidian's vertical scroll axis under _Readable line length_; nested `subgraph` blocks omit explicit `direction` unless overridden so Mermaid cross-subgraph edge routing remains intact).

### 3.2 Deterministic Flavor Scoring (When `as:` Is Omitted)

1. Resolve the domain of each FocusPath (`categorical`, `path`, `numeric`, `temporal`) using Obsidian's `types.json` Property Type Registry first (so empty query results do not flip chart types), falling back to non-null value inspection.
2. Rank compatible VizFlavors:
   - `links:`, `chain:`, or `focus:` specified -> **`graph`** (`flowchart TD`), plus `mindmap` / `sankey` when grouped.
   - Path (`"file.path"`) or `GroupByBucket[]` + `numeric` weight -> **`sankey`** (`sankey-beta`), **`bars`**, **`mindmap`**, **`pie`**.
   - `NormalizedTask[]` or `temporal` intervals -> **`gantt`**, **`timeline`**, **`bars`**.
   - `temporal` or `categorical` buckets + `numeric` / scalar numeric sequence -> **`bars`** (`xychart-beta`, using numeric range `x-axis 1 --> N` on unlabeled sequences to prevent tick-label collisions), **`line`**, **`pie`**.
   - Two `numeric` FocusPaths -> **`quadrant`** (`quadrantChart`), **`bars`**.
   - `TreeNode[]` or `GroupByBucket[]` without weights or links -> **`mindmap`**, **`graph`**.

## 4. Pre-Calculation, Interactive Switcher, and Persistence

### 4.1 Pass 2 Pre-Calculation & One-Time Triggers

- When `as:` is specified, or during any one-time TemplateTrigger (`NewNoteFromTemplate`, `InsertTemplateAtSelections`, `NewNoteFromUnresolvedLink`), `| visualize` formats and emits **only** the single target/top-ranked ` ```mermaid ` block.
- In a **ReactiveInsertBlock** when `as:` is **omitted**:
  1. `| visualize` pre-calculates the ` ```mermaid ` Markdown string and `{ nodes, edges }` complexity metrics for all compatible VizFlavors (`2`–`5` plain strings, retaining zero `VaultQueryMatch` references in `CodeBlockRenderCache`).
  2. Resolves the initial active VizFlavor via precedence: **ephemeral session selection -> `VizLockStore` (`data.json`) -> #1 ranked VizFlavor**.
  3. Emits **only** the active VizFlavor's ` ```mermaid ` string to `BoundedEmitter`, while recording `{ vizIndex, flavors, metricsByFlavor, defaultFlavor, startOffset, endOffset }` on `TemplateRenderResult.visualizations`.

### 4.2 Child `MarkdownRenderChild` Switching, Locking, & Copy Splicing

1. **Isolated DOM slot:** After the outer ReactiveInsertBlock renders, `rhizome-codeblock.ts` wraps each unpinned VizSlot in `<div class="rhizome-viz-slot">` managed by a child `MarkdownRenderChild` (`activeRenderChild.addChild(vizChild)`), mounting a hover toolbar with a **VizFlavor dropdown** and a **Lock checkbox (`🔒`)**.
2. **Zero-flicker local swap:** Selecting a different VizFlavor in the dropdown updates the ephemeral session map and re-renders **only** that VizSlot's child `MarkdownRenderChild`—leaving surrounding tables, prose, scroll position, and sibling charts' pan/zoom state untouched.
3. **Sync-safe locking:** Changing the dropdown while unlocked performs **zero** `data.json` writes. Checking **Lock** runs the render-sentinel check first; once `MarkdownRenderer.render()` resolves cleanly on the selected flavor, Rhizome writes `lockedVisualizations[notePath][callKey] = flavor` to `data.json` (re-keyed on `vault.on('rename')` and pruned on `metadataCache.on('deleted')`). Unchecking **Lock** deletes the entry from `data.json`.
4. **Copy Markdown accuracy:** Clicking the outer ReactiveInsertBlock's **Copy Markdown** button splices each VizSlot's `[startOffset, endOffset)` span with `flavors[currentActiveFlavor]` so the clipboard always receives the exact Mermaid diagram currently displayed on screen.

## 5. Render-Time & Crash-Sentinel Guardrails

Because a `35 KiB` Mermaid diagram with `1,500` cross-edges slips under character-count thresholds while still taxing Dagre's `O(V * E)` crossing minimizer:

1. **Standby & Crash Sentinel integration:** In ReactiveInsertBlocks, any VizFlavor whose `nodes + edges` crosses `400` engages Rhizome's standby callout and write-ahead `RenderSentinelStore` probation/quarantine guard prior to calling `MarkdownRenderer.render()` (both on initial mount and on dropdown flavor switches).
2. **Runaway edge ceiling:** `graph` enforces a protective edge cap (`2,500` edges under InteractiveRenderBudget; `10,000` under LongFormRenderBudget), failing fast with an actionable `TemplateDiagnostic` rather than hanging the UI thread.
