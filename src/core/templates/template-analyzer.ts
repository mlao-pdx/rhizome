import {
	analyzeQueryDependencyDag,
	And,
	BangNot,
	Colon,
	compileQuery,
	CompOp,
	DateTimeLiteral,
	type DiagnosticCode,
	GraphArrow,
	Identifier,
	LBrace,
	LBracket,
	LIQUID_BLOCK_COMMENT_PATTERN,
	LIQUID_INLINE_COMMENT_PATTERN,
	LParen,
	type NormalizedDocument,
	Not,
	Or,
	QueryReference,
	QuotedString,
	RBrace,
	RBracket,
	RegexLiteral,
	type ResolvedEngineConfig,
	RParen,
	type SearchAST,
	SearchLexer,
	type SourceSpan,
	TagLiteral,
	ThisReference,
	WikiLinkValue,
} from '@core/search';
import { Tag, type Template } from 'liquidjs';
import {
	maskQueryBlockBodies,
	offsetRangeToSourceSpan,
	parseQueryTagArgs,
	scanQueryBlockSpans,
	unclosedQueryDiagnostic,
} from './query-tag';
import { parseRhizomeTemplatePass1ForAnalysis } from './template-engine';
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
	'heading',
	'endheading',
	'promote',
	'demote',
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
const LIQUID_INLINE_COMMENT_AT_START_RE = new RegExp(
	`^(?:${LIQUID_INLINE_COMMENT_PATTERN.source})`,
);
const LIQUID_BLOCK_COMMENT_AT_START_RE = new RegExp(`^(?:${LIQUID_BLOCK_COMMENT_PATTERN.source})`);

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

/**
 * Emits token spans for a single Liquid tag or output expression.
 *
 * @param hasRightDelimiter - Force whether `end` includes a closing delimiter. Pass `false` for
 * partial spans whose text may end with a quoted `%}`/`}}`; omit to auto-detect.
 */
