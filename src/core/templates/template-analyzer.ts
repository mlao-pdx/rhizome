import {
	And,
	BangNot,
	Colon,
	compileQuery,
	CompOp,
	DateTimeLiteral,
	type DiagnosticCode,
	Identifier,
	LBracket,
	LIQUID_BLOCK_COMMENT_PATTERN,
	LIQUID_INLINE_COMMENT_PATTERN,
	LParen,
	Not,
	Or,
	QuotedString,
	RBracket,
	RegexLiteral,
	type ResolvedEngineConfig,
	RParen,
	SearchLexer,
	type SourceSpan,
	TagLiteral,
	WikiLinkValue,
} from '@core/search';
import { offsetRangeToSourceSpan, parseQueryTagArgs, scanQueryBlockSpans } from './query-tag';
import { parseRhizomeTemplatePass1 } from './template-engine';
import type { ExtractedQueryBlock, TemplateDiagnosticCode } from './types';

/**
 * Semantic token categories emitted by `analyzeRhizomeCodeBlock` for CodeMirror 6 highlighting.
 */
export type CodeBlockTokenKind =
	| 'liquid-delimiter'
	| 'liquid-keyword'
	| 'liquid-filter'
	| 'liquid-variable'
	| 'liquid-string'
	| 'liquid-number'
	| 'comment'
	| 'query-scope'
	| 'query-property'
	| 'query-keyword'
	| 'query-operator'
	| 'query-date'
	| 'query-regex'
	| 'query-string'
	| 'query-tag'
	| 'query-wikilink'
	| 'query-identifier'
	| 'query-paren';

/**
 * A single non-overlapping syntax highlight span inside a `rhizome` codeblock.
 */
export interface CodeBlockTokenSpan {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly kind: CodeBlockTokenKind;
}

/**
 * A single template or search query diagnostic span inside a `rhizome` codeblock.
 */
export interface CodeBlockDiagnosticSpan {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly code: TemplateDiagnosticCode | DiagnosticCode;
	readonly severity: 'error' | 'warning' | 'hint';
	readonly issue: string;
	readonly hint: string | null;
	readonly span: SourceSpan;
}

/**
 * Complete static analysis of a `rhizome` codeblock for editor syntax highlighting and hover tooltips.
 */
export interface CodeBlockAnalysis {
	readonly tokens: readonly CodeBlockTokenSpan[];
	readonly diagnostics: readonly CodeBlockDiagnosticSpan[];
	readonly queries: readonly ExtractedQueryBlock[];
}

const LIQUID_KEYWORDS: ReadonlySet<string> = new Set([
	'query',
	'endquery',
	'explain',
	'for',
	'endfor',
	'if',
	'elsif',
	'else',
	'endif',
	'unless',
	'endunless',
	'case',
	'when',
	'endcase',
	'assign',
	'capture',
	'endcapture',
	'raw',
	'endraw',
	'comment',
	'endcomment',
	'in',
	'and',
	'or',
	'not',
	'contains',
	'break',
	'continue',
	'cycle',
	'increment',
	'decrement',
	'tablerow',
	'endtablerow',
	'echo',
	'liquid',
	'true',
	'false',
	'nil',
	'null',
	'empty',
	'blank',
]);

const LIQUID_INLINE_COMMENT_GLOBAL_RE = new RegExp(LIQUID_INLINE_COMMENT_PATTERN.source, 'g');
const LIQUID_BLOCK_COMMENT_GLOBAL_RE = new RegExp(LIQUID_BLOCK_COMMENT_PATTERN.source, 'g');
const LIQUID_INLINE_COMMENT_ANCHORED_RE = new RegExp(`^${LIQUID_INLINE_COMMENT_PATTERN.source}$`);
const LIQUID_BLOCK_COMMENT_ANCHORED_RE = new RegExp(`^${LIQUID_BLOCK_COMMENT_PATTERN.source}$`);
const OUTER_LIQUID_BLOCK_OR_TAG_RE = new RegExp(
	[
		LIQUID_BLOCK_COMMENT_PATTERN.source,
		LIQUID_INLINE_COMMENT_PATTERN.source,
		/\{%[\s\S]*?%\}/.source,
		/\{\{[\s\S]*?\}\}/.source,
	].join('|'),
	'g',
);

