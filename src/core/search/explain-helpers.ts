import { Temporal } from '@js-temporal/polyfill';
import {
	encodeDoubleQuoted,
	formatLeafMatcher,
	formatRhsDisplay,
	formatScopeRhsDisplay,
	formatValueExprInner,
} from './linter';
import { resolveQueryPropertyType } from './property-coercion';
import {
	isVirtualFileKey,
	type DateGrain,
	type DateInterval,
	type ObsidianPropertyType,
	type PropertyFilterNode,
	type PropertyOperator,
	type PropertyTypeRegistry,
	type ScopedFilterNode,
	type SourceSpan,
	type TextMatchNode,
} from './types';

export {
	encodeDoubleQuoted,
	formatLeafMatcher,
	formatRhsDisplay,
	formatScopeRhsDisplay,
	formatValueExprInner,
};

export type PropertyTypeOrigin = 'virtual' | 'built-in' | 'configured' | 'default';

export interface ResolvedPropertyTypeInfo {
	readonly type: ObsidianPropertyType;
	readonly origin: PropertyTypeOrigin;
	readonly originLabel: string;
}

export interface FormattedIntervalWindow {
	readonly grain: DateGrain;
	readonly utcWindow: string;
	readonly localWindow: string;
	readonly inequality: string;
	readonly description: string;
}

export interface ScopeSemanticsInfo {
	readonly targetsDescription: string;
	readonly matchRuleDescription: string;
}

/**
 * Resolves a lowercased property key to its `ObsidianPropertyType` and origin classification.
 */
export function resolvePropertyTypeWithOrigin(
	lowerKey: string,
	registry: Readonly<PropertyTypeRegistry>,
): ResolvedPropertyTypeInfo {
	if (isVirtualFileKey(lowerKey)) {
		return {
			type: resolveQueryPropertyType(lowerKey, registry),
			origin: 'virtual',
			originLabel: 'virtual (file.*)',
		};
	}
	if (lowerKey === 'tags' || lowerKey === 'tag') {
		return {
			type: 'tags',
			origin: 'built-in',
			originLabel: 'built-in',
		};
	}
	if (lowerKey === 'aliases' || lowerKey === 'alias') {
		return {
			type: 'multitext',
			origin: 'built-in',
			originLabel: 'built-in',
		};
	}
	if (Object.prototype.hasOwnProperty.call(registry, lowerKey)) {
		const configured = registry[lowerKey];
		if (configured !== undefined) {
			return {
				type: configured,
				origin: 'configured',
				originLabel: 'configured',
			};
		}
	}
	return {
		type: 'text',
		origin: 'default',
		originLabel: "default fallback ('text')",
	};
}

/**
 * Formats a UTC epoch millisecond timestamp as both UTC ISO-8601 and local wall-clock in `timeZone`.
 */
export function formatEpochTimestamp(
	epochMs: number,
	timeZone: string,
): { utcIso: string; localFormatted: string } {
	let utcIso: string;
	try {
		utcIso = Temporal.Instant.fromEpochMilliseconds(epochMs).toString();
	} catch {
		const d = new Date(epochMs);
		utcIso = Number.isNaN(d.getTime()) ? `${String(epochMs)}ms` : d.toISOString();
	}

	try {
		const zdt = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
		const localIso = zdt.toString({ timeZoneName: 'never' });
		return { utcIso, localFormatted: `${localIso} (${timeZone})` };
	} catch {
		return { utcIso, localFormatted: `${utcIso} (unresolvable timezone "${timeZone}")` };
	}
}

/**
 * Formats a half-open `[start, end)` `DateInterval` along with operator comparison semantics.
 */
export function formatDateIntervalWindow(
	interval: DateInterval,
	operator: PropertyOperator,
	timeZone: string,
): FormattedIntervalWindow {
	const startFormatted = formatEpochTimestamp(interval.start, timeZone);
	const endFormatted = formatEpochTimestamp(interval.end, timeZone);

	const utcWindow = `[${startFormatted.utcIso}, ${endFormatted.utcIso})`;
	let startLocal = startFormatted.localFormatted;
	let endLocal = endFormatted.localFormatted;
	const tzSuffix = ` (${timeZone})`;
	if (startLocal.endsWith(tzSuffix) && endLocal.endsWith(tzSuffix)) {
		startLocal = startLocal.slice(0, -tzSuffix.length);
		endLocal = endLocal.slice(0, -tzSuffix.length);
	}
	const localWindow = `[${startLocal}, ${endLocal}) in ${timeZone}`;

	let inequality: string;
	let description: string;
	switch (operator) {
		case ':':
		case '=':
			inequality = 'D.start >= Q.start && D.end <= Q.end';
			description = 'note interval D is contained within query window Q';
			break;
		case '!=':
			inequality = 'D.start < Q.start || D.end > Q.end';
			description = 'note interval D is not contained within query window Q';
			break;
		case '<':
			inequality = 'D.end <= Q.start';
			description = 'note interval D ends at or before query window start Q.start';
			break;
		case '<=':
			inequality = 'D.end <= Q.end';
			description = 'note interval D ends at or before query window end Q.end';
			break;
		case '>':
			inequality = 'D.start >= Q.end';
			description = 'note interval D starts at or after query window end Q.end';
			break;
		case '>=':
			inequality = 'D.start >= Q.start';
			description = 'note interval D starts at or after query window start Q.start';
			break;
		default:
			inequality = 'D overlaps Q';
			description = 'interval comparison';
			break;
	}

	return {
		grain: interval.grain,
		utcWindow,
		localWindow,
		inequality,
		description,
	};
}