function scanSingleLiquidTag(
	source: string,
	start: number,
	end: number,
	out: CodeBlockTokenSpan[],
	hasRightDelimiter?: boolean,
): void {
	const raw = source.slice(start, end);
	if (raw.startsWith('{%') || raw.startsWith('{{')) {
		const leftLen = raw[2] === '-' ? 3 : 2;
		out.push({ startOffset: start, endOffset: start + leftLen, kind: 'liquid-delimiter' });
		const detectedRightDelim = raw.endsWith('%}') || raw.endsWith('}}');
		const hasRightDelim = (hasRightDelimiter ?? detectedRightDelim) && detectedRightDelim;
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
		/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\|\s*[a-zA-Z_][a-zA-Z0-9_-]*)|([+-]?\d+(?:\.\d+)?)|([a-zA-Z_][a-zA-Z0-9_.-]*(?:\+\d+d?)?)/g;
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

interface TagDelimiterScan {
	readonly closeIdx: number;
	readonly nextOpenIdx: number;
}

/**
 * Scans from `from` for the closing delimiter of a Liquid tag/output. Outputs respect quoted
 * strings (matching LiquidJS `readOutputToken`), while tags close at the first `%}` regardless
 * of quotes (matching `readTagToken`, which does not set `respectQuoted`). Returns the first
 * nested opening delimiter so an unclosed tag is not lazily extended into a later tag's closer.
 */
function scanTagDelimiters(region: string, from: number, isTag: boolean): TagDelimiterScan {
	const respectQuoted = !isTag;
	let quote: '"' | "'" | null = null;
	for (let i = from; i < region.length; i++) {
		const ch = region[i]!;
		if (respectQuoted && quote !== null) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (respectQuoted && (ch === '"' || ch === "'")) {
			quote = ch;
			continue;
		}
		if (isTag) {
			if (ch === '%' && region[i + 1] === '}') {
				return { closeIdx: i, nextOpenIdx: -1 };
			}
		} else if (ch === '}' && region[i + 1] === '}') {
			return { closeIdx: i, nextOpenIdx: -1 };
		}
		if (ch === '{' && (region[i + 1] === '%' || region[i + 1] === '{')) {
			return { closeIdx: -1, nextOpenIdx: i };
		}
	}
	return { closeIdx: -1, nextOpenIdx: -1 };
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
	const region = source.slice(regionStart, regionEnd);
	let cursor = 0;
	let nextTagIdx = region.indexOf('{%', cursor);
	let nextOutputIdx = region.indexOf('{{', cursor);

	while (cursor < region.length) {
		if (nextTagIdx !== -1 && nextTagIdx < cursor) {
			nextTagIdx = region.indexOf('{%', cursor);
		}
		if (nextOutputIdx !== -1 && nextOutputIdx < cursor) {
			nextOutputIdx = region.indexOf('{{', cursor);
		}

		let openIdx = -1;
		let isTag = false;
		if (nextTagIdx !== -1 && (nextOutputIdx === -1 || nextTagIdx <= nextOutputIdx)) {
			openIdx = nextTagIdx;
			isTag = true;
		} else if (nextOutputIdx !== -1) {
			openIdx = nextOutputIdx;
			isTag = false;
		}
		if (openIdx === -1) {
			break;
		}

		if (isTag) {
			const rest = region.slice(openIdx);
			const inlineComment = LIQUID_INLINE_COMMENT_AT_START_RE.exec(rest);
			if (inlineComment) {
				const end = openIdx + inlineComment[0].length;
				out.push({
					startOffset: regionStart + openIdx,
					endOffset: regionStart + end,
					kind: 'comment',
				});
				cursor = end;
				continue;
			}
			const blockComment = LIQUID_BLOCK_COMMENT_AT_START_RE.exec(rest);
			if (blockComment) {
				const end = openIdx + blockComment[0].length;
				out.push({
					startOffset: regionStart + openIdx,
					endOffset: regionStart + end,
					kind: 'comment',
				});
				cursor = end;
				continue;
			}
		}

		const { closeIdx, nextOpenIdx } = scanTagDelimiters(region, openIdx + 2, isTag);
		if (closeIdx !== -1) {
			const end = closeIdx + 2;
			scanSingleLiquidTag(source, regionStart + openIdx, regionStart + end, out);
			cursor = end;
		} else {
			// A half-typed tag: highlight its opening delimiter and inner tokens up to the end of
			// the region or the next opening delimiter, whichever comes first. Do not lazily
			// consume a later tag's closing delimiter.
			const partialEnd = nextOpenIdx !== -1 ? nextOpenIdx : region.length;
			scanSingleLiquidTag(
				source,
				regionStart + openIdx,
				regionStart + partialEnd,
				out,
				false,
			);
			cursor = partialEnd;
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
	hostDoc?: NormalizedDocument | null,
): SearchAST | null {
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
	const containerStack: Array<'[' | '{'> = [];

	for (let i = 0; i < lexTokens.length; i++) {
		const tok = lexTokens[i]!;
		const prevTok = i > 0 ? lexTokens[i - 1] : undefined;
		const nextTok = i + 1 < lexTokens.length ? lexTokens[i + 1] : undefined;
		const startOffset = baseOffset + tok.startOffset;
		const endOffset = startOffset + tok.image.length;
		const type = tok.tokenType;
		const inBracket =
			containerStack.length > 0 && containerStack[containerStack.length - 1] === '[';

		if (type === LBracket) {
			containerStack.push('[');
			tokensOut.push({ startOffset, endOffset, kind: 'query-property' });
		} else if (type === RBracket) {
			if (containerStack[containerStack.length - 1] === '[') {
				containerStack.pop();
			}
			tokensOut.push({ startOffset, endOffset, kind: 'query-property' });
		} else if (type === LBrace) {
			containerStack.push('{');
			tokensOut.push({ startOffset, endOffset, kind: 'query-paren' });
		} else if (type === RBrace) {
			if (containerStack[containerStack.length - 1] === '{') {
				containerStack.pop();
			}
			tokensOut.push({ startOffset, endOffset, kind: 'query-paren' });
		} else if (type === LParen || type === RParen) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-paren' });
		} else if (type === Or || type === And || type === Not || type === BangNot) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-keyword' });
		} else if (type === CompOp || type === Colon || type === GraphArrow) {
			tokensOut.push({ startOffset, endOffset, kind: 'query-operator' });
		} else if (type === DateTimeLiteral || type === ThisReference || type === QueryReference) {
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
			} else if (
				!inBracket &&
				(nextTok?.tokenType === Colon || nextTok?.tokenType === GraphArrow)
			) {
				tokensOut.push({ startOffset, endOffset, kind: 'query-scope' });
			} else {
				tokensOut.push({ startOffset, endOffset, kind: 'query-identifier' });
			}
		}
	}

	const compileRes = compileQuery(body, config, referenceTimeMs, hostDoc);
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
	return compileRes.ast;
}

const EXTERNAL_TEMPLATE_TAG_RE = /\{%-?\s*(?:render\b|layout\s+(?!none\s*-?%\}))/;

