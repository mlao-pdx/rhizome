import { FORBIDDEN_KEYS, isVacuousOccurrence, mergeKeyValue } from '@core/search';
import {
	Context,
	Filter,
	type FilterImplOptions,
	filters,
	type Liquid,
	Tokenizer,
	toValueSync,
} from 'liquidjs';
import {
	createRhizomeLiquidOperators,
	installTemporalTokenizerExtensions,
	readContextLiquidInstance,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';

/**
 * Parsed deep-path selector for Rhizome collection and payload filters, mapping a
 * non-empty sequence of case-sensitive source `segments` and an optional Liquid
 * `filterRaw` pipeline (`"<path> | <filters>"`) to its target `outputSegments` and
 * leaf `outputKey`.
 */
export interface ParsedPathSelector {
	readonly segments: readonly string[];
	readonly filterRaw: string | null;
	readonly outputSegments: readonly string[];
	readonly outputKey: string;
	readonly isNullLiteral?: boolean;
	readonly hasLiteral?: boolean;
	readonly literalValue?: unknown;
}

/**
 * Options controlling literal source parsing and strict error reporting in selector parsers.
 */
export interface ParseSelectorOptions {
	readonly allowLiterals?: boolean | undefined;
	readonly strict?: boolean | undefined;
}

/**
 * Shape of `this` bound by LiquidJS when invoking a registered filter handler.
 */
export interface LiquidFilterThis {
	readonly context?: Context;
	readonly liquid?: Liquid;
}

const NON_NEGATIVE_INT_SEGMENT_RE = /^(?:0|[1-9]\d*)$/;
const NUMERIC_OR_LITERAL_ARG_RE = /^(?:[+-]?\d+(?:\.\d+)?|true|false|nil|null)$/i;
const MULTI_ARG_FILTER_MAX_EXTRA_COMMAS: Readonly<Record<string, number>> = Object.freeze({
	slice: 1,
	replace: 1,
	replace_first: 1,
	replace_last: 1,
	truncate: 1,
	truncatewords: 1,
	date: 1,
	date_to_string: 1,
	date_to_long_string: 1,
	default: 1,
	lookup: 2,
	tree: 2,
});

/**
 * Returns `true` when `val` (after `unwrapLiquidValue`) is a non-null plain object
 * or record (including `Object.create(null)` frontmatter maps), excluding arrays,
 * `TemporalDrop`, `Date`, and `RegExp`.
 */
export function isPlainRecord(val: unknown): val is Record<string, unknown> {
	const u = unwrapLiquidValue(val);
	return (
		u !== null &&
		typeof u === 'object' &&
		!Array.isArray(u) &&
		!(u instanceof TemporalDrop) &&
		!(u instanceof Date) &&
		!(u instanceof RegExp)
	);
}

/**
 * Splits a dot-separated path into trimmed, non-empty segments, returning `null`
 * if any segment is empty, `'*'`, or in `FORBIDDEN_KEYS`.
 */
export function splitCleanSegments(rawPath: string): string[] | null {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) return null;
	const parts = trimmed.split('.');
	const segments: string[] = [];
	for (const part of parts) {
		const seg = part.trim();
		if (seg.length === 0 || seg === '*' || FORBIDDEN_KEYS.has(seg)) {
			return null;
		}
		segments.push(seg);
	}
	return segments.length > 0 ? segments : null;
}

/**
 * Strips matching outer single or double quotes from `raw` if present.
 */
