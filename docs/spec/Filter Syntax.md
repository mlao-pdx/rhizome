---
~created: 2026-10-20T17:11:34-07:00
~modified: 2026-10-23T14:13:43-07:00
---

# Technical Specification (V3.14): Obsidian Metadata Search DSL, Normalizer, Linter & Test Oracle

## 1. System Architecture & Public API Contract

### 1.1 Core Architectural Pillars

1. **No Full-Text Body Search, `resolvedLinks`, or Backlinks**: Queries operate strictly against per-note file metadata (`TFile` attributes + normalized per-note `CachedMetadata` + properties). The DSL and normalizer do not ingest `MetadataCache.resolvedLinks` and do not support backlink queries (`backlink:`, `backlinks:`, `referencedLinks:`); only outgoing `links` and `embeds` recorded on the note itself are indexed. Bare words without an operator match against `file.basename`, `file.path`, `aliases`, and `tags` (and emit `HINT_BARE_TEXT_NO_BODY`).
2. **Authorized Queries & Native ECMAScript `RegExp`**: This engine is intended for queries the vault owner has authorized for execution. It uses native ECMAScript regular expressions (`new RegExp(pattern, flags)` with stateless flags `i`, `m`, `s`, `u`) and deliberately provides no execution deadline or protection against pathological backtracking. Metadata strings are not length-bounded. Integrations must not treat imported or shared query text as trusted solely because it resides in a local vault.
3. **Centralized, Runtime-Immutable Configuration & Normalization Fingerprinting (`initEngineConfig`)**:
   - Timezone validation, property-type registry normalization, and custom scope deduplication happen once in `initEngineConfig(rawConfig)`, returning a deeply frozen `ResolvedEngineConfig` closure.
   - Each `ResolvedEngineConfig` computes a deterministic `normalizationFingerprint: string` over `timeZone` and sorted `propertyTypes` entries. Every `NormalizedDocument` records the `normalizationFingerprint` it was normalized with, and `evaluateVault` / `oracleEvaluateVault` verify `doc.normalizationFingerprint === prepared.resolvedConfig.normalizationFingerprint` (rejecting stale documents normalized under incompatible configurations).
4. **Pinned Reference-Time Compilation & Deeply Frozen AST (`compileQuery` $\to$ `PreparedQuery`)**:
   - `compileQuery(input, resolvedConfig, referenceTimeMs)` validates `referenceTimeMs`, parses and validates the query, **recursively freezes the entire `SearchAST`** (`deepFreezeAST`), and returns a frozen `PreparedQuery` binding `{ ast, resolvedConfig, referenceTimeMs }`.
   - **Temporal Snapshot & Result Caching Rule**: A `PreparedQuery` is a temporal snapshot. Reusing it never advances relative anchors (`@today`, `@now`, etc.). Integrations must recompile with a new `referenceTimeMs` when refreshed relative semantics are desired. Query result caches must distinguish both the `PreparedQuery` identity and the input vault snapshot/revision (if using a structural cache key rather than `PreparedQuery` object identity, the key must include normalized query semantics, the bound `referenceTimeMs`, full configuration semantics including custom scopes, and the vault revision). Evaluators only accept compiler-produced `PreparedQuery` objects.
5. **Half-Open Millisecond Interval Date Model ($[s, e)$), Positional Ranges (`[s1, e2)`) & Relative `@` Anchors via `Temporal`**:
   - Every valid date, datetime, interval range (`<Atom1>..<Atom2>`), and query-side relative anchor resolves to a UTC epoch millisecond half-open interval $[s, e)$ satisfying $\text{Number.isSafeInteger}(s) \land \text{Number.isSafeInteger}(e) \land s < e$.
   - **Positional Range Rule (`[s1, e2)` iff $s_1 < e_2$)**: Given `<Atom1>` $= [s_1, e_1)$ and `<Atom2>` $= [s_2, e_2)$, `<Atom1>..<Atom2>` combines into **$[s_1, e_2)$** if and only if **$s_1 < e_2$**.
6. **Template-Ready Document & Query Diagnostics (`DocumentDiagnostic` & `VaultEvaluationReport`)**:
   - All diagnostic objects are pure, JSON-serializable POJOs using `null` (never `undefined`) for optional fields (`line: number | null`, `hint: string | null`, `span: SourceSpan | null`).
   - Malformed stored property values on a note normalize to `{ kind: 'invalid' }` without crashing vault queries, attach a `DocumentDiagnostic` to `doc.diagnostics`, and are surfaced in `VaultEvaluationReport.propertyDiagnostics` whenever a query filters on that non-virtual property key.
7. **Hybrid Property Model (Occurrence Stream + Key-Order Array + Per-Key Local Value Order)**:
   - `propertyOccurrences: PropertyOccurrence[]` preserves cache-level occurrence order (`Object.entries(frontmatter)` followed by the caller-supplied `inlineProperties` array).
   - `propertyKeys: string[]` stores the exact first-seen order of normalized property keys from `propertyOccurrences`.
   - `properties: Record<string, unknown>` exposes an $O(1)$ null-prototype lookup table with per-key local occurrence order.

---

### 1.2 Complete Public Type Definitions (`types.ts`)

```typescript
export type ObsidianPropertyType =
  | 'text'
  | 'multitext'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'tags';

export const VALID_PROPERTY_TYPES_LIST: readonly ObsidianPropertyType[] = Object.freeze([
  'text', 'multitext', 'number', 'checkbox', 'date', 'datetime', 'tags'
]);

const PRIVATE_VALID_PROPERTY_TYPES = new Set<string>(VALID_PROPERTY_TYPES_LIST);

export function isValidPropertyType(val: unknown): val is ObsidianPropertyType {
  return typeof val === 'string' && PRIVATE_VALID_PROPERTY_TYPES.has(val);
}

export const VIRTUAL_FILE_KEYS_LIST: readonly string[] = Object.freeze([
  'file.mtime',
  'file.ctime',
  'file.size',
  'file.ext',
  'file.extension',
  'file.name',
  'file.basename',
  'file.path',
  'file.parent'
]);

const PRIVATE_VIRTUAL_FILE_KEYS = new Set<string>(VIRTUAL_FILE_KEYS_LIST);

export function isVirtualFileKey(key: string): boolean {
  return PRIVATE_VIRTUAL_FILE_KEYS.has(key);
}

export type PropertyTypeRegistry = Record<string, ObsidianPropertyType>;

export type DateGrain =
  | 'year'
  | 'quarter'
  | 'month'
  | 'week'
  | 'day'
  | 'minute'
  | 'second'
  | 'ms'
  | 'range';

export interface DateInterval {
  /** Inclusive UTC epoch ms (safe integer within [-8.64e15, 8.64e15]) */
  readonly start: number;
  /** Exclusive UTC epoch ms (safe integer, strictly start < end; may equal MAX_SAFE_EPOCH_MS + 1) */
  readonly end: number;
  readonly grain: DateGrain;
  readonly raw: string;
}

export type DateParseResult =
  | { ok: true; interval: DateInterval }
  | { ok: false; reason: 'INVALID_FORMAT' | 'SKIPPED_DATE' | 'RELATIVE_NOT_ALLOWED' }
  | {
      ok: false;
      reason: 'REVERSED_RANGE';
      leftRaw: string;
      rightRaw: string;
      hint: string | null; // e.g., "Use 2026-01-01..2026-10-01"
    };

/**
 * Target-Type Consistency Invariant:
 * Coercing a value for target type T MUST ONLY produce:
 * - { kind: 'null' } (when input is null or undefined)
 * - { kind: 'invalid', raw, expectedType: T, reason, hint } (when input is incompatible with T)
 * - { kind: 'text' } (when T is 'text' | 'multitext' | 'tags')
 * - { kind: T } (when T is 'number' | 'checkbox' | 'date' | 'datetime')
 */
export type TypedPropertyValue =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number; raw: string }
  | { kind: 'checkbox'; value: boolean; raw: string }
  | { kind: 'date' | 'datetime'; interval: DateInterval; raw: string }
  | { kind: 'null' }
  | {
      kind: 'invalid';
      raw: string;
      expectedType: ObsidianPropertyType;
      reason: 'INVALID_VALUE' | 'REVERSED_DATE_RANGE' | 'SKIPPED_DATE' | 'RELATIVE_IN_STORED_PROPERTY';
      hint: string | null;
    };

export type SanitizedScalar = string | number | boolean | null;

export interface PropertyOccurrence {
  key: string;                        // Normalized: rawKey.trim().toLowerCase()
  rawKey: string;                     // Key casing as provided in cache/inline
  source: 'frontmatter' | 'inline';
  line: number | null;                // Positive safe integer (1-based) when available; null otherwise
  propertyType: ObsidianPropertyType;
  rawValue: SanitizedScalar | SanitizedScalar[];
  typedValues: TypedPropertyValue[];
}

export type DocumentDiagnosticCode =
  | 'DOC_REVERSED_DATE_RANGE'
  | 'DOC_SKIPPED_DATE'
  | 'DOC_INVALID_PROPERTY_VALUE';

/**
 * Pure POJO diagnostic for a malformed property value on a NormalizedDocument.
 * Emitted in occurrence order and array-element order (one diagnostic per invalid scalar element).
 * Uses `null` instead of `undefined` for strict LiquidJS template compatibility.
 */
export interface DocumentDiagnostic {
  code: DocumentDiagnosticCode;
  filePath: string;
  fileBasename: string;
  propertyKey: string;
  rawKey: string;
  rawValue: string;
  expectedType: ObsidianPropertyType;
  source: 'frontmatter' | 'inline';
  line: number | null;
  occurrenceIndex: number;
  valueIndex: number;
  issue: string;
  hint: string | null;
}

export interface NormalizedFileStat {
  ctime: number; // Safe integer UTC epoch ms within [-8.64e15, 8.64e15]
  mtime: number; // Safe integer UTC epoch ms within [-8.64e15, 8.64e15]
  size: number;  // Safe integer >= 0
}

export interface NormalizedFileInfo {
  path: string;
  name: string;
  basename: string;
  extension: string;
  parent: string; // "" for vault root
  stat: NormalizedFileStat;
}

export interface NormalizedHeading {
  text: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface NormalizedLink {
  link: string;                // Raw link string from cache, e.g., "Other Note#Heading" or "#Overview"
  rawTarget: string;           // Unresolved target without #heading/^block (or self path for "#Overview")
  resolvedPath: string | null; // Vault path via resolveLinkPath(), or null if unresolved
  subpath: string;             // "#Heading" or "^block", or ""
  displayText: string;
  source: 'body' | 'frontmatter' | 'embed';
}

export interface NormalizedDocument {
  /** Fingerprint of the ResolvedEngineConfig (timeZone + propertyTypes) used to normalize this document */
  normalizationFingerprint: string;
  file: NormalizedFileInfo;
  aliases: string[];
  tags: string[];                            // Explicit tags only, lowercase with '#', sorted & deduplicated
  headings: NormalizedHeading[];
  links: NormalizedLink[];                   // Outgoing links (body + frontmatterLinks, excluding embeds)
  embeds: NormalizedLink[];                  // Outgoing embeds
  blocks: string[];                          // Lowercase block IDs with any leading '^' stripped
  propertyOccurrences: PropertyOccurrence[]; // Cache-level occurrence stream
  propertyKeys: string[];                    // Exact first-seen order of normalized property keys
  properties: Record<string, unknown>;       // Null-prototype O(1) lookup map with per-key local occurrence order
  diagnostics: DocumentDiagnostic[];         // Non-fatal document property diagnostics
}

// ============================================================================
// AST, CONFIG, PREPARED QUERY & EVALUATION REPORT TYPES
// ============================================================================

/**
 * UTF-16 code-unit offsets and 1-based line/column coordinates.
 * startOffset is inclusive (0-based); endOffset is exclusive (0-based, endOffset >= startOffset).
 */
export interface SourceSpan {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;   // 1-based
  readonly startColumn: number; // 1-based
}

export type SearchAST =
  | MatchAllNode
  | LogicalNode
  | NotNode
  | ScopedFilterNode
  | PropertyFilterNode
  | TextMatchNode;

export interface MatchAllNode {
  readonly type: 'MATCH_ALL';
}

export interface LogicalNode {
  readonly type: 'LOGICAL';
  readonly operator: 'AND' | 'OR';
  readonly parenthesized?: boolean;
  readonly children: readonly SearchAST[];
  readonly span?: SourceSpan;
}

export interface NotNode {
  readonly type: 'NOT';
  readonly syntax: 'NOT' | '-';
  readonly child: SearchAST;
  readonly span?: SourceSpan;
}

export type LeafMatcher =
  | { readonly kind: 'string'; readonly value: string; readonly quoted: boolean }
  | { readonly kind: 'regex'; readonly pattern: string; readonly flags: string };

export type ValueExprAST =
  | { readonly type: 'VALUE_LOGICAL'; readonly operator: 'AND' | 'OR'; readonly children: readonly ValueExprAST[] }
  | { readonly type: 'VALUE_NOT'; readonly syntax: 'NOT' | '-'; readonly child: ValueExprAST }
  | { readonly type: 'VALUE_LEAF'; readonly matcher: LeafMatcher };

export interface ScopedFilterNode {
  readonly type: 'SCOPED_FILTER';
  readonly scope: string;    // Trimmed canonicalName from ResolvedEngineConfig
  readonly rawScope: string; // Authored scope token text, or '#' when lowered from TagShorthand
  readonly expr: ValueExprAST;
  readonly span?: SourceSpan;
}

export type PropertyOperator = 'EXISTS' | ':' | '=' | '!=' | '<' | '>' | '<=' | '>=';

export interface PropertyFilterNode {
  readonly type: 'PROPERTY_FILTER';
  readonly key: string;             // Decoded, trimmed, lowercased property key
  readonly rawKey: string;          // Decoded property key (with outer quotes stripped if quoted)
  readonly operator: PropertyOperator;
  readonly valueExpr?: ValueExprAST; // Present iff operator !== 'EXISTS'
  readonly span?: SourceSpan;
}

export interface TextMatchNode {
  readonly type: 'TEXT_MATCH';
  readonly matcher: LeafMatcher;
  readonly rawText: string;         // Original token text for linting
  readonly span?: SourceSpan;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'hint';

export type DiagnosticCode =
  | 'SYNTAX_ERROR'
  | 'ERROR_INVALID_CONFIG'
  | 'ERROR_UNKNOWN_SCOPE'
  | 'ERROR_TYPE_MISMATCH'
  | 'ERROR_INVALID_OPERATOR_FOR_TYPE'
  | 'WARN_UNQUOTED_MULTIWORD_SCOPE'
  | 'WARN_LOWERCASE_BOOLEAN'
  | 'WARN_DANGEROUS_SPACED_HYPHEN'
  | 'WARN_SINGLE_VALUE_CONTRADICTION'
  | 'HINT_PROP_NEQ_EXISTENCE'
  | 'HINT_AMBIGUOUS_PRECEDENCE'
  | 'HINT_WIKILINK_BRACKETS_IN_SCOPE'
  | 'HINT_BARE_TEXT_NO_BODY';

export interface SearchDiagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  issue: string;
  hint: string | null;
  span: SourceSpan | null;
}

/**
 * Custom Scope Callbacks Contract:
 * - Regex leaves (`/pattern/flags`) are compiled once per query and evaluated centrally by the engine
 *   against extracted targets, so custom scopes only need to implement string matching in `matchString`!
 * - Both `extract` and `matchString` MUST be pure, deterministic, non-mutating, non-throwing,
 *   and capture no mutable external state for the lifetime of a ResolvedEngineConfig.
 */
export interface ScopeDefinition {
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  extract(doc: NormalizedDocument): readonly string[];
  matchString(target: string, queryValue: string, quoted: boolean): boolean;
}

export interface EngineConfig {
  timeZone: string;
  propertyTypes: PropertyTypeRegistry;
  customScopes?: readonly ScopeDefinition[];
}

export interface ResolvedEngineConfig {
  readonly __brand: 'ResolvedEngineConfig';
  readonly timeZone: string;
  readonly propertyTypes: Readonly<PropertyTypeRegistry>;
  /** Deterministic fingerprint of timeZone + propertyTypes for verifying document normalization compatibility */
  readonly normalizationFingerprint: string;
  getScope(nameOrAlias: string): ScopeDefinition | undefined;
  getAllScopeNames(): readonly string[];
}

export type ConfigResult =
  | { ok: true; config: ResolvedEngineConfig; diagnostics: readonly [] }
  | { ok: false; config: null; diagnostics: readonly SearchDiagnostic[] };

/**
 * Deeply frozen prepared query produced by `compileQuery`.
 */
export interface PreparedQuery {
  readonly __brand: 'PreparedQuery';
  readonly ast: SearchAST;
  readonly resolvedConfig: ResolvedEngineConfig;
  readonly referenceTimeMs: number;
}

export interface CompileResult {
  ast: SearchAST | null;
  prepared: PreparedQuery | null;
  diagnostics: SearchDiagnostic[];
  executable: boolean;
}

export interface VaultEvaluationReport {
  /** Matched documents in exact input vault order */
  matches: NormalizedDocument[];
  /**
   * All DocumentDiagnostics from vault documents whose `propertyKey` was referenced
   * by at least one non-virtual `PropertyFilterNode` in `ast` (in document, occurrence, and value order).
   */
  propertyDiagnostics: DocumentDiagnostic[];
}
```

