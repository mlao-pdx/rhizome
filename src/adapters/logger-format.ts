import type { LogLevel } from '@ports/logger-port';

/**
 * Pure formatting/level-filtering helpers for the Obsidian logger adapter
 * (`obsidian-logger-adapter.ts`). Split out with zero `obsidian` import so
 * this logic is unit-testable without mocking the Obsidian API.
 */

/**
 * Severity order, lowest to highest. The single source of truth for every
 * `LogLevel` list.
 *
 * @remarks
 * The Diagnostics settings dropdown (`settings.ts`) imports this instead
 * of re-declaring its own copy, so adding/removing a level can't desync
 * the UI from `shouldLog()`'s comparison.
 */
export const LEVEL_ORDER: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

/** True when `level` is at or above `threshold` in severity. */
export function shouldLog(threshold: LogLevel, level: LogLevel): boolean {
	return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(threshold);
}

/**
 * Formats one log line as
 * `<ISO8601 timestamp> [<LEVEL>] <message> <meta as JSON if present>`,
 * terminated with a newline so callers can append directly to the log file.
 */
export function formatLogLine(
	timestamp: string,
	level: LogLevel,
	message: string,
	meta?: Record<string, unknown>,
): string {
	const metaSuffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
	return `${timestamp} [${level.toUpperCase()}] ${message}${metaSuffix}\n`;
}