export function stripOuterQuotes(raw: string): string {
	const trimmed = raw.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function splitTrailingAsClause(trimmed: string): { leftPart: string; targetPath: string | null } {
	let quote: string | null = null;
	let escaped = false;
	let parenDepth = 0;
	let lastAsStart = -1;
	let lastAsTargetStart = -1;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
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
		if (ch === '(') {
			parenDepth++;
			continue;
		}
		if (ch === ')') {
			parenDepth = Math.max(0, parenDepth - 1);
			continue;
		}
		if (parenDepth === 0 && /\s/.test(ch)) {
			let j = i;
			while (j < trimmed.length && /\s/.test(trimmed[j]!)) j++;
			if (
				j + 2 < trimmed.length &&
				(trimmed[j] === 'a' || trimmed[j] === 'A') &&
				(trimmed[j + 1] === 's' || trimmed[j + 1] === 'S') &&
				/\s/.test(trimmed[j + 2]!)
			) {
				let k = j + 2;
				while (k < trimmed.length && /\s/.test(trimmed[k]!)) k++;
				const candidateTarget = trimmed.slice(k);
				if (candidateTarget.length > 0 && !/[\s|()"']/.test(candidateTarget)) {
					lastAsStart = i;
					lastAsTargetStart = k;
				}
			}
		}
	}

	if (lastAsStart !== -1 && lastAsTargetStart !== -1) {
		return {
			leftPart: trimmed.slice(0, lastAsStart).trim(),
			targetPath: trimmed.slice(lastAsTargetStart).trim(),
		};
	}
	return { leftPart: trimmed, targetPath: null };
}

/**
 * Returns `true` when `rawSelector` ends with an explicit `as <target.deep.path>` clause.
 */
export function hasExplicitTrailingAsClause(rawSelector: string): boolean {
	return splitTrailingAsClause(rawSelector.trim()).targetPath !== null;
}

function findFirstTopLevelPipe(raw: string): number {
	let quote: string | null = null;
	let escaped = false;
	let parenDepth = 0;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
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
		if (ch === '(') {
			parenDepth++;
			continue;
		}
		if (ch === ')') {
			parenDepth = Math.max(0, parenDepth - 1);
			continue;
		}
		if (parenDepth === 0 && ch === '|') {
			return i;
		}
	}
	return -1;
}

function tryParseDirectSelectorLiteral(
	rawSourcePath: string,
): { readonly matched: true; readonly value: unknown } | { readonly matched: false } {
	if (rawSourcePath === 'true') {
		return { matched: true, value: true };
	}
	if (rawSourcePath === 'false') {
		return { matched: true, value: false };
	}
	if (/^[+-]?\d+(?:\.\d+)?$/.test(rawSourcePath)) {
		const num = Number(rawSourcePath);
		if (Number.isFinite(num)) {
			return { matched: true, value: num === 0 ? 0 : num };
		}
	}
	if (
		rawSourcePath.length >= 2 &&
		((rawSourcePath.startsWith('"') && rawSourcePath.endsWith('"')) ||
			(rawSourcePath.startsWith("'") && rawSourcePath.endsWith("'")))
	) {
		const quoteChar = rawSourcePath[0]!;
		let unescaped = '';
		let escaped = false;
		for (let i = 1; i < rawSourcePath.length - 1; i++) {
			const ch = rawSourcePath[i]!;
			if (escaped) {
				if (ch === 'n') unescaped += '\n';
				else if (ch === 'r') unescaped += '\r';
				else if (ch === 't') unescaped += '\t';
				else unescaped += ch;
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (ch === quoteChar) {
				// Unescaped quote inside means multiple tokens (not a single string literal).
				return { matched: false };
			}
			unescaped += ch;
		}
		if (!escaped) {
			return { matched: true, value: unescaped };
		}
	}
	return { matched: false };
}

/**
 * Parses a single selector string of the form `<deep.path> [| <filterPipeline>] [as <target.deep.path>]`.
 * Returns `null` if the source path, filter pipeline, or target path is invalid or contains `FORBIDDEN_KEYS`.
 */
export function parseSingleSelectorString(
	raw: string,
	options?: ParseSelectorOptions,
): ParsedPathSelector | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;

	const { leftPart, targetPath } = splitTrailingAsClause(trimmed);
	if (leftPart.length === 0) return null;

	const pipeIdx = findFirstTopLevelPipe(leftPart);
	const rawSourcePath = (pipeIdx === -1 ? leftPart : leftPart.slice(0, pipeIdx)).trim();
	const rawFilter = pipeIdx === -1 ? null : leftPart.slice(pipeIdx + 1).trim();
	if (rawFilter !== null && rawFilter.length === 0) {
		return null;
	}

	const normalizedSourcePath =
		options?.allowLiterals === true
			? rawSourcePath.replace(
					/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*([+-])\s*(\d+[a-zA-Z]+)$/,
					'$1$2$3',
				)
			: rawSourcePath;

	const isSelfSelector = normalizedSourcePath === '.' || normalizedSourcePath === 'this';
	const isNullLiteral = normalizedSourcePath === 'nil' || normalizedSourcePath === 'null';
	const parsedLiteral =
		!isSelfSelector && !isNullLiteral && options?.allowLiterals
			? tryParseDirectSelectorLiteral(normalizedSourcePath)
			: ({ matched: false } as const);

	if (parsedLiteral.matched && targetPath === null) {
		throw new Error(
			`Literal selector '${trimmed}' requires an explicit 'as <target>' property name.`,
		);
	}

	const segments =
		isSelfSelector || isNullLiteral || parsedLiteral.matched
			? []
			: splitCleanSegments(normalizedSourcePath);
	if (!segments) return null;

	if (targetPath !== null) {
		const outputSegments = splitCleanSegments(targetPath);
		if (!outputSegments) return null;
		if (outputSegments.some((seg) => seg === 'nil' || seg === 'null')) {
			throw new Error(
				`Cannot assign to reserved keyword '${targetPath}' in selector '${trimmed}'. Specify a valid property name after 'as'.`,
			);
		}
		const outputKey = outputSegments[outputSegments.length - 1]!;
		return Object.freeze({
			segments: Object.freeze(segments),
			filterRaw: rawFilter,
			outputSegments: Object.freeze(outputSegments),
			outputKey,
			...(isNullLiteral ? { isNullLiteral: true } : {}),
			...(parsedLiteral.matched
				? { hasLiteral: true, literalValue: parsedLiteral.value }
				: {}),
		});
	}

	const leaf = isSelfSelector
		? 'this'
		: isNullLiteral
			? rawSourcePath
			: segments[segments.length - 1]!;
	return Object.freeze({
		segments: Object.freeze(segments),
		filterRaw: rawFilter,
		outputSegments: Object.freeze([leaf]),
		outputKey: leaf,
		...(isNullLiteral ? { isNullLiteral: true } : {}),
	});
}