---

## 2. Configuration, Native `RegExp`, Scopes & Extended Temporal Contract

### 2.1 Centralized `initEngineConfig(rawConfig)` & Normalization Compatibility Contract

1. **Timezone Validation**: Verifies `Intl.DateTimeFormat(undefined, { timeZone: rawConfig.timeZone })`. Invalid timezones emit `ERROR_INVALID_CONFIG`.
2. **Obsidian `types.json` Property Type Normalization & Collision Check**:
   - `rawConfig.propertyTypes` is populated from Obsidian’s `.obsidian/types.json` (`typesJson.types: Record<string, ObsidianPropertyType>`) or runtime `app.metadataTypeManager`.
   - Trims and lowercases every key in `rawConfig.propertyTypes`.
   - Verifies `isValidPropertyType(propType)` using the private Set (`'text'`, `'multitext'`, `'number'`, `'checkbox'`, `'date'`, `'datetime'`, `'tags'`). Unregistered properties default to `'text'` (except reserved `tag`/`tags` $\to$ `'tags'` and `alias`/`aliases` $\to$ `'multitext'`).
   - Rejects case collisions in `types.json` that map to **different** types (e.g., `{ Status: 'text', status: 'number' }` $\to$ `ERROR_INVALID_CONFIG`; identical types `{ Status: 'date', status: 'date' }` are deduplicated cleanly).
   - Freezes `normalizedTypes` with `Object.freeze()`.
3. **Normalization Fingerprint (`normalizationFingerprint`)**:
   - Computed deterministically as `JSON.stringify({ tz: trimmedTz, types: Object.keys(normalizedTypes).sort().map(k => [k, normalizedTypes[k]]) })`.
   - Stored on `ResolvedEngineConfig.normalizationFingerprint` and stamped onto every `NormalizedDocument.normalizationFingerprint`.
   - **Compatibility Precondition**: Every document passed to `evaluateVault(docs, prepared)` or `oracleEvaluateVault(docs, prepared)` **must** have `doc.normalizationFingerprint === prepared.resolvedConfig.normalizationFingerprint`; mismatches throw an error. (If an integration persists normalized documents across plugin or runtime upgrades, it must rebuild the persisted index on startup when the engine schema changes).
4. **Custom Scope Normalization, Cloning & Deduplication**:
   - Deduplicates exact source `ScopeDefinition` object references in `rawConfig.customScopes`.
   - Trims `canonicalName`, deduplicates lowercase aliases, validates against `/^[a-zA-Z][a-zA-Z0-9_-]*$/` (excluding `and`, `or`, `not`), rejects cross-definition collisions (`ERROR_INVALID_CONFIG`), and stores a deeply frozen defensive copy in the private `Map`.
5. **Cache Invalidation Rule**:
   - Changing `timeZone` or `propertyTypes` changes `normalizationFingerprint` and invalidates normalized documents, compiled `PreparedQuery` objects, and cached query results.
   - Changing `customScopes` invalidates compiled `PreparedQuery` objects and cached query results (normalized documents do not depend on `customScopes` and retain their `normalizationFingerprint`).

### 2.2 Native ECMAScript `RegExp`, Centralized Matching & Authorized Queries Contract

- **DSL Delimiter & Escaping Rule**: After DSL literal extraction, regex bodies are interpreted by the runtime’s native `RegExp`. Every delimiter slash `/` inside the DSL regex body must be escaped as `\/`, **including slashes inside character classes** (e.g., `/[\/]/`, not `/[/]/`). Empty regex literals `//` are forbidden by the lexer.
- **Supported Flags**: Only `i`, `m`, `s`, and `u` flags are accepted. Any other flag character (including `g`, `y`, `d`, `v`) or duplicate flag characters (e.g., `/foo/ii`) is rejected at compile time with `SYNTAX_ERROR`.
- **Syntax Validation & Centralized Engine-Owned Matching**: Validated via `new RegExp(pattern, flags)` during compilation. Available ECMAScript regex features depend on the supported JavaScript runtime. If `new RegExp` throws a `SyntaxError`, compilation emits `SYNTAX_ERROR` (`executable: false`). For both built-in and custom scopes, when a `VALUE_LEAF` has `matcher.kind === 'regex'`, the engine evaluates the regex directly against each extracted `target` string (compiling each regex leaf once per `PreparedQuery` in production evaluation). When `matcher.kind === 'string'`, the engine delegates to `scopeDef.matchString(target, matcher.value, matcher.quoted)`.
- **Deployment & Trust Policy**: This engine is intended for queries the vault owner has authorized for execution. It uses native ECMAScript regular expressions and deliberately provides no execution deadline or protection against pathological backtracking. Metadata strings are not length-bounded. Integrations must not treat imported or shared query text as trusted solely because it resides in a local vault.

### 2.3 Built-In Scope Registry Table

| Canonical Name (`scope`) | Accepted Lowercase Aliases                 | `extract(doc)`                                                                                                                         | `matchString(target, queryValue, quoted)` Policy                                                |
| :----------------------- | :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| `file`                   | `file`, `filename`                         | `[doc.file.name, doc.file.basename]`                                                                                                   | Case-insensitive substring (`target.toLowerCase().includes(queryValue.toLowerCase())`).         |
| `path`                   | `path`, `folder`                           | `[doc.file.path]`                                                                                                                      | Case-insensitive substring.                                                                     |
| `ext`                    | `ext`, `extension`                         | `[doc.file.extension]`                                                                                                                 | Strips optional leading `.` from `queryValue`; case-insensitive **exact** equality (`t === q`). |
| `tag`                    | `tag` _(plus `#` shorthand)_               | `doc.tags`                                                                                                                             | Prepends `#` if missing on `queryValue`; matches `t === q \|\| t.startsWith(q + '/')`.          |
| `aliases`                | `aliases`, `alias`                         | `doc.aliases`                                                                                                                          | Case-insensitive substring.                                                                     |
| `headings`               | `headings`, `heading`, `header`, `headers` | `doc.headings.map(h => h.text)`                                                                                                        | Case-insensitive substring.                                                                     |
| `links`                  | `links`, `link`, `outlink`, `outlinks`     | `doc.links.flatMap(l => l.resolvedPath ? [l.link, l.rawTarget, l.resolvedPath, l.displayText] : [l.link, l.rawTarget, l.displayText])` | Case-insensitive substring.                                                                     |
| `embeds`                 | `embeds`, `embed`                          | `doc.embeds.flatMap(e => e.resolvedPath ? [e.link, e.rawTarget, e.resolvedPath] : [e.link, e.rawTarget])`                              | Case-insensitive substring.                                                                     |
| `blocks`                 | `blocks`, `block`                          | `doc.blocks`                                                                                                                           | Strips optional leading `^` from `queryValue`; case-insensitive **exact** equality (`t === q`). |

