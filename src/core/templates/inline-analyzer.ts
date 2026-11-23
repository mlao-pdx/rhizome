import {
	extractInlineRhizomeExpression,
	type ExtractInlineExpressionOptions,
	parseInlineRhizomeExpression,
} from './inline-expression';
import { offsetRangeToSourceSpan } from './query-tag';
import type {
	CodeBlockDiagnosticSpan,
	CodeBlockTokenKind,
	CodeBlockTokenSpan,
} from './template-analyzer';

/**
 * Static syntax-highlighting and lint analysis for a single inline `◊ ...` code-span interior,
 * with all offsets mapped back to the raw interior string passed to `analyzeInlineRhizomeSpan`.
 */
export interface InlineSpanAnalysis {
	readonly tokens: readonly CodeBlockTokenSpan[];
	readonly diagnostics: readonly CodeBlockDiagnosticSpan[];
}

const INLINE_LIQUID_KEYWORDS: ReadonlySet<string> = new Set([
	'and',
	'or',
	'not',
	'contains',
	'true',
	'false',
	'nil',
	'null',
	'empty',
	'blank',
]);

const INLINE_TOKEN_RE =
	/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\|\s*[a-zA-Z_][a-zA-Z0-9_-]*)|([+-]?\d+(?:\.\d+)?)|([a-zA-Z_\u25CA][a-zA-Z0-9_.\u25CA-]*(?:\+\d+d?)?)/g;

function mapExprOffsetToRaw(exprOffsets: readonly number[], offset: number): number {
	const maxIdx = exprOffsets.length - 1;
	const clamped = Math.max(0, Math.min(maxIdx, offset));
	return exprOffsets[clamped] ?? 0;
}

function scanUnquotedQueryReferences(
	expr: string,
): Array<{ readonly start: number; readonly end: number }> {
	const refs: Array<{ readonly start: number; readonly end: number }> = [];
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i]!;
		if (quote !== null) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch !== 'q' || expr.slice(i, i + 5) !== 'query') {
			continue;
		}

		const prevChar = i > 0 ? expr[i - 1]! : '';
		if (prevChar === '.' || /[a-zA-Z0-9_-]/.test(prevChar)) {
			continue;
		}
		const afterWord = expr[i + 5] ?? '';
		if (/[a-zA-Z0-9_-]/.test(afterWord)) {
			continue;
		}

		// Skip `| query` where `query` is in filter-name position.
		let back = i - 1;
		while (back >= 0 && /[\s\u00A0]/.test(expr[back]!)) {
			back--;
		}
		if (back >= 0 && expr[back] === '|') {
			continue;
		}

		let end = i + 5;
		while (end < expr.length && expr[end] === '.') {
			if (expr[end + 1] === '.') {
				// Stop before `..` range operator (`query..x`)
				break;
			}
			const segMatch = /^[a-zA-Z0-9_-]+/.exec(expr.slice(end + 1));
			if (!segMatch) {
				break;
			}
			end += 1 + segMatch[0].length;
		}

		// Skip named filter kwargs like `| foo: query: 1`.
		let ahead = end;
		while (ahead < expr.length && /[\s\u00A0]/.test(expr[ahead]!)) {
			ahead++;
		}
		if (end === i + 5 && expr[ahead] === ':') {
			continue;
		}

		refs.push({ start: i, end });
		i = end - 1;
	}

	return refs;
}

/**
 * Analyzes a CommonMark inline code-span interior (`rawInterior`, excluding surrounding backticks)
 * for Rhizome inline `◊ ...` syntax highlighting and diagnostics, mapping all offsets back
 * to `rawInterior` coordinates.
 */
