import {
	type Context,
	type Emitter,
	type FilteredValueToken,
	Liquid,
	type Template,
	Tokenizer,
	toValue,
	Value,
} from 'liquidjs';
import { registerPayloadLiquidFilters } from './payload-filters';
import { offsetRangeToSourceSpan } from './query-tag';
import {
	checkFilterOutputSize,
	installBoundedTemplateRenderer,
	TEMPLATE_MEMORY_LIMIT,
	TEMPLATE_RENDER_LIMIT_MS,
} from './render-limits';
import { buildRhizomeTemplateContext, HOST_QUERY_KEY } from './template-context';
import { extractLiquidErrorDiagnostic } from './template-engine';
import {
	createRhizomeLiquidOperators,
	installTemporalTokenizerExtensions,
	registerTemporalLiquidExtensions,
} from './temporal-drop';
import type { TemplateDiagnostic, TemplateRuntimeContext } from './types';

/**
 * Maximum nesting depth (`4`) for inline `◊ ...` expressions rendered inside the Markdown
 * output of another inline `◊ ...` expression before cycle protection leaves deeper spans
 * as literal `code` elements.
 */
export const MAX_INLINE_RENDER_DEPTH = 4;

const MAX_COMPILED_INLINE_CACHE_ENTRIES = 256;
const SIGNET_EXPR_RE = /^\u25CA([\s\u00A0]+)([\s\S]+)$/;

/**
 * Options controlling CommonMark normalization and GFM table-cell pipe unescaping when extracting
 * an inline Rhizome expression from a code-span interior.
 */
export interface ExtractInlineExpressionOptions {
	/**
	 * When `true`, unescapes `\|` to `|` prior to CommonMark normalization (matching GFM table
	 * cell parsing in Source mode and Live Preview) while recording exact raw character offsets.
	 */
	readonly unescapeTablePipes?: boolean | undefined;
	/**
	 * When `false`, skips CommonMark line-ending conversion and single leading/trailing space
	 * stripping (used in Reading mode where Obsidian's Markdown parser already normalized
	 * `codeEl.textContent`). Defaults to `true`.
	 */
	readonly normalizeCommonMark?: boolean | undefined;
}

/**
 * Extracted inline Rhizome expression and offset map back to the input `rawInterior` string.
 */
export interface ExtractedInlineExpression {
	readonly expr: string;
	readonly signetOffset: number;
	/**
	 * Monotonically increasing raw character offsets of length `expr.length + 1`, mapping any
	 * half-open slice `[start, end)` in `expr` to `[exprOffsets[start], exprOffsets[end])` in
	 * `rawInterior`.
	 */
	readonly exprOffsets: readonly number[];
}

/**
 * Compiled inline Liquid `FilteredValue` expression ready for synchronous evaluation.
 */
export interface CompiledInlineExpression {
	readonly expr: string;
	readonly templates: readonly [Template];
}

/**
 * Result of parsing an inline Rhizome expression.
 */
export type ParseInlineExpressionResult =
	| { readonly ok: true; readonly compiled: CompiledInlineExpression }
	| { readonly ok: false; readonly diagnostic: TemplateDiagnostic };

/**
 * Result of synchronously evaluating an inline Rhizome expression.
 */
export type InlineEvaluationResult =
	| { readonly ok: true; readonly markdown: string }
	| { readonly ok: false; readonly diagnostic: TemplateDiagnostic };

class InlineValueTemplate implements Template {
	readonly token: FilteredValueToken;
	readonly value: Value;

	constructor(token: FilteredValueToken, liquid: Liquid) {
		this.token = token;
		this.value = new Value(token, liquid);
	}

	*render(ctx: Context, emitter: Emitter): IterableIterator<unknown> {
		const val: unknown = yield toValue(yield this.value.value(ctx, false));
		emitter.write(val);
	}
}

let inlineLiquidSingleton: Liquid | null = null;
const compiledInlineCache = new Map<string, CompiledInlineExpression>();

function getInlineLiquidInstance(): Liquid {
	if (inlineLiquidSingleton !== null) {
		return inlineLiquidSingleton;
	}
	installTemporalTokenizerExtensions();
	const liquid = new Liquid({
		cache: false,
		dynamicPartials: false,
		relativeReference: false,
		ownPropertyOnly: true,
		renderLimit: TEMPLATE_RENDER_LIMIT_MS,
		memoryLimit: TEMPLATE_MEMORY_LIMIT,
		operators: createRhizomeLiquidOperators(),
	});
	installBoundedTemplateRenderer(liquid);
	registerTemporalLiquidExtensions(liquid);
	registerPayloadLiquidFilters(liquid);
	inlineLiquidSingleton = liquid;
	return liquid;
}