/**
 * Splits a multi-selector string on top-level commas (outside quotes, parentheses,
 * and filter argument lists).
 */
export function splitTopLevelSelectorList(raw: string, strict: boolean = false): string[] {
	const results: string[] = [];
	let quote: string | null = null;
	let escaped = false;
	let parenDepth = 0;
	let inFilterWithColon = false;
	let currentFilterName = '';
	let filterArgCommasSeen = 0;
	let sawTopLevelComma = false;
	let start = 0;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
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
		if (ch === '(') {
			parenDepth++;
			continue;
		}
		if (ch === ')') {
			parenDepth = Math.max(0, parenDepth - 1);
			continue;
		}
		if (parenDepth === 0) {
			if (ch === '|') {
				inFilterWithColon = false;
				filterArgCommasSeen = 0;
				const afterPipe = raw.slice(i + 1).trimStart();
				const nameMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(afterPipe);
				currentFilterName = nameMatch ? (nameMatch[1] ?? '').toLowerCase() : '';
				continue;
			}
			if (ch === ':') {
				inFilterWithColon = true;
				filterArgCommasSeen = 0;
				continue;
			}
			if (ch === ',') {
				const currentSlice = raw.slice(start, i);
				if (inFilterWithColon && !hasExplicitTrailingAsClause(currentSlice)) {
					const rest = raw.slice(i + 1).trimStart();
					const nextCommaIdx = rest.indexOf(',');
					const nextPipeIdx = findFirstTopLevelPipe(rest);
					let boundIdx = -1;
					if (nextCommaIdx !== -1 && nextPipeIdx !== -1) {
						boundIdx = Math.min(nextCommaIdx, nextPipeIdx);
					} else if (nextCommaIdx !== -1) {
						boundIdx = nextCommaIdx;
					} else if (nextPipeIdx !== -1) {
						boundIdx = nextPipeIdx;
					}
					const nextChunk = (boundIdx === -1 ? rest : rest.slice(0, boundIdx)).trim();
					const hasNextPipe =
						nextPipeIdx !== -1 && (nextCommaIdx === -1 || nextPipeIdx < nextCommaIdx);
					const hasTrailingAsOrDir =
						splitTrailingAsClause(nextChunk).targetPath !== null ||
						/\s+(?:asc|ascending|desc|descending)$/i.test(nextChunk);
					const withoutAs = splitTrailingAsClause(nextChunk).leftPart;
					const stripDirChunk = withoutAs.replace(
						/\s+(?:asc|ascending|desc|descending)$/i,
						'',
					);
					const maxExtraCommas =
						MULTI_ARG_FILTER_MAX_EXTRA_COMMAS[currentFilterName] ?? 0;
					const isMultiArgContinuation =
						filterArgCommasSeen < maxExtraCommas &&
						(!hasNextPipe || boundIdx === -1) &&
						!hasTrailingAsOrDir;
					const isLiteralFilterArg =
						(stripDirChunk.startsWith('"') ||
							stripDirChunk.startsWith("'") ||
							NUMERIC_OR_LITERAL_ARG_RE.test(stripDirChunk)) &&
						(!hasTrailingAsOrDir || filterArgCommasSeen < maxExtraCommas);
					if (isLiteralFilterArg || isMultiArgContinuation) {
						filterArgCommasSeen++;
						continue;
					}
				}
				sawTopLevelComma = true;
				const piece = currentSlice.trim();
				if (piece.length === 0 && strict) {
					throw new Error("Unexpected empty selector before ',' in selector string.");
				}
				if (piece.length > 0) {
					results.push(piece);
				}
				start = i + 1;
				inFilterWithColon = false;
				currentFilterName = '';
				filterArgCommasSeen = 0;
			}
		}
	}

	const tail = raw.slice(start).trim();
	if (tail.length === 0 && sawTopLevelComma && strict) {
		throw new Error("Trailing ',' in selector string.");
	}
	if (tail.length > 0) {
		results.push(tail);
	}
	return results;
}

