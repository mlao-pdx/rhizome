## Language Development Principles

These principles guide the design of Rhizome's two languages: the query
language and the template language. Like `docs/principles.md`, they are not
absolute, but any deviation should be well-reasoned.

The two baseline guidelines are:

- **Query:** full parity with the Obsidian core Search plugin, with a minimal
  learning curve and one purposeful omission: body text filters. (Task support
  is on the roadmap, but not yet implemented.)
- **Template:** close parity with LiquidJS, but with cross-the-board support
  for deep `.path` references and filter expressions wherever variables are
  allowed, support for temporal data types, shaping of metadata structures to
  fit reporting needs, and additional tools that make it a natural extension
  for shaping a JSON structure into a Markdown rendering.

The guidelines below are organized into four layers: the boundary between the
two languages, Query, Template, and cross-cutting user experience.

---

### 1. Select vs. Shape

The biggest risk in a dual-language system is feature bleed—either turning the
query language into a clunky SQL/aggregates engine or forcing users to write
`{% for %}` + `{% if %}` loops in Liquid to filter notes.

- **Select vs. Shape:** Query narrows the candidate set; Template shapes the
  result.
  - If an operation decides _which vault entities_ are in play based on
    indexed metadata, it belongs in **Query**.
  - If an operation sorts, groups, aggregates, pivots, formats, or projects
    those matched records into Markdown, it belongs in **Template**.

### 2. One Seam, One Contract

- **One seam, one contract:** one canonical data contract across the seam.
  - The output of a `{% query %}` block should always be a predictable,
    inspectable structure (matched documents, normalized properties, plus
    query/property diagnostics and explain plans).
  - A user who isn't sure what a query returned should be able to pipe any
    query result or sub-property into a debug/inspection filter (e.g.,
    `| json`) and immediately see the exact shape they are working with.

### 3. Same Word, Same Meaning

- **Same word, same meaning:** shared semantics for shared concepts.
  - Temporal literals/anchors (`@today`, `2026-01..2026-03`, half-open
    intervals `[start, end)`), property coercion rules, and comment syntax
    (`{% # ... %}`, `{% comment %}`) must behave identically whether written
    inside `{% query %}` or in surrounding Liquid expressions. A date or
    property should never mean one thing during filtering and another thing
    during rendering.

---

## Query Language

### 4. Zero-Surprise Transfer

- **Zero-surprise transfer from Obsidian core Search:**
  - Any metadata filter a user already knows from Obsidian Search (`path:`,
    `file:`, `tag:` / `#tag`, `[property]:value`, boolean `AND`/`OR`/`-`,
    parentheses, `/regex/`) must work with the exact same mental model and
    precedence.

### 5. Explicit Targets Only

- **Explicit targets only (no accidental full-text fallbacks):**
  - Because body-text search is intentionally omitted, unscoped bare words
    must fail fast at compile time with an actionable hint (e.g., suggesting
    `file:`, `path:`, `#tag`, or `[property]`) rather than silently matching
    nothing or guessing a field.

### 6. Vault Types Rule

- **Vault-schema awareness via Obsidian's Property Type Registry:**
  - Comparisons (`<`, `<=`, `>`, `>=`, ranges `..`) should honor the vault's
    configured property types (`number`, `date`, `datetime`, `checkbox`,
    `text`, `multitext`, `tags`) rather than treating frontmatter as raw
    strings.

### 7. Judge the Query, Not the Vault