- **No `resolvedLinks` or Backlink Scopes**: The DSL does not support `resolvedLinks` or backlink scopes (`backlink:`, `backlinks:`, `referencedLinks:`). Normalization and scoped filtering operate strictly on per-note metadata (`links` and `embeds` inspect only outgoing references from the note's own `CachedMetadata`).

### 2.4 Extended Temporal Model: ISO Literals, Relative `@` Anchors, Day Offsets & Positional Ranges (`[s1, e2)` Iff $s_1 < e_2$)

1. **Concrete ISO-8601 Atoms (Allowed in both Stored Properties & Query Literals)**:
   - `YYYY` (authored 4-digit year `1000..9999`)
   - `YYYY-MM` (`MM` in `01..12`)
   - `YYYY-MM-DD` (`DD` strictly validated against `daysInMonth(YYYY, MM)`)
   - `YYYY-MM-DD[+-]\d+d` (ISO day with explicit signed day offset `[+-]N` where $|N| \le 36525$; the offset result may cross into adjacent years outside `1000..9999` provided it remains a valid `Temporal.PlainDate`)
   - `YYYY-MM-DDTHH:mm` or `"YYYY-MM-DD HH:mm"` (with optional `:ss`, optional `.sss...` fractional seconds accepted only after `:ss` and truncated to 3 digits, and optional `Z` or `[+-]HH:?mm` offset where `HH` in `00..23` and `mm` in `00..59`)
2. **Timezone Disambiguation & Interval Duration Rules**:
   - If an explicit offset (`Z` or `[+-]HH:?mm`) is present, `start` is computed using that fixed offset, and `end` adds a fixed elapsed duration: `60_000` ms (`minute`), `1_000` ms (`second`), or `1` ms (`ms`).
   - If no explicit offset is present, wall-clock components are resolved in `resolvedConfig.timeZone` using `Temporal.PlainDateTime.toZonedDateTime(timeZone, { disambiguation: 'compatible' })` (choosing the earlier occurrence for fall-back overlaps and shifting forward by the gap length for spring-forward gaps).
   - Calendar grains (`year`, `quarter`, `month`, `week`, `day`) span from local `00:00:00.000` at the start of the calendar unit to local `00:00:00.000` at the start of the next calendar unit in `resolvedConfig.timeZone`. Time grains (`minute`, `second`, `ms`) add fixed elapsed durations (`60_000`, `1_000`, `1` ms) to `start`.
   - If a timezone transition skips an entire calendar date such that $s \ge e$ (e.g., `Pacific/Apia` `2011-12-30`), parsing returns `{ ok: false, reason: 'SKIPPED_DATE' }`.
3. **Relative `@` Anchors (Allowed in Query Literals Only; Rejected in Stored Properties)**:
   Evaluated against the pinned `referenceTimeMs` in `resolvedConfig.timeZone` (case-insensitive):
   - **`@now`**: Millisecond scalar interval $[t, t + 1)$ where $t = \text{referenceTimeMs}$.
   - **Day-Level Relative Anchors (Accept Optional Explicit Day Offset `[+-]\d+d?` with $|N| \le 36525$ applied on top of the anchor’s base day)**:
     - `@today` / `@thisday` (base delta `0`), `@yesterday` / `@lastday` (base delta `-1`), `@tomorrow` / `@nextday` (base delta `+1`).
     - E.g., `@today-6d..@today` spans 7 calendar days (from 6 days ago at local `00:00` through the end of today at tomorrow’s local `00:00`); `@today-7d..@today` spans 8 calendar days (seven days ago through today, inclusive).
   - **Coarse Relative Anchors (Do NOT Accept Day Offsets)**:
     - `@lastweek`, `@thisweek`, `@nextweek`: ISO-8601 weeks starting on **Monday (`dayOfWeek === 1`) at `00:00`** and ending on the following **Monday at `00:00`** in `resolvedConfig.timeZone`.
     - `@lastmonth`, `@thismonth`, `@nextmonth`: 1st of the month at `00:00` to 1st of the next month at `00:00`.
     - `@lastquarter`, `@thisquarter`, `@nextquarter`: Q1 (`Jan 1..Apr 1`), Q2 (`Apr 1..Jul 1`), Q3 (`Jul 1..Oct 1`), Q4 (`Oct 1..Jan 1`).
     - `@lastyear`, `@thisyear`, `@nextyear`: `Jan 1` at `00:00` to `Jan 1` of the next year at `00:00`.
4. **Positional Range Combination Rule (`<Atom1>..<Atom2>`)**:
   Let `<Atom1>` resolve to $[s_1, e_1)$ and `<Atom2>` resolve to $[s_2, e_2)$:
   - **Left operand (`<Atom1>`)** contributes its inclusive start boundary **$s_1$**.
   - **Right operand (`<Atom2>`)** contributes its exclusive end boundary **$e_2$**.
   - Valid if and only if **$s_1 < e_2$**, producing **$[s_1, e_2)$** with `grain: 'range'`.
     - Note that positional validity ($s_1 < e_2$) does **not** require $s_1 \le s_2$: for example, `2026-10-22..2026` (or `@today..@thisyear` on Oct 22, 2026) has $s_1 = \text{Oct 22, 2026}$ and $e_2 = \text{Jan 1, 2027}$, so $s_1 < e_2$ holds and the range spans from Oct 22, 2026 through the end of 2026! Similarly, `@thisyear..@today` spans from `Jan 1` (`00:00`) through the end of `@today` (tomorrow `00:00`).
   - If **$s_1 \ge e_2$** (empty or reversed range, such as `@today..@today-7d` or `2026-10-01..2026-01-01`):
     - `parseTemporalExpr` returns `{ ok: false, reason: 'REVERSED_RANGE', leftRaw, rightRaw, hint: s2 < e1 ? "Use ${rightRaw}..${leftRaw}" : null }`.
     - **In a Query Literal**: Compilation emits `SYNTAX_ERROR` (`executable: false`) with `hint`.
     - **In a Stored Note Property**: Normalization coerces the value to `{ kind: 'invalid', raw, expectedType, reason: 'REVERSED_DATE_RANGE', hint }` and appends a `DocumentDiagnostic` (`code: 'DOC_REVERSED_DATE_RANGE'`) to `doc.diagnostics`.

### 2.5 Property Type & Comparison Operator Matrix (`[key op rhs]`)

| Resolved Property Type            | `EXISTS` (`[k]`)              | `:` (`[k: expr]`)                                           | `=`, `!=` (`[k = leaf]`)                                                                                                                                | `<`, `>`, `<=`, `>=` (`[k < leaf]`)                                                                                                                      |
| :-------------------------------- | :---------------------------- | :---------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`text` / `multitext` / `tags`** | `true` if $\ge 1$ valid entry | Case-insensitive substring or `/regex/` per entry           | Unquoted or quoted string (no regex). Case-insensitive equality (`a.toLowerCase() === b.toLowerCase()`).                                                | Unquoted or quoted string (no regex). UTF-16 code-unit ordering on `.toLowerCase()` (`a < b`).                                                           |
| **`number`**                      | `true` if $\ge 1$ valid entry | Case-insensitive substring or `/regex/` on `entry.raw`      | Requires **unquoted** valid number literal. Numeric `===` / `!==`.                                                                                      | Requires **unquoted** valid number literal. Numeric `<, >, <=, >=`.                                                                                      |
| **`checkbox`**                    | `true` if $\ge 1$ valid entry | Case-insensitive substring on `"true"`/`"false"` (no regex) | Requires **unquoted** `true` or `false`. Boolean `===` / `!==`.                                                                                         | **Rejected at compile time** (`ERROR_INVALID_OPERATOR_FOR_TYPE`).                                                                                        |
| **`date` / `datetime`**           | `true` if $\ge 1$ valid entry | Case-insensitive substring or `/regex/` on `entry.raw`      | Quoted or unquoted valid temporal expression $Q = [q_s, q_e)$. Containment: `=` is $d_s \ge q_s \land d_e \le q_e$; `!=` is $d_s < q_s \lor d_e > q_e$. | Quoted or unquoted valid temporal expression $Q = [q_s, q_e)$. `<` is $d_e \le q_s$; `>=` is $d_s \ge q_s$; `>` is $d_s \ge q_e$; `<=` is $d_e \le q_e$. |

- **Null & Invalid Entry Rule**: Entries with `typedValue.kind === 'null'` or `typedValue.kind === 'invalid'` **never** satisfy any operator (including `EXISTS` and `!=`).

### 2.6 Virtual `file.*` Properties vs. Stored User Properties

The 9 virtual property keys are `VIRTUAL_FILE_KEYS_LIST` (`file.mtime`, `file.ctime`, `file.size`, `file.ext`, `file.extension`, `file.name`, `file.basename`, `file.path`, `file.parent`), checked via `isVirtualFileKey(key)`:

- In queries (`[file.size > 1024]`), virtual keys **always** resolve against `doc.file` and never inspect `doc.propertyOccurrences`.
- In document normalization (`normalizeObsidianMetadata`), authored properties in frontmatter or inline fields use `resolveUserPropertyType(key, resolvedConfig.propertyTypes)` (which checks `tag`/`tags`, `alias`/`aliases`, and `resolvedConfig.propertyTypes`, without applying virtual `file.*` types to user-authored properties).
- In `collectReferencedPropertyKeys(ast)`, virtual keys (`isVirtualFileKey(k) === true`) are **excluded**, so a query `[file.size > 1024]` never reports diagnostics for a shadowed user property named `"file.size"`.

---

## 3. Normative Lexer, Disambiguated Grammar & Literal Decoding Contract

### 3.1 Syntactic Resource Limits

- **Maximum Query Length**: `4096` UTF-16 code units (checked before lexing; exceeding emits `SYNTAX_ERROR`).
- **Maximum Syntactic Nesting Depth**: `32` levels. Depth is incremented by `+1` only when consuming a unary negation operator (`NOT` or `HyphenNot` in `NotExpression` or `ValueNotExpr`) or opening a parenthesized group (`LParen` in `Parenthesized` or `ValueNotExpr`), enforced before descending into the operand or inner expression. Exceeding `32` aborts parsing and emits `SYNTAX_ERROR`.

### 3.2 Normative Anchor-Free Chevrotain Token Definitions

```typescript
import { createToken, Lexer } from 'chevrotain';

export const WhiteSpace = createToken({
  name: 'WhiteSpace',
  pattern: /\s+/,
  group: Lexer.SKIPPED
});

export const WikiLinkValue = createToken({
  name: 'WikiLinkValue',
  pattern: /\[\[[^\]\r\n]+\]\]/
});

export const LParen = createToken({ name: 'LParen', pattern: /\(/ });
export const RParen = createToken({ name: 'RParen', pattern: /\)/ });
export const LBracket = createToken({ name: 'LBracket', pattern: /\[/ });
export const RBracket = createToken({ name: 'RBracket', pattern: /\]/ });

// Anchor-free boundary assertion: succeeds before whitespace, (), [], or EOF
export const Or = createToken({ name: 'Or', pattern: /OR(?![^\s()\[\]])/ });
export const And = createToken({ name: 'And', pattern: /AND(?![^\s()\[\]])/ });
export const Not = createToken({ name: 'Not', pattern: /NOT(?![^\s()\[\]])/ });

export const HyphenNot = createToken({ name: 'HyphenNot', pattern: /-(?=\S)/ });

// Matches:
// - ISO dates/datetimes (with optional ±Nd day offset on YYYY-MM-DD)
// - @now, @today, @yesterday, @tomorrow, @(last|this|next)(day|week|month|quarter|year) (with optional ±Nd? offset)
// - Any <Atom1>..<Atom2> range (including YYYY..YYYY-MM, 2026-10-22..2026, @thisyear..@today, @today..@today-7d, etc.)
export const DateTimeLiteral = createToken({
  name: 'DateTimeLiteral',
  pattern:
    /(?:(?:\d{4}-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)|(?:[+-]\d+d))?)?|@[a-zA-Z0-9_+-]+)(?:\.\.(?:\d{4}(?:-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)|(?:[+-]\d+d))?)?)?|@[a-zA-Z0-9_+-]+))?|\d{4}\.\.(?:\d{4}(?:-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)|(?:[+-]\d+d))?)?)?|@[a-zA-Z0-9_+-]+))(?![^\s()\[\]])/
});

export const Colon = createToken({ name: 'Colon', pattern: /:/ });
export const CompOp = createToken({ name: 'CompOp', pattern: /!=|>=|<=|>|<|=/ });

export const RegexLiteral = createToken({
  name: 'RegexLiteral',
  pattern: /\/(?:\\.|[^/\\\r\n])+\/[a-zA-Z]*/
});

export const QuotedString = createToken({
  name: 'QuotedString',
  pattern: /"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/
});

export const TagLiteral = createToken({
  name: 'TagLiteral',
  pattern: /#[a-zA-Z0-9_\-/]+/
});

export const Identifier = createToken({
  name: 'Identifier',
  pattern: /[^\s()\[\]:"'><=!]+/
});

export const ALL_TOKENS = [
  WhiteSpace,
  WikiLinkValue,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Or,
  And,
  Not,
  HyphenNot,
  DateTimeLiteral,
  Colon,
  CompOp,
  RegexLiteral,
  QuotedString,
  TagLiteral,
  Identifier
];

export const SearchLexer = new Lexer(ALL_TOKENS);
```

### 3.3 Disambiguated LL(k) Grammar

```ebnf
Query             ::= OrExpression? EOF

OrExpression      ::= AndExpression ( "OR" AndExpression )*

/* Conjunction applies to adjacent NotExpressions without an explicit 'AND' keyword */
AndExpression     ::= NotExpression ( "AND"? NotExpression )*

NotExpression     ::= ( "NOT" | HyphenNot ) NotExpression
                    | Primary

Primary           ::= Parenthesized
                    | PropertyFilter
                    | ScopedOperator
                    | TagShorthand
                    | BareLeafValue

Parenthesized     ::= "(" OrExpression ")"

PropertyFilter    ::= "[" PropertyKey ( ":" ScopeOrPropRhs | CompOp RhsLeafValue )? "]"

ScopedOperator    ::= ScopeName ":" ScopeOrPropRhs

ScopeOrPropRhs    ::= "(" ValueOrExpr ")"
                    | WikiLinkValue
                    | RhsLeafValue

ValueOrExpr       ::= ValueAndExpr ( "OR" ValueAndExpr )*
ValueAndExpr      ::= ValueNotExpr ( "AND"? ValueNotExpr )*
ValueNotExpr      ::= ( "NOT" | HyphenNot ) ValueNotExpr
                    | "(" ValueOrExpr ")"
                    | WikiLinkValue
                    | UnsignedValueLeaf

PropertyKey       ::= QuotedString | Identifier
ScopeName         ::= Identifier
TagShorthand      ::= TagLiteral

BareLeafValue     ::= QuotedString
                    | RegexLiteral
                    | DateTimeLiteral
                    | Identifier

UnsignedValueLeaf ::= QuotedString
                    | RegexLiteral
                    | DateTimeLiteral
                    | TagLiteral
                    | Identifier

RhsLeafValue      ::= QuotedString
                    | RegexLiteral
                    | DateTimeLiteral
                    | TagLiteral
                    | SignedIdentifier

/* HyphenNot and Identifier must be adjacent in source offsets: hyphen.endOffset + 1 === id.startOffset */
SignedIdentifier  ::= HyphenNot? Identifier
```

### 3.4 Normative Literal Decoding & AST Lowering Rules

1. **Empty Query Lowering**: If `Query` contains no `OrExpression` (empty or whitespace-only input), return `ast: { type: 'MATCH_ALL' }`.
2. **`QuotedString` Escape Decoding (`decodeQuotedString(rawTokenText): string`)**:
   Remove the first and last character (the matching `"` or `'` delimiters). Scan the interior left-to-right:
   - When `\` is encountered at index `i` (with `i + 1 < inner.length`):
     - `\"` $\to$ `"`, `\'` $\to$ `'`, `\\` $\to$ `\`, `\n` $\to$ `\n` (LF), `\r` $\to$ `\r` (CR), `\t` $\to$ `\t` (TAB).
     - Any other character `c`: emit both `\` and `c` literally (`\` + `c`), advancing by 2.
   - Returns the decoded `string`. When lowered as a value leaf, wrap in `LeafMatcher: { kind: 'string', value: decodeQuotedString(token.image), quoted: true }`.
3. **Unquoted Leaf Construction (`Identifier`, `DateTimeLiteral`, `TagLiteral`, `SignedIdentifier`)**:
   - For `Identifier`, `DateTimeLiteral`, or `TagLiteral`: `value` is `token.image`, `quoted: false`.
   - For `SignedIdentifier`: if `HyphenNot` is present, verify `hyphenToken.endOffset + 1 === idToken.startOffset` (if whitespace separated them, emit `SYNTAX_ERROR`); combine into `value: "-" + idToken.image`, `quoted: false`.
   - Wrap in `LeafMatcher: { kind: 'string', value, quoted: false }`.
4. **`RegexLiteral` Extraction (`decodeRegexLiteral(rawTokenText): { pattern: string; flags: string }`)**:
   Find the last `/` in `rawTokenText`: `pattern = rawTokenText.slice(1, lastSlashIdx)`, `flags = rawTokenText.slice(lastSlashIdx + 1)`. Wrap in `LeafMatcher: { kind: 'regex', pattern, flags }`.
5. **`WikiLinkValue` Lowering (`decodeWikiLinkValue(rawTokenText): string`)**:
   - `inner = rawTokenText.slice(2, -2)`, `pipeIdx = inner.indexOf('|')`, `target = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim()`.
   - If `target.length === 0`, emit `SYNTAX_ERROR`.
   - Lower to `VALUE_LEAF({ kind: 'string', value: target, quoted: true })` and emit `HINT_WIKILINK_BRACKETS_IN_SCOPE`.
6. **`TagShorthand` Lowering**:
   Lowers to `ScopedFilterNode { type: 'SCOPED_FILTER', scope: 'tag', rawScope: '#', expr: { type: 'VALUE_LEAF', matcher: { kind: 'string', value: token.image, quoted: false } }, span }`.
7. **`PropertyKey` Decoding**:
   If `PropertyKey` is a `QuotedString`, `rawKey = decodeQuotedString(token.image)`; if `Identifier`, `rawKey = token.image`. Set `key = rawKey.trim().toLowerCase()`. If `key.length === 0`, emit `SYNTAX_ERROR`.
8. **Slash-Prefixed Paths vs. `RegexLiteral`**:
   At a token boundary, a slash-prefixed value that matches `RegexLiteral` (such as `path:/projects/active`) is tokenized as regex syntax. Quote path values when they could match `RegexLiteral` (`path:"/projects/active"`). Unquoted paths that do not start with `/` (such as `path:Projects/Active/Archive`) tokenize as `Identifier`.

---

## 4. Semantic Compilation, Production Execution Plan & Diagnostics Contract

### 4.1 Compilation Procedure (`compileQuery(input, resolvedConfig, referenceTimeMs)`)

0. **Validate `referenceTimeMs`**:
   - Verify `isValidReferenceTimeMs(referenceTimeMs)` (`Number.isSafeInteger(referenceTimeMs) && Math.abs(referenceTimeMs) <= MAX_SAFE_EPOCH_MS`). If invalid, emit `ERROR_INVALID_CONFIG` (`span: null`) and return `{ ast: null, prepared: null, diagnostics, executable: false }`.
1. **Check Length & Lex/Parse**:
   - Enforce `input.length <= 4096` and recursion depth $\le 32$. Any lexer error, parser error, or unconsumed token emits `SYNTAX_ERROR` and returns `{ ast: null, prepared: null, diagnostics, executable: false }`.
2. **Validate Every `RegexLiteral`**:
   - Verify `flags` contains only unique characters from `{'i', 'm', 's', 'u'}` and `new RegExp(pattern, flags)` succeeds.
   - **Precedence Rule**: If a `RegexLiteral` fails validation (e.g., `[priority = /foo(/]`), emit `SYNTAX_ERROR` on that leaf and **skip all Step 4 operator and type validation on any `PropertyFilterNode` containing that invalid regex leaf**.
3. **Resolve Scopes**:
   - If `rawScope === '#'`, construct the `ScopedFilterNode` with `scope: 'tag'`.
   - Otherwise look up `resolvedConfig.getScope(rawScope)`. If found, construct the `ScopedFilterNode` with `scope: def.canonicalName` (do not mutate `readonly` properties on already-constructed public AST nodes). If not found, emit `ERROR_UNKNOWN_SCOPE`.
4. **Validate Property Filters (With Short-Circuit Precedence)**:
   - Skip any `PropertyFilterNode` whose `valueExpr` already failed Step 2 regex syntax validation.
   - Resolve `propType = resolveQueryPropertyType(node.key, resolvedConfig.propertyTypes)`.
   - If `node.operator === 'EXISTS'`, validation succeeds.
   - Otherwise, inspect `node.valueExpr` leaves:
     - **Step 4a (Operator / Matcher Kind Compatibility First)**:
       - If `node.operator` is `=`, `!=`, `<`, `>`, `<=`, or `>=`, and `valueExpr` contains a valid `regex` leaf $\to$ emit `ERROR_INVALID_OPERATOR_FOR_TYPE` and **stop validating this `PropertyFilterNode`**.
       - If `propType === 'checkbox'` and (`node.operator` is `<, >, <=, >=` OR (`node.operator === ':'` and `valueExpr` contains a valid `regex` leaf)) $\to$ emit `ERROR_INVALID_OPERATOR_FOR_TYPE` and **stop validating this `PropertyFilterNode`**.
     - **Step 4b (Leaf Literal Value Validation for `=`, `!=`, `<`, `>`, `<=`, `>=`)**:
       - If `propType === 'checkbox'`: leaf must be unquoted `"true"` or `"false"` (case-insensitive), else emit `ERROR_TYPE_MISMATCH`.
       - If `propType === 'number'`: leaf must be unquoted, match `/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/`, and parse to a finite number, else emit `ERROR_TYPE_MISMATCH`.
       - If `propType === 'date' || propType === 'datetime'`:
         Call `res = parseTemporalExpr(leaf.value, { allowYearOnly: true, allowRelative: true, timeZone: resolvedConfig.timeZone, referenceTimeMs })`:
         - If `!res.ok && res.reason === 'REVERSED_RANGE'`, emit **`SYNTAX_ERROR`** with `issue: "The left endpoint '${res.leftRaw}' starts on or after the exclusive end contributed by the right endpoint '${res.rightRaw}'."` and `hint: res.hint`.
         - If `!res.ok` (any other reason), emit **`ERROR_TYPE_MISMATCH`**.
5. **Run Non-Blocking Linter Pass** (Section 4.3).
6. **Enforce Global Compile Gate & Deeply Freeze `PreparedQuery`**:

   ```typescript
   const hasErrors = diagnostics.some((d) => d.severity === 'error');
   if (hasErrors || !ast) {
     return { ast: null, prepared: null, diagnostics, executable: false };
   }
   const frozenAst = deepFreezeAST(ast);
   const prepared: PreparedQuery = Object.freeze({
     __brand: 'PreparedQuery' as const,
     ast: frozenAst,
     resolvedConfig,
     referenceTimeMs
   });
   return { ast: frozenAst, prepared, diagnostics, executable: true };
   ```

### 4.2 Normative Evaluation Rules & Diagnostic Collection (`evaluateVault(docs, prepared)`)

1. **Production Execution Plan Reuse vs. Reference Oracle**:
   - Production query preparation (`compileQuery` / `evaluateVault`) **must** compile each `RegExp` leaf and parse each typed comparison literal (`number`, `checkbox` boolean, and `DateInterval` resolved at `prepared.referenceTimeMs`) **once per `PreparedQuery`** (for example, storing the compiled execution plan in an internal `WeakMap<PreparedQuery, ExecutionPlan>` so repeated `evaluateVault(docs, prepared)` calls reuse the same compiled regexes and intervals without recompiling). Because regex matching is owned centrally by the engine (while `ScopeDefinition.matchString` handles string leaves), once-per-query regex compilation applies uniformly to both built-in and custom scopes.
   - The reference oracle (`oracleEvaluateVault` / `oracleEvaluateDoc`) consumes the same `PreparedQuery` (guaranteeing identical `resolvedConfig` and `referenceTimeMs`) and may repeat regex construction and literal parsing per candidate for simplicity.
2. **Document Normalization Compatibility Check**:
   - Before evaluating any document `doc` in `docs`, both `evaluateVault` and `oracleEvaluateVault` verify `doc.normalizationFingerprint === prepared.resolvedConfig.normalizationFingerprint`. If any document has a mismatched fingerprint, evaluation throws an Error.
3. **Existential Property Quantifier**: `[key op rhs]` evaluates `doc.propertyOccurrences` (or virtual `file.*` entries) for `key`, discarding `{ kind: 'null' }` and `{ kind: 'invalid' }`. Returns `true` iff **at least one** valid entry satisfies `op` against `rhs`.
4. **Per-Entry Property `:` Groups**: `[status: (draft AND active)]` evaluates `draft AND active` against **one single property value** at a time.
5. **Per-Target Scoped Groups**: `scope:(expr)` extracts `targets = scopeDef.extract(doc)` and returns `true` iff **at least one single string $t \in \text{targets}$** satisfies the entire `expr`. If `targets` is empty, `scope:(expr)` is **always `false`** (even when `expr` contains negation).
6. **Quoting Policy**: Quoting affects token grouping and escaping (and disallows numeric/boolean coercion on `=`, `!=`, `<`, `>`, `<=`, `>=`), **not** the scope’s matching policy. Each scope retains its registered `matchString` policy.
7. **Deterministic Input-Order Preservation & Query-Scoped Diagnostic Collection**:
   - `evaluateVault(docs, prepared)` preserves the exact input order of `docs` in `report.matches`.
   - `collectReferencedPropertyKeys(prepared.ast)` traverses the entire `SearchAST` (including `[key]` existence filters, negated branches, and short-circuited branches) and collects all `PropertyFilterNode.key` values where `isVirtualFileKey(key) === false`.
   - Across all `docs` in input order, every `DocumentDiagnostic` in `doc.diagnostics` whose `propertyKey` is in `queriedKeys` is appended to `report.propertyDiagnostics` in exact document, occurrence (`occurrenceIndex`), and array-element (`valueIndex`) order, preserving one diagnostic per invalid value (without deduplication).

### 4.3 Diagnostic & Hint Trigger Catalog (Emitted Once Per Offending AST Node / Edge)

| Code                              | Severity  | Exact Trigger Condition                                                                                                                                                                                                                                                                     | Issue & Hint                                                                                                                        |
| :-------------------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------- |
| `SYNTAX_ERROR`                    | `error`   | Query $> 4096$ chars, recursion depth $> 32$, lexer/parser error, empty `WikiLinkValue` / `PropertyKey`, invalid/duplicate regex flags, `new RegExp` `SyntaxError`, or **reversed/empty date range (`s1 >= e2` in `<Atom1>..<Atom2>`)**. _(Short-circuits Step 4 validation on that node)._ | Blocks execution. For reversed date ranges, sets `hint: "Use ${rightRaw}..${leftRaw}"` (when `s2 < e1`).                            |
| `ERROR_INVALID_CONFIG`            | `error`   | Invalid IANA `timeZone`, invalid `referenceTimeMs`, invalid `ObsidianPropertyType`, conflicting property-key casing types, or scope alias collision across different definitions.                                                                                                           | Returned by `initEngineConfig` or Step 0 of `compileQuery`.                                                                         |
| `ERROR_UNKNOWN_SCOPE`             | `error`   | `ScopedFilterNode` (with `rawScope !== '#'`) not found via `resolvedConfig.getScope(rawScope)`.                                                                                                                                                                                             | Suggests closest scope via Levenshtein ($\le 2$) or synonym (`tags` $\to$ `tag`, `prop` $\to$ `[prop:]`).                           |
| `ERROR_INVALID_OPERATOR_FOR_TYPE` | `error`   | Valid regex used with `=`, `!=`, `<`, `>`, `<=`, `>=` (any type) or with `:` on `checkbox`; or `<, >, <=, >=` used on `checkbox`. _(Checked before `ERROR_TYPE_MISMATCH`)._                                                                                                                 | `Operator "${op}" cannot be used with ${propType}/regex.`                                                                           |
| `ERROR_TYPE_MISMATCH`             | `error`   | Non-regex leaf in `[key op val]` fails validation for `key`‘s resolved `ObsidianPropertyType` (excluding `REVERSED_RANGE`, which emits `SYNTAX_ERROR`).                                                                                                                                     | `"${val}" is not a valid ${propType} for property "${key}".`                                                                        |
| `WARN_UNQUOTED_MULTIWORD_SCOPE`   | `warning` | Checked during CST-to-AST construction before flattening: an adjacent pair `(left, right)` joined without an explicit `AND` token where `left` is a `ScopedFilterNode` with an unquoted string leaf and `right` is a bare `TextMatchNode` on the same `startLine`.                          | `"${next}" is searched as a separate term, not inside "${scope}:".` Hint: `Use ${scope}:"${val} ${next}"`                           |
| `WARN_LOWERCASE_BOOLEAN`          | `warning` | Bare unquoted `TextMatchNode` has `rawText` in `{"and", "or", "not"}` (case-insensitive, excluding exact uppercase).                                                                                                                                                                        | `Lowercase "${rawText}" is searched as literal text.` Hint: `Use uppercase "${rawText.toUpperCase()}".`                             |
| `WARN_DANGEROUS_SPACED_HYPHEN`    | `warning` | Bare unquoted `TextMatchNode` has `rawText === "-"` immediately preceding another sibling in an `AndExpression`.                                                                                                                                                                            | `A space after "-" prevents negation.` Hint: `Use "-term" or "NOT term".`                                                           |
| `WARN_SINGLE_VALUE_CONTRADICTION` | `warning` | An `AND` node contains two direct equality predicates on the **same canonical single-valued field** (`ext:` / `[file.ext = ...]`, `[file.name = ...]`, `[file.basename = ...]`, `[file.path = ...]`, `[file.parent = ...]`) with different normalized target values.                        | `A single file cannot match both "${a}" and "${b}" on the same single-valued field.` Hint: `Did you mean "OR"?`                     |
| `HINT_PROP_NEQ_EXISTENCE`         | `hint`    | Every `PropertyFilterNode` with `operator === '!='`.                                                                                                                                                                                                                                        | `"[${key} != ...]" requires "${key}" to exist.` Hint: `To exclude notes (including notes missing "${key}"), use "-[${key} = ...]".` |
| `HINT_AMBIGUOUS_PRECEDENCE`       | `hint`    | An `OR` `LogicalNode` has a child `AND` `LogicalNode` with `parenthesized !== true`.                                                                                                                                                                                                        | `Evaluated as "(A AND B) OR C".` Hint: `Add parentheses to make precedence explicit.`                                               |
| `HINT_WIKILINK_BRACKETS_IN_SCOPE` | `hint`    | Every `WikiLinkValue` token lowered into a `VALUE_LEAF`.                                                                                                                                                                                                                                    | `Wikilink brackets "[[...]]" are not needed.` Hint: `Stripped "[[...]]" automatically.`                                             |
| `HINT_BARE_TEXT_NO_BODY`          | `hint`    | Every document-level `TextMatchNode` (unless already flagged by `WARN_LOWERCASE_BOOLEAN` or `WARN_DANGEROUS_SPACED_HYPHEN`).                                                                                                                                                                | `Bare terms only search filenames, paths, aliases, and tags (note body is not indexed).`                                            |

---

## 5. Reference Normalizer, Positional Range Engine, Deep AST Freezer & Oracle Evaluator (`reference-engine.ts`)

> **Implementation Scope Note**: The reference module below provides the normative implementation of `initEngineConfig`, `parseTemporalExpr`, `normalizeObsidianMetadata`, `deepFreezeAST`, `normalizeAST`, and `oracleEvaluateVault` / `oracleEvaluateDoc`. The implementation team is responsible for implementing the Chevrotain `SearchParser`, `compileQuery` (returning `PreparedQuery`), `evaluateVault` (with once-per-query compiled regex/literal caching), and the `fast-check` test suite in `search.spec.ts`.

```typescript
import { Temporal } from '@js-temporal/polyfill';
import {
  ConfigResult,
  DateInterval,
  DateParseResult,
  DocumentDiagnostic,
  EngineConfig,
  isValidPropertyType,
  isVirtualFileKey,
  LeafMatcher,
  LogicalNode,
  NormalizedDocument,
  ObsidianPropertyType,
  PreparedQuery,
  PropertyOccurrence,
  PropertyOperator,
  PropertyTypeRegistry,
  ResolvedEngineConfig,
  SanitizedScalar,
  ScopeDefinition,
  SearchAST,
  SearchDiagnostic,
  TypedPropertyValue,
  ValueExprAST,
  VaultEvaluationReport
} from './types';

// ============================================================================
// 1. NATIVE REGEXP VALIDATOR, DEEP AST FREEZER & LITERAL DECODERS
// ============================================================================

const ALLOWED_REGEX_FLAGS = new Set(['i', 'm', 's', 'u']);

export function validateRegexLiteral(pattern: string, flags: string): RegExp | null {
  const seen = new Set<string>();
  for (const ch of flags) {
    if (!ALLOWED_REGEX_FLAGS.has(ch) || seen.has(ch)) return null;
    seen.add(ch);
  }
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function testRegex(target: string, leaf: Extract<LeafMatcher, { kind: 'regex' }>): boolean {
  const rx = validateRegexLiteral(leaf.pattern, leaf.flags);
  if (!rx) throw new Error(`Invalid regex literal in AST: /${leaf.pattern}/${leaf.flags}`);
  return rx.test(target);
}

export function deepFreezeValueExprAST(expr: ValueExprAST): ValueExprAST {
  if (expr.type === 'VALUE_LEAF') {
    Object.freeze(expr.matcher);
    return Object.freeze(expr);
  }
  if (expr.type === 'VALUE_NOT') {
    deepFreezeValueExprAST(expr.child);
    return Object.freeze(expr);
  }
  for (const c of expr.children) deepFreezeValueExprAST(c);
  Object.freeze(expr.children);
  return Object.freeze(expr);
}

export function deepFreezeAST(ast: SearchAST): SearchAST {
  if (ast.type === 'MATCH_ALL') return Object.freeze(ast);
  if ('span' in ast && ast.span) Object.freeze(ast.span);

  switch (ast.type) {
    case 'TEXT_MATCH':
      Object.freeze(ast.matcher);
      return Object.freeze(ast);
    case 'NOT':
      deepFreezeAST(ast.child);
      return Object.freeze(ast);
    case 'SCOPED_FILTER':
      deepFreezeValueExprAST(ast.expr);
      return Object.freeze(ast);
    case 'PROPERTY_FILTER':
      if (ast.valueExpr) deepFreezeValueExprAST(ast.valueExpr);
      return Object.freeze(ast);
    case 'LOGICAL':
      for (const c of ast.children) deepFreezeAST(c);
      Object.freeze(ast.children);
      return Object.freeze(ast);
  }
}

export function decodeQuotedString(rawTokenText: string): string {
  const inner = rawTokenText.slice(1, -1);
  let out = '';
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '"' || next === "'" || next === '\\') out += next;
      else if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else out += '\\' + next;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function decodeRegexLiteral(rawTokenText: string): { pattern: string; flags: string } {
  const lastSlash = rawTokenText.lastIndexOf('/');
  return {
    pattern: rawTokenText.slice(1, lastSlash),
    flags: rawTokenText.slice(lastSlash + 1)
  };
}

export function decodeWikiLinkValue(rawTokenText: string): string {
  const inner = rawTokenText.slice(2, -2);
  const pipeIdx = inner.indexOf('|');
  return (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
}

// ============================================================================
// 2. BUILT-IN SCOPE REGISTRY & FROZEN CONFIG INITIALIZER
// ============================================================================

const substringStringMatch = (target: string, queryValue: string): boolean =>
  target.toLowerCase().includes(queryValue.toLowerCase());

export const BUILT_IN_SCOPES: readonly ScopeDefinition[] = Object.freeze(
  [
    {
      canonicalName: 'file',
      aliases: Object.freeze(['file', 'filename']),
      extract: (doc: NormalizedDocument) => [doc.file.name, doc.file.basename],
      matchString: substringStringMatch
    },
    {
      canonicalName: 'path',
      aliases: Object.freeze(['path', 'folder']),
      extract: (doc: NormalizedDocument) => [doc.file.path],
      matchString: substringStringMatch
    },
    {
      canonicalName: 'ext',
      aliases: Object.freeze(['ext', 'extension']),
      extract: (doc: NormalizedDocument) => [doc.file.extension],
      matchString: (target: string, queryValue: string) => {
        const q = queryValue.toLowerCase();
        const normQ = q.startsWith('.') ? q.slice(1) : q;
        return target.toLowerCase() === normQ;
      }
    },
    {
      canonicalName: 'tag',
      aliases: Object.freeze(['tag']),
      extract: (doc: NormalizedDocument) => doc.tags,
      matchString: (target: string, queryValue: string) => {
        const q = queryValue.toLowerCase();
        const normQ = q.startsWith('#') ? q : `#${q}`;
        const t = target.toLowerCase();
        return t === normQ || t.startsWith(`${normQ}/`);
      }
    },
    {
      canonicalName: 'aliases',
      aliases: Object.freeze(['aliases', 'alias']),
      extract: (doc: NormalizedDocument) => doc.aliases,
      matchString: substringStringMatch
    },
    {
      canonicalName: 'headings',
      aliases: Object.freeze(['headings', 'heading', 'header', 'headers']),
      extract: (doc: NormalizedDocument) => doc.headings.map((h) => h.text),
      matchString: substringStringMatch
    },
    {
      canonicalName: 'links',
      aliases: Object.freeze(['links', 'link', 'outlink', 'outlinks']),
      extract: (doc: NormalizedDocument) =>
        doc.links.flatMap((l) =>
          l.resolvedPath
            ? [l.link, l.rawTarget, l.resolvedPath, l.displayText]
            : [l.link, l.rawTarget, l.displayText]
        ),
      matchString: substringStringMatch
    },
    {
      canonicalName: 'embeds',
      aliases: Object.freeze(['embeds', 'embed']),
      extract: (doc: NormalizedDocument) =>
        doc.embeds.flatMap((e) =>
          e.resolvedPath ? [e.link, e.rawTarget, e.resolvedPath] : [e.link, e.rawTarget]
        ),
      matchString: substringStringMatch
    },
    {
      canonicalName: 'blocks',
      aliases: Object.freeze(['blocks', 'block']),
      extract: (doc: NormalizedDocument) => doc.blocks,
      matchString: (target: string, queryValue: string) => {
        const q = queryValue.toLowerCase();
        const normQ = q.startsWith('^') ? q.slice(1) : q;
        return target.toLowerCase() === normQ;
      }
    }
  ].map((s) => Object.freeze(s))
);

const VALID_SCOPE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const RESERVED_KEYWORDS = new Set(['and', 'or', 'not']);

export function initEngineConfig(
  rawConfig: EngineConfig = { timeZone: 'UTC', propertyTypes: {} }
): ConfigResult {
  const diagnostics: SearchDiagnostic[] = [];
  const tz = typeof rawConfig.timeZone === 'string' ? rawConfig.timeZone.trim() : '';

  try {
    if (!tz) throw new RangeError('Empty timeZone');
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    diagnostics.push({
      code: 'ERROR_INVALID_CONFIG',
      severity: 'error',
      issue: `Invalid IANA timeZone: "${rawConfig.timeZone}".`,
      hint: 'Provide a valid IANA timeZone such as "UTC" or "America/New_York".',
      span: null
    });
  }

  const normalizedTypes: PropertyTypeRegistry = Object.create(null);
  for (const [rawKey, propType] of Object.entries(rawConfig.propertyTypes ?? {})) {
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    if (!isValidPropertyType(propType)) {
      diagnostics.push({
        code: 'ERROR_INVALID_CONFIG',
        severity: 'error',
        issue: `Unsupported ObsidianPropertyType "${String(propType)}" for key "${rawKey}".`,
        hint: 'Allowed types: text, multitext, number, checkbox, date, datetime, tags.',
        span: null
      });
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(normalizedTypes, key) &&
      normalizedTypes[key] !== propType
    ) {
      diagnostics.push({
        code: 'ERROR_INVALID_CONFIG',
        severity: 'error',
        issue: `Conflicting property types for normalized key "${key}": "${normalizedTypes[key]}" vs "${propType}".`,
        hint: `Assign a single consistent type to "${key}".`,
        span: null
      });
      continue;
    }
    normalizedTypes[key] = propType;
  }

  const privateScopeMap = new Map<string, ScopeDefinition>();
  const seenSourceDefs = new Set<ScopeDefinition>();

  const registerDef = (def: ScopeDefinition, isCustom: boolean) => {
    if (seenSourceDefs.has(def)) return;
    seenSourceDefs.add(def);

    const trimmedCanon = def.canonicalName.trim();
    const dedupedNames = Array.from(
      new Set<string>([
        trimmedCanon.toLowerCase(),
        ...def.aliases.map((a) => a.trim().toLowerCase())
      ])
    );

    const frozenClone: ScopeDefinition = Object.freeze({
      canonicalName: trimmedCanon,
      aliases: Object.freeze(dedupedNames),
      extract: def.extract,
      matchString: def.matchString
    });

    for (const name of dedupedNames) {
      if (isCustom && (!VALID_SCOPE_NAME_RE.test(name) || RESERVED_KEYWORDS.has(name))) {
        diagnostics.push({
          code: 'ERROR_INVALID_CONFIG',
          severity: 'error',
          issue: `Invalid custom scope name or alias "${name}".`,
          hint: 'Scope names must match /^[a-zA-Z][a-zA-Z0-9_-]*$/ and cannot be AND, OR, or NOT.',
          span: null
        });
        continue;
      }
      const existing = privateScopeMap.get(name);
      if (existing && existing !== frozenClone) {
        diagnostics.push({
          code: 'ERROR_INVALID_CONFIG',
          severity: 'error',
          issue: `Scope name "${name}" collides with existing scope "${existing.canonicalName}".`,
          hint: `Choose a unique canonical name and alias list for "${trimmedCanon}".`,
          span: null
        });
        continue;
      }
      privateScopeMap.set(name, frozenClone);
    }
  };

  for (const builtIn of BUILT_IN_SCOPES) registerDef(builtIn, false);
  for (const custom of rawConfig.customScopes ?? []) registerDef(custom, true);

  if (diagnostics.length > 0) {
    return { ok: false, config: null, diagnostics: Object.freeze(diagnostics) };
  }

  const frozenTypes = Object.freeze(normalizedTypes);
  const allNames = Object.freeze(Array.from(privateScopeMap.keys()));
  const sortedTypePairs = Object.keys(frozenTypes)
    .sort()
    .map((k) => [k, frozenTypes[k]]);
  const normalizationFingerprint = JSON.stringify({ tz, types: sortedTypePairs });

  const resolved: ResolvedEngineConfig = Object.freeze({
    __brand: 'ResolvedEngineConfig' as const,
    timeZone: tz,
    propertyTypes: frozenTypes,
    normalizationFingerprint,
    getScope: (nameOrAlias: string) => privateScopeMap.get(nameOrAlias.trim().toLowerCase()),
    getAllScopeNames: () => allNames
  });

  return { ok: true, config: resolved, diagnostics: Object.freeze([]) };
}

// ============================================================================
// 3. NORMATIVE TEMPORAL ENGINE (ISO ATOMS, @ RELATIVE ANCHORS, OFFSETS & RANGES)
// ============================================================================

const STRICT_ISO_ATOM_RE =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:([+-]\d+)d|[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):?(\d{2}))?)?)?)?$/;