function scanHeaderAndFooterTokens(
	source: string,
	block: ExtractedQueryBlock,
	out: CodeBlockTokenSpan[],
): void {
	scanSingleLiquidTag(source, block.headerSpan.startOffset, block.headerSpan.endOffset, out);
	if (block.fullSpan.endOffset > block.bodySpan.endOffset) {
		scanSingleLiquidTag(source, block.bodySpan.endOffset, block.fullSpan.endOffset, out);
	}
}

function scanSingleLiquidTag(
	source: string,
	start: number,
	end: number,
	out: CodeBlockTokenSpan[],
): void {
	const raw = source.slice(start, end);
	if (raw.startsWith('{%') || raw.startsWith('{{')) {
		const leftLen = raw[2] === '-' ? 3 : 2;
		out.push({ startOffset: start, endOffset: start + leftLen, kind: 'liquid-delimiter' });
		const hasRightDelim = raw.endsWith('%}') || raw.endsWith('}}');
		const rightLen = hasRightDelim ? (raw[raw.length - 3] === '-' ? 3 : 2) : 0;
		const innerStart = start + leftLen;
		const innerEnd = end - rightLen;
		if (innerEnd > innerStart) {
			scanLiquidTagInner(source.slice(innerStart, innerEnd), innerStart, out);
		}
		if (rightLen > 0 && end - rightLen >= start + leftLen) {
			out.push({ startOffset: end - rightLen, endOffset: end, kind: 'liquid-delimiter' });
		}
	}
}

function scanLiquidTagInner(inner: string, baseOffset: number, out: CodeBlockTokenSpan[]): void {
	const trimmedLeft = inner.length - inner.trimStart().length;
	if (inner.slice(trimmedLeft).startsWith('#')) {
		out.push({
			startOffset: baseOffset + trimmedLeft,
			endOffset: baseOffset + inner.length,
			kind: 'comment',
		});
		return;
	}

	const tokenRe =
		/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\|\s*[a-zA-Z_][a-zA-Z0-9_-]*)|([+-]?\d+(?:\.\d+)?)|([a-zA-Z_][a-zA-Z0-9_.-]*)/g;
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(inner)) !== null) {
		const tokStart = baseOffset + match.index;
		const tokEnd = tokStart + match[0].length;
		if (match[1] !== undefined) {
			out.push({ startOffset: tokStart, endOffset: tokEnd, kind: 'liquid-string' });
		} else if (match[2] !== undefined) {
			out.push({ startOffset: tokStart, endOffset: tokEnd, kind: 'liquid-filter' });
		} else if (match[3] !== undefined) {
			out.push({ startOffset: tokStart, endOffset: tokEnd, kind: 'liquid-number' });
		} else if (match[4] !== undefined) {
			const word = match[4];
			const kind: CodeBlockTokenKind = LIQUID_KEYWORDS.has(word)
				? 'liquid-keyword'
				: 'liquid-variable';
			out.push({ startOffset: tokStart, endOffset: tokEnd, kind });
		}
	}
}

function scanOuterLiquidRegion(
	source: string,
	regionStart: number,
	regionEnd: number,
	out: CodeBlockTokenSpan[],
): void {
	if (regionEnd <= regionStart) {
		return;
	}
	const slice = source.slice(regionStart, regionEnd);
	OUTER_LIQUID_BLOCK_OR_TAG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = OUTER_LIQUID_BLOCK_OR_TAG_RE.exec(slice)) !== null) {
		const absStart = regionStart + match.index;
		const absEnd = absStart + match[0].length;
		const text = match[0];
		if (
			LIQUID_BLOCK_COMMENT_ANCHORED_RE.test(text) ||
			LIQUID_INLINE_COMMENT_ANCHORED_RE.test(text)
		) {
			out.push({ startOffset: absStart, endOffset: absEnd, kind: 'comment' });
		} else {
			scanSingleLiquidTag(source, absStart, absEnd, out);
		}
	}
}

