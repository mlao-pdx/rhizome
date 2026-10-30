/**
 * `LoggerPort` — developer-diagnostics logging, gated by user opt-in
 * (Settings → Diagnostics tab), never telemetry.
 *
 * `LoggerPort` ships in the production bundle and is silent by default; it
 * only writes anything once the user turns logging on.
 *
 * Core code depends on this interface, never on `obsidian`'s `Vault`/
 * `DataAdapter` directly. The adapter implementation (outside
 * `src/core`/`src/ports`) owns the enabled/level checks, formatting,
 * segmentation, and the actual vault file write.
 *
 * **Sensitivity marking is the caller's responsibility.** Any `message`/`meta`
 * content built from vault content (note titles, paths, aliases, property
 * keys/values, query expressions, body excerpts) must be wrapped in
 * double-exclamation markers (`‼️...‼️`) by the calling code before it
 * reaches `log()`. Structural/internal-only information (timings, counts,
 * diagnostic codes, code paths, port/adapter names) is never wrapped.
 *
 * Shape, not contract: no implementation lives here.
 *
 * @remarks
 * (design, 2026-10-29) Switched from plain-text `.log` files with guillemet
 * (`«...»`) markers to size-segmented Markdown tables (`◊Rhizome/logs/<epoch>.md`)
 * tagged with `◊InternalRhizome: \{ "001": "Do not index or query." \}` frontmatter
 * and `‼️...‼️` sensitivity markers. Each log entry renders both a shape-redacted
 * `Description` column (with `‼️` markers stripped and sensitive characters
 * masked) and an unredacted `‼️Description‼️` column (preserving `‼️...‼️`
 * markers so the user can either delete the column in Obsidian or spot-redact
 * individual spans).
 *
 * SUPERSEDED (design, 2026-08-01): Originally wrote plain-text `.log` files
 * and used guillemets (`«...»`) so the plugin's markdown-file processing
 * would ignore log files by extension alone. Replaced by the `◊InternalRhizome`
 * frontmatter convention (`001`) and Markdown table segments for direct
 * readability and one-click column deletion in Obsidian.
 */
export type LogLevel = 'debug' | 'warn' | 'error';

/**
 * Structured metadata accompanying a diagnostic log entry.
 *
 * Every rendered Markdown table row has 7 columns:
 * `| Timestamp | Level | Source | Duration | Count | Description | ‼️Description‼️ |`
 *
 * - **Mandatory for every call:** `level`, `message`, and `meta.source`
 *   (`Timestamp`, `Description`, and `‼️Description‼️` are derived automatically).
 * - **Optional (routine-dependent):** `meta.durationMs` (populates `Duration`)
 *   and `meta.count` (populates `Count`).
 * - **Additional context:** Any other keys on `meta` are serialized as JSON
 *   into `Description` (with `‼️...‼️` spans redacted) and `‼️Description‼️`
 *   (with `‼️...‼️` spans preserved). A string under `meta.query` wrapped in
 *   `‼️...‼️` receives syntax-aware query redaction in `Description`.
 */
export interface LogEntryMeta {
	/**
	 * Mandatory dotted `<domain>.<routine>` identifier (or top-level subsystem
	 * such as `'lifecycle'` or `'datastore'`), e.g. `'query.compile'`,
	 * `'query.run'`, `'query.explain'`, `'db.bootstrap'`.
	 */
	readonly source: string;
	/**
	 * Optional elapsed wall-clock time in milliseconds (`>= 0`), rendered as
	 * `<n> ms` in the `Duration` column. Provide on timed or bounded
	 * operations (vault scans, query runs, explanations, batch indexing);
	 * omit on instantaneous state transitions.
	 */
	readonly durationMs?: number | undefined;
	/**
	 * Optional primary quantity processed or emitted (e.g. notes scanned,
	 * diagnostics emitted, property types loaded), rendered in the `Count`
	 * column. Omit when no meaningful cardinality applies.
	 */
	readonly count?: number | string | undefined;
	/**
	 * Additional structured key-value context appended as JSON to
	 * `Description` and `‼️Description‼️`.
	 */
	readonly [key: string]: unknown;
}

export interface LoggerPort {
	/**
	 * Record a diagnostic entry at `level`. No-ops when diagnostic logging
	 * is disabled or `level` is below the configured threshold.
	 *
	 * @remarks
	 * Callers do not need to guard calls themselves — the check happens
	 * before any file I/O. Reserved `meta` keys (`source`, `durationMs`,
	 * `count`) populate dedicated Markdown table columns; remaining keys
	 * are formatted into `Description` and `‼️Description‼️`.
	 */
	log(level: LogLevel, message: string, meta: LogEntryMeta): void;
}