- **Forgiving on vault chaos, strict on query syntax ("Judge, don't
  sentence"):**
  - _Query syntax errors_ (typos in operators, reversed ranges, unknown
    scopes) are caught at compile time with source spans and fix-it hints.
  - _Vault data errors_ (a note where `due_date: "next tuesday"` fails date
    coercion) must **never** crash the query or abort the report. Instead, the
    note's property normalizes to an `invalid` diagnostic attached to the
    query report so the user can surface malformed notes right inside their
    template if they choose to.

### 8. Pin the Clock

- **Pinned reference time per execution:**
  - All relative temporal anchors (`@now`, `@today`, `@this-week`) resolve
    against a single pinned timestamp for the entire query/template render
    pass so results are deterministic and cacheable.

### 9. Structure, Not Prose

- **Sub-note granularity only for structured, indexable items (roadmap
  boundary):**
  - Rejecting body-text search keeps the index fast and structural. As Task
    support (and potentially headings/list-items) lands, the rule of thumb
    should be: _Query only indexes discrete, addressable structural items with
    metadata (status, dates, tags, properties), never arbitrary prose._

---

## Template Language

### 10. Works Everywhere It's Allowed

- **Orthogonality ("If an expression works in `{{ ... }}`, it works
  everywhere"):**
  - Standard Liquid frustrates users because filter chains or deep paths work
    in `{{ output }}` but fail inside `{% if %}`, `{% for %}`, or filter
    arguments. Supporting deep `.path` lookups and inline filter/selector
    expressions uniformly across tags, conditionals, loops, and filter
    parameters eliminates the #1 source of Liquid boilerplate
    (`{% assign temp = ... %}`).

### 11. Pipeline Over Loops

- **Pipeline-first data shaping over imperative loop gymnastics:**
  - In standard Liquid, grouping, multi-key sorting, aggregating, or reshaping
    nested arrays requires deeply nested `{% for %}` loops and
    string-splitting hacks.
  - Rhizome's template filters (`group_by`, `sort_by`, `aggregate`,
    collection/payload selectors) should let users express _data
    transformations_ declaratively in a pipeline (`items | where: ... |
group_by: ... | sort_by: ...`), reserving `{% for %}` loops strictly for
    final layout emission.

### 12. Dates Are Values

- **First-class temporal values, not stringified dates:**
  - Dates and intervals flowing from frontmatter or queries should remain rich
    temporal objects (`TemporalDrop` / intervals) all the way through
    comparison, range checks (`in`), sorting, bucketing, and arithmetic—
    converting to formatted text only at final output.

### 13. Render for the Medium

- **Markdown-native and Obsidian-native output primitives:**
  - Because the target medium is always Obsidian Markdown (tables, callouts,
    wikilinks, task lists, frontmatter properties, embeds), built-in filters
    should handle the finicky parts of Markdown generation automatically:
    - Escaping pipe characters and newlines inside Markdown table cells.
    - Formatting `[[wikilinks|aliases]]` and `#tags` cleanly from file objects
      or paths.
    - Turning shaped JSON/hierarchical groups (such as multi-level `group_by`
      trees or explain plans) into Markdown tables, nested lists, or callouts
      without repetitive boilerplate.

### 14. Chaos-Tolerant Paths

- **Null-safe and chaos-tolerant navigation:**
  - Vault notes have missing keys, scalar-vs-single-element-list
    inconsistencies in YAML, and mixed types. Deep path traversal and
    collection filters should treat missing properties and `null` gracefully
    without throwing runtime exceptions, and normalize singletons vs. arrays
    predictably when filtering or grouping.

---

## Cross-Cutting Ergonomics and Guardrails

### 15. Explain Yourself

- **Self-diagnosing by default (`explain` and inline diagnostics):**
  - When a user asks _"Why didn't my note show up?"_ or _"Why did this sort
    strangely?"_, the language itself should answer the question—via
    `{% query name explain %}` plans and accessible `diagnostics` collections
    on the query payload, rather than forcing the user into the developer
    console.

### 16. Render Never Writes

- **Pure, side-effect-free evaluation:**
  - Rendering a template or running a query must be strictly read-only and
    deterministic for a given vault snapshot and reference timestamp.
    Templates never mutate vault files or frontmatter as a side effect of
    rendering.

### 17. Cache-Sized

- **Mobile-safe, bounded resource footprint:**
  - Because Obsidian runs on mobile devices (`isDesktopOnly: false`), both
    languages must operate purely against in-memory metadata caches
    without reading raw note bodies from disk during query evaluation.

---

## The Five-Question Test

Whenever a new operator, tag, or filter is proposed, evaluate it against these
five questions:

1. **Select or Shape?** Does this belong in Query (candidate selection) or
   Template (shaping and rendering)?
2. **Would they guess it?** Would an Obsidian Search or LiquidJS user guess
   this syntax on their first try?
3. **Is it orthogonal?** Does it work orthogonally to the rest of the language
   (deep paths, temporal intervals, filter chains)?
4. **What breaks?** What happens when it encounters a note with missing,
   mistyped, or chaotic frontmatter?
5. **Does it save boilerplate?** Does it save the user from writing imperative
   `{% assign %}` / `{% for %}` boilerplate to produce Obsidian Markdown?