function analyzeQueryBody(
	fullSource: string,
	block: ExtractedQueryBlock,
	config: ResolvedEngineConfig,
	referenceTimeMs: number,
	tokensOut: CodeBlockTokenSpan[],
	diagsOut: CodeBlockDiagnosticSpan[],
): void {
	const body = block.query;
	const baseOffset = block.bodySpan.startOffset;

	for (const re of [LIQUID_INLINE_COMMENT_GLOBAL_RE, LIQUID_BLOCK_COMMENT_GLOBAL_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(body)) !== null) {
			tokensOut.push({
				startOffset: baseOffset + m.index,
				endOffset: baseOffset + m.index + m[0].length,
				kind: 'comment',
			});
		}
	}

	const lexResult = SearchLexer.tokenize(body);
	const lexTokens = lexResult.tokens;
	let bracketDepth = 0;

	for (let i = 0; i < lexTokens.length; i++) {
		const tok = lexTokens[i]!;
		const prevTok = i > 0 ? lexTokens[i - 1] : undefined;
		const nextTok = i + 1 < lexTokens.length ? lexTokens[i + 1] : undefined;
		const startOffset = baseOffset + tok.startOffset;
		const endOffset = startOffset + tok.image.length;
		const type = tok.tokenType;

		if (type === LBracket) {
			bracketDepth++;
			tokensOut.push({ startOffset, endOffset, kind: 'query-property' });
		} else if (type === RBracket) {
			bracketDepth = Math.max(0, bracketDepth - 1);
			tokensOut.push({ startOffset, endOffset, kind: 'query-property' });
		} else if (type === LParen || type === RParen) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-paren' });
		} else if (type === Or || type === And || type === Not || type === BangNot) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-keyword' });
		} else if (type === CompOp || type === Colon) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-operator' });
		} else if (type === DateTimeLiteral) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-date' });
		} else if (type === RegexLiteral) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-regex' });
		} else if (type === QuotedString) {
			const isPropKey = prevTok?.tokenType === LBracket;
			tokensOut.push({
				startOffset,
				endOffset,
				kind: isPropKey ? 'query-property' : 'query-string',
			});
		} else if (type === TagLiteral) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-tag' });
		} else if (type === WikiLinkValue) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-wikilink' });
		} else if (type === Identifier) {
			if (prevTok?.tokenType === LBracket) {
				tokensOut.push({ startOffset, endOffset, kind: 'query-property' });
			} else if (bracketDepth === 0 && nextTok?.tokenType === Colon) {
				tokensOut.push({ startOffset, endOffset, kind: 'query-scope' });
			} else {
				tokensOut.push({ startOffset, endOffset, kind: 'query-identifier' });
			}
		}
	}

	const compileRes = compileQuery(body, config, referenceTimeMs);
	for (const d of compileRes.diagnostics) {
		let startOffset: number;
		let endOffset: number;
		if (d.span) {
			startOffset = baseOffset + d.span.startOffset;
			endOffset = baseOffset + Math.max(d.span.startOffset + 1, d.span.endOffset);
		} else {
			startOffset = block.headerSpan.startOffset;
			endOffset = block.headerSpan.endOffset;
		}
		const span = offsetRangeToSourceSpan(fullSource, startOffset, endOffset);
		diagsOut.push(
			Object.freeze({
				startOffset: span.startOffset,
				endOffset: span.endOffset,
				code: d.code,
				severity: d.severity,
				issue: d.issue,
				hint: d.hint,
				span,
			}),
		);
	}
}

