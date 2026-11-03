import { compareDateIntervals, type DateInterval } from '@core/search';
import {
	evaluateSelectorOnItem,
	type LiquidFilterThis,
	type ParsedPathSelector,
	parseSingleSelectorString,
} from './selector-evaluator';
import {
	canonicalRhizomeValueKey,
	coerceToTemporalGroupDrop,
	isVacuousSortOrGroupValue,
} from './sort-group-filters';
import {
	coerceOperandToDateInterval,
	parseFiniteRangeNumber,
	readContextTemporalMeta,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';

function resolveCollectionSelector(
	rawSelector: unknown,
): Pick<ParsedPathSelector, 'segments' | 'filterRaw'> | null {
	const u = unwrapLiquidValue(rawSelector);
	if (typeof u !== 'string') return null;
	const trimmed = u.trim();
	if (trimmed.length === 0) return null;
	if (trimmed === '.' || trimmed === 'this') {
		return Object.freeze({ segments: Object.freeze([]), filterRaw: null });
	}
	return parseSingleSelectorString(trimmed);
}

function evalCollectionItem(
	item: unknown,
	selector: Pick<ParsedPathSelector, 'segments' | 'filterRaw'>,
	filterThis: LiquidFilterThis | void,
): unknown {
	if (selector.segments.length === 0 && selector.filterRaw === null) {
		return unwrapLiquidValue(item);
	}
	return evaluateSelectorOnItem(item, selector, filterThis);
}

function coerceStringOrDropToDateInterval(
	val: unknown,
	allowEpochNumber: boolean,
	timeZone: string,
	referenceTimeMs: number,
): DateInterval | null {
	const u = unwrapLiquidValue(val);
	if (u instanceof TemporalDrop) {
		return u.toDateInterval();
	}
	if (allowEpochNumber && typeof u === 'number') {
		return coerceOperandToDateInterval(u, timeZone, referenceTimeMs);
	}
	const drop = coerceToTemporalGroupDrop(u, timeZone, referenceTimeMs);
	return drop ? drop.toDateInterval() : null;
}

interface PreparedWhereTarget {
	readonly hasExpectedArg: boolean;
	readonly uExpected: unknown;
	readonly isVacuous: boolean;
	readonly isArray: boolean;
	readonly interval: DateInterval | null;
	readonly canonicalKey: string;
	readonly timeZone: string;
	readonly referenceTimeMs: number;
}

function prepareWhereTarget(
	expectedVal: unknown,
	hasExpectedArg: boolean,
	timeZone: string,
	referenceTimeMs: number,
): PreparedWhereTarget {
	if (!hasExpectedArg) {
		return {
			hasExpectedArg: false,
			uExpected: undefined,
			isVacuous: true,
			isArray: false,
			interval: null,
			canonicalKey: '',
			timeZone,
			referenceTimeMs,
		};
	}

	const uExpected = unwrapLiquidValue(expectedVal);
	const isVacuous = isVacuousSortOrGroupValue(uExpected);
	const isArray = Array.isArray(uExpected);
	const interval = isVacuous
		? null
		: coerceStringOrDropToDateInterval(
				uExpected,
				uExpected instanceof TemporalDrop,
				timeZone,
				referenceTimeMs,
			);
	const canonicalKey = isVacuous
		? 'v:null'
		: canonicalRhizomeValueKey(uExpected, timeZone, referenceTimeMs);

	return {
		hasExpectedArg: true,
		uExpected,
		isVacuous,
		isArray,
		interval,
		canonicalKey,
		timeZone,
		referenceTimeMs,
	};
}

function matchesPreparedWhereTarget(actualVal: unknown, target: PreparedWhereTarget): boolean {
	const uActual = unwrapLiquidValue(actualVal);

	if (!target.hasExpectedArg) {
		return uActual !== false && !isVacuousSortOrGroupValue(uActual);
	}

	if (target.isVacuous) {
		return isVacuousSortOrGroupValue(uActual);
	}
	if (isVacuousSortOrGroupValue(uActual)) {
		return false;
	}

	if (Array.isArray(uActual) && !target.isArray) {
		return (uActual as readonly unknown[]).some((el) => matchesPreparedWhereTarget(el, target));
	}

	const intExpected =
		target.interval ??
		(uActual instanceof TemporalDrop
			? coerceStringOrDropToDateInterval(
					target.uExpected,
					true,
					target.timeZone,
					target.referenceTimeMs,
				)
			: null);
	if (intExpected !== null) {
		const intActual = coerceStringOrDropToDateInterval(
			uActual,
			typeof target.uExpected !== 'number',
			target.timeZone,
			target.referenceTimeMs,
		);
		if (intActual) {
			return (
				compareDateIntervals(intActual, '=', intExpected) ||
				compareDateIntervals(intExpected, '=', intActual)
			);
		}
	}

	if (intExpected === null && typeof uActual === 'string') {
		return `s:${uActual}` === target.canonicalKey;
	}

	return (
		canonicalRhizomeValueKey(uActual, target.timeZone, target.referenceTimeMs) ===
		target.canonicalKey
	);
}

function filterCollectionByWhere(
	filterThis: LiquidFilterThis | void,
	input: unknown,
	selectorArg: unknown,
	restArgs: readonly unknown[],
	includeMatch: boolean,
): unknown[] {
	const unwrapped = unwrapLiquidValue(input);
	if (!Array.isArray(unwrapped)) return [];
	const items: readonly unknown[] = unwrapped;
	const selector = resolveCollectionSelector(selectorArg);
	if (!selector) return [];

	const ctx =
		filterThis && typeof filterThis === 'object' && 'context' in filterThis
			? filterThis.context
			: undefined;
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);
	const preparedTarget = prepareWhereTarget(
		restArgs[0],
		restArgs.length > 0,
		timeZone,
		referenceTimeMs,
	);

	const out: unknown[] = [];
	for (const item of items) {
		const actualVal = evalCollectionItem(item, selector, filterThis);
		if (matchesPreparedWhereTarget(actualVal, preparedTarget) === includeMatch) {
			out.push(item);
		}
	}
	return out;
}