const RELATIVE_DAY_RE = /^@(today|yesterday|tomorrow|(?:last|this|next)day)(?:([+-]\d+)d?)?$/i;
const RELATIVE_COARSE_RE = /^@(last|this|next)(week|month|quarter|year)$/i;

export const MAX_SAFE_EPOCH_MS = 8_640_000_000_000_000;
const MAX_DAY_OFFSET = 36_525;

export function isValidReferenceTimeMs(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && Math.abs(val) <= MAX_SAFE_EPOCH_MS;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
    case 4: case 6: case 9: case 11: return 30;
    case 2: return isLeapYear(year) ? 29 : 28;
    default: return 0;
  }
}

export function wallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string
): number {
  const pdt = new Temporal.PlainDateTime(year, month, day, hour, minute, second, ms);
  const zdt = pdt.toZonedDateTime(timeZone, { disambiguation: 'compatible' });
  return zdt.epochMilliseconds;
}

function plainDateToDayInterval(pd: Temporal.PlainDate, timeZone: string, raw: string): DateInterval {
  const nextDay = pd.add({ days: 1 });
  const start = wallClockToUtcMs(pd.year, pd.month, pd.day, 0, 0, 0, 0, timeZone);
  const end = wallClockToUtcMs(nextDay.year, nextDay.month, nextDay.day, 0, 0, 0, 0, timeZone);
  return Object.freeze({ start, end, grain: 'day' as const, raw });
}

