import type { MarkdownRenderChild } from 'obsidian';
import type { TemplateRenderResult } from '@core/templates';
import type { LoggerPort } from '@ports/logger-port';
import {
	LARGE_MARKDOWN_CHAR_THRESHOLD,
	LARGE_MARKDOWN_LINE_THRESHOLD,
	type MarkdownOutputMetrics,
} from './codeblock-render-cache';
import { markSensitive } from './logger-format';
import type { PersistedRenderSentinelRecord } from './render-sentinel-idb';

const COUNT_FORMATTER = new Intl.NumberFormat('en-US');
const BYTES_PER_MIB = 1024 * 1024;
const BYTES_PER_KIB = 1024;
const PAINT_YIELD_FALLBACK_MS = 32;

export type StandbyTrigger =
	| {
			readonly kind: 'records';
			readonly totalRecords: number;
	  }
	| {
			readonly kind: 'output';
			readonly metrics: MarkdownOutputMetrics;
	  };

function clampNonNegativeInt(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Formats a Markdown UTF-16 character length as a concise human-readable `KB` or `MB` string.
 */
export function formatHumanMarkdownSize(chars: number): string {
	const safeChars = clampNonNegativeInt(chars);
	if (safeChars >= BYTES_PER_MIB) {
		return `${(safeChars / BYTES_PER_MIB).toFixed(1)} MB`;
	}
	const kb = Math.max(1, Math.round(safeChars / BYTES_PER_KIB));
	return `${COUNT_FORMATTER.format(kb)} KB`;
}

/**
 * Formats the dynamic `[!info]` standby callout naming the exact threshold metric(s) that
 * triggered the yield (`records` at Checkpoint 1, or `lines` and/or `KB`/`MB` at Checkpoint 2).
 */
export function formatDynamicStandbyCallout(trigger: StandbyTrigger): string {
	if (trigger.kind === 'records') {
		const formattedRecords = COUNT_FORMATTER.format(clampNonNegativeInt(trigger.totalRecords));
		return [
			'> [!info]',
			`> The template needs to render across a large result set (~${formattedRecords} records).<br>Please stand-by.`,
		].join('\n');
	}

	const { chars, lines } = trigger.metrics;
	const linesExceeded = lines >= LARGE_MARKDOWN_LINE_THRESHOLD;
	const charsExceeded = chars >= LARGE_MARKDOWN_CHAR_THRESHOLD;
	const parts: string[] = [];

	if (linesExceeded || !charsExceeded) {
		parts.push(`~${COUNT_FORMATTER.format(clampNonNegativeInt(lines))} lines`);
	}
	if (charsExceeded) {
		parts.push(`~${formatHumanMarkdownSize(chars)}`);
	}

	return [
		'> [!info]',
		`> The generated Markdown output is large (${parts.join(', ')}).<br>Please stand-by.`,
		'>',
		'> If Obsidian stops responding, force-close and reopen the app to pause this codeblock so you can edit it.',
	].join('\n');
}

/**
 * Formats the Checkpoint 1 `[!info]` standby Markdown callout for a large query record count,
 * delegating to `formatDynamicStandbyCallout` as the single source of truth.
 */
export function formatLargeRenderStandbyCallout(totalRecords: number): string {
	return formatDynamicStandbyCallout({ kind: 'records', totalRecords });
}

/**
 * Formats the `[!danger]` quarantine Markdown callout shown when a previous session terminated
 * while rendering a heavy `rhizome` codeblock.
 */
export function formatQuarantinedCalloutMarkdown(record: PersistedRenderSentinelRecord): string {
	const formattedRecords = COUNT_FORMATTER.format(clampNonNegativeInt(record.records));
	const formattedLines = COUNT_FORMATTER.format(clampNonNegativeInt(record.outputLines));
	const formattedSize = formatHumanMarkdownSize(record.outputChars);

	return [
		'> [!danger] Render paused after a previous crash',
		`> Obsidian closed unexpectedly while rendering this codeblock (~${formattedRecords} records, ~${formattedLines} lines, ~${formattedSize}).`,
		'>',
		'> To reduce render cost, narrow the query, limit rendered fields, or remove language identifiers (such as `json`) from fenced codeblocks in the template because syntax highlighting is expensive. Select **Retry** to render it again.',
	].join('\n');
}

interface ObsidianDomHost {
	querySelector?: (selector: string) => HTMLElement | null;
	createDiv?: (opts?: { cls?: string }) => ObsidianDomHost & HTMLElement;
	createEl?: <K extends keyof HTMLElementTagNameMap>(
		tag: K,
		opts?: { cls?: string; text?: string; attr?: Record<string, string> },
	) => HTMLElementTagNameMap[K];
}

/**
 * Appends a native **Retry** button inside the quarantined `[!danger]` callout container,
 * stopping `mousedown` and `click` propagation so Live Preview does not collapse the widget
 * into source-edit mode when clicked.
 */
export function appendQuarantineRetryButton(
	containerEl: HTMLElement,
	renderChild: MarkdownRenderChild,
	onRetry: () => void,
): HTMLButtonElement | null {
	const outerHost = containerEl as unknown as ObsidianDomHost;
	const targetHost =
		(typeof outerHost.querySelector === 'function'
			? (outerHost.querySelector('.callout-content') as unknown as ObsidianDomHost | null)
			: null) ?? outerHost;

	let buttonEl: HTMLButtonElement | null = null;
	if (typeof targetHost.createDiv === 'function') {
		const actionsEl = targetHost.createDiv({ cls: 'rhizome-quarantine-actions' });
		if (typeof actionsEl.createEl === 'function') {
			buttonEl = actionsEl.createEl('button', {
				cls: 'mod-cta',
				text: 'Retry',
				attr: { type: 'button' },
			});
		}
	}

	if (!buttonEl) {
		return null;
	}

	let retrying = false;
	const onMouseDown = (evt: Event): void => {
		evt.preventDefault();
		evt.stopPropagation();
	};
	const onClick = (evt: Event): void => {
		evt.preventDefault();
		evt.stopPropagation();
		if (retrying) return;
		retrying = true;
		onRetry();
	};

	buttonEl.addEventListener('mousedown', onMouseDown);
	buttonEl.addEventListener('click', onClick);
	renderChild.register(() => {
		buttonEl.removeEventListener('mousedown', onMouseDown);
		buttonEl.removeEventListener('click', onClick);
	});
	return buttonEl;
}

/**
 * Schedules `cb` after the owning window completes its next animation frame (`Style` + `Layout` +
 * `Paint`) and a trailing macrotask (`setTimeout(..., 0)`), falling back to a macrotask when the
 * owning document is hidden/minimized so background or popout windows do not stall sentinel cleanup
 * while visible windows hold `'running'` across C++ table layout and PrismJS work.
 */
export function schedulePostRenderPaintCleanup(cb: () => void, containerEl?: HTMLElement): void {
	const ownerWin =
		(containerEl as { ownerDocument?: { defaultView?: Window | null } } | undefined)
			?.ownerDocument?.defaultView ?? window;
	const doc = (ownerWin as { document?: Document | undefined }).document;

	let settled = false;
	let rafId: number | null = null;

	const cleanupVisibility = (): void => {
		if (doc && typeof doc.removeEventListener === 'function') {
			doc.removeEventListener('visibilitychange', onVisibilityChange);
		}
	};

	const invokeOnce = (): void => {
		if (settled) return;
		settled = true;
		cleanupVisibility();
		cb();
	};

	const onVisibilityChange = (): void => {
		if (doc?.visibilityState === 'hidden' && !settled) {
			if (rafId !== null && typeof ownerWin.cancelAnimationFrame === 'function') {
				ownerWin.cancelAnimationFrame(rafId);
				rafId = null;
			}
			cleanupVisibility();
			ownerWin.setTimeout(invokeOnce, 0);
		}
	};

	const isHidden = doc?.visibilityState === 'hidden';
	if (!isHidden && typeof ownerWin.requestAnimationFrame === 'function') {
		if (doc && typeof doc.addEventListener === 'function') {
			doc.addEventListener('visibilitychange', onVisibilityChange);
		}
		rafId = ownerWin.requestAnimationFrame(() => {
			rafId = null;
			cleanupVisibility();
			ownerWin.setTimeout(invokeOnce, 0);
		});
		return;
	}
	ownerWin.setTimeout(invokeOnce, 0);
}

/**
 * Yields to the browser rendering pipeline (`requestAnimationFrame` followed by a macrotask,
 * bounded by a `32 ms` fallback timer when the window is occluded or minimized) so a standby
 * callout mounted into `el` is composited and painted before heavy synchronous template or
 * DOM work blocks the main thread. Resolves early if either signal aborts.
 */
export function yieldForBrowserPaint(
	outerSignal: AbortSignal,
	cycleSignal: AbortSignal,
): Promise<void> {
	if (outerSignal.aborted || cycleSignal.aborted) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		let settled = false;
		let timeoutId: number | null = null;
		let fallbackTimeoutId: number | null = null;
		let rafId: number | null = null;

		const finish = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
				window.cancelAnimationFrame(rafId);
				rafId = null;
			}
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
				timeoutId = null;
			}
			if (fallbackTimeoutId !== null) {
				window.clearTimeout(fallbackTimeoutId);
				fallbackTimeoutId = null;
			}
			outerSignal.removeEventListener('abort', finish);
			cycleSignal.removeEventListener('abort', finish);
			resolve();
		};

		outerSignal.addEventListener('abort', finish, { once: true });
		cycleSignal.addEventListener('abort', finish, { once: true });

		const scheduleMacrotask = (): void => {
			rafId = null;
			if (settled || outerSignal.aborted || cycleSignal.aborted) {
				finish();
				return;
			}
			timeoutId = window.setTimeout(finish, 0);
		};

		if (typeof window.requestAnimationFrame === 'function') {
			rafId = window.requestAnimationFrame(scheduleMacrotask);
			fallbackTimeoutId = window.setTimeout(finish, PAINT_YIELD_FALLBACK_MS);
		} else {
			scheduleMacrotask();
		}
	});
}