function templatesContainExternalInclude(templates: readonly Template[]): boolean {
	for (const tpl of templates) {
		if (!(tpl instanceof Tag)) {
			continue;
		}
		const tag = tpl as unknown as {
			readonly name: string;
			readonly file?: unknown;
			readonly templates?: Template[];
			readonly branches?: unknown;
			readonly elseTemplates?: Template[];
		};
		if (tag.name === 'render') {
			return true;
		}
		if (tag.name === 'layout') {
			if (tag.file !== undefined) {
				return true;
			}
			if (Array.isArray(tag.templates) && templatesContainExternalInclude(tag.templates)) {
				return true;
			}
			continue;
		}
		if (Array.isArray(tag.templates) && templatesContainExternalInclude(tag.templates)) {
			return true;
		}
		if (Array.isArray(tag.branches)) {
			for (const b of tag.branches as unknown[]) {
				if (b && typeof b === 'object') {
					const bt = (b as { templates?: unknown }).templates;
					if (Array.isArray(bt) && templatesContainExternalInclude(bt as Template[])) {
						return true;
					}
				}
			}
		}
		if (
			Array.isArray(tag.elseTemplates) &&
			templatesContainExternalInclude(tag.elseTemplates)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Analyzes a `rhizome` codeblock's outer LiquidJS syntax and inner `{% query %}` DSL blocks,
 * returning sorted, non-overlapping highlight token spans and sorted diagnostic spans.
 */
export function analyzeRhizomeCodeBlock(
	source: string,
	config: ResolvedEngineConfig,
	referenceTimeMs: number,
	hostDoc?: NormalizedDocument | null,
): CodeBlockAnalysis {
	const { env, templates } = parseRhizomeTemplatePass1ForAnalysis(source);
	const queries: ExtractedQueryBlock[] = [...env.queries];
	const rawTokens: CodeBlockTokenSpan[] = [];
	const rawDiags: CodeBlockDiagnosticSpan[] = [];

	const recordedHeaderOffsets = new Set<number>(queries.map((q) => q.headerSpan.startOffset));

	for (const scanned of scanQueryBlockSpans(source)) {
		if (recordedHeaderOffsets.has(scanned.headerStart)) {
			continue;
		}
		const headerSpan = offsetRangeToSourceSpan(source, scanned.headerStart, scanned.headerEnd);
		const bodySpan = offsetRangeToSourceSpan(source, scanned.bodyStart, scanned.bodyEnd);
		const blockEnd = scanned.closeEnd ?? scanned.bodyEnd;
		const fullSpan = offsetRangeToSourceSpan(source, scanned.headerStart, blockEnd);
		const rawQuery = source.slice(scanned.bodyStart, scanned.bodyEnd);

		const parsedArgs = parseQueryTagArgs(scanned.rawArgs, headerSpan);
		const name = parsedArgs.ok ? parsedArgs.name : '__invalid__';
		const explain = parsedArgs.ok ? parsedArgs.explain : false;

		const hasExistingAtHeader = env.diagnostics.some(
			(d) => d.span?.startOffset === scanned.headerStart,
		);
		if (scanned.closeEnd === null && !hasExistingAtHeader) {
			env.diagnostics.push(
				unclosedQueryDiagnostic(
					source.slice(scanned.headerStart, scanned.headerEnd),
					headerSpan,
					null,
				),
			);
		} else if (!parsedArgs.ok && !hasExistingAtHeader) {
			env.diagnostics.push(parsedArgs.diagnostic);
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
				file: null,
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
	const dagInputs: Array<{
		readonly name: string;
		readonly ast: SearchAST | null;
		readonly block: ExtractedQueryBlock;
	}> = [];

	for (const q of queries) {
		if (q.fullSpan.startOffset > outerCursor) {
			scanOuterLiquidRegion(source, outerCursor, q.fullSpan.startOffset, rawTokens);
		}
		scanHeaderAndFooterTokens(source, q, rawTokens);
		const ast = analyzeQueryBody(
			source,
			q,
			config,
			referenceTimeMs,
			rawTokens,
			rawDiags,
			hostDoc,
		);
		if (q.name !== '__invalid__') {
			dagInputs.push({ name: q.name, ast, block: q });
		}
		outerCursor = Math.max(outerCursor, q.fullSpan.endOffset);
	}
	if (outerCursor < source.length) {
		scanOuterLiquidRegion(source, outerCursor, source.length, rawTokens);
	}

	if (dagInputs.length > 0) {
		const hasExternalTemplates =
			templates !== null
				? templatesContainExternalInclude(templates)
				: EXTERNAL_TEMPLATE_TAG_RE.test(maskQueryBlockBodies(source));
		const dagAnalysis = analyzeQueryDependencyDag(dagInputs, {
			checkUnknownRefs: !hasExternalTemplates,
		});
		const blocksByName = new Map<string, ExtractedQueryBlock>();
		for (const item of dagInputs) {
			if (!blocksByName.has(item.name)) {
				blocksByName.set(item.name, item.block);
			}
		}
		const pushShiftedDiags = (
			map: ReadonlyMap<
				string,
				ReadonlyArray<{
					readonly code: DiagnosticCode;
					readonly severity: 'error' | 'warning' | 'hint';
					readonly issue: string;
					readonly hint: string | null;
					readonly span: SourceSpan | null;
				}>
			>,
		): void => {
			for (const [qName, diags] of map) {
				const block = blocksByName.get(qName);
				if (!block) continue;
				const baseOffset = block.bodySpan.startOffset;
				for (const d of diags) {
					const startOffset = d.span
						? baseOffset + d.span.startOffset
						: block.headerSpan.startOffset;
					const endOffset = d.span
						? baseOffset + Math.max(d.span.startOffset + 1, d.span.endOffset)
						: block.headerSpan.endOffset;
					const span = offsetRangeToSourceSpan(source, startOffset, endOffset);
					rawDiags.push(
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
		};
		pushShiftedDiags(dagAnalysis.unknownRefDiagnosticsByQuery);
		pushShiftedDiags(dagAnalysis.cycleDiagnosticsByQuery);
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
