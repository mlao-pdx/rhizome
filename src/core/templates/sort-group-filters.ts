import {
	compareDateIntervals,
	type DateInterval,
	FORBIDDEN_KEYS,
	isVacuousOccurrence,
	parseSingleTemporalAtom,
	parseTemporalExpr,
} from '@core/search';
import type { Context } from 'liquidjs';
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
	finestDisplayGrain,
	normalizeRelativeTemporalString,
	parseFiniteRangeNumber,
	readContextTemporalMeta,
	resolveDefaultSystemTimeZone,
	resolveValidTimeZone,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';

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

/**
 * Output bucket entry returned by `group_by`.
 */
export interface GroupByBucket {
	readonly name: unknown;
	readonly items: unknown[];
	readonly size: number;
	readonly groups?: GroupByBucket[];
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
 * Reads the active `language` tag from a LiquidJS `Context`, defaulting to `'en'`.
 */
export function readContextLanguage(ctx: Context | undefined): string {
	if (!ctx) return 'en';
	try {
		const rawLang: unknown = ctx.getSync(['language']);
		if (typeof rawLang === 'string' && rawLang.trim().length > 0) {
			return rawLang.trim();
		}
	} catch {
		// Fall back to globals or 'en'
	}
	const globals = (ctx as unknown as { globals?: Record<string, unknown> }).globals;
	if (globals && typeof globals.language === 'string' && globals.language.trim().length > 0) {
		return globals.language.trim();
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

/**
 * Returns `true` when `val` is vacuous for sorting and grouping (`null`, `undefined`, `""`,
 * an empty array or array of only vacuous elements, or an empty plain object `{}`).
 */
export function isVacuousSortOrGroupValue(val: unknown): boolean {
	const u = unwrapLiquidValue(val);
	if (isVacuousOccurrence(u)) {
		return true;
	}
	if (Array.isArray(u)) {
		return u.every((el) => isVacuousSortOrGroupValue(el));
	}
	if (isPlainRecord(u)) {
		for (const key of Object.keys(u)) {
			if (!FORBIDDEN_KEYS.has(key)) {
				return false;
			}
		}
		return true;
	}
	return false;
}

type ClassifiedValue =
	| { readonly rank: 1; readonly bool: number }
	| { readonly rank: 2; readonly num: number }
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
		return { rank: 2, num: Number.isFinite(u) ? (u === 0 ? 0 : u) : 0 };
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
		const temporalDrop = coerceToTemporalGroupDrop(u, timeZone, referenceTimeMs);
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
		return ca.num < cb.num ? -1 : ca.num > cb.num ? 1 : 0;
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

interface ParsedGroupSelector {
	readonly segments: readonly string[];
	readonly filterRaw: string | null;
}

function parseGroupBySelectors(args: readonly unknown[]): ParsedGroupSelector[] {
	const selectors: ParsedGroupSelector[] = [];

	const visitArg = (arg: unknown): void => {
		const u = unwrapLiquidValue(arg);
		if (typeof u === 'string') {
			for (const piece of splitTopLevelSelectorList(u)) {
				const trimmed = piece.trim();
				if (trimmed === '.' || trimmed === 'this') {
					selectors.push(Object.freeze({ segments: Object.freeze([]), filterRaw: null }));
					continue;
				}
				const parsed = parseSingleSelectorString(trimmed);
				if (parsed) {
					selectors.push(
						Object.freeze({
							segments: parsed.segments,
							filterRaw: parsed.filterRaw,
						}),
					);
				}
			}
			return;
		}
		if (Array.isArray(u)) {
			for (const item of u) {
				visitArg(item);
			}
		}
	};

	for (const arg of args) {
		visitArg(arg);
	}
	return selectors;
}

/**
 * Coerces a `TemporalDrop` or temporal string (including `left..right` range strings,
 * preserving the finest endpoint `DisplayGrain`) into a `TemporalDrop` normalized to UTC
 * epoch milliseconds using `timeZone` for naïve dates.
 */
export function coerceToTemporalGroupDrop(
	val: unknown,
	timeZone: string,
	referenceTimeMs: number,
): TemporalDrop | null {
	const u = unwrapLiquidValue(val);
	if (u instanceof TemporalDrop) return u;
	if (typeof u === 'string') {
		const trimmed = u.trim();
		if (trimmed.length === 0 || !/^[0-9@tTyYlLnN]/.test(trimmed)) return null;
		// Keep pure non-4-digit decimal numbers as strings/numbers unless they are 4-digit years or ISO dates
		if (parseFiniteRangeNumber(trimmed) !== null && !/^\d{4}$/.test(trimmed)) {
			return null;
		}
		const normalized = normalizeRelativeTemporalString(trimmed);
		const rangeParts = normalized.split('..');
		if (rangeParts.length === 2) {
			const leftRaw = rangeParts[0]?.trim() ?? '';
			const rightRaw = rangeParts[1]?.trim() ?? '';
			if (!leftRaw || !rightRaw) return null;
			const parseOpts = {
				allowYearOnly: true,
				allowRelative: true,
				timeZone,
				referenceTimeMs,
			};
			const leftRes = parseSingleTemporalAtom(leftRaw, parseOpts);
			if (!leftRes.ok) return null;
			const rightRes = parseSingleTemporalAtom(rightRaw, parseOpts);
			if (!rightRes.ok) return null;
			const leftDrop = TemporalDrop.fromDateInterval(
				leftRes.interval,
				timeZone,
				referenceTimeMs,
			);
			const rightDrop = TemporalDrop.fromDateInterval(
				rightRes.interval,
				timeZone,
				referenceTimeMs,
			);
			if (leftDrop.start >= rightDrop.end) return null;
			return new TemporalDrop({
				start: leftDrop.start,
				end: rightDrop.end,
				grain: finestDisplayGrain(leftDrop.grain, rightDrop.grain),
				isRange: true,
				timeZone,
				referenceTimeMs,
				raw: trimmed,
			});
		}

		const parsed = parseTemporalExpr(normalized, {
			allowYearOnly: true,
			allowRelative: true,
			timeZone,
			referenceTimeMs,
		});
		if (parsed.ok) {
			return TemporalDrop.fromDateInterval(parsed.interval, timeZone, referenceTimeMs);
		}
	}
	return null;
}

/**
 * Builds a deterministic structural key for value-based bucketing and `uniq` deduplication,
 * normalizing temporal values (explicit-offset ISO timestamps and naïve dates interpreted in
 * `timeZone`) to their UTC millisecond interval `[start, end)`.
 */
export function canonicalRhizomeValueKey(
	val: unknown,
	timeZone: string,
	referenceTimeMs: number,
): string {
	const u = unwrapLiquidValue(val);
	if (isVacuousSortOrGroupValue(u)) return 'v:null';
	if (typeof u === 'boolean') return `b:${u}`;
	if (typeof u === 'number') return `n:${u === 0 ? 0 : u}`;
	if (u instanceof TemporalDrop) {
		return `t:${u.grain}:${u.start}:${u.end}`;
	}
	if (typeof u === 'string') {
		const temporalDrop = coerceToTemporalGroupDrop(u, timeZone, referenceTimeMs);
		if (temporalDrop) {
			return `t:${temporalDrop.grain}:${temporalDrop.start}:${temporalDrop.end}`;
		}
		return `s:${u}`;
	}
	if (Array.isArray(u)) {
		return `a:[${u.map((el) => canonicalRhizomeValueKey(el, timeZone, referenceTimeMs)).join(',')}]`;
	}
	if (isPlainRecord(u)) {
		const keys = Object.keys(u)
			.filter((k) => !FORBIDDEN_KEYS.has(k))
			.sort();
		const pairs = keys.map(
			(k) =>
				`${JSON.stringify(k)}:${canonicalRhizomeValueKey(u[k], timeZone, referenceTimeMs)}`,
		);
		return `o:{${pairs.join(',')}}`;
	}
	return `x:${typeof u}`;
}

interface IndexedEntry {
	readonly item: unknown;
	readonly index: number;
}

interface ActiveGroupBucket {
	name: unknown;
	entries: IndexedEntry[];
	active: boolean;
	subsumedInto: ActiveGroupBucket | null;
	interval: DateInterval | null;
}

function resolveActiveBucket(bucket: ActiveGroupBucket): ActiveGroupBucket {
	let curr = bucket;
	while (curr.subsumedInto !== null) {
		curr = curr.subsumedInto;
	}
	return curr;
}

function groupItemsAtLevel(
	items: readonly unknown[],
	selectors: readonly ParsedGroupSelector[],
	selectorIndex: number,
	filterThis: LiquidFilterThis | void,
	timeZone: string,
	referenceTimeMs: number,
): GroupByBucket[] {
	const selector = selectors[selectorIndex]!;
	const bucketsInOrder: ActiveGroupBucket[] = [];
	const temporalByGrain = new Map<DisplayGrain, ActiveGroupBucket[]>();
	const exactTemporalMap = new Map<string, ActiveGroupBucket>();
	const valueBucketsByKey = new Map<string, ActiveGroupBucket>();
	let nullBucketEntries: IndexedEntry[] | null = null;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const rawVal =
			selector.segments.length === 0 && selector.filterRaw === null
				? unwrapLiquidValue(item)
				: evaluateSelectorOnItem(item, selector, filterThis);
		const entry: IndexedEntry = { item, index: i };

		if (isVacuousSortOrGroupValue(rawVal)) {
			if (!nullBucketEntries) {
				nullBucketEntries = [];
			}
			nullBucketEntries.push(entry);
			continue;
		}

		const temporalDrop = coerceToTemporalGroupDrop(rawVal, timeZone, referenceTimeMs);
		if (temporalDrop) {
			const grain = temporalDrop.grain;
			const exactKey = `${grain}:${temporalDrop.start}:${temporalDrop.end}`;
			const exactHit = exactTemporalMap.get(exactKey);
			if (exactHit) {
				const target = resolveActiveBucket(exactHit);
				target.entries.push(entry);
				continue;
			}

			const candInterval = temporalDrop.toDateInterval();
			let grainList = temporalByGrain.get(grain);
			if (!grainList) {
				grainList = [];
				temporalByGrain.set(grain, grainList);
			}

			let matchedBucket: ActiveGroupBucket | null = null;
			for (let b = 0; b < grainList.length; b++) {
				const g = grainList[b]!;
				if (!g.active || !g.interval) continue;

				if (compareDateIntervals(candInterval, '=', g.interval)) {
					// Candidate C is contained in existing bucket G_i (C <= G_i)
					g.entries.push(entry);
					exactTemporalMap.set(exactKey, g);
					matchedBucket = g;
					break;
				}

				if (compareDateIntervals(g.interval, '=', candInterval)) {
					// Candidate C widens existing bucket G_i (G_i < C)
					g.name = temporalDrop;
					g.interval = candInterval;
					g.entries.push(entry);
					exactTemporalMap.set(exactKey, g);
					matchedBucket = g;

					// Sweep remaining active buckets at the same grain for subsumption into G_i
					let mergedAny = false;
					for (let j = 0; j < grainList.length; j++) {
						const other = grainList[j]!;
						if (other === g || !other.active || !other.interval) continue;
						if (compareDateIntervals(other.interval, '=', candInterval)) {
							other.active = false;
							other.subsumedInto = g;
							g.entries.push(...other.entries);
							other.entries = [];
							mergedAny = true;
						}
					}
					if (mergedAny) {
						g.entries.sort((x, y) => x.index - y.index);
					}
					break;
				}
			}

			if (!matchedBucket) {
				const freshBucket: ActiveGroupBucket = {
					name: temporalDrop,
					entries: [entry],
					active: true,
					subsumedInto: null,
					interval: candInterval,
				};
				grainList.push(freshBucket);
				bucketsInOrder.push(freshBucket);
				exactTemporalMap.set(exactKey, freshBucket);
			}
			continue;
		}

		const valKey = canonicalRhizomeValueKey(rawVal, timeZone, referenceTimeMs);
		let valBucket = valueBucketsByKey.get(valKey);
		if (!valBucket) {
			valBucket = {
				name: unwrapLiquidValue(rawVal),
				entries: [entry],
				active: true,
				subsumedInto: null,
				interval: null,
			};
			valueBucketsByKey.set(valKey, valBucket);
			bucketsInOrder.push(valBucket);
		} else {
			valBucket.entries.push(entry);
		}
	}

	const hasNextLevel = selectorIndex + 1 < selectors.length;
	const outputGroups: GroupByBucket[] = [];

	for (const bucket of bucketsInOrder) {
		if (!bucket.active) continue;
		const bucketItems = bucket.entries.map((e) => e.item);
		if (hasNextLevel) {
			outputGroups.push({
				name: bucket.name,
				items: bucketItems,
				size: bucketItems.length,
				groups: groupItemsAtLevel(
					bucketItems,
					selectors,
					selectorIndex + 1,
					filterThis,
					timeZone,
					referenceTimeMs,
				),
			});
		} else {
			outputGroups.push({
				name: bucket.name,
				items: bucketItems,
				size: bucketItems.length,
			});
		}
	}

	if (nullBucketEntries && nullBucketEntries.length > 0) {
		const nullItems = nullBucketEntries.map((e) => e.item);
		if (hasNextLevel) {
			outputGroups.push({
				name: null,
				items: nullItems,
				size: nullItems.length,
				groups: groupItemsAtLevel(
					nullItems,
					selectors,
					selectorIndex + 1,
					filterThis,
					timeZone,
					referenceTimeMs,
				),
			});
		} else {
			outputGroups.push({
				name: null,
				items: nullItems,
				size: nullItems.length,
			});
		}
	}

	return outputGroups;
}

/**
 * Liquid `group_by` filter: groups an array by one or more `<deep.path> [| <filterPipeline>]`
 * selectors in first-seen order (`name: null` bucket last), supporting hierarchical nested
 * `groups` (Option B), grain-partitioned bidirectional `=` temporal interval bucketing with
 * arrival-order-independent widening subsumption, and structural value bucketing.
 */
export function groupByFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	...args: unknown[]
): GroupByBucket[] {
	const unwrapped = unwrapLiquidValue(input);
	if (!Array.isArray(unwrapped)) {
		return [];
	}
	const selectors = parseGroupBySelectors(args);
	if (selectors.length === 0) {
		return [];
	}

	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);

	return groupItemsAtLevel(unwrapped, selectors, 0, this, timeZone, referenceTimeMs);
}