export function analyzeInlineRhizomeSpan(
	rawInterior: string,
	options?: ExtractInlineExpressionOptions,
): InlineSpanAnalysis {
	const extracted = extractInlineRhizomeExpression(rawInterior, options);
	if (extracted === null) {
		return Object.freeze({
			tokens: Object.freeze([]),
			diagnostics: Object.freeze([]),
		});
	}

	const { expr, signetOffset, exprOffsets } = extracted;
	const rawTokens: CodeBlockTokenSpan[] = [
		{
			startOffset: signetOffset,
			endOffset: Math.min(rawInterior.length, signetOffset + 1),
			kind: 'liquid-delimiter',
		},
	];

	INLINE_TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INLINE_TOKEN_RE.exec(expr)) !== null) {
		const exprStart = match.index;
		const exprEnd = exprStart + match[0].length;
		const rawStart = mapExprOffsetToRaw(exprOffsets, exprStart);
		const rawEnd = mapExprOffsetToRaw(exprOffsets, exprEnd);
		if (rawEnd <= rawStart) {
			continue;
		}
		let kind: CodeBlockTokenKind;
		if (match[1] !== undefined) {
			kind = 'liquid-string';
		} else if (match[2] !== undefined) {
			kind = 'liquid-filter';
		} else if (match[3] !== undefined) {
			kind = 'liquid-number';
		} else {
			const word = match[4] ?? '';
			kind = INLINE_LIQUID_KEYWORDS.has(word) ? 'liquid-keyword' : 'liquid-variable';
		}
		rawTokens.push({ startOffset: rawStart, endOffset: rawEnd, kind });
	}

	rawTokens.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
	const normalizedTokens: CodeBlockTokenSpan[] = [];
	let tokenCursor = 0;
	for (const tok of rawTokens) {
		const start = Math.max(
			tokenCursor,
			Math.max(0, Math.min(rawInterior.length, tok.startOffset)),
		);
		const end = Math.max(start, Math.min(rawInterior.length, tok.endOffset));
		if (end > start) {
			normalizedTokens.push(
				Object.freeze({ startOffset: start, endOffset: end, kind: tok.kind }),
			);
			tokenCursor = end;
		}
	}

	const rawDiags: CodeBlockDiagnosticSpan[] = [];
	const parsed = parseInlineRhizomeExpression(expr);
	if (!parsed.ok) {
		const d = parsed.diagnostic;
		const exprStart = d.span ? d.span.startOffset : 0;
		const exprEnd = d.span ? Math.max(exprStart + 1, d.span.endOffset) : expr.length;
		const rawStart = mapExprOffsetToRaw(exprOffsets, exprStart);
		const rawEnd = Math.max(rawStart + 1, mapExprOffsetToRaw(exprOffsets, exprEnd));
		const clampedSpan = offsetRangeToSourceSpan(rawInterior, rawStart, rawEnd);
		rawDiags.push(
			Object.freeze({
				startOffset: clampedSpan.startOffset,
				endOffset: clampedSpan.endOffset,
				code: d.code,
				severity: d.severity,
				issue: d.issue,
				hint: d.hint,
				span: clampedSpan,
			}),
		);
	}

	for (const qRef of scanUnquotedQueryReferences(expr)) {
		const rawStart = mapExprOffsetToRaw(exprOffsets, qRef.start);
		const rawEnd = Math.max(rawStart + 1, mapExprOffsetToRaw(exprOffsets, qRef.end));
		const clampedSpan = offsetRangeToSourceSpan(rawInterior, rawStart, rawEnd);
		rawDiags.push(
			Object.freeze({
				startOffset: clampedSpan.startOffset,
				endOffset: clampedSpan.endOffset,
				code: 'INLINE_QUERY_SCOPE_UNAVAILABLE',
				severity: 'warning',
				issue: "Inline '◊' expressions cannot access 'query' results from fenced 'rhizome' codeblocks; 'query' is always empty here.",
				hint: "Use 'this.<field>' for the hosting note's metadata, or move vault queries into a fenced 'rhizome' codeblock.",
				span: clampedSpan,
			}),
		);
	}

	rawDiags.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

	return Object.freeze({
		tokens: Object.freeze(normalizedTokens),
		diagnostics: Object.freeze(rawDiags),
	});
}