/**
 * Normalizes a CommonMark inline code-span interior (with optional GFM table `\|` unescaping)
 * and extracts `{ expr, signetOffset, exprOffsets }` when the normalized span begins with
 * `◊` (`U+25CA`) followed by at least one whitespace character and a non-blank expression.
 * Returns `null` for ordinary code spans, bare `◊`, `◊<non-space>`, and whitespace-only bodies.
 */
export function extractInlineRhizomeExpression(
	rawInterior: string,
	options?: ExtractInlineExpressionOptions,
): ExtractedInlineExpression | null {
	if (typeof rawInterior !== 'string' || rawInterior.length < 3) {
		return null;
	}
	const unescapePipes = options?.unescapeTablePipes === true;
	const normalizeCommonMark = options?.normalizeCommonMark !== false;

	const chars: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];

	let i = 0;
	while (i < rawInterior.length) {
		const ch = rawInterior[i]!;
		if (unescapePipes && ch === '\\' && rawInterior[i + 1] === '|') {
			chars.push('|');
			starts.push(i);
			ends.push(i + 2);
			i += 2;
		} else if (normalizeCommonMark && ch === '\r') {
			const step = rawInterior[i + 1] === '\n' ? 2 : 1;
			chars.push(' ');
			starts.push(i);
			ends.push(i + step);
			i += step;
		} else if (normalizeCommonMark && ch === '\n') {
			chars.push(' ');
			starts.push(i);
			ends.push(i + 1);
			i += 1;
		} else {
			chars.push(ch);
			starts.push(i);
			ends.push(i + 1);
			i += 1;
		}
	}

	let normStart = 0;
	let normEnd = chars.length;
	if (
		normalizeCommonMark &&
		normEnd - normStart >= 2 &&
		chars[normStart] === ' ' &&
		chars[normEnd - 1] === ' '
	) {
		let hasNonSpace = false;
		for (let j = normStart; j < normEnd; j++) {
			if (chars[j] !== ' ') {
				hasNonSpace = true;
				break;
			}
		}
		if (hasNonSpace) {
			normStart++;
			normEnd--;
		}
	}

	if (normStart >= normEnd || chars[normStart] !== '\u25CA') {
		return null;
	}

	const normalized = chars.slice(normStart, normEnd).join('');
	const match = SIGNET_EXPR_RE.exec(normalized);
	if (!match) {
		return null;
	}

	const sep = match[1]!;
	const expr = match[2]!;
	if (expr.trim().length === 0) {
		return null;
	}

	const signetOffset = starts[normStart]!;
	const exprNormStart = normStart + 1 + sep.length;
	const exprOffsets: number[] = new Array<number>(expr.length + 1);
	for (let k = 0; k < expr.length; k++) {
		exprOffsets[k] = starts[exprNormStart + k]!;
	}
	exprOffsets[expr.length] = ends[normEnd - 1]!;

	return Object.freeze({
		expr,
		signetOffset,
		exprOffsets: Object.freeze(exprOffsets),
	});
}

function makeInlineSyntaxError(
	expr: string,
	startOffset: number,
	endOffset: number,
	issue: string,
	hint: string,
): ParseInlineExpressionResult {
	const span = offsetRangeToSourceSpan(expr, startOffset, Math.max(startOffset + 1, endOffset));
	return Object.freeze({
		ok: false,
		diagnostic: Object.freeze({
			code: 'TEMPLATE_SYNTAX_ERROR',
			severity: 'error',
			issue,
			hint,
			span,
			file: null,
		}),
	});
}

function precheckInlineExpressionSyntax(expr: string): ParseInlineExpressionResult | null {
	let quote: '"' | "'" | null = null;
	let quoteStart = 0;
	let escaped = false;
	let lastNonBlankChar = '';
	let lastNonBlankOffset = -1;

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
			quoteStart = i;
			escaped = false;
			lastNonBlankChar = ch;
			lastNonBlankOffset = i;
			continue;
		}
		const two = expr.slice(i, i + 2);
		if (two === '{%' || two === '%}' || two === '{{' || two === '}}') {
			return makeInlineSyntaxError(
				expr,
				i,
				i + 2,
				`Liquid delimiter '${two}' is not allowed inside an inline '◊' expression.`,
				"Write a single filtered expression without '{{ ... }}' or '{% ... %}' wrappers (for example, '`◊ this.file.basename`').",
			);
		}
		if (!/[\s\u00A0]/.test(ch)) {
			lastNonBlankChar = ch;
			lastNonBlankOffset = i;
		}
	}

	if (quote !== null) {
		return makeInlineSyntaxError(
			expr,
			quoteStart,
			expr.length,
			`Unclosed ${quote === '"' ? 'double' : 'single'}-quoted string literal in inline expression.`,
			`Add a matching closing ${quote} quote.`,
		);
	}

	if (lastNonBlankChar === '|') {
		return makeInlineSyntaxError(
			expr,
			lastNonBlankOffset,
			lastNonBlankOffset + 1,
			"Expected a filter name after '|' in inline expression.",
			"Add a filter name after '|' (for example, '| upcase' or '| default: \"none\"') or remove the trailing '|'.",
		);
	}

	return null;
}

