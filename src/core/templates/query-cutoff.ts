import { FORBIDDEN_KEYS, formatInlineCode } from '@core/search';
import type { ExtractedQueryBlock, TemplateRuntimeContext } from './types';

/**
 * Default maximum number of matched records forwarded into LiquidJS Pass 2 per
 * `{% query %}` block when no explicit `cutoff:` option is specified.
 */
export const DEFAULT_QUERY_CUTOFF = 5_000;

const CUTOFF_NUMBER_FORMAT = new Intl.NumberFormat('en-US');
const WIKILINK_UNSAFE_RE = /[[\]#^|\r\n]/;

/**
 * Result returned by `applyQueryCutoffs` prior to LiquidJS Pass 2 rendering.
 */
export interface QueryCutoffApplication {
	readonly effectivePayload: Readonly<Record<string, unknown[]>>;
	readonly calloutsMarkdown: string;
}

function compareQueryNames(a: string, b: string): number {
	const lowerA = a.toLowerCase();
	const lowerB = b.toLowerCase();
	if (lowerA < lowerB) return -1;
	if (lowerA > lowerB) return 1;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function formatProvenancePath(path: string): string {
	if (WIKILINK_UNSAFE_RE.test(path)) {
		return formatInlineCode(path);
	}
	return `[[${path}]]`;
}

function formatCutoffProvenance(
	queryBlock: ExtractedQueryBlock,
	runtimeContext?: TemplateRuntimeContext,
): string {
	const line = queryBlock.headerSpan.startLine;
	const partialFile =
		typeof queryBlock.file === 'string' && queryBlock.file.trim().length > 0
			? queryBlock.file.trim()
			: null;
	if (partialFile !== null) {
		return `Defined in ${formatProvenancePath(partialFile)} (line ${line})`;
	}

	const hostPath =
		typeof runtimeContext?.sourcePath === 'string' &&
		runtimeContext.sourcePath.trim().length > 0
			? runtimeContext.sourcePath.trim()
			: null;
	if (hostPath !== null) {
		return `Defined inline in this codeblock in ${formatProvenancePath(hostPath)} (line ${line})`;
	}

	return `Defined inline in this codeblock (line ${line})`;
}

/**
 * Formats a collapsed Obsidian `[!warning]-` callout explaining that `queryBlock`
 * matched more records than its active `cutoff` and how to refine or override it.
 */
export function formatQueryCutoffCallout(
	queryBlock: ExtractedQueryBlock,
	matchedCount: number,
	runtimeContext?: TemplateRuntimeContext,
): string {
	const matchedFormatted = CUTOFF_NUMBER_FORMAT.format(matchedCount);
	const cutoffFormatted = CUTOFF_NUMBER_FORMAT.format(queryBlock.cutoff);
	const provenance = formatCutoffProvenance(queryBlock, runtimeContext);

	return [
		`> [!warning]- Query \`${queryBlock.name}\` ${matchedFormatted} matches; cut-off at ${cutoffFormatted}`,
		`> ${provenance}. Results are truncated in vault scan order before Liquid filters run:`,
		'> - Narrow the query filters to match fewer notes.',
		'> - Set `cutoff: 0` and pipe through `| sort: ... | slice: 0, N` to take the top `N` across all matches.',
		`> - Raise \`cutoff: <number>\` (or \`cutoff: 0\` for no limit) in \`{% query ${queryBlock.name} %}\` if the template needs every match.`,
	].join('\n');
}

/**
 * Non-destructively slices any query arrays in `safePayload` whose length exceeds
 * the extracted query block's `cutoff` (`> 0`) and formats deterministic alphabetical
 * `[!warning]-` callouts to prepend to the rendered template output.
 */
export function applyQueryCutoffs(
	queries: readonly ExtractedQueryBlock[],
	safePayload: Readonly<Record<string, unknown[]>>,
	runtimeContext?: TemplateRuntimeContext,
): QueryCutoffApplication {
	if (queries.length === 0) {
		return Object.freeze({
			effectivePayload: safePayload,
			calloutsMarkdown: '',
		});
	}

	const sortedQueries = [...queries].sort((a, b) => compareQueryNames(a.name, b.name));
	const truncatedEntries: Array<readonly [string, unknown[]]> = [];
	const callouts: string[] = [];

	for (const q of sortedQueries) {
		if (q.cutoff <= 0 || FORBIDDEN_KEYS.has(q.name)) {
			continue;
		}
		if (!Object.prototype.hasOwnProperty.call(safePayload, q.name)) {
			continue;
		}
		const rawMatches = safePayload[q.name];
		if (!Array.isArray(rawMatches) || rawMatches.length <= q.cutoff) {
			continue;
		}

		const sliced = Object.freeze(rawMatches.slice(0, q.cutoff)) as unknown as unknown[];
		truncatedEntries.push([q.name, sliced]);
		callouts.push(formatQueryCutoffCallout(q, rawMatches.length, runtimeContext));
	}

	if (truncatedEntries.length === 0) {
		return Object.freeze({
			effectivePayload: safePayload,
			calloutsMarkdown: '',
		});
	}

	const derived = Object.create(null) as Record<string, unknown[]>;
	for (const key of Object.keys(safePayload)) {
		if (FORBIDDEN_KEYS.has(key)) {
			continue;
		}
		derived[key] = safePayload[key]!;
	}
	for (const [name, sliced] of truncatedEntries) {
		derived[name] = sliced;
	}

	return Object.freeze({
		effectivePayload: Object.freeze(derived),
		calloutsMarkdown: callouts.join('\n\n'),
	});
}