/**
 * Parses variadic filter arguments for `pick` and `aggregate` (`agg`), supporting:
 * - String selectors (including comma-separated selector lists): `"file.basename"`, `"properties.status as state"`, `"file.size | divided_by: 1024 as meta.kb"`
 * - Array arguments containing string selectors (e.g., `pick: keys_array`)
 * - LiquidJS named-argument `[alias, path]` 2-tuples when `alias` is a valid target path
 */
export function parsePickOrAggSelectors(
	args: readonly unknown[],
	options?: ParseSelectorOptions,
): ParsedPathSelector[] {
	const selectors: ParsedPathSelector[] = [];
	const strict = options?.strict === true;

	const visitArg = (arg: unknown, allowNamedTuple: boolean): void => {
		const u = unwrapLiquidValue(arg);
		if (typeof u === 'string') {
			const pieces = splitTopLevelSelectorList(u, strict);
			if (strict && pieces.length === 0) {
				throw new Error('Selector string cannot be empty.');
			}
			for (const piece of pieces) {
				const parsed = parseSingleSelectorString(piece, options);
				if (parsed) {
					if (
						parsed.isNullLiteral &&
						(parsed.outputKey === 'nil' || parsed.outputKey === 'null')
					) {
						throw new Error(
							`Selector '${piece}' uses '${parsed.outputKey}' without an 'as <target>' alias.`,
						);
					}
					selectors.push(parsed);
				} else if (strict) {
					throw new Error(`Invalid selector '${piece}'.`);
				}
			}
			return;
		}
		if (Array.isArray(u)) {
			if (
				allowNamedTuple &&
				u.length === 2 &&
				typeof u[0] === 'string' &&
				typeof u[1] === 'string'
			) {
				const rawKey = u[0].trim();
				const rawVal = u[1].trim();
				const isQuotedKey =
					(rawKey.startsWith('"') && rawKey.endsWith('"')) ||
					(rawKey.startsWith("'") && rawKey.endsWith("'"));
				const unquotedKey = stripOuterQuotes(rawKey);
				if (
					(isQuotedKey || !/[\s.|]/.test(unquotedKey)) &&
					!/\s+as\s+/i.test(unquotedKey) &&
					!/\s+as\s+/i.test(rawVal) &&
					(isQuotedKey || rawVal.includes('.') || rawVal.includes('|'))
				) {
					const parsed = parseSingleSelectorString(
						`${rawVal} as ${unquotedKey}`,
						options,
					);
					if (parsed) {
						selectors.push(parsed);
						return;
					}
				}
			}
			for (const item of u) {
				visitArg(item, false);
			}
			return;
		}
		if (strict) {
			throw new Error(
				'Selector argument must evaluate to a selector string or an array of selector strings.',
			);
		}
	};

	for (const arg of args) {
		visitArg(arg, true);
	}
	if (strict && selectors.length === 0) {
		throw new Error('At least one valid property selector is required.');
	}
	return selectors;
}