/**
 * Parses and validates an inline Rhizome `FilteredValue` expression (`{{ <expr> }}` interior
 * parity), rejecting unquoted Liquid delimiters, unclosed quotes, dangling trailing `|`, and
 * unconsumed trailing tokens. Caches compiled templates in a bounded 256-entry LRU map.
 */
export function parseInlineRhizomeExpression(expr: string): ParseInlineExpressionResult {
	if (typeof expr !== 'string' || expr.trim().length === 0) {
		return makeInlineSyntaxError(
			expr ?? '',
			0,
			Math.max(1, (expr ?? '').length),
			"Empty inline '◊' expression.",
			"Provide a variable or literal after '◊ ' (for example, '`◊ this.file.basename`').",
		);
	}

	const cached = compiledInlineCache.get(expr);
	if (cached !== undefined) {
		compiledInlineCache.delete(expr);
		compiledInlineCache.set(expr, cached);
		return Object.freeze({ ok: true, compiled: cached });
	}

	const precheckFailure = precheckInlineExpressionSyntax(expr);
	if (precheckFailure !== null) {
		return precheckFailure;
	}

	const liquid = getInlineLiquidInstance();
	try {
		const tokenizer = new Tokenizer(
			expr,
			liquid.options.operators,
			undefined,
			undefined,
			liquid.options.groupedExpressions,
		);
		const filteredToken = tokenizer.readFilteredValue();
		tokenizer.skipBlank();
		if (!tokenizer.end()) {
			const unconsumedStart = tokenizer.p;
			const preview = expr.slice(unconsumedStart).trim().slice(0, 32);
			return makeInlineSyntaxError(
				expr,
				unconsumedStart,
				expr.length,
				`Unexpected trailing token '${preview}' in inline expression.`,
				"Check for extra arguments, stray parentheses, or a missing '|' before a filter.",
			);
		}
		const tpl = new InlineValueTemplate(filteredToken, liquid);
		const compiled: CompiledInlineExpression = Object.freeze({
			expr,
			templates: Object.freeze([tpl] as const),
		});
		if (compiledInlineCache.size >= MAX_COMPILED_INLINE_CACHE_ENTRIES) {
			const oldestKey = compiledInlineCache.keys().next().value;
			if (oldestKey !== undefined) {
				compiledInlineCache.delete(oldestKey);
			}
		}
		compiledInlineCache.set(expr, compiled);
		return Object.freeze({ ok: true, compiled });
	} catch (err: unknown) {
		const diag = extractLiquidErrorDiagnostic(
			expr,
			err,
			'TEMPLATE_SYNTAX_ERROR',
			'Verify that parentheses, quotes, ranges, and filter arguments are balanced and valid.',
		);
		return Object.freeze({ ok: false, diagnostic: diag });
	}
}

/**
 * Synchronously evaluates an inline Rhizome expression against `hostMatch` and `runtimeContext`
 * with bounded render time (`TEMPLATE_RENDER_LIMIT_MS`), memory (`TEMPLATE_MEMORY_LIMIT`), and
 * output size (`MAX_TEMPLATE_OUTPUT_CHARS`). Never throws.
 */
export function evaluateInlineRhizomeExpression(
	expr: string,
	hostMatch: object | null | undefined,
	runtimeContext?: TemplateRuntimeContext,
): InlineEvaluationResult {
	const parsed = parseInlineRhizomeExpression(expr);
	if (!parsed.ok) {
		return parsed;
	}

	const liquid = getInlineLiquidInstance();
	try {
		const rawPayload =
			hostMatch !== null && hostMatch !== undefined && typeof hostMatch === 'object'
				? { [HOST_QUERY_KEY]: [hostMatch] }
				: {};
		const rootScope = buildRhizomeTemplateContext(rawPayload, runtimeContext);
		const renderedRaw: unknown = liquid.renderSync([...parsed.compiled.templates], rootScope, {
			globals: rootScope,
			renderLimit: TEMPLATE_RENDER_LIMIT_MS,
			memoryLimit: TEMPLATE_MEMORY_LIMIT,
		});
		const markdown = typeof renderedRaw === 'string' ? renderedRaw : '';
		checkFilterOutputSize(markdown.length);
		return Object.freeze({ ok: true, markdown });
	} catch (err: unknown) {
		const diag = extractLiquidErrorDiagnostic(
			expr,
			err,
			'TEMPLATE_RENDER_ERROR',
			'Verify the inline expression and filter arguments.',
		);
		return Object.freeze({ ok: false, diagnostic: diag });
	}
}
