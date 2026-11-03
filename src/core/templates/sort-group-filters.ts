import { FORBIDDEN_KEYS } from '@core/search';
import type { Context } from 'liquidjs';
import {
	canonicalRhizomeValueKey,
	coerceToTemporalGroupDrop,
	type GroupByBucket,
	groupByFilter,
	isVacuousSortOrGroupValue,
} from './group-by-filter';
import {
	evaluateSelectorOnItem,
	isPlainRecord,
	type LiquidFilterThis,
	parseSingleSelectorString,
	splitTopLevelSelectorList,
	stripOuterQuotes,
} from './selector-evaluator';
import {
	type DisplayGrain,
	parseFiniteRangeNumber,
	readContextTemporalMeta,
	resolveDefaultSystemTimeZone,
	resolveValidTimeZone,
	TEMPORAL_CONTEXT_META_SYMBOL,
	type TemporalContextMeta,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';

export {
	canonicalRhizomeValueKey,
	coerceToTemporalGroupDrop,
	type GroupByBucket,
	groupByFilter,
	isVacuousSortOrGroupValue,
};

/**
 * Sort direction for a single selector in `sort` or `sort_natural`.
 */
export type SortDirection = 'asc' | 'desc';

/**
 * Parsed selector entry for `sort` and `sort_natural`.
 */
export interface ParsedSortSelector {
	readonly segments: readonly string[];
	readonly filterRaw: string | null;
	readonly direction: SortDirection;
}

const GRAIN_ORDER: Readonly<Record<DisplayGrain, number>> = Object.freeze({
	year: 0,
	month: 1,
	day: 2,
	minute: 3,
});

const TRAILING_DIRECTION_RE = /^(.*?)\s+(asc|ascending|desc|descending)$/i;
const DIRECTION_ONLY_RE = /^(?:asc|ascending|desc|descending)$/i;

const collatorCache = new Map<string, Intl.Collator>();

/**
 * Returns a cached `Intl.Collator` configured with `{ usage: 'sort', sensitivity: 'base', numeric: true }`
 * for `language`, falling back to `'en'` if `language` is invalid or unsupported.
 */
export function getNaturalSortCollator(language: string): Intl.Collator {
	const cleanLang = language.trim() || 'en';
	let collator = collatorCache.get(cleanLang);
	if (collator) return collator;

	try {
		collator = new Intl.Collator(cleanLang, {
			usage: 'sort',
			sensitivity: 'base',
			numeric: true,
		});
	} catch {
		collator = new Intl.Collator('en', {
			usage: 'sort',
			sensitivity: 'base',
			numeric: true,
		});
	}
	collatorCache.set(cleanLang, collator);
	return collator;
}

/**
 * Reads the active `language` tag from a LiquidJS `Context`, preferring the unshadowable
 * `TEMPORAL_CONTEXT_META_SYMBOL` on `ctx.globals` or `ctx.environments` so item properties
 * or `{% assign language = ... %}` cannot corrupt natural collation, defaulting to `'en'`.
 */
export function readContextLanguage(ctx: Context | undefined): string {
	if (!ctx) return 'en';
	const ctxInternal = ctx as unknown as {
		globals?: Record<PropertyKey, unknown>;
		environments?: Record<PropertyKey, unknown>;
	};
	const fromGlobals = ctxInternal.globals?.[TEMPORAL_CONTEXT_META_SYMBOL] as
		TemporalContextMeta | undefined;
	if (
		fromGlobals &&
		typeof fromGlobals.language === 'string' &&
		fromGlobals.language.trim().length > 0
	) {
		return fromGlobals.language.trim();
	}
	const fromEnvs = ctxInternal.environments?.[TEMPORAL_CONTEXT_META_SYMBOL] as
		TemporalContextMeta | undefined;
	if (fromEnvs && typeof fromEnvs.language === 'string' && fromEnvs.language.trim().length > 0) {
		return fromEnvs.language.trim();
	}
	try {
		const rawLang: unknown = ctx.getSync(['language']);
		if (typeof rawLang === 'string' && rawLang.trim().length > 0) {
			return rawLang.trim();
		}
	} catch {
		// Fall back to globals or 'en'
	}
	if (
		ctxInternal.globals &&
		typeof ctxInternal.globals.language === 'string' &&
		ctxInternal.globals.language.trim().length > 0
	) {
		return ctxInternal.globals.language.trim();
	}
	return 'en';
}

function normalizeDirectionWord(word: string): SortDirection {
	return word.toLowerCase().startsWith('desc') ? 'desc' : 'asc';
}

function parseSingleSortPiece(rawPiece: string): ParsedSortSelector | null {
	const trimmed = rawPiece.trim();
	if (trimmed.length === 0) return null;

	if (DIRECTION_ONLY_RE.test(trimmed)) {
		return Object.freeze({
			segments: Object.freeze([]),
			filterRaw: null,
			direction: normalizeDirectionWord(trimmed),
		});
	}

	let direction: SortDirection = 'asc';
	let core = trimmed;
	const dirMatch = TRAILING_DIRECTION_RE.exec(trimmed);
	if (dirMatch) {
		const candidateCore = (dirMatch[1] ?? '').trim();
		const dirWord = dirMatch[2] ?? 'asc';
		if (candidateCore.length > 0) {
			core = candidateCore;
			direction = normalizeDirectionWord(dirWord);
		}
	}

	if (core === '.' || core === 'this') {
		return Object.freeze({
			segments: Object.freeze([]),
			filterRaw: null,
			direction,
		});
	}

	const parsed = parseSingleSelectorString(core);
	if (!parsed) return null;

	return Object.freeze({
		segments: parsed.segments,
		filterRaw: parsed.filterRaw,
		direction,
	});
}

/**
 * Parses variadic filter arguments for `sort` and `sort_natural`, supporting:
 * - Single or multiple string selectors (`"file.basename"`, `"properties.due desc"`)
 * - Comma-separated selector strings (`"properties.status, file.basename desc"`)
 * - Array arguments containing selector strings
 * - LiquidJS named-argument `[selector, "asc" | "desc"]` 2-tuples
 */
export function parseSortSelectors(args: readonly unknown[]): ParsedSortSelector[] {
	const selectors: ParsedSortSelector[] = [];

	const visitArg = (arg: unknown, allowNamedTuple: boolean): void => {
		const u = unwrapLiquidValue(arg);
		if (typeof u === 'string') {
			for (const piece of splitTopLevelSelectorList(u)) {
				const parsed = parseSingleSortPiece(piece);
				if (parsed) selectors.push(parsed);
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
				const rawDir = stripOuterQuotes(u[1]);
				if (DIRECTION_ONLY_RE.test(rawDir)) {
					const rawSelector = stripOuterQuotes(u[0]);
					const parsed = parseSingleSortPiece(`${rawSelector} ${rawDir}`);
					if (parsed) {
						selectors.push(parsed);
						return;
					}
				}
			}
			for (const item of u) {
				visitArg(item, false);
			}
		}
	};

	for (const arg of args) {
		visitArg(arg, true);
	}
	return selectors;
}

type ClassifiedValue =
	| { readonly rank: 1; readonly bool: number }
	| { readonly rank: 2; readonly num: number; readonly rawStr: string | null }
	| {
			readonly rank: 3;
			readonly start: number;
			readonly end: number;
			readonly grainRank: number;
	  }
	| { readonly rank: 4; readonly str: string }
	| { readonly rank: 5; readonly items: readonly ClassifiedValue[] }
	| { readonly rank: 6; readonly entries: readonly [string, ClassifiedValue | null][] };

function classifySortKeyValue(
	val: unknown,
	timeZone: string,
	referenceTimeMs: number,
): ClassifiedValue | null {
	if (isVacuousSortOrGroupValue(val)) {
		return null;
	}
	const u = unwrapLiquidValue(val);
	if (typeof u === 'boolean') {
		return { rank: 1, bool: u ? 1 : 0 };
	}
	if (typeof u === 'number') {
		return { rank: 2, num: Number.isFinite(u) ? (u === 0 ? 0 : u) : 0, rawStr: null };
	}
	if (u instanceof TemporalDrop) {
		return {
			rank: 3,
			start: u.start,
			end: u.end,
			grainRank: GRAIN_ORDER[u.grain],
		};
	}
	if (typeof u === 'string') {
		const numVal = parseFiniteRangeNumber(u);
		if (numVal !== null) {
			return { rank: 2, num: numVal === 0 ? 0 : numVal, rawStr: u };
		}
		const temporalDrop = coerceToTemporalGroupDrop(u, timeZone, referenceTimeMs, false);
		if (temporalDrop) {
			return {
				rank: 3,
				start: temporalDrop.start,
				end: temporalDrop.end,
				grainRank: GRAIN_ORDER[temporalDrop.grain],
			};
		}
		return { rank: 4, str: u };
	}
	if (Array.isArray(u)) {
		const classifiedItems: ClassifiedValue[] = [];
		for (const el of u as readonly unknown[]) {
			const cEl = classifySortKeyValue(el, timeZone, referenceTimeMs);
			if (cEl !== null) {
				classifiedItems.push(cEl);
			}
		}
		return { rank: 5, items: classifiedItems };
	}
	if (isPlainRecord(u)) {
		const keys = Object.keys(u)
			.filter((k) => !FORBIDDEN_KEYS.has(k))
			.sort();
		return {
			rank: 6,
			entries: keys.map((k) => [k, classifySortKeyValue(u[k], timeZone, referenceTimeMs)]),
		};
	}
	return { rank: 4, str: typeof u };
}

function comparePreclassifiedValues(
	ca: ClassifiedValue | null,
	cb: ClassifiedValue | null,
	natural: boolean,
	collator: Intl.Collator | null,
	useCodePointTieBreaker: boolean,
): number {
	if (ca === null && cb === null) return 0;
	if (ca === null) return 1;
	if (cb === null) return -1;

	if (ca.rank !== cb.rank) {
		return ca.rank - cb.rank;
	}

	if (ca.rank === 1 && cb.rank === 1) {
		return ca.bool - cb.bool;
	}
	if (ca.rank === 2 && cb.rank === 2) {
		if (ca.num !== cb.num) return ca.num < cb.num ? -1 : 1;
		if (useCodePointTieBreaker && ca.rawStr !== cb.rawStr) {
			if (ca.rawStr === null) return -1;
			if (cb.rawStr === null) return 1;
			return ca.rawStr < cb.rawStr ? -1 : 1;
		}
		return 0;
	}
	if (ca.rank === 3 && cb.rank === 3) {
		if (ca.start !== cb.start) return ca.start < cb.start ? -1 : 1;
		if (ca.end !== cb.end) return ca.end < cb.end ? -1 : 1;
		if (ca.grainRank !== cb.grainRank) return ca.grainRank - cb.grainRank;
		return 0;
	}
	if (ca.rank === 4 && cb.rank === 4) {
		if (natural && collator) {
			const cmp = collator.compare(ca.str, cb.str);
			if (cmp !== 0) return cmp < 0 ? -1 : 1;
			if (!useCodePointTieBreaker) return 0;
		}
		return ca.str < cb.str ? -1 : ca.str > cb.str ? 1 : 0;
	}
	if (ca.rank === 5 && cb.rank === 5) {
		const minLen = Math.min(ca.items.length, cb.items.length);
		for (let i = 0; i < minLen; i++) {
			const elCmp = comparePreclassifiedValues(
				ca.items[i]!,
				cb.items[i]!,
				natural,
				collator,
				useCodePointTieBreaker,
			);
			if (elCmp !== 0) return elCmp;
		}
		return ca.items.length - cb.items.length;
	}
	if (ca.rank === 6 && cb.rank === 6) {
		const minLen = Math.min(ca.entries.length, cb.entries.length);
		for (let i = 0; i < minLen; i++) {
			const [ka, va] = ca.entries[i]!;
			const [kb, vb] = cb.entries[i]!;
			if (ka !== kb) return ka < kb ? -1 : 1;
			const valCmp = comparePreclassifiedValues(
				va,
				vb,
				natural,
				collator,
				useCodePointTieBreaker,
			);
			if (valCmp !== 0) return valCmp;
		}
		return ca.entries.length - cb.entries.length;
	}
	return 0;
}

/**
 * Total, transitive domain-aware comparator for `sort` and `sort_natural` with `NULLS LAST`
 * semantics (vacuous values always sort after non-vacuous values regardless of `direction`).
 */
export function compareRhizomeValues(
	aVal: unknown,
	bVal: unknown,
	direction: SortDirection = 'asc',
	options?: {
		readonly natural?: boolean;
		readonly language?: string;
		readonly timeZone?: string;
		readonly referenceTimeMs?: number;
		readonly useCodePointTieBreaker?: boolean;
	},
): number {
	const timeZone =
		options?.timeZone !== undefined
			? resolveValidTimeZone(options.timeZone)
			: resolveDefaultSystemTimeZone();
	const referenceTimeMs = options?.referenceTimeMs ?? 0;

	const ca = classifySortKeyValue(aVal, timeZone, referenceTimeMs);
	const cb = classifySortKeyValue(bVal, timeZone, referenceTimeMs);
	if (ca === null && cb === null) return 0;
	if (ca === null) return 1;
	if (cb === null) return -1;

	const natural = Boolean(options?.natural);
	const collator = natural ? getNaturalSortCollator(options?.language ?? 'en') : null;
	const useCodePointTieBreaker = options?.useCodePointTieBreaker ?? true;

	const rawCmp = comparePreclassifiedValues(ca, cb, natural, collator, useCodePointTieBreaker);
	if (rawCmp === 0) return 0;
	return direction === 'desc' ? -rawCmp : rawCmp;
}

function executeSort(
	filterThis: LiquidFilterThis | void,
	input: unknown,
	args: readonly unknown[],
	natural: boolean,
): unknown[] {
	const unwrapped = unwrapLiquidValue(input);
	if (!Array.isArray(unwrapped)) {
		return [];
	}
	const items: readonly unknown[] = unwrapped;
	if (items.length <= 1) {
		return [...items];
	}

	const ctx =
		filterThis && typeof filterThis === 'object' && 'context' in filterThis
			? filterThis.context
			: undefined;
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);
	const language = natural ? readContextLanguage(ctx) : 'en';
	const collator = natural ? getNaturalSortCollator(language) : null;

	const parsedSelectors = parseSortSelectors(args);
	const selectors: readonly ParsedSortSelector[] =
		parsedSelectors.length > 0
			? parsedSelectors
			: [Object.freeze({ segments: Object.freeze([]), filterRaw: null, direction: 'asc' })];

	const decorated = items.map((item, index) => {
		const classifiedKeys = selectors.map((sel) => {
			const rawKey =
				sel.segments.length === 0 && sel.filterRaw === null
					? unwrapLiquidValue(item)
					: evaluateSelectorOnItem(item, sel, filterThis);
			return classifySortKeyValue(rawKey, timeZone, referenceTimeMs);
		});
		return { item, index, classifiedKeys };
	});

	decorated.sort((a, b) => {
		for (let s = 0; s < selectors.length; s++) {
			const dir = selectors[s]!.direction;
			const aKey = a.classifiedKeys[s] ?? null;
			const bKey = b.classifiedKeys[s] ?? null;
			if (aKey === null && bKey === null) continue;
			if (aKey === null) return 1;
			if (bKey === null) return -1;

			const cmp = comparePreclassifiedValues(aKey, bKey, natural, collator, !natural);
			if (cmp !== 0) {
				return dir === 'desc' ? -cmp : cmp;
			}
		}

		if (natural) {
			for (let s = 0; s < selectors.length; s++) {
				const dir = selectors[s]!.direction;
				const aKey = a.classifiedKeys[s] ?? null;
				const bKey = b.classifiedKeys[s] ?? null;
				if (aKey === null || bKey === null) {
					continue;
				}
				const tieCmp = comparePreclassifiedValues(aKey, bKey, false, null, true);
				if (tieCmp !== 0) {
					return dir === 'desc' ? -tieCmp : tieCmp;
				}
			}
		}

		return a.index - b.index;
	});

	return decorated.map((d) => d.item);
}

/**
 * Liquid `sort` filter: sorts an array by one or more `<deep.path> [| <filterPipeline>] [asc|desc]`
 * selectors using Rhizome's total domain-aware comparator and `NULLS LAST` semantics.
 */
export function sortFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	...args: unknown[]
): unknown[] {
	return executeSort(this, input, args, false);
}

/**
 * Liquid `sort_natural` filter: sorts an array by one or more `<deep.path> [| <filterPipeline>] [asc|desc]`
 * selectors using locale-aware `Intl.Collator` (`sensitivity: 'base', numeric: true`) with a
 * deterministic UTF-16 code-point tie-breaker and `NULLS LAST` semantics.
 */
export function sortNaturalFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	...args: unknown[]
): unknown[] {
	return executeSort(this, input, args, true);
}