/**
 * Walks `segments` case-sensitively on `root` (supporting non-negative integer indices
 * on arrays as well as plain record keys), returning `null` if any intermediate step
 * is missing, out-of-bounds, non-record, or in `FORBIDDEN_KEYS`, and normalizing `undefined` to `null`.
 */
export function readDeepPath(root: unknown, segments: readonly string[]): unknown {
	let current: unknown = unwrapLiquidValue(root);
	for (const seg of segments) {
		if (FORBIDDEN_KEYS.has(seg)) {
			return null;
		}
		if (Array.isArray(current)) {
			if (!NON_NEGATIVE_INT_SEGMENT_RE.test(seg)) {
				return null;
			}
			const idx = Number(seg);
			if (idx < 0 || idx >= current.length) {
				return null;
			}
			current = unwrapLiquidValue(current[idx]);
			continue;
		}
		if (!isPlainRecord(current) || !Object.prototype.hasOwnProperty.call(current, seg)) {
			return null;
		}
		current = unwrapLiquidValue(current[seg]);
	}
	return current === undefined ? null : current;
}

const MAX_FILTER_TOKEN_CACHE_SIZE = 512;
const cachedFilterTokens = new Map<string, ReturnType<Tokenizer['readFilters']>>();
const fallbackOperators = createRhizomeLiquidOperators();
const fallbackCustomFilters = new Map<string, FilterImplOptions>();

/**
 * Registers a fallback filter implementation for direct TypeScript filter calls outside a `Liquid` instance.
 */
export function registerFallbackFilter(name: string, impl: FilterImplOptions): void {
	fallbackCustomFilters.set(name, impl);
}

function getCompiledFilterTokens(filterRaw: string): ReturnType<Tokenizer['readFilters']> {
	installTemporalTokenizerExtensions();
	let tokens = cachedFilterTokens.get(filterRaw);
	if (!tokens) {
		const tokenizer = new Tokenizer(`| ${filterRaw}`, fallbackOperators);
		tokens = tokenizer.readFilters();
		tokenizer.skipBlank();
		tokenizer.assert(
			tokenizer.end(),
			() => `unexpected token ${tokenizer.snapshot()} in selector filter pipeline`,
		);
		if (cachedFilterTokens.size >= MAX_FILTER_TOKEN_CACHE_SIZE) {
			const oldestKey = cachedFilterTokens.keys().next().value;
			if (oldestKey !== undefined) {
				cachedFilterTokens.delete(oldestKey);
			}
		}
		cachedFilterTokens.set(filterRaw, tokens);
	}
	return tokens;
}

/**
 * Evaluates a compiled Liquid filter pipeline (`filterRaw`) synchronously against `ctx`.
 */
