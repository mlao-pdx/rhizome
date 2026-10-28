import { Temporal } from '@js-temporal/polyfill';
import {
	encodeDoubleQuoted,
	formatLeafMatcher,
	formatRhsDisplay,
	formatScopeRhsDisplay,
	formatValueExprInner,
} from './linter';
import { resolveQueryPropertyType } from './property-coercion';
import { normalizeTagBody } from './scopes';
import {
	isVirtualFileKey,
	type DateGrain,
	type DateInterval,
	type ObsidianPropertyType,
	type PropertyFilterNode,
	type PropertyOperator,
	type PropertyTypeRegistry,
	type ScopedFilterNode,
	type SearchAST,
	type SourceSpan,
	type TextMatchNode,
	type ValueExprAST,
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
	readonly plainEnglish: string;
}

export interface ScopeSemanticsInfo {
	readonly friendlyTitle: string;
	readonly singularTarget: string;
	readonly targetsDescription: string;
	readonly matchRuleDescription: string;
	readonly formatPlainStringMatch: (value: string) => string;
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

function formatReadableLocalMoment(epochMs: number, timeZone: string): string {
	try {
		const zdt = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
		const y = String(zdt.year).padStart(4, '0');
		const m = String(zdt.month).padStart(2, '0');
		const d = String(zdt.day).padStart(2, '0');
		const hh = String(zdt.hour).padStart(2, '0');
		const mm = String(zdt.minute).padStart(2, '0');
		const ss = String(zdt.second).padStart(2, '0');
		if (zdt.millisecond !== 0) {
			const ms = String(zdt.millisecond).padStart(3, '0');
			return `\`${y}-${m}-${d} ${hh}:${mm}:${ss}.${ms}\` (\`${timeZone}\`)`;
		}
		if (zdt.second !== 0) {
			return `\`${y}-${m}-${d} ${hh}:${mm}:${ss}\` (\`${timeZone}\`)`;
		}
		return `\`${y}-${m}-${d} ${hh}:${mm}\` (\`${timeZone}\`)`;
	} catch {
		return `\`${formatEpochTimestamp(epochMs, timeZone).utcIso}\``;
	}
}

/**
 * Formats a half-open `[start, end)` `DateInterval` along with both reference interval inequalities and plain-English descriptions.
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

	const startReadable = formatReadableLocalMoment(interval.start, timeZone);
	const endReadable = formatReadableLocalMoment(interval.end, timeZone);
	const rawCode = formatInlineCode(interval.raw);

	let inequality: string;
	let description: string;
	let plainEnglish: string;
	switch (operator) {
		case ':':
		case '=':
			inequality = 'D.start >= Q.start && D.end <= Q.end';
			description = 'note interval D is contained within query window Q';
			plainEnglish =
				interval.grain === 'ms'
					? `is exactly ${startReadable}`
					: `falls within ${startReadable} to ${endReadable} (${interval.grain} window for ${rawCode})`;
			break;
		case '!=':
			inequality = 'D.start < Q.start || D.end > Q.end';
			description = 'note interval D is not contained within query window Q';
			plainEnglish = `is outside ${startReadable} to ${endReadable} (${interval.grain} window for ${rawCode})`;
			break;
		case '<':
			inequality = 'D.end <= Q.start';
			description = 'note interval D ends at or before query window start Q.start';
			plainEnglish = `is before ${startReadable} (start of ${rawCode})`;
			break;
		case '<=':
			inequality = 'D.end <= Q.end';
			description = 'note interval D ends at or before query window end Q.end';
			plainEnglish = `ends at or before ${endReadable} (end of ${rawCode})`;
			break;
		case '>':
			inequality = 'D.start >= Q.end';
			description = 'note interval D starts at or after query window end Q.end';
			plainEnglish = `is on or after ${endReadable} (end of ${rawCode})`;
			break;
		case '>=':
			inequality = 'D.start >= Q.start';
			description = 'note interval D starts at or after query window start Q.start';
			plainEnglish = `is on or after ${startReadable} (start of ${rawCode})`;
			break;
		default:
			inequality = 'D overlaps Q';
			description = 'interval comparison';
			plainEnglish = `matches ${rawCode}`;
			break;
	}

	return {
		grain: interval.grain,
		utcWindow,
		localWindow,
		inequality,
		description,
		plainEnglish,
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
				friendlyTitle: 'Filename filter',
				singularTarget: 'filename (`file.name` or `file.basename`)',
				targetsDescription:
					'`file.name` (with extension) and `file.basename` (without extension)',
				matchRuleDescription: 'case-insensitive substring match',
				formatPlainStringMatch: (val) =>
					`contains ${formatInlineCode(val)} (case-insensitive)`,
			};
		case 'path':
			return {
				friendlyTitle: 'Folder / path filter',
				singularTarget: 'vault-relative path (`file.path`)',
				targetsDescription: 'vault-relative `file.path`',
				matchRuleDescription: 'case-insensitive substring match',
				formatPlainStringMatch: (val) =>
					`contains ${formatInlineCode(val)} (case-insensitive)`,
			};
		case 'ext':
			return {
				friendlyTitle: 'File extension filter',
				singularTarget: 'file extension (`file.extension`)',
				targetsDescription: '`file.extension`',
				matchRuleDescription:
					'case-insensitive exact match (after stripping any leading `.` from the query value)',
				formatPlainStringMatch: (val) => {
					const norm = val.toLowerCase().replace(/^\./, '');
					return `equals ${formatInlineCode(norm)} (case-insensitive)`;
				},
			};
		case 'tag':
			return {
				friendlyTitle: 'Tag filter',
				singularTarget: 'tag',
				targetsDescription: 'all note `tags` (frontmatter, inline, and body)',
				matchRuleDescription:
					'case-insensitive hierarchical tag match (`#a` matches `#a` and `#a/...`, with leading `#` stripped)',
				formatPlainStringMatch: (val) => {
					const norm = normalizeTagBody(val);
					return `is ${formatInlineCode(`#${norm}`)} or a nested tag under ${formatInlineCode(`#${norm}/...`)} (case-insensitive)`;
				},
			};
		case 'aliases':
			return {
				friendlyTitle: 'Alias filter',
				singularTarget: 'alias',
				targetsDescription: 'note `aliases`',
				matchRuleDescription: 'case-insensitive substring match',
				formatPlainStringMatch: (val) =>
					`contains ${formatInlineCode(val)} (case-insensitive)`,
			};
		case 'headings':
			return {
				friendlyTitle: 'Heading filter',
				singularTarget: 'section heading',
				targetsDescription: 'section `headings` text (`#` through `######`)',
				matchRuleDescription: 'case-insensitive substring match',
				formatPlainStringMatch: (val) =>
					`contains ${formatInlineCode(val)} (case-insensitive)`,
			};
		case 'links':
			return {
				friendlyTitle: 'Outgoing link filter',
				singularTarget: 'outgoing link',
				targetsDescription:
					'outgoing `links` (`link`, `rawTarget`, `resolvedPath` if resolved, and `displayText`)',
				matchRuleDescription: 'case-insensitive substring match',
				formatPlainStringMatch: (val) =>
					`contains ${formatInlineCode(val)} (case-insensitive)`,
			};
		case 'embeds':
			return {
				friendlyTitle: 'Embed filter',
				singularTarget: 'embedded link',
				targetsDescription:
					'outgoing `embeds` (`link`, `rawTarget`, and `resolvedPath` if resolved)',
				matchRuleDescription: 'case-insensitive substring match',
				formatPlainStringMatch: (val) =>
					`contains ${formatInlineCode(val)} (case-insensitive)`,
			};
		case 'blocks':
			return {
				friendlyTitle: 'Block ID filter',
				singularTarget: 'block ID (`^id`)',
				targetsDescription: 'note `blocks` (`^block-id` identifiers)',
				matchRuleDescription:
					'case-insensitive exact match (after stripping any leading `^` from the query value)',
				formatPlainStringMatch: (val) => {
					const norm = val.toLowerCase().replace(/^\^/, '');
					return `equals ${formatInlineCode(`^${norm}`)} (case-insensitive)`;
				},
			};
		default: {
			const scopeCode = formatInlineCode(scope);
			return {
				friendlyTitle: `Scope ${scopeCode} filter`,
				singularTarget: `${scopeCode} value`,
				targetsDescription: `custom scope ${scopeCode} extracted targets`,
				matchRuleDescription: `custom scope ${scopeCode} string matcher`,
				formatPlainStringMatch: (val) => `matches ${formatInlineCode(val)}`,
			};
		}
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
 * Extracts the exact authored substring of `input` covered by `node.span`,
 * falling back to reconstructed syntax when `span` is absent or out of bounds.
 */
export function extractAstSlice(input: string, node: SearchAST): string {
	if (node.type === 'MATCH_ALL') {
		return input.trim();
	}
	if (
		node.span &&
		node.span.startOffset >= 0 &&
		node.span.endOffset >= node.span.startOffset &&
		node.span.endOffset <= input.length
	) {
		return input.slice(node.span.startOffset, node.span.endOffset);
	}
	switch (node.type) {
		case 'TEXT_MATCH':
		case 'SCOPED_FILTER':
		case 'PROPERTY_FILTER':
			return formatAuthoredFilter(node);
		case 'NOT': {
			const childSlice = extractAstSlice(input, node.child);
			return node.syntax === '-' ? `-${childSlice}` : `NOT ${childSlice}`;
		}
		case 'LOGICAL': {
			const joiner = node.operator === 'OR' ? ' OR ' : node.implicit ? ' ' : ' AND ';
			const inner = node.children.map((c) => extractAstSlice(input, c)).join(joiner);
			return node.parenthesized ? `(${inner})` : inner;
		}
	}
}

/**
 * Extracts the exact authored substring of `input` covered by `expr.span`,
 * falling back to `formatValueExprInner(expr)` when `span` is absent or out of bounds.
 */
export function extractValueExprSlice(input: string, expr: ValueExprAST): string {
	if (
		expr.span &&
		expr.span.startOffset >= 0 &&
		expr.span.endOffset >= expr.span.startOffset &&
		expr.span.endOffset <= input.length
	) {
		return input.slice(expr.span.startOffset, expr.span.endOffset);
	}
	return formatValueExprInner(expr);
}

/**
 * Formats a 1-based line snippet for a `SourceSpan` in `input` by enclosing the pertinent span
 * inline with `‼️...‼️` markers, avoiding multi-line caret alignment issues when wrapped.
 */
export function formatSourceCaretSnippet(input: string, span: SourceSpan): string {
	const lines = input.split(/\r\n|\r|\n/);
	const lineIdx = Math.max(0, Math.min(lines.length - 1, span.startLine - 1));
	const rawLine = lines[lineIdx] ?? '';
	const displayLine = rawLine.replace(/\t/g, ' ');
	const linePrefix = `${span.startLine} | `;
	const colZeroBased = Math.max(0, Math.min(displayLine.length, span.startColumn - 1));
	const rawSpanLen = Math.max(0, span.endOffset - span.startOffset);
	const highlightLen = Math.min(rawSpanLen, Math.max(0, displayLine.length - colZeroBased));
	const before = displayLine.slice(0, colZeroBased);
	const highlighted = displayLine.slice(colZeroBased, colZeroBased + highlightLen);
	const after = displayLine.slice(colZeroBased + highlightLen);
	return `${linePrefix}${before}‼️${highlighted}‼️${after}`;
}