function searchFirstInCollection(
	filterThis: LiquidFilterThis | void,
	input: unknown,
	selectorArg: unknown,
	restArgs: readonly unknown[],
): [number, unknown] | null {
	const unwrapped = unwrapLiquidValue(input);
	if (!Array.isArray(unwrapped)) return null;
	const items: readonly unknown[] = unwrapped;
	const selector = resolveCollectionSelector(selectorArg);
	if (!selector) return null;

	const ctx =
		filterThis && typeof filterThis === 'object' && 'context' in filterThis
			? filterThis.context
			: undefined;
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);
	const preparedTarget = prepareWhereTarget(
		restArgs[0],
		restArgs.length > 0,
		timeZone,
		referenceTimeMs,
	);

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const actualVal = evalCollectionItem(item, selector, filterThis);
		if (matchesPreparedWhereTarget(actualVal, preparedTarget)) {
			return [i, item];
		}
	}
	return null;
}

/**
 * Liquid `where` filter supporting `<deep.path> [| <filterPipeline>]` selectors and
 * Rhizome vacuous/temporal/array-membership equality.
 */
export function whereFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	selectorArg?: unknown,
	...restArgs: unknown[]
): unknown[] {
	return filterCollectionByWhere(this, input, selectorArg, restArgs, true);
}

/**
 * Liquid `reject` filter supporting `<deep.path> [| <filterPipeline>]` selectors and
 * Rhizome vacuous/temporal/array-membership equality.
 */
export function rejectFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	selectorArg?: unknown,
	...restArgs: unknown[]
): unknown[] {
	return filterCollectionByWhere(this, input, selectorArg, restArgs, false);
}

/**
 * Liquid `find` filter supporting `<deep.path> [| <filterPipeline>]` selectors.
 */
export function findFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	selectorArg?: unknown,
	...restArgs: unknown[]
): unknown {
	const found = searchFirstInCollection(this, input, selectorArg, restArgs);
	return found ? found[1] : null;
}

/**
 * Liquid `find_index` filter supporting `<deep.path> [| <filterPipeline>]` selectors.
 */
export function findIndexFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	selectorArg?: unknown,
	...restArgs: unknown[]
): number | null {
	const found = searchFirstInCollection(this, input, selectorArg, restArgs);
	return found ? found[0] : null;
}

/**
 * Liquid `has` filter supporting `<deep.path> [| <filterPipeline>]` selectors.
 */
export function hasFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	selectorArg?: unknown,
	...restArgs: unknown[]
): boolean {
	return searchFirstInCollection(this, input, selectorArg, restArgs) !== null;
}

/**
 * Liquid `map` filter supporting `<deep.path> [| <filterPipeline>]` selectors.
 */
export function mapFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	selectorArg?: unknown,
): unknown[] {
	const unwrapped = unwrapLiquidValue(input);
	if (!Array.isArray(unwrapped)) return [];
	const selector = resolveCollectionSelector(selectorArg);
	if (!selector) return [];

	return unwrapped.map((item) => evalCollectionItem(item, selector, this));
}

/**
 * Liquid `uniq` filter supporting optional `<deep.path> [| <filterPipeline>]` selectors
 * and canonical structural/temporal deduplication.
 */
export function uniqFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	selectorArg?: unknown,
): unknown[] {
	const unwrapped = unwrapLiquidValue(input);
	if (!Array.isArray(unwrapped)) return [];

	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);
	const hasSelectorArg = selectorArg !== undefined;
	const selector = hasSelectorArg ? resolveCollectionSelector(selectorArg) : null;
	if (hasSelectorArg && !selector) return [];

	const seen = new Set<string>();
	const out: unknown[] = [];
	for (const item of unwrapped) {
		const targetVal = selector
			? evalCollectionItem(item, selector, this)
			: unwrapLiquidValue(item);
		const key = canonicalRhizomeValueKey(targetVal, timeZone, referenceTimeMs);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(item);
		}
	}
	return out;
}

/**
 * Liquid `sum` filter supporting optional `<deep.path> [| <filterPipeline>]` selectors.
 */
export function sumFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	selectorArg?: unknown,
): number {
	const unwrapped = unwrapLiquidValue(input);
	if (!Array.isArray(unwrapped)) return 0;
	const items: readonly unknown[] = unwrapped;

	const hasSelectorArg = selectorArg !== undefined;
	const selector = hasSelectorArg ? resolveCollectionSelector(selectorArg) : null;
	if (hasSelectorArg && !selector) return 0;
	let total = 0;

	const addValue = (candidate: unknown): void => {
		const u = unwrapLiquidValue(candidate);
		if (Array.isArray(u)) {
			for (const el of u as readonly unknown[]) addValue(el);
			return;
		}
		const num = parseFiniteRangeNumber(u);
		if (num !== null) {
			total += num;
		}
	};

	for (const item of items) {
		const val = selector ? evalCollectionItem(item, selector, this) : item;
		addValue(val);
	}
	return total === 0 ? 0 : total;
}