function parseSingleTemporalAtom(
  rawAtom: string,
  opts: {
    allowYearOnly: boolean;
    allowRelative: boolean;
    timeZone: string;
    referenceTimeMs?: number;
  }
): DateParseResult {
  const str = rawAtom.trim();
  const { allowYearOnly, allowRelative, timeZone, referenceTimeMs } = opts;

  if (str.startsWith('@')) {
    if (!allowRelative) return { ok: false, reason: 'RELATIVE_NOT_ALLOWED' };
    if (!isValidReferenceTimeMs(referenceTimeMs)) {
      return { ok: false, reason: 'INVALID_FORMAT' };
    }
    const lower = str.toLowerCase();

    if (lower === '@now') {
      return {
        ok: true,
        interval: Object.freeze({ start: referenceTimeMs, end: referenceTimeMs + 1, grain: 'ms', raw: str })
      };
    }

    let todayDate: Temporal.PlainDate;
    try {
      todayDate = Temporal.Instant.fromEpochMilliseconds(referenceTimeMs)
        .toZonedDateTimeISO(timeZone)
        .toPlainDate();
    } catch {
      return { ok: false, reason: 'INVALID_FORMAT' };
    }

    const dayMatch = RELATIVE_DAY_RE.exec(str);
    if (dayMatch) {
      const anchor = dayMatch[1].toLowerCase();
      const offsetStr = dayMatch[2];
      let baseDelta = 0;
      if (anchor === 'yesterday' || anchor === 'lastday') baseDelta = -1;
      else if (anchor === 'tomorrow' || anchor === 'nextday') baseDelta = 1;

      let extraOffset = 0;
      if (offsetStr !== undefined) {
        extraOffset = Number(offsetStr);
        if (!Number.isSafeInteger(extraOffset) || Math.abs(extraOffset) > MAX_DAY_OFFSET) {
          return { ok: false, reason: 'INVALID_FORMAT' };
        }
      }
      try {
        const targetDate = todayDate.add({ days: baseDelta + extraOffset });
        const interval = plainDateToDayInterval(targetDate, timeZone, str);
        if (!Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end)) {
          return { ok: false, reason: 'INVALID_FORMAT' };
        }
        if (interval.start >= interval.end) return { ok: false, reason: 'SKIPPED_DATE' };
        return { ok: true, interval };
      } catch {
        return { ok: false, reason: 'INVALID_FORMAT' };
      }
    }

    const coarseMatch = RELATIVE_COARSE_RE.exec(str);
    if (coarseMatch) {
      const dir = coarseMatch[1].toLowerCase();
      const unit = coarseMatch[2].toLowerCase();
      const shift = dir === 'last' ? -1 : dir === 'next' ? 1 : 0;

      try {
        if (unit === 'week') {
          const currentMonday = todayDate.subtract({ days: todayDate.dayOfWeek - 1 }).add({ weeks: shift });
          const nextMonday = currentMonday.add({ weeks: 1 });
          const start = wallClockToUtcMs(currentMonday.year, currentMonday.month, currentMonday.day, 0, 0, 0, 0, timeZone);
          const end = wallClockToUtcMs(nextMonday.year, nextMonday.month, nextMonday.day, 0, 0, 0, 0, timeZone);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { ok: false, reason: 'INVALID_FORMAT' };
          if (start >= end) return { ok: false, reason: 'SKIPPED_DATE' };
          return { ok: true, interval: Object.freeze({ start, end, grain: 'week', raw: str }) };
        }
        if (unit === 'month') {
          const firstOfThisMonth = Temporal.PlainDate.from({ year: todayDate.year, month: todayDate.month, day: 1 });
          const targetMonthStart = firstOfThisMonth.add({ months: shift });
          const nextMonthStart = targetMonthStart.add({ months: 1 });
          const start = wallClockToUtcMs(targetMonthStart.year, targetMonthStart.month, 1, 0, 0, 0, 0, timeZone);
          const end = wallClockToUtcMs(nextMonthStart.year, nextMonthStart.month, 1, 0, 0, 0, 0, timeZone);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { ok: false, reason: 'INVALID_FORMAT' };
          if (start >= end) return { ok: false, reason: 'SKIPPED_DATE' };
          return { ok: true, interval: Object.freeze({ start, end, grain: 'month', raw: str }) };
        }
        if (unit === 'quarter') {
          const currentQuarterStartMonth = Math.floor((todayDate.month - 1) / 3) * 3 + 1;
          const firstOfThisQuarter = Temporal.PlainDate.from({ year: todayDate.year, month: currentQuarterStartMonth, day: 1 });
          const targetQuarterStart = firstOfThisQuarter.add({ months: shift * 3 });
          const nextQuarterStart = targetQuarterStart.add({ months: 3 });
          const start = wallClockToUtcMs(targetQuarterStart.year, targetQuarterStart.month, 1, 0, 0, 0, 0, timeZone);
          const end = wallClockToUtcMs(nextQuarterStart.year, nextQuarterStart.month, 1, 0, 0, 0, 0, timeZone);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { ok: false, reason: 'INVALID_FORMAT' };
          if (start >= end) return { ok: false, reason: 'SKIPPED_DATE' };
          return { ok: true, interval: Object.freeze({ start, end, grain: 'quarter', raw: str }) };
        }
        if (unit === 'year') {
          const targetYear = todayDate.year + shift;
          const start = wallClockToUtcMs(targetYear, 1, 1, 0, 0, 0, 0, timeZone);
          const end = wallClockToUtcMs(targetYear + 1, 1, 1, 0, 0, 0, 0, timeZone);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { ok: false, reason: 'INVALID_FORMAT' };
          if (start >= end) return { ok: false, reason: 'SKIPPED_DATE' };
          return { ok: true, interval: Object.freeze({ start, end, grain: 'year', raw: str }) };
        }
      } catch {
        return { ok: false, reason: 'INVALID_FORMAT' };
      }
    }

    return { ok: false, reason: 'INVALID_FORMAT' };
  }

  const m = STRICT_ISO_ATOM_RE.exec(str);
  if (!m) return { ok: false, reason: 'INVALID_FORMAT' };

  const [, yStr, moStr, dStr, isoDayOffsetStr, hStr, miStr, sStr, fracStr, tzFull, tzSign, tzHStr, tzMStr] = m;
  if (!moStr && !allowYearOnly) return { ok: false, reason: 'INVALID_FORMAT' };
  if (str.includes(' ') && !hStr) return { ok: false, reason: 'INVALID_FORMAT' };

  const year = Number(yStr);
  if (year < 1000 || year > 9999) return { ok: false, reason: 'INVALID_FORMAT' };

  const month = moStr ? Number(moStr) : 1;
  if (month < 1 || month > 12) return { ok: false, reason: 'INVALID_FORMAT' };

  const maxDay = daysInMonth(year, month);
  const day = dStr ? Number(dStr) : 1;
  if (day < 1 || day > maxDay) return { ok: false, reason: 'INVALID_FORMAT' };

  const hour = hStr ? Number(hStr) : 0;
  const minute = miStr ? Number(miStr) : 0;
  const second = sStr ? Number(sStr) : 0;
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'INVALID_FORMAT' };

  const ms = fracStr ? Number(fracStr.slice(0, 3).padEnd(3, '0')) : 0;

  let interval: DateInterval;
  try {
    if (tzFull) {
      let explicitOffsetMs = 0;
      if (tzFull !== 'Z') {
        const tzH = Number(tzHStr);
        const tzM = Number(tzMStr);
        if (tzH > 23 || tzM > 59) return { ok: false, reason: 'INVALID_FORMAT' };
        explicitOffsetMs = (tzSign === '-' ? -1 : 1) * (tzH * 60 + tzM) * 60_000;
      }
      const start = Date.UTC(year, month - 1, day, hour, minute, second, ms) - explicitOffsetMs;
      if (!sStr) interval = Object.freeze({ start, end: start + 60_000, grain: 'minute', raw: str });
      else if (!fracStr) interval = Object.freeze({ start, end: start + 1_000, grain: 'second', raw: str });
      else interval = Object.freeze({ start, end: start + 1, grain: 'ms', raw: str });
    } else if (!moStr) {
      const start = wallClockToUtcMs(year, 1, 1, 0, 0, 0, 0, timeZone);
      const end = wallClockToUtcMs(year + 1, 1, 1, 0, 0, 0, 0, timeZone);
      interval = Object.freeze({ start, end, grain: 'year', raw: str });
    } else if (!dStr) {
      const nextY = month === 12 ? year + 1 : year;
      const nextM = month === 12 ? 1 : month + 1;
      const start = wallClockToUtcMs(year, month, 1, 0, 0, 0, 0, timeZone);
      const end = wallClockToUtcMs(nextY, nextM, 1, 0, 0, 0, 0, timeZone);
      interval = Object.freeze({ start, end, grain: 'month', raw: str });
    } else if (!hStr) {
      let baseDate = Temporal.PlainDate.from({ year, month, day });
      if (isoDayOffsetStr !== undefined) {
        const delta = Number(isoDayOffsetStr);
        if (!Number.isSafeInteger(delta) || Math.abs(delta) > MAX_DAY_OFFSET) {
          return { ok: false, reason: 'INVALID_FORMAT' };
        }
        baseDate = baseDate.add({ days: delta });
      }
      interval = plainDateToDayInterval(baseDate, timeZone, str);
    } else {
      const start = wallClockToUtcMs(year, month, day, hour, minute, second, ms, timeZone);
      if (!sStr) interval = Object.freeze({ start, end: start + 60_000, grain: 'minute', raw: str });
      else if (!fracStr) interval = Object.freeze({ start, end: start + 1_000, grain: 'second', raw: str });
      else interval = Object.freeze({ start, end: start + 1, grain: 'ms', raw: str });
    }
  } catch {
    return { ok: false, reason: 'INVALID_FORMAT' };
  }

  if (!Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end)) {
    return { ok: false, reason: 'INVALID_FORMAT' };
  }
  if (interval.start >= interval.end) {
    return { ok: false, reason: 'SKIPPED_DATE' };
  }
  return { ok: true, interval };
}

/**
 * Full Temporal Expression Parser.
 * Positional Range Rule: `<Atom1>..<Atom2>` combines into `[s1, e2)` iff `s1 < e2`.
 * If `s1 >= e2`, returns `REVERSED_RANGE` with `hint: "Use ${rightRaw}..${leftRaw}"` when `s2 < e1`.
 */
export function parseTemporalExpr(
  rawInput: string,
  opts: {
    allowYearOnly: boolean;
    allowRelative: boolean;
    timeZone: string;
    referenceTimeMs?: number;
  }
): DateParseResult {
  const str = rawInput.trim();
  const rangeParts = str.split('..');
  if (rangeParts.length > 2) return { ok: false, reason: 'INVALID_FORMAT' };

  if (rangeParts.length === 2) {
    const [leftRaw, rightRaw] = rangeParts.map((s) => s.trim());
    if (!leftRaw || !rightRaw) return { ok: false, reason: 'INVALID_FORMAT' };

    const leftRes = parseSingleTemporalAtom(leftRaw, opts);
    if (!leftRes.ok) return leftRes;

    const rightRes = parseSingleTemporalAtom(rightRaw, opts);
    if (!rightRes.ok) return rightRes;

    const s1 = leftRes.interval.start;
    const e1 = leftRes.interval.end;
    const s2 = rightRes.interval.start;
    const e2 = rightRes.interval.end;

    if (s1 >= e2) {
      return {
        ok: false,
        reason: 'REVERSED_RANGE',
        leftRaw,
        rightRaw,
        hint: s2 < e1 ? `Use ${rightRaw}..${leftRaw}` : null
      };
    }

    return {
      ok: true,
      interval: Object.freeze({
        start: s1,
        end: e2,
        grain: 'range',
        raw: str
      })
    };
  }

  return parseSingleTemporalAtom(str, opts);
}