export function runSelectorFilterPipeline(
	rawVal: unknown,
	filterRaw: string,
	ctx: Context,
	liquid?: Liquid,
): unknown {
	const filterTokens = getCompiledFilterTokens(filterRaw);
	if (filterTokens.length === 0) {
		return rawVal;
	}
	const effectiveLiquid = liquid ?? readContextLiquidInstance(ctx);
	const ctxInternal = ctx as unknown as { sync?: boolean | undefined };
	const prevSync = ctxInternal.sync;
	ctxInternal.sync = true;
	try {
		let current: unknown = rawVal;
		for (const token of filterTokens) {
			const filterImpl: FilterImplOptions | undefined = effectiveLiquid
				? effectiveLiquid.filters[token.name]
				: (fallbackCustomFilters.get(token.name) ??
					(filters as Record<string, FilterImplOptions | undefined>)[token.name]);
			const filterInstance = new Filter(
				token,
				filterImpl,
				(effectiveLiquid ?? { options: ctx.opts, filters }) as unknown as Liquid,
			);
			current = toValueSync(filterInstance.render(current, ctx));
		}
		const finalVal = unwrapLiquidValue(current);
		return finalVal === undefined ? null : finalVal;
	} finally {
		ctxInternal.sync = prevSync;
	}
}

/**
 * Evaluates a `ParsedPathSelector` against `item`: reads `readDeepPath(item, selector.segments)`
 * (or `null` when `selector.isNullLiteral === true`) and, when `selector.filterRaw !== null`,
 * runs the Liquid filter pipeline with `item` pushed onto the active `Context` so filter arguments
 * can reference sibling properties of `item`.
 */
export function evaluateSelectorOnItem(
	item: unknown,
	selector: Pick<
		ParsedPathSelector,
		'segments' | 'filterRaw' | 'isNullLiteral' | 'hasLiteral' | 'literalValue'
	>,
	filterThis?: LiquidFilterThis | void,
): unknown {
	const rawVal = selector.isNullLiteral
		? null
		: selector.hasLiteral
			? selector.literalValue
			: readDeepPath(item, selector.segments);
	if (selector.filterRaw === null) {
		return rawVal;
	}

	const filterTokens = getCompiledFilterTokens(selector.filterRaw);
	if (filterTokens.length === 0) {
		return rawVal;
	}

	const ctx =
		filterThis && typeof filterThis === 'object' && filterThis.context
			? filterThis.context
			: new Context({});
	const liquid =
		filterThis && typeof filterThis === 'object' && filterThis.liquid
			? filterThis.liquid
			: readContextLiquidInstance(ctx);

	const unwrappedItem = unwrapLiquidValue(item);
	const scopeFrame = isPlainRecord(unwrappedItem) ? unwrappedItem : { item: unwrappedItem };

	ctx.push(scopeFrame);
	try {
		return runSelectorFilterPipeline(rawVal, selector.filterRaw, ctx, liquid);
	} finally {
		ctx.pop();
	}
}

/**
 * Returns a shallow clone of a plain record, omitting any keys in `FORBIDDEN_KEYS`.
 */
export function shallowClonePlainRecord(obj: Record<string, unknown>): Record<string, unknown> {
	const clone: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		clone[key] = obj[key];
	}
	return clone;
}

/**
 * Merges `val` into `target[key]` via `mergeKeyValue`, guarding against inherited
 * `Object.prototype` keys (`toString`, `valueOf`, etc.) and normalizing pre-existing
 * untracked array/vacuous properties on cloned containers.
 */
export function safeMergeKeyValue(
	target: Record<string, unknown>,
	promotedSet: Set<string>,
	key: string,
	val: unknown,
): void {
	if (FORBIDDEN_KEYS.has(key)) return;
	if (Object.prototype.hasOwnProperty.call(target, key)) {
		if (!promotedSet.has(key)) {
			const existingLeaf = unwrapLiquidValue(target[key]);
			if (Array.isArray(existingLeaf)) {
				target[key] = [...(existingLeaf as readonly unknown[])];
				promotedSet.add(key);
			} else if (isVacuousOccurrence(existingLeaf)) {
				target[key] = null;
			}
		}
	} else if (key in target) {
		const rhs = isVacuousOccurrence(val) ? null : val;
		if (Array.isArray(rhs)) {
			target[key] = [...(rhs as readonly unknown[])];
			promotedSet.add(key);
		} else {
			target[key] = rhs;
		}
		return;
	}
	mergeKeyValue(target, promotedSet, key, val);
}