/**
 * Analyzes a `rhizome` codeblock's outer LiquidJS syntax and inner `{% query %}` DSL blocks,
 * returning sorted, non-overlapping highlight token spans and sorted diagnostic spans.
 */
export function analyzeRhizomeCodeBlock(
	source: string,
	config: ResolvedEngineConfig,
	referenceTimeMs: number,
): CodeBlockAnalysis {
	const { env } = parseRhizomeTemplatePass1(source);
	const queries: ExtractedQueryBlock[] = [...env.queries];
	const rawTokens: CodeBlockTokenSpan[] = [];
	const rawDiags: CodeBlockDiagnosticSpan[] = [];

	const recordedHeaderOffsets = new Set<number>(queries.map((q) => q.headerSpan.startOffset));

	for (const scanned of scanQueryBlockSpans(source)) {
		if (scanned.closeEnd === null || recordedHeaderOffsets.has(scanned.headerStart)) {
			continue;
		}
		const headerSpan = offsetRangeToSourceSpan(source, scanned.headerStart, scanned.headerEnd);
		const bodySpan = offsetRangeToSourceSpan(source, scanned.bodyStart, scanned.bodyEnd);
		const fullSpan = offsetRangeToSourceSpan(source, scanned.headerStart, scanned.closeEnd);
		const rawQuery = source.slice(scanned.bodyStart, scanned.bodyEnd);

		const parsedArgs = parseQueryTagArgs(scanned.rawArgs, headerSpan);
		const name = parsedArgs.ok ? parsedArgs.name : '__invalid__';
		const explain = parsedArgs.ok ? parsedArgs.explain : false;

		if (!parsedArgs.ok) {
			const hasExistingAtHeader = env.diagnostics.some(
				(d) => d.span?.startOffset === scanned.headerStart,
			);
			if (!hasExistingAtHeader) {
				env.diagnostics.push(parsedArgs.diagnostic);
			}
		}

		recordedHeaderOffsets.add(scanned.headerStart);
		queries.push(
			Object.freeze({
				name,
				query: rawQuery,
				explain,
				headerSpan,
				bodySpan,
				fullSpan,
			}),
		);
	}

	queries.sort((a, b) => a.fullSpan.startOffset - b.fullSpan.startOffset);

	for (const d of env.diagnostics) {
		const start = d.span ? d.span.startOffset : 0;
		const end = d.span ? Math.max(start + 1, d.span.endOffset) : Math.min(source.length, 1);
		const clampedSpan = offsetRangeToSourceSpan(source, start, end);
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

	let outerCursor = 0;
	for (const q of queries) {
		if (q.fullSpan.startOffset > outerCursor) {
			scanOuterLiquidRegion(source, outerCursor, q.fullSpan.startOffset, rawTokens);
		}
		scanHeaderAndFooterTokens(source, q, rawTokens);
		analyzeQueryBody(source, q, config, referenceTimeMs, rawTokens, rawDiags);
		outerCursor = Math.max(outerCursor, q.fullSpan.endOffset);
	}
	if (outerCursor < source.length) {
		scanOuterLiquidRegion(source, outerCursor, source.length, rawTokens);
	}

	rawTokens.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
	const normalizedTokens: CodeBlockTokenSpan[] = [];
	let tokenCursor = 0;
	for (const tok of rawTokens) {
		const start = Math.max(tokenCursor, Math.max(0, Math.min(source.length, tok.startOffset)));
		const end = Math.max(start, Math.min(source.length, tok.endOffset));
		if (end > start) {
			normalizedTokens.push(
				Object.freeze({
					startOffset: start,
					endOffset: end,
					kind: tok.kind,
				}),
			);
			tokenCursor = end;
		}
	}

	rawDiags.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

	return Object.freeze({
		tokens: Object.freeze(normalizedTokens),
		diagnostics: Object.freeze(rawDiags),
		queries: Object.freeze(queries),
	});
}