export function compareDateIntervals(D: DateInterval, op: PropertyOperator, Q: DateInterval): boolean {
  switch (op) {
    case '=':  return D.start >= Q.start && D.end <= Q.end;
    case '!=': return D.start < Q.start || D.end > Q.end;
    case '<':  return D.end <= Q.start;
    case '>=': return D.start >= Q.start;
    case '>':  return D.start >= Q.end;
    case '<=': return D.end <= Q.end;
    default:   return false;
  }
}

// ============================================================================
// 4. HYBRID PROPERTY NORMALIZER & DOCUMENT DIAGNOSTICS COLLECTOR
// ============================================================================

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const STRICT_NUMBER_RE = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function safeToString(val: unknown): string {
  try {
    return String(val);
  } catch {
    return '[unconvertible]';
  }
}

export function buildPropertiesViews(occurrences: readonly PropertyOccurrence[]): {
  propertyKeys: string[];
  properties: Record<string, unknown>;
} {
  const propertyKeys: string[] = [];
  const out: Record<string, unknown> = Object.create(null);
  const promotedKeys = new Set<string>();

  for (const { key, rawValue } of occurrences) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (!(key in out)) {
      propertyKeys.push(key);
      if (Array.isArray(rawValue)) {
        out[key] = [...rawValue];
        promotedKeys.add(key);
      } else {
        out[key] = rawValue;
      }
    } else {
      let targetArr: unknown[];
      if (promotedKeys.has(key)) {
        targetArr = out[key] as unknown[];
      } else {
        targetArr = [out[key]];
        out[key] = targetArr;
        promotedKeys.add(key);
      }
      if (Array.isArray(rawValue)) {
        for (const item of rawValue) targetArr.push(item);
      } else {
        targetArr.push(rawValue);
      }
    }
  }

  return { propertyKeys, properties: out };
}

function sanitizeScalar(item: unknown): { valid: boolean; scalar: SanitizedScalar } {
  if (item === null || item === undefined) return { valid: true, scalar: null };
  if (typeof item === 'boolean' || typeof item === 'string') return { valid: true, scalar: item };
  if (typeof item === 'number') return { valid: true, scalar: Number.isFinite(item) ? item : null };
  if (item instanceof Date) {
    return { valid: true, scalar: Number.isNaN(item.getTime()) ? null : item.toISOString() };
  }
  return { valid: false, scalar: null };
}

function sanitizeLineNumber(line: number | null | undefined): number | null {
  if (typeof line === 'number' && Number.isSafeInteger(line) && line >= 1) {
    return line;
  }
  return null;
}

/**
 * Non-throwing for JSON primitives, undefined, and standard Date instances
 * without overridden methods.
 */
export function coercePropertyValue(
  val: unknown,
  propType: ObsidianPropertyType,
  timeZone: string
): TypedPropertyValue {
  if (val === null || val === undefined) return { kind: 'null' };

  switch (propType) {
    case 'number': {
      if (val instanceof Date || typeof val === 'boolean') {
        return {
          kind: 'invalid',
          raw: safeToString(val),
          expectedType: 'number',
          reason: 'INVALID_VALUE',
          hint: 'Provide a finite numeric value (e.g., 42 or -3.5).'
        };
      }
      if (typeof val === 'number') {
        return Number.isFinite(val)
          ? { kind: 'number', value: val, raw: String(val) }
          : {
              kind: 'invalid',
              raw: String(val),
              expectedType: 'number',
              reason: 'INVALID_VALUE',
              hint: 'Provide a finite numeric value.'
            };
      }
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!STRICT_NUMBER_RE.test(trimmed)) {
          return {
            kind: 'invalid',
            raw: val,
            expectedType: 'number',
            reason: 'INVALID_VALUE',
            hint: 'Provide a finite decimal number without units or hex prefixes.'
          };
        }
        const num = Number(trimmed);
        return Number.isFinite(num)
          ? { kind: 'number', value: num, raw: val }
          : {
              kind: 'invalid',
              raw: val,
              expectedType: 'number',
              reason: 'INVALID_VALUE',
              hint: 'Provide a finite numeric value.'
            };
      }
      return {
        kind: 'invalid',
        raw: safeToString(val),
        expectedType: 'number',
        reason: 'INVALID_VALUE',
        hint: 'Provide a finite numeric value.'
      };
    }

    case 'checkbox': {
      if (typeof val === 'boolean') {
        return { kind: 'checkbox', value: val, raw: val ? 'true' : 'false' };
      }
      if (typeof val === 'string') {
        const lower = val.trim().toLowerCase();
        if (lower === 'true') return { kind: 'checkbox', value: true, raw: 'true' };
        if (lower === 'false') return { kind: 'checkbox', value: false, raw: 'false' };
      }
      return {
        kind: 'invalid',
        raw: safeToString(val),
        expectedType: 'checkbox',
        reason: 'INVALID_VALUE',
        hint: 'Use true or false.'
      };
    }

    case 'date':
    case 'datetime': {
      if (val instanceof Date) {
        if (Number.isNaN(val.getTime())) {
          return {
            kind: 'invalid',
            raw: 'Invalid Date',
            expectedType: propType,
            reason: 'INVALID_VALUE',
            hint: 'Use ISO-8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss).'
          };
        }
        const iso = val.toISOString();
        const res = parseTemporalExpr(iso, { allowYearOnly: true, allowRelative: false, timeZone });
        return res.ok
          ? { kind: propType, interval: res.interval, raw: iso }
          : {
              kind: 'invalid',
              raw: iso,
              expectedType: propType,
              reason: 'INVALID_VALUE',
              hint: 'Use ISO-8601 format (YYYY-MM-DD).'
            };
      }
      if (typeof val === 'string') {
        const res = parseTemporalExpr(val, { allowYearOnly: true, allowRelative: false, timeZone });
        if (res.ok) {
          return { kind: propType, interval: res.interval, raw: val };
        }
        if (res.reason === 'REVERSED_RANGE') {
          return {
            kind: 'invalid',
            raw: val,
            expectedType: propType,
            reason: 'REVERSED_DATE_RANGE',
            hint: res.hint
          };
        }
        if (res.reason === 'SKIPPED_DATE') {
          return {
            kind: 'invalid',
            raw: val,
            expectedType: propType,
            reason: 'SKIPPED_DATE',
            hint: `Calendar date "${val}" was skipped by a timezone transition in "${timeZone}".`
          };
        }
        if (res.reason === 'RELATIVE_NOT_ALLOWED' || /(?:^|\.\.)\s*@/.test(val.trim())) {
          return {
            kind: 'invalid',
            raw: val,
            expectedType: propType,
            reason: 'RELATIVE_IN_STORED_PROPERTY',
            hint: 'Relative @date anchors are only allowed in search queries, not in stored note properties.'
          };
        }
        return {
          kind: 'invalid',
          raw: val,
          expectedType: propType,
          reason: 'INVALID_VALUE',
          hint: 'Use a valid ISO-8601 date (YYYY-MM-DD) or range (YYYY-MM-DD..YYYY-MM-DD).'
        };
      }
      return {
        kind: 'invalid',
        raw: safeToString(val),
        expectedType: propType,
        reason: 'INVALID_VALUE',
        hint: 'Use an ISO-8601 date string (YYYY-MM-DD).'
      };
    }

    case 'text':
    case 'multitext':
    case 'tags': {
      if (val instanceof Date) {
        if (Number.isNaN(val.getTime())) {
          return {
            kind: 'invalid',
            raw: 'Invalid Date',
            expectedType: propType,
            reason: 'INVALID_VALUE',
            hint: null
          };
        }
        return { kind: 'text', value: val.toISOString() };
      }
      if (typeof val === 'number') {
        return Number.isFinite(val)
          ? { kind: 'text', value: String(val) }
          : {
              kind: 'invalid',
              raw: String(val),
              expectedType: propType,
              reason: 'INVALID_VALUE',
              hint: null
            };
      }
      if (typeof val === 'boolean' || typeof val === 'string') {
        return { kind: 'text', value: String(val) };
      }
      return {
        kind: 'invalid',
        raw: safeToString(val),
        expectedType: propType,
        reason: 'INVALID_VALUE',
        hint: null
      };
    }
  }
}

/**
 * Resolves the property type for a stored user property during document normalization.
 * Does NOT apply virtual `file.*` types to user-authored properties.
 */
export function resolveUserPropertyType(
  lowerKey: string,
  normalizedRegistry: Readonly<PropertyTypeRegistry>
): ObsidianPropertyType {
  if (lowerKey === 'tags' || lowerKey === 'tag') return 'tags';
  if (lowerKey === 'aliases' || lowerKey === 'alias') return 'multitext';
  return Object.prototype.hasOwnProperty.call(normalizedRegistry, lowerKey)
    ? normalizedRegistry[lowerKey]
    : 'text';
}

/**
 * Resolves the property type for a query `PropertyFilterNode` (`[key op val]`).
 * Virtual `file.*` keys take precedence over user properties.
 */
export function resolveQueryPropertyType(
  lowerKey: string,
  normalizedRegistry: Readonly<PropertyTypeRegistry>
): ObsidianPropertyType {
  if (lowerKey === 'file.mtime' || lowerKey === 'file.ctime') return 'datetime';
  if (lowerKey === 'file.size') return 'number';
  if (isVirtualFileKey(lowerKey)) return 'text';
  return resolveUserPropertyType(lowerKey, normalizedRegistry);
}

function validateIntegerTimestampMs(val: number, fieldName: string): number {
  if (!Number.isSafeInteger(val) || Math.abs(val) > MAX_SAFE_EPOCH_MS) {
    throw new Error(`Invalid file stat ${fieldName}: ${val}`);
  }
  return val;
}

