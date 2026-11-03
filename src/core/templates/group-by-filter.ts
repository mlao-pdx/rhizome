import {
	compareDateIntervals,
	type DateInterval,
	FORBIDDEN_KEYS,
	isVacuousOccurrence,
	parseSingleTemporalAtom,
	parseTemporalExpr,
} from '@core/search';
import {
	evaluateSelectorOnItem,
	isPlainRecord,
	type LiquidFilterThis,
	parseSingleSelectorString,
	splitTopLevelSelectorList,
} from './selector-evaluator';
import {
	type DisplayGrain,
	finestDisplayGrain,
	normalizeRelativeTemporalString,
	parseFiniteRangeNumber,
	readContextTemporalMeta,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';

/**
 * Output bucket entry returned by `group_by`.
 */
export interface GroupByBucket {
	readonly name: unknown;
	readonly items: unknown[];
	readonly size: number;
	readonly groups?: GroupByBucket[];
}

interface ParsedGroupSelector {
	readonly segments: readonly string[];
	readonly filterRaw: string | null;
}

const TEMPORAL_START_CHAR_RE = /^[0-9@tTyYlLnN+-]/;
const BARE_UNSIGNED_YEAR_RE = /^\d{4}$/;

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
 * Coerces a `TemporalDrop` or temporal string (including `left..right` range strings and
 * signed ISO years, preserving the finest endpoint `DisplayGrain`) into a `TemporalDrop`
 * normalized to UTC epoch milliseconds using `timeZone` for naïve dates.
 *
 * When `allowBareYearString` is `false`, bare 4-digit numeric strings (`"1024"`, `"2026"`)
 * are not coerced to year-grain `TemporalDrop`s so numeric/string comparisons stay consistent.
 */
export function coerceToTemporalGroupDrop(
	val: unknown,
	timeZone: string,
	referenceTimeMs: number,
	allowBareYearString = true,
): TemporalDrop | null {
	const u = unwrapLiquidValue(val);
	if (u instanceof TemporalDrop) return u;
	if (typeof u === 'string') {
		const trimmed = u.trim();
		if (trimmed.length === 0 || !TEMPORAL_START_CHAR_RE.test(trimmed)) return null;
		if (parseFiniteRangeNumber(trimmed) !== null) {
			if (!allowBareYearString || !BARE_UNSIGNED_YEAR_RE.test(trimmed)) {
				return null;
			}
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
			allowYearOnly: allowBareYearString,
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
		const temporalDrop = coerceToTemporalGroupDrop(u, timeZone, referenceTimeMs, false);
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

	const evaluatedValues: unknown[] = new Array(items.length);
	let hasUnambiguousTemporal = false;
	let hasNonYearNumeric = false;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const rawVal =
			selector.segments.length === 0 && selector.filterRaw === null
				? unwrapLiquidValue(item)
				: evaluateSelectorOnItem(item, selector, filterThis);
		evaluatedValues[i] = rawVal;
		const u = unwrapLiquidValue(rawVal);
		if (u instanceof TemporalDrop) {
			hasUnambiguousTemporal = true;
		} else if (typeof u === 'number' && Number.isFinite(u)) {
			if (!Number.isInteger(u) || u < 1000 || u > 9999) {
				hasNonYearNumeric = true;
			}
		} else if (typeof u === 'string') {
			const trimmed = u.trim();
			if (parseFiniteRangeNumber(trimmed) !== null) {
				if (!BARE_UNSIGNED_YEAR_RE.test(trimmed)) {
					hasNonYearNumeric = true;
				}
			} else if (coerceToTemporalGroupDrop(trimmed, timeZone, referenceTimeMs, false)) {
				hasUnambiguousTemporal = true;
			}
		}
	}

	const allowBareYearString = hasUnambiguousTemporal || !hasNonYearNumeric;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const rawVal = evaluatedValues[i];
		const entry: IndexedEntry = { item, index: i };

		if (isVacuousSortOrGroupValue(rawVal)) {
			if (!nullBucketEntries) {
				nullBucketEntries = [];
			}
			nullBucketEntries.push(entry);
			continue;
		}

		const temporalDrop = coerceToTemporalGroupDrop(
			rawVal,
			timeZone,
			referenceTimeMs,
			allowBareYearString,
		);
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
					g.entries.push(entry);
					exactTemporalMap.set(exactKey, g);
					matchedBucket = g;
					break;
				}

				if (compareDateIntervals(g.interval, '=', candInterval)) {
					g.name = temporalDrop;
					g.interval = candInterval;
					g.entries.push(entry);
					exactTemporalMap.set(exactKey, g);
					matchedBucket = g;

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