/**
 * Writes `val` into `rootOut` at `outputSegments` using copy-on-write spine cloning
 * for intermediate objects and `safeMergeKeyValue` collision resolution at the leaf key.
 */
export function writeDeepTargetValue(
	rootOut: Record<string, unknown>,
	promotedByContainer: Map<Record<string, unknown>, Set<string>>,
	clonedContainers: Set<Record<string, unknown>>,
	outputSegments: readonly string[],
	val: unknown,
): void {
	if (outputSegments.length === 0) return;

	let current = rootOut;
	for (let i = 0; i < outputSegments.length - 1; i++) {
		const seg = outputSegments[i]!;
		if (FORBIDDEN_KEYS.has(seg)) return;

		const existing = Object.prototype.hasOwnProperty.call(current, seg)
			? unwrapLiquidValue(current[seg])
			: undefined;
		if (!isPlainRecord(existing)) {
			const fresh: Record<string, unknown> = {};
			current[seg] = fresh;
			clonedContainers.add(fresh);
			current = fresh;
		} else if (!clonedContainers.has(existing)) {
			const cloned = shallowClonePlainRecord(existing);
			current[seg] = cloned;
			clonedContainers.add(cloned);
			current = cloned;
		} else {
			current = existing;
		}
	}

	const leafKey = outputSegments[outputSegments.length - 1]!;
	if (FORBIDDEN_KEYS.has(leafKey)) return;

	let promotedSet = promotedByContainer.get(current);
	if (!promotedSet) {
		promotedSet = new Set<string>();
		promotedByContainer.set(current, promotedSet);
	}
	safeMergeKeyValue(current, promotedSet, leafKey, val);
}

/**
 * Writes `val` into `rootOut` at `outputSegments` using copy-on-write spine cloning
 * for intermediate objects and **last-executed-wins** direct replacement at `leafKey`.
 */
export function overwriteDeepTargetValue(
	rootOut: Record<string, unknown>,
	clonedContainers: Set<Record<string, unknown>>,
	outputSegments: readonly string[],
	val: unknown,
): void {
	if (outputSegments.length === 0) return;

	let current = rootOut;
	for (let i = 0; i < outputSegments.length - 1; i++) {
		const seg = outputSegments[i]!;
		if (FORBIDDEN_KEYS.has(seg)) return;

		const existing = Object.prototype.hasOwnProperty.call(current, seg)
			? unwrapLiquidValue(current[seg])
			: undefined;
		if (!isPlainRecord(existing)) {
			const fresh: Record<string, unknown> = {};
			current[seg] = fresh;
			clonedContainers.add(fresh);
			current = fresh;
		} else if (!clonedContainers.has(existing)) {
			const cloned = shallowClonePlainRecord(existing);
			current[seg] = cloned;
			clonedContainers.add(cloned);
			current = cloned;
		} else {
			current = existing;
		}
	}

	const leafKey = outputSegments[outputSegments.length - 1]!;
	if (FORBIDDEN_KEYS.has(leafKey)) return;
	current[leafKey] = val === undefined ? null : val;
}

/**
 * Projects a single plain record through `selectors`, writing each evaluated selector value
 * into a new plain object via `writeDeepTargetValue`.
 */
export function pickFromObject(
	item: unknown,
	selectors: readonly ParsedPathSelector[],
	filterThis: LiquidFilterThis | void,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const u = unwrapLiquidValue(item);
	if (!isPlainRecord(u)) {
		return out;
	}
	const promotedByContainer = new Map<Record<string, unknown>, Set<string>>();
	const clonedContainers = new Set<Record<string, unknown>>([out]);

	for (const selector of selectors) {
		if (FORBIDDEN_KEYS.has(selector.outputKey)) continue;
		const val = evaluateSelectorOnItem(u, selector, filterThis);
		writeDeepTargetValue(
			out,
			promotedByContainer,
			clonedContainers,
			selector.outputSegments,
			val,
		);
	}
	return out;
}
