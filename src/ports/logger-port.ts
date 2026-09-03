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
 * rotation, and the actual vault file write.
 *
 * **Redaction is the caller's responsibility.** Any `message`/`meta`
 * content built from vault content (note titles, aliases, property
 * values, body excerpts) must already be wrapped in guillemets (`«...»`)
 * by the calling code before it reaches `log()`. Structural/internal-only
 * information (timings, counts, stack traces, code paths, port/adapter
 * names) is never wrapped.
 *
 * Shape, not contract: no implementation lives here.
 *
 * @remarks
 * This is independent of `__DEV__` (`types/globals.d.ts`): `__DEV__`
 * strips code from the production bundle entirely, so it cannot help a
 * real user capture a real bug. `LoggerPort` ships in the production
 * bundle and is silent by default until a user opts in. The log lives
 * inside the vault (not the OS filesystem or a network endpoint) so a
 * non-technical user can find and attach it to a bug report, and so
 * nothing is transmitted over a network. The log file is plain text, not
 * markdown, so it is never picked up by the plugin's own markdown-file
 * processing. This port is hand-written rather than backed by a logging
 * library, because no such library ships an Obsidian-vault transport
 * (one would be hand-written regardless) and a facade over another
 * logger would just duplicate this seam.
 *
 * Neither this interface nor its adapter inspects arguments for vault
 * content — only the caller knows which arguments are vault-derived.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface LoggerPort {
	/**
	 * Record a diagnostic line at `level`. No-ops when diagnostic logging
	 * is disabled or `level` is below the configured threshold.
	 *
	 * @remarks
	 * Callers do not need to guard calls themselves — the check happens
	 * before any file I/O.
	 */
	log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}