/**
 * Constructs a zero-network `regex101.com` deep link for an ECMAScript regular expression.
 */
export function buildRegex101Url(pattern: string, flags: string): string {
	return `https://regex101.com/?flavor=javascript&regex=${encodeURIComponent(pattern)}&flags=${encodeURIComponent(flags)}`;
}

/**
 * Formats the authored filter representation of a leaf AST node.
 */
export function formatAuthoredFilter(
	node: ScopedFilterNode | PropertyFilterNode | TextMatchNode,
): string {
	switch (node.type) {
		case 'TEXT_MATCH':
			return node.rawText;
		case 'SCOPED_FILTER': {
			const rhs = formatScopeRhsDisplay(node.expr);
			if (node.rawScope === '#') {
				return rhs.startsWith('#') ? rhs : `#${rhs}`;
			}
			return `${node.rawScope}:${rhs}`;
		}
		case 'PROPERTY_FILTER': {
			if (node.operator === 'EXISTS') {
				return `[${node.rawKey}]`;
			}
			const rhs = node.valueExpr ? formatScopeRhsDisplay(node.valueExpr) : '';
			if (node.operator === ':') {
				return `[${node.rawKey}:${rhs}]`;
			}
			return `[${node.rawKey} ${node.operator} ${rhs}]`;
		}
	}
}

/**
 * Returns a human-readable description of what note metadata a scope extracts and how strings match.
 */
export function describeScopeSemantics(scope: string): ScopeSemanticsInfo {
	switch (scope) {
		case 'file':
			return {
				targetsDescription:
					'`file.name` (with extension) and `file.basename` (without extension)',
				matchRuleDescription: 'case-insensitive substring match',
			};
		case 'path':
			return {
				targetsDescription: 'vault-relative `file.path`',
				matchRuleDescription: 'case-insensitive substring match',
			};
		case 'ext':
			return {
				targetsDescription: '`file.extension`',
				matchRuleDescription:
					'case-insensitive exact match (after stripping any leading `.` from the query value)',
			};
		case 'tag':
			return {
				targetsDescription: 'all note `tags` (frontmatter, inline, and body)',
				matchRuleDescription:
					'case-insensitive hierarchical tag match (`#a` matches `#a` and `#a/...`, with leading `#` stripped)',
			};
		case 'aliases':
			return {
				targetsDescription: 'note `aliases`',
				matchRuleDescription: 'case-insensitive substring match',
			};
		case 'headings':
			return {
				targetsDescription: 'section `headings` text (`#` through `######`)',
				matchRuleDescription: 'case-insensitive substring match',
			};
		case 'links':
			return {
				targetsDescription:
					'outgoing `links` (`link`, `rawTarget`, `resolvedPath` if resolved, and `displayText`)',
				matchRuleDescription: 'case-insensitive substring match',
			};
		case 'embeds':
			return {
				targetsDescription:
					'outgoing `embeds` (`link`, `rawTarget`, and `resolvedPath` if resolved)',
				matchRuleDescription: 'case-insensitive substring match',
			};
		case 'blocks':
			return {
				targetsDescription: 'note `blocks` (`^block-id` identifiers)',
				matchRuleDescription:
					'case-insensitive exact match (after stripping any leading `^` from the query value)',
			};
		default:
			return {
				targetsDescription: `custom scope \`${scope}\` extracted targets`,
				matchRuleDescription: `custom scope \`${scope}\` string matcher`,
			};
	}
}

/**
 * Safely wraps `text` in a single-line Markdown code span, choosing a backtick fence that cannot collide.
 */
export function formatInlineCode(text: string): string {
	const singleLine = text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
	let maxBackticks = 0;
	let current = 0;
	for (const ch of singleLine) {
		if (ch === '`') {
			current++;
			if (current > maxBackticks) maxBackticks = current;
		} else {
			current = 0;
		}
	}
	const fence = '`'.repeat(maxBackticks + 1);
	const needsSpace =
		singleLine.length === 0 ||
		singleLine.startsWith('`') ||
		singleLine.endsWith('`') ||
		singleLine.startsWith(' ') ||
		singleLine.endsWith(' ');
	return needsSpace ? `${fence} ${singleLine} ${fence}` : `${fence}${singleLine}${fence}`;
}

/**
 * Escapes pipes and line breaks so arbitrary text can be placed safely inside a GFM table cell.
 */
export function escapeMarkdownTableCell(text: string): string {
	return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\|/g, '\\|');
}

/**
 * Formats a 1-based line and `^` caret underline snippet for a `SourceSpan` in `input`.
 */
export function formatSourceCaretSnippet(input: string, span: SourceSpan): string {
	const lines = input.split(/\r\n|\r|\n/);
	const lineIdx = Math.max(0, Math.min(lines.length - 1, span.startLine - 1));
	const rawLine = lines[lineIdx] ?? '';
	const displayLine = rawLine.replace(/\t/g, ' ');
	const linePrefix = `${span.startLine} | `;
	const colZeroBased = Math.max(0, Math.min(displayLine.length, span.startColumn - 1));
	const rawSpanLen = Math.max(1, span.endOffset - span.startOffset);
	const maxCaretLen = Math.max(1, displayLine.length - colZeroBased);
	const caretLen = Math.max(1, Math.min(rawSpanLen, maxCaretLen));
	const caretLine = `${' '.repeat(linePrefix.length + colZeroBased)}${'^'.repeat(caretLen)}`;
	return `${linePrefix}${displayLine}\n${caretLine}`;
}