export function normalizeObsidianMetadata(
  tfile: {
    path: string;
    name: string;
    basename: string;
    extension: string;
    parent?: { path: string } | null;
    stat: { ctime: number; mtime: number; size: number };
  },
  cache: {
    frontmatter?: Record<string, unknown>;
    tags?: Array<{ tag: string }>;
    headings?: Array<{ heading: string; level: number }>;
    links?: Array<{ link: string; displayText?: string }>;
    frontmatterLinks?: Array<{ link: string; displayText?: string }>;
    embeds?: Array<{ link: string; displayText?: string }>;
    blocks?: Record<string, { id: string }>;
  } | null,
  resolvedConfig: ResolvedEngineConfig,
  inlineProperties: Array<{ key: string; value: unknown; line?: number | null }> = [],
  resolveLinkPath?: (rawTarget: string, sourcePath: string) => string | null
): NormalizedDocument {
  const { timeZone, propertyTypes, normalizationFingerprint } = resolvedConfig;
  const propertyOccurrences: PropertyOccurrence[] = [];
  const diagnostics: DocumentDiagnostic[] = [];

  const recordDocDiagnosticIfInvalid = (
    tv: TypedPropertyValue,
    key: string,
    rawKey: string,
    source: 'frontmatter' | 'inline',
    line: number | null,
    occurrenceIndex: number,
    valueIndex: number
  ) => {
    if (tv.kind !== 'invalid') return;
    const code =
      tv.reason === 'REVERSED_DATE_RANGE'
        ? 'DOC_REVERSED_DATE_RANGE'
        : tv.reason === 'SKIPPED_DATE'
        ? 'DOC_SKIPPED_DATE'
        : 'DOC_INVALID_PROPERTY_VALUE';

    diagnostics.push({
      code,
      filePath: tfile.path,
      fileBasename: tfile.basename,
      propertyKey: key,
      rawKey,
      rawValue: tv.raw,
      expectedType: tv.expectedType,
      source,
      line,
      occurrenceIndex,
      valueIndex,
      issue:
        code === 'DOC_REVERSED_DATE_RANGE'
          ? `The left endpoint starts on or after the exclusive end contributed by the right endpoint in "${tv.raw}".`
          : code === 'DOC_SKIPPED_DATE'
          ? `Date "${tv.raw}" does not exist in timezone "${timeZone}".`
          : `Value "${tv.raw}" is not a valid ${tv.expectedType}.`,
      hint: tv.hint
    });
  };

  const addOccurrence = (
    rawKey: string,
    val: unknown,
    source: 'frontmatter' | 'inline',
    rawLine?: number | null
  ) => {
    if (source === 'frontmatter' && rawKey === 'position') return;
    const key = rawKey.trim().toLowerCase();
    if (!key || FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(rawKey)) return;

    const line = sanitizeLineNumber(rawLine);
    const propertyType = resolveUserPropertyType(key, propertyTypes);
    const occurrenceIndex = propertyOccurrences.length;

    if (Array.isArray(val)) {
      const sanitizedList: SanitizedScalar[] = [];
      const typedValues: TypedPropertyValue[] = [];
      for (const item of val) {
        const s = sanitizeScalar(item);
        if (!s.valid) continue;
        const valueIndex = typedValues.length;
        sanitizedList.push(s.scalar);
        const tv = coercePropertyValue(item, propertyType, timeZone);
        typedValues.push(tv);
        recordDocDiagnosticIfInvalid(tv, key, rawKey, source, line, occurrenceIndex, valueIndex);
      }
      propertyOccurrences.push({
        key,
        rawKey,
        source,
        line,
        propertyType,
        rawValue: sanitizedList,
        typedValues
      });
    } else {
      const s = sanitizeScalar(val);
      if (!s.valid) return;
      const tv = coercePropertyValue(val, propertyType, timeZone);
      recordDocDiagnosticIfInvalid(tv, key, rawKey, source, line, occurrenceIndex, 0);
      propertyOccurrences.push({
        key,
        rawKey,
        source,
        line,
        propertyType,
        rawValue: s.scalar,
        typedValues: [tv]
      });
    }
  };

  for (const [k, v] of Object.entries(cache?.frontmatter ?? {})) {
    addOccurrence(k, v, 'frontmatter', null);
  }
  for (const inline of inlineProperties) {
    addOccurrence(inline.key, inline.value, 'inline', inline.line);
  }

  const { propertyKeys, properties } = buildPropertiesViews(propertyOccurrences);

  const tagSet = new Set<string>();
  for (const t of cache?.tags ?? []) {
    const body = t.tag.trim().replace(/^#+/, '').toLowerCase();
    if (body) tagSet.add(`#${body}`);
  }
  for (const occ of propertyOccurrences) {
    if (occ.key === 'tags' || occ.key === 'tag') {
      for (const tv of occ.typedValues) {
        if (tv.kind === 'text') {
          const body = tv.value.trim().replace(/^#+/, '').toLowerCase();
          if (body) tagSet.add(`#${body}`);
        }
      }
    }
  }

  const aliases: string[] = [];
  for (const occ of propertyOccurrences) {
    if (occ.key === 'aliases' || occ.key === 'alias') {
      for (const tv of occ.typedValues) {
        if (tv.kind === 'text') aliases.push(tv.value);
      }
    }
  }

  const normalizeLink = (
    l: { link: string; displayText?: string },
    source: 'body' | 'frontmatter' | 'embed'
  ) => {
    const raw = l.link;
    let rawTarget = raw;
    let subpath = '';
    const hashIdx = raw.indexOf('#');
    const blockIdx = raw.indexOf('^');
    const splitIdx =
      hashIdx !== -1 && blockIdx !== -1
        ? Math.min(hashIdx, blockIdx)
        : hashIdx !== -1
        ? hashIdx
        : blockIdx;

    if (splitIdx === 0) {
      rawTarget = tfile.path;
      subpath = raw;
    } else if (splitIdx > 0) {
      rawTarget = raw.slice(0, splitIdx);
      subpath = raw.slice(splitIdx);
    }

    const resolvedPath =
      splitIdx === 0
        ? tfile.path
        : resolveLinkPath
        ? resolveLinkPath(rawTarget, tfile.path)
        : null;

    return {
      link: raw,
      rawTarget,
      resolvedPath,
      subpath,
      displayText: l.displayText ?? raw,
      source
    };
  };

  const links = [
    ...(cache?.links ?? []).map((l) => normalizeLink(l, 'body')),
    ...(cache?.frontmatterLinks ?? []).map((l) => normalizeLink(l, 'frontmatter'))
  ];
  const embeds = (cache?.embeds ?? []).map((e) => normalizeLink(e, 'embed'));

  const ctime = validateIntegerTimestampMs(tfile.stat.ctime, 'ctime');
  const mtime = validateIntegerTimestampMs(tfile.stat.mtime, 'mtime');
  if (!Number.isSafeInteger(tfile.stat.size) || tfile.stat.size < 0) {
    throw new Error(`Invalid file stat size: ${tfile.stat.size}`);
  }

  return {
    normalizationFingerprint,
    file: {
      path: tfile.path,
      name: tfile.name,
      basename: tfile.basename,
      extension: tfile.extension,
      parent: tfile.parent?.path && tfile.parent.path !== '/' ? tfile.parent.path : '',
      stat: { ctime, mtime, size: tfile.stat.size }
    },
    aliases,
    tags: Array.from(tagSet).sort(),
    headings: (cache?.headings ?? []).map((h) => ({
      text: h.heading,
      level: (Number.isFinite(h.level) ? Math.min(6, Math.max(1, Math.trunc(h.level))) : 1) as 1 | 2 | 3 | 4 | 5 | 6
    })),
    links,
    embeds,
    blocks: Object.keys(cache?.blocks ?? {}).map((b) =>
      b.startsWith('^') ? b.slice(1).toLowerCase() : b.toLowerCase()
    ),
    propertyOccurrences,
    propertyKeys,
    properties,
    diagnostics
  };
}

// ============================================================================
// 5. NORMATIVE AST NORMALIZER, DIAGNOSTIC FILTER & ORACLE EVALUATOR
// ============================================================================

/**
 * Collects all non-virtual user property keys referenced anywhere in `ast`.
 * Virtual `file.*` keys are excluded because they read `doc.file`, not `doc.propertyOccurrences`.
 */
export function collectReferencedPropertyKeys(ast: SearchAST, out: Set<string> = new Set()): Set<string> {
  switch (ast.type) {
    case 'PROPERTY_FILTER': {
      const k = ast.key.trim().toLowerCase();
      if (!isVirtualFileKey(k)) out.add(k);
      return out;
    }
    case 'NOT':
      return collectReferencedPropertyKeys(ast.child, out);
    case 'LOGICAL':
      for (const c of ast.children) collectReferencedPropertyKeys(c, out);
      return out;
    default:
      return out;
  }
}

export function oracleEvaluateVault(
  docs: readonly NormalizedDocument[],
  prepared: PreparedQuery
): VaultEvaluationReport {
  const { ast, resolvedConfig } = prepared;
  const expectedFp = resolvedConfig.normalizationFingerprint;
  const queriedKeys = collectReferencedPropertyKeys(ast);
  const matches: NormalizedDocument[] = [];
  const propertyDiagnostics: DocumentDiagnostic[] = [];

  for (const doc of docs) {
    if (doc.normalizationFingerprint !== expectedFp) {
      throw new Error(
        `Document "${doc.file.path}" normalizationFingerprint mismatch: expected ${expectedFp}, got ${doc.normalizationFingerprint}`
      );
    }
    if (oracleEvaluateDoc(doc, prepared)) {
      matches.push(doc);
    }
    if (queriedKeys.size > 0 && doc.diagnostics.length > 0) {
      for (const diag of doc.diagnostics) {
        if (queriedKeys.has(diag.propertyKey)) {
          propertyDiagnostics.push(diag);
        }
      }
    }
  }

  return { matches, propertyDiagnostics };
}

export function oracleEvaluateDoc(
  doc: NormalizedDocument,
  prepared: PreparedQuery
): boolean {
  if (doc.normalizationFingerprint !== prepared.resolvedConfig.normalizationFingerprint) {
    throw new Error(`Document "${doc.file.path}" normalizationFingerprint mismatch.`);
  }
  return evalAstNode(doc, prepared.ast, prepared.resolvedConfig, prepared.referenceTimeMs);
}

function evalAstNode(
  doc: NormalizedDocument,
  ast: SearchAST,
  resolvedConfig: ResolvedEngineConfig,
  referenceTimeMs: number
): boolean {
  switch (ast.type) {
    case 'MATCH_ALL':
      return true;
    case 'LOGICAL':
      return ast.operator === 'AND'
        ? ast.children.every((c) => evalAstNode(doc, c, resolvedConfig, referenceTimeMs))
        : ast.children.some((c) => evalAstNode(doc, c, resolvedConfig, referenceTimeMs));
    case 'NOT':
      return !evalAstNode(doc, ast.child, resolvedConfig, referenceTimeMs);
    case 'TEXT_MATCH': {
      const targets = [doc.file.basename, doc.file.path, ...doc.aliases, ...doc.tags];
      return targets.some((t) =>
        ast.matcher.kind === 'regex'
          ? testRegex(t, ast.matcher)
          : substringStringMatch(t, ast.matcher.value)
      );
    }
    case 'SCOPED_FILTER': {
      const def =
        ast.rawScope === '#'
          ? resolvedConfig.getScope('tag')
          : resolvedConfig.getScope(ast.scope);
      if (!def) throw new Error(`Unresolved scope in AST: ${ast.scope}`);
      const targets = def.extract(doc);
      return targets.some((target) => evalValueExprOnTarget(target, ast.expr, def));
    }
    case 'PROPERTY_FILTER': {
      const entries = getTypedPropertyEntries(doc, ast.key.toLowerCase());
      const validEntries = entries.filter((e) => e.kind !== 'null' && e.kind !== 'invalid');
      if (validEntries.length === 0) return false;
      if (ast.operator === 'EXISTS') return true;
      return validEntries.some((entry) =>
        evalPropertyEntry(entry, ast.operator, ast.valueExpr!, resolvedConfig.timeZone, referenceTimeMs)
      );
    }
  }
}

function evalValueExprOnTarget(
  target: string,
  expr: ValueExprAST,
  scopeDef: Pick<ScopeDefinition, 'matchString'>
): boolean {
  switch (expr.type) {
    case 'VALUE_LOGICAL':
      return expr.operator === 'AND'
        ? expr.children.every((c) => evalValueExprOnTarget(target, c, scopeDef))
        : expr.children.some((c) => evalValueExprOnTarget(target, c, scopeDef));
    case 'VALUE_NOT':
      return !evalValueExprOnTarget(target, expr.child, scopeDef);
    case 'VALUE_LEAF':
      return expr.matcher.kind === 'regex'
        ? testRegex(target, expr.matcher)
        : scopeDef.matchString(target, expr.matcher.value, expr.matcher.quoted);
  }
}

function getTypedPropertyEntries(doc: NormalizedDocument, lowerKey: string): TypedPropertyValue[] {
  if (lowerKey === 'file.mtime') {
    const t = doc.file.stat.mtime;
    return [{ kind: 'datetime', interval: { start: t, end: t + 1, grain: 'ms', raw: String(t) }, raw: String(t) }];
  }
  if (lowerKey === 'file.ctime') {
    const t = doc.file.stat.ctime;
    return [{ kind: 'datetime', interval: { start: t, end: t + 1, grain: 'ms', raw: String(t) }, raw: String(t) }];
  }
  if (lowerKey === 'file.size') {
    const s = doc.file.stat.size;
    return [{ kind: 'number', value: s, raw: String(s) }];
  }
  if (lowerKey === 'file.ext' || lowerKey === 'file.extension') return [{ kind: 'text', value: doc.file.extension }];
  if (lowerKey === 'file.name') return [{ kind: 'text', value: doc.file.name }];
  if (lowerKey === 'file.basename') return [{ kind: 'text', value: doc.file.basename }];
  if (lowerKey === 'file.path') return [{ kind: 'text', value: doc.file.path }];
  if (lowerKey === 'file.parent') return [{ kind: 'text', value: doc.file.parent }];
  return doc.propertyOccurrences
    .filter((occ) => occ.key === lowerKey)
    .flatMap((occ) => occ.typedValues);
}

const PROPERTY_COLON_MATCHER: Pick<ScopeDefinition, 'matchString'> = {
  matchString: substringStringMatch
};

function evalPropertyEntry(
  entry: TypedPropertyValue,
  op: PropertyOperator,
  expr: ValueExprAST,
  timeZone: string,
  referenceTimeMs: number
): boolean {
  if (entry.kind === 'null' || entry.kind === 'invalid') return false;
  if (op === ':') {
    if (entry.kind === 'checkbox' && containsRegexLeaf(expr)) return false;
    const rawStr =
      entry.kind === 'text'
        ? entry.value
        : entry.kind === 'checkbox'
        ? entry.value
          ? 'true'
          : 'false'
        : entry.raw;
    return evalValueExprOnTarget(rawStr, expr, PROPERTY_COLON_MATCHER);
  }
  if (expr.type !== 'VALUE_LEAF' || expr.matcher.kind === 'regex') return false;
  const { value: rhsRaw, quoted } = expr.matcher;

  switch (entry.kind) {
    case 'number': {
      if (quoted || !STRICT_NUMBER_RE.test(rhsRaw.trim())) return false;
      const rhsNum = Number(rhsRaw.trim());
      if (!Number.isFinite(rhsNum)) return false;
      switch (op) {
        case '=':  return entry.value === rhsNum;
        case '!=': return entry.value !== rhsNum;
        case '<':  return entry.value < rhsNum;
        case '>':  return entry.value > rhsNum;
        case '<=': return entry.value <= rhsNum;
        case '>=': return entry.value >= rhsNum;
        default:   return false;
      }
    }
    case 'checkbox': {
      if (quoted) return false;
      const lower = rhsRaw.trim().toLowerCase();
      if (lower !== 'true' && lower !== 'false') return false;
      const rhsBool = lower === 'true';
      if (op === '=') return entry.value === rhsBool;
      if (op === '!=') return entry.value !== rhsBool;
      return false;
    }
    case 'date':
    case 'datetime': {
      const res = parseTemporalExpr(rhsRaw, {
        allowYearOnly: true,
        allowRelative: true,
        timeZone,
        referenceTimeMs
      });
      if (!res.ok) {
        throw new Error(`Unvalidated temporal literal reached evaluator: ${rhsRaw}`);
      }
      return compareDateIntervals(entry.interval, op, res.interval);
    }
    case 'text': {
      const a = entry.value.toLowerCase();
      const b = rhsRaw.toLowerCase();
      switch (op) {
        case '=':  return a === b;
        case '!=': return a !== b;
        case '<':  return a < b;
        case '>':  return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
        default:   return false;
      }
    }
  }
}

function containsRegexLeaf(expr: ValueExprAST): boolean {
  if (expr.type === 'VALUE_LEAF') return expr.matcher.kind === 'regex';
  if (expr.type === 'VALUE_NOT') return containsRegexLeaf(expr.child);
  return expr.children.some(containsRegexLeaf);
}

export function normalizeValueExprAST(expr: ValueExprAST): ValueExprAST {
  switch (expr.type) {
    case 'VALUE_LEAF':
      return { type: 'VALUE_LEAF', matcher: { ...expr.matcher } };
    case 'VALUE_NOT':
      return { type: 'VALUE_NOT', syntax: 'NOT', child: normalizeValueExprAST(expr.child) };
    case 'VALUE_LOGICAL': {
      const flatChildren: ValueExprAST[] = [];
      for (const c of expr.children) {
        const normC = normalizeValueExprAST(c);
        if (normC.type === 'VALUE_LOGICAL' && normC.operator === expr.operator) {
          flatChildren.push(...normC.children);
        } else {
          flatChildren.push(normC);
        }
      }
      if (flatChildren.length === 1) return flatChildren[0];
      return { type: 'VALUE_LOGICAL', operator: expr.operator, children: flatChildren };
    }
  }
}

export function normalizeAST(ast: SearchAST): SearchAST {
  switch (ast.type) {
    case 'MATCH_ALL':
      return { type: 'MATCH_ALL' };
    case 'TEXT_MATCH':
      return {
        type: 'TEXT_MATCH',
        matcher: { ...ast.matcher },
        rawText: ''
      };
    case 'NOT':
      return {
        type: 'NOT',
        syntax: 'NOT',
        child: normalizeAST(ast.child)
      };
    case 'SCOPED_FILTER': {
      let normExpr = normalizeValueExprAST(ast.expr);
      if (
        ast.scope === 'tag' &&
        normExpr.type === 'VALUE_LEAF' &&
        normExpr.matcher.kind === 'string'
      ) {
        const matcher = normExpr.matcher;
        normExpr = {
          type: 'VALUE_LEAF',
          matcher: {
            kind: 'string',
            value: matcher.value.startsWith('#') ? matcher.value : `#${matcher.value}`,
            quoted: matcher.quoted
          }
        };
      }
      return {
        type: 'SCOPED_FILTER',
        scope: ast.scope,
        rawScope: ast.scope,
        expr: normExpr
      };
    }
    case 'PROPERTY_FILTER': {
      const lowerKey = ast.key.trim().toLowerCase();
      return {
        type: 'PROPERTY_FILTER',
        key: lowerKey,
        rawKey: lowerKey,
        operator: ast.operator,
        ...(ast.valueExpr ? { valueExpr: normalizeValueExprAST(ast.valueExpr) } : {})
      };
    }
    case 'LOGICAL': {
      const flatChildren: SearchAST[] = [];
      for (const c of ast.children) {
        const normC = normalizeAST(c);
        if (normC.type === 'LOGICAL' && normC.operator === ast.operator) {
          flatChildren.push(...normC.children);
        } else {
          flatChildren.push(normC);
        }
      }
      if (flatChildren.length === 1) return flatChildren[0];
      const out: LogicalNode = {
        type: 'LOGICAL',
        operator: ast.operator,
        children: flatChildren
      };
      return out;
    }
  }
}
```

---

## 6. Invariant Verification Suite (`fast-check`) & Complete Conformance Matrix

### 6.1 Formal Property-Based Invariants & Printable Executable AST Contract

1. **Strict TypeScript Build, Lexer, Parser & Deep-Freeze Smoke Test**:
   - Compiling under `tsc --strict --noEmit`, constructing `new Lexer(ALL_TOKENS)`, and instantiating `new SearchParser()` with `performSelfAnalysis()` succeeds with zero errors.
   - Mutating any node, array, or matcher on `compileQuery(...).ast` or `compileQuery(...).prepared.ast` in strict mode throws a `TypeError`.
2. **JSON-Content Round-Trip, Normalization Fingerprint & Forbidden-Key Safety**:
   - For any generated `NormalizedDocument` and any `VaultEvaluationReport`, `JSON.parse(JSON.stringify(obj))` has identical JSON content to `obj`, no `undefined` values exist on `PropertyOccurrence`, `DocumentDiagnostic`, or `SearchDiagnostic`, and `__proto__`, `constructor`, and `prototype` never appear in `doc.propertyKeys` or `doc.properties`.
   - Evaluating a `PreparedQuery` against a `NormalizedDocument` with a mismatched `normalizationFingerprint` throws an error.
3. **Hybrid Property Ordering & Aggregation Invariant**:
   - `doc.propertyKeys` equals the deduplicated sequence of `occ.key` in exact order of first appearance in `doc.propertyOccurrences`.
   - For each `k` in `doc.propertyKeys`, if `k` appeared once in `propertyOccurrences`, `doc.properties[k]` equals `occ.rawValue`; if `k` appeared $\ge 2$ times, `doc.properties[k]` equals the 1-level concatenation of `rawValue` across all occurrences of `k` in local occurrence order (frontmatter values in original list order followed by inline values in order of appearance).
4. **Target-Type Coercion & Non-Throwing Reference-Time Invariant**:
   - For any generated JSON primitive, `undefined`, or standard `Date` instance, `coercePropertyValue(val, propType, tz)` never throws and returns only `{ kind: 'null' }`, `{ kind: 'invalid', expectedType: propType }`, `{ kind: 'text' }` (when `propType` is `'text'|'multitext'|'tags'`), or `{ kind: propType }`.
   - Calling `parseTemporalExpr` or `compileQuery` with any arbitrary number for `referenceTimeMs` (including `NaN`, `±Infinity`, or out-of-range numbers) never throws an uncaught exception.
5. **Printable Executable AST Round-Trip & `normalizeAST` Idempotence**:
   - `normalizeAST(normalizeAST(ast))` deeply equals `normalizeAST(ast)`.
   - `printableExecutableAstArb(resolvedConfig, refMs)` constructs ASTs satisfying:
     1. **Logical Arity**: `LogicalNode.children.length >= 2` and `VALUE_LOGICAL.children.length >= 2`; `MatchAllNode` only at root.
     2. **Operator/RHS Shape**: `operator === 'EXISTS'` has `valueExpr === undefined`; `operator === ':'` allows `VALUE_LOGICAL`, `VALUE_NOT`, or `VALUE_LEAF`; `=`, `!=`, `<`, `>`, `<=`, `>=` require a single non-regex `VALUE_LEAF`.
     3. **Scope Membership**: `ScopedFilterNode.scope` is a registered canonical scope name in `resolvedConfig`.
     4. **Context-Specific String Printability (for Scopes, Bare Text & Property `:` Leaves)**: Unquoted string leaves (`quoted: false`) at bare document level or inside parenthesized `ValueOrExpr` match `/^[a-zA-Z_][a-zA-Z0-9_-]{0,15}$/` (excluding `"AND"`, `"OR"`, `"NOT"`); direct unparenthesized RHS leaves (`RhsLeafValue`) also allow signed identifiers (`-[a-zA-Z_][a-zA-Z0-9_-]{0,15}`). Quoted string leaves (`quoted: true`) are printed with `"` and escaped via `\"`, `\\`, `\n`, `\r`, `\t` (preserving `quoted` identically across print + parse).
     5. **Type-Valid Comparison Leaves (Overrides Rule 4 for Property `=`, `!=`, `<`, `>`, `<=`, `>=`)**: Resolved via `resolveQueryPropertyType(key, resolvedConfig.propertyTypes)`: `'number'` uses unquoted `/^-?\d{1,6}(?:\.\d{1,3})?$/`; `'checkbox'` uses unquoted `"true"`/`"false"`; `'date'`/`'datetime'` uses temporal literals that pass `parseTemporalExpr(..., { allowYearOnly: true, allowRelative: true, timeZone: resolvedConfig.timeZone, referenceTimeMs: refMs }).ok === true`; text-like types use Rule 4.
     6. **Structural Printable Regex Leaves**: Generated structurally (not via random punctuation strings) from non-empty concatenations/alternations of alphanumeric literals, escaped metacharacters (`\.`, `\/`, `\-`), small character classes (`[a-z]`, `[0-9]`), and optional `^`/`$` anchors (excluding repetition quantifiers from the random generator so differential runs always terminate instantaneously), with unique flags from `"imsu"`, verified via `validateRegexLiteral(pattern, flags) !== null`.
     7. **Length & Depth Bounds**: Filtered so `printAST(ast).length <= 4096` and syntactic recursion depth (counting unary negations and parenthesized groups) is $\le 32$.
6. **Temporal Range, Relative Anchor & Point-Timestamp Partitioning Invariants**:
   - **Successful-Result Validity & Self-Range Identity**: Every `parseTemporalExpr` call returning `ok: true` produces a `DateInterval` with safe integer bounds satisfying `start < end`; for any valid single temporal atom `A`, `A..A` resolves with `ok: true` and has identical `[start, end)` bounds to `A`.
   - **Alias & Day-Offset Shift Equivalence (Excluding `raw`)**: For any `timeZone`, `referenceTimeMs`, and integer day offset $k \in [-36524, 36524]$, `@yesterday+(k+1)d`, `@lastday+(k+1)d`, `@today+kd`, `@thisday+kd`, `@tomorrow+(k-1)d`, and `@nextday+(k-1)d` produce identical `{ start, end, grain }` on success or identical `{ ok: false, reason }` on failure, and consecutive valid days abut (`(@today+kd).end === (@today+(k+1)d).start`).
   - **Ordinary-Case Coverage, Triplet Contiguity & Cross-Grain Containment (`@today` vs Coarse Units)**: For representable reference times in non-skipped calendar periods (e.g., years `1970..2100` in `UTC` and `America/New_York`), all relative anchor families (`@now`, `@today`, `@yesterday`, `@tomorrow`, `@(last|this|next)(day|week|month|quarter|year)`) resolve with `ok: true`; for each unit `u ∈ {'day', 'week', 'month', 'quarter', 'year'}`, `@last<u>`, `@this<u>`, and `@next<u>` form a contiguous partition (`last.end === this.start`, `this.end === next.start`, `this.start <= referenceTimeMs < this.end`, and `@last<u>..@next<u>` spans `[last.start, next.end)`); and for every coarse unit `u ∈ {'day', 'week', 'month', 'quarter', 'year'}`, `compareDateIntervals(@today, '=', @this<u>)`, `compareDateIntervals(@today, '<', @next<u>)`, and `compareDateIntervals(@today, '>', @last<u>)` all evaluate to `true` (with `@now` nested inside `@today` and `@thisday ⊆ @thisweek`, `@thisday ⊆ @thismonth ⊆ @thisquarter ⊆ @thisyear`).
   - **Point Timestamp Partitioning & General Interval Algebra**: For any valid `NormalizedDocument` and any valid `DateInterval` query $Q$, `doc` satisfies **exactly one** of `[file.mtime < Q]`, `[file.mtime = Q]`, or `[file.mtime > Q]`, and `[file.mtime = Q]` is equivalent to `[file.mtime >= Q] AND [file.mtime <= Q]`. For any two valid intervals $D = [d_s, d_e)$ and $Q = [q_s, q_e)$, `compareDateIntervals` satisfies `(D = Q) ⟺ (D >= Q && D <= Q)`, `(D != Q) ⟺ !(D = Q)`, `(D < Q) ⟺ (Q > D)`, `(D < Q) + (D = Q) + (D > Q) <= 1` (at most one, since wider intervals can partially overlap $Q$), and containment preorder laws (`D = D`, transitivity, and antisymmetry on `[start, end)`), while at the document property level `null`/`undefined` or `invalid` entries (`coercePropertyValue` returning `{ kind: 'null' }` or `{ kind: 'invalid' }`) never satisfy any comparison operator (including `!=` or `EXISTS`) and only match when negated at the document filter level (`NOT [k = Q]`).
   - **ISO Prefix-Grain Nesting & Explicit Offset Timezone Invariance**: For any non-skipped local calendar timestamp, finer ISO prefixes nest inside coarser prefixes (`YYYY-MM-DDTHH:mm:ss.sss` $\subset$ `YYYY-MM-DDTHH:mm:ss` $\subset$ `YYYY-MM-DDTHH:mm` $\subset$ `YYYY-MM-DD` $\subset$ `YYYY-MM` $\subset$ `YYYY`) with the first/last days of `YYYY-MM` abutting `YYYY-MM` and the 12 months partitioning `YYYY`; and any ISO datetime with an explicit offset (`Z` or `[+-]HH:?mm`) resolves to the exact same `{ start, end, grain }` regardless of `resolvedConfig.timeZone` or equivalent explicit-offset representation.
7. **Boolean Algebra & Per-Item Scope Distribution**:
   De Morgan’s Laws, Complementarity (`A OR NOT A = U`, `A AND NOT A = ∅`), Scope OR Distribution (`s:(a OR b) === s:a OR s:b`), and Scope AND Containment (`s:(a AND b) ⊆ s:a AND s:b`) hold across all generated executable `PreparedQuery` objects and compatible documents.
8. **Differential Evaluation Equivalence (`evaluateVault` vs. `oracleEvaluateVault`)**:
   For every generated vault `docs: NormalizedDocument[]` normalized with `resolvedConfig` and every executable `prepared: PreparedQuery` compiled with `resolvedConfig`:
   - `evaluateVault(docs, prepared).matches.map(d => d.file.path)` deeply equals `oracleEvaluateVault(docs, prepared).matches.map(d => d.file.path)`.
   - `evaluateVault(docs, prepared).propertyDiagnostics` deeply equals `oracleEvaluateVault(docs, prepared).propertyDiagnostics`.

---

### 6.2 Complete Hand-Authored Conformance Matrix (Tests 1–15)

Unless otherwise noted, tests use `initEngineConfig({ timeZone: 'America/New_York', propertyTypes: { score: 'number', priority: 'number', meeting: 'datetime', due: 'date', modified: 'date', sprint: 'date', status: 'text' } })` and pinned `referenceTimeMs = Date.parse('2026-10-22T15:30:00.000Z')` (Thursday, Oct 22, 2026, 11:30 AM EDT):

1. **`tag:#work/urgent` & Bare `#work`** $\rightarrow$ Both compile with zero errors (`#work` has `rawScope: '#'`, `scope: 'tag'`); both match a note with `#work/urgent`.
2. **`[score >= -10.5]`** $\rightarrow$ Parses `-10.5` via `RhsLeafValue`; matches `score: -5`, rejects `score: -20`.
3. **`-draft` vs `file:-draft` vs `file:(-draft)`** $\rightarrow$ `-draft` negates document-level `TEXT_MATCH("draft")`; `file:-draft` matches substring `"-draft"` in filename; `file:(-draft)` requires at least one filename string (`name` or `basename`) not containing `"draft"`.
4. **`path:"/projects/active"` vs `path:/projects/active` vs `path:Projects/Active/Archive`** $\rightarrow$ `path:"/projects/active"` and `path:Projects/Active/Archive` compile and match as string paths; unquoted `path:/projects/active` tokenizes `/projects/active` as `RegexLiteral` with invalid flags `active` and is rejected with `SYNTAX_ERROR` (`executable: false`).
5. **`[meeting = 2026-10-22T14:00:00+02:00]`** $\rightarrow$ Tokenizes via anchor-free `DateTimeLiteral`; matches `2026-10-22T12:00:00.000Z`.
6. **Invalid & Skipped Dates (Including Relative Offset Landing on Skipped Date)**:
   - `[due = 2026-02-31]` $\rightarrow$ Rejected at compile time with `ERROR_TYPE_MISMATCH` (`executable: false`).
   - With `timeZone: 'Pacific/Apia'` and `referenceTimeMs = Date.parse('2011-12-29T12:00:00.000Z')`: both `[due = 2011-12-30]` and `NOT [due = @today+1d]` (which lands on skipped Dec 30, 2011) are rejected at compile time with `ERROR_TYPE_MISMATCH` (`executable: false`, never silently inverted by `NOT`).
7. **IANA DST Fall-Back Day (`America/New_York`, `[modified = 2026-11-01]`)** $\rightarrow$ Interval spans 25 hours (`2026-11-01T04:00:00.000Z` to `2026-11-02T05:00:00.000Z`).
8. **`headings:(Intro AND Summary)`** $\rightarrow$ Rejects doc with two separate headings `["Intro", "Summary"]`; matches doc with a single heading `"Intro and Summary"`.
9. **`[status != done]`** $\rightarrow$ Emits `HINT_PROP_NEQ_EXISTENCE` with `hint: 'To exclude notes (including notes missing "status"), use "-[status = done]".'`
10. **Compile-Time Error Gating & Precedence (`NOT [priority > high]`, `[priority = /10/]`, and `[priority = /foo(/]`)** $\rightarrow$ First emits `ERROR_TYPE_MISMATCH`; second emits only `ERROR_INVALID_OPERATOR_FOR_TYPE`; third emits only `SYNTAX_ERROR`. All three set `ast: null, prepared: null, executable: false`.
11. **Self-Link Cache Normalization & Wikilink Alias Stripping**:
    - `cache.links = [{ link: '#Overview' }]` in `Notes/A.md` $\rightarrow$ Normalizes `rawTarget` and `resolvedPath` to `"Notes/A.md"`, `subpath` to `"#Overview"`.
    - `links:[[Notes/A|Custom Label]]` $\rightarrow$ Lowers to `VALUE_LEAF("Notes/A")` and emits `HINT_WIKILINK_BRACKETS_IN_SCOPE`.
12. **Hybrid Property Ordering & Custom Scope Trimming**:
    - Given `frontmatter = { foo: ["fm1", "fm2"] }` and `inlineProperties = [{ key: "10", value: "ten", line: 5 }, { key: "2", value: "two", line: 6 }, { key: "foo", value: "inline1", line: 7 }, { key: "foo", value: ["inline2", "inline3"], line: 8 }]`:
      - `doc.propertyKeys` is `["foo", "10", "2"]`.
      - `doc.properties.foo` is `["fm1", "fm2", "inline1", "inline2", "inline3"]`.
    - Given `{ canonicalName: ' Tasks ', aliases: ['tasks', 'task'], extract, matchString }`, `initEngineConfig` trims `canonicalName` to `'Tasks'`, deduplicates `['tasks', 'task']`, and `task:urgent` and `task:/^urgent/i` compile and evaluate cleanly.
13. **Native ECMAScript `RegExp` Validation & Escaped Delimiters**:
    - `file:/(\d{1,3}\.){3}\d{1,3}/i`, `file:/^note-(?!draft)/`, and `path:/[\/]/` $\rightarrow$ Compile and execute cleanly via native `RegExp`.
    - Unescaped slash inside character class `path:/[/]/`, stateful/duplicate flags `file:/test/g`, `file:/test/ii`, or unclosed group `file:/[unclosed/` $\rightarrow$ Rejected at compile time with `SYNTAX_ERROR` (`executable: false`).
14. **Positional Date Ranges (`[s1, e2)` iff $s_1 < e_2$) & All Relative `@` Anchor Families**:
    - **`@now`**: Resolves to `[1792683000000, 1792683000001)`.
    - **`@today`, `@yesterday`, `@tomorrow`, `@today-6d..@today` (7 calendar days), `@today-7d..@today` (8 calendar days)**: Resolve to exact local midnight boundaries in `America/New_York`.
    - **`@lastweek`, `@thisweek`, `@nextweek`, `@lastmonth`, `@thismonth`, `@nextmonth`, `@lastquarter`, `@thisquarter`, `@nextquarter`, `@lastyear`, `@thisyear`, `@nextyear`**: All resolve to exact local midnight boundaries in `America/New_York`.
    - **Positional Non-Relative & Relative Mixed-Precision Ranges (`[due = 2026-10-22..2026]`, `[due = @thisyear..@today]`, `[due = @today..@thisyear]`)**: All three satisfy $s_1 < e_2$ and compile cleanly.
    - **Reversed Query Range (`[due = @today..@today-7d]` or `[due = 2026-10-15..2026-10-01]`)**: Fails $s_1 < e_2$, emits `SYNTAX_ERROR` (`executable: false`) with `hint: "Use @today-7d..@today"` / `"Use 2026-10-01..2026-10-15"`.
15. **Stored Property Diagnostic Filtering & Virtual Property Shadowing Isolation**:
    - Given `Projects/Sprint-12.md` with frontmatter `{"file.size": "large"}` and inline `{ key: "Sprint", value: "2026-10-01..2026-01-01", line: 14 }` and `{ key: "due", value: "2026-01-01..@today", line: 15 }`:
      - `"file.size"` is normalized as an ordinary `'text'` user property (zero `DocumentDiagnostic` items), and querying `[file.size > 1024]` reads `doc.file.stat.size` and returns `propertyDiagnostics: []`.
      - `"due"` (`"2026-01-01..@today"`) produces `DOC_INVALID_PROPERTY_VALUE` with `hint: "Relative @date anchors are only allowed in search queries, not in stored note properties."`
      - Evaluating `[sprint = @thisquarter]` returns `propertyDiagnostics` containing the exact POJO for `Sprint` with `occurrenceIndex: 1`, `valueIndex: 0`, `line: 14`, and `hint: "Use 2026-01-01..2026-10-01"`.
16. **Immutability, Fingerprint Compatibility, Temporal Snapshot Reuse & Duplicate Diagnostic Indexing**:
    - **Registry Key-Order Fingerprint Stability**: `initEngineConfig({ timeZone: 'UTC', propertyTypes: { a: 'number', b: 'date' } })` and `initEngineConfig({ timeZone: 'UTC', propertyTypes: { b: 'date', a: 'number' } })` produce the exact same `normalizationFingerprint`.
    - **Fingerprint Mismatch Rejection**: Evaluating a `PreparedQuery` compiled under `timeZone: 'UTC'` against a `NormalizedDocument` normalized under `timeZone: 'America/New_York'` throws a `normalizationFingerprint mismatch` error.
    - **AST Deep-Freeze Immutability**: Attempting `(compiled.ast as any).children.push(...)` or mutating `compiled.prepared!.ast` in strict mode throws a `TypeError`.
    - **Temporal Snapshot Reuse**: Reusing the same `PreparedQuery` for `[due = @today]` across multiple `evaluateVault` calls always evaluates `@today` against the `PreparedQuery`‘s bound `referenceTimeMs` regardless of wall-clock time passage.
    - **Duplicate Malformed List Value Indexing**: A note with frontmatter `sprint: ["invalid", "invalid"]` produces two `DocumentDiagnostic` items with `(occurrenceIndex: 0, valueIndex: 0)` and `(occurrenceIndex: 0, valueIndex: 1)`.