export interface CodeBlockRenderTelemetry {
	readonly parseMs: number;
	readonly liquidMs: number;
	readonly markdownRenderMs: number;
	readonly records: number;
	readonly outputChars: number;
	readonly outputLines: number;
	readonly standbyShown?: boolean | undefined;
	readonly cacheHit?: 'remount' | 'payload' | 'coalesced' | undefined;
}

export function logCodeBlockRenderResult(
	logger: LoggerPort | undefined,
	sourcePath: string,
	result: TemplateRenderResult,
	telemetry: CodeBlockRenderTelemetry,
): void {
	const durationMs = telemetry.parseMs + telemetry.liquidMs + telemetry.markdownRenderMs;
	if (!result.ok) {
		const isRenderError = result.diagnostics.some((d) => d.code === 'TEMPLATE_RENDER_ERROR');
		logger?.log(
			'warn',
			`Template ${isRenderError ? 'render' : 'parse'} diagnostics in ${markSensitive(sourcePath)}`,
			{
				source: isRenderError ? 'template.render' : 'template.parse',
				durationMs,
				count: result.diagnostics.length,
				queryCount: result.queries.length,
				codes: result.diagnostics.map((d) => d.code),
				parseMs: telemetry.parseMs,
				liquidMs: telemetry.liquidMs,
				markdownRenderMs: telemetry.markdownRenderMs,
				records: telemetry.records,
				outputChars: telemetry.outputChars,
				outputLines: telemetry.outputLines,
				...(telemetry.standbyShown ? { standbyShown: true } : {}),
				...(telemetry.cacheHit !== undefined
					? { cached: true, cacheHit: telemetry.cacheHit }
					: {}),
			},
		);
	} else {
		logger?.log('debug', `Rendered rhizome codeblock in ${markSensitive(sourcePath)}`, {
			source: 'template.render',
			durationMs,
			count: result.queries.length,
			parseMs: telemetry.parseMs,
			liquidMs: telemetry.liquidMs,
			markdownRenderMs: telemetry.markdownRenderMs,
			records: telemetry.records,
			outputChars: telemetry.outputChars,
			outputLines: telemetry.outputLines,
			...(telemetry.standbyShown ? { standbyShown: true } : {}),
			...(telemetry.cacheHit !== undefined
				? { cached: true, cacheHit: telemetry.cacheHit }
				: {}),
		});
	}
}
