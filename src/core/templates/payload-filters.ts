import { FORBIDDEN_KEYS } from '@core/search';
import type { Context, FilterImplOptions, Liquid } from 'liquidjs';
import { aggregateFilter } from './aggregate-filter';
import {
	findFilter,
	findIndexFilter,
	hasFilter,
	mapFilter,
	rejectFilter,
	sumFilter,
	uniqFilter,
	whereFilter,
} from './collection-filters';
import {
	evaluateSelectorOnItem,
	isPlainRecord,
	type LiquidFilterThis,
	type ParsedPathSelector,
	parsePickOrAggSelectors,
	registerFallbackFilter,
	safeMergeKeyValue,
	shallowClonePlainRecord,
	splitCleanSegments,
	writeDeepTargetValue,
} from './selector-evaluator';
import { groupByFilter, sortFilter, sortNaturalFilter } from './sort-group-filters';
import { tableFilter } from './table-filter';
import {
	attachLiquidInstanceToOptions,
	parseFiniteRangeNumber,
	unwrapLiquidValue,
} from './temporal-drop';

/**
 * Parses variadic filter arguments for `prune` into an array of case-sensitive `<deep.path>`
 * segment arrays (rejecting strings with filter pipelines or `as` target clauses).
 */
export function parsePrunePaths(args: readonly unknown[]): (readonly string[])[] {
	const paths: (readonly string[])[] = [];

	const visitArg = (arg: unknown): void => {
		const u = unwrapLiquidValue(arg);
		if (typeof u === 'string') {
			const trimmed = u.trim();
			if (/[\s|]/.test(trimmed)) {
				return;
			}
			const segments = splitCleanSegments(trimmed);
			if (segments) {
				paths.push(Object.freeze(segments));
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
	return paths;
}

function pickFromObject(
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

/**
 * Liquid `pick` filter: extracts one or more root or deep-dotted paths (with optional
 * `| <filterPipeline>` and `as <target.deep.path>`) from an object or array of objects
 * into a new plain object, resolving same-leaf collisions via `mergeKeyValue`.
 */
export function pickFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	...args: unknown[]
): unknown {
	const selectors = parsePickOrAggSelectors(args);
	const unwrapped = unwrapLiquidValue(input);
	if (Array.isArray(unwrapped)) {
		return unwrapped.map((el) => pickFromObject(el, selectors, this));
	}
	if (isPlainRecord(unwrapped)) {
		return pickFromObject(unwrapped, selectors, this);
	}
	return {};
}

function prunePathFromObject(
	obj: Record<string, unknown>,
	segments: readonly string[],
	depth: number,
): Record<string, unknown> {
	const clone = shallowClonePlainRecord(obj);
	if (depth >= segments.length) {
		return clone;
	}
	const head = segments[depth]!;
	if (FORBIDDEN_KEYS.has(head) || !Object.prototype.hasOwnProperty.call(clone, head)) {
		return clone;
	}
	if (depth === segments.length - 1) {
		delete clone[head];
		return clone;
	}
	const child = unwrapLiquidValue(clone[head]);
	if (isPlainRecord(child)) {
		clone[head] = prunePathFromObject(child, segments, depth + 1);
	}
	return clone;
}

function pruneObjectAllPaths(
	item: unknown,
	paths: readonly (readonly string[])[],
): Record<string, unknown> {
	const u = unwrapLiquidValue(item);
	if (!isPlainRecord(u)) {
		return {};
	}
	let current = shallowClonePlainRecord(u);
	for (const segments of paths) {
		if (segments.length > 0) {
			current = prunePathFromObject(current, segments, 0);
		}
	}
	return current;
}

/**
 * Liquid `prune` filter: non-destructively removes one or more root or deep-dotted
 * paths from an object (or each object in an array of objects).
 */
export function pruneFilter(input: unknown, ...args: unknown[]): unknown {
	const paths = parsePrunePaths(args);
	const unwrapped = unwrapLiquidValue(input);
	if (Array.isArray(unwrapped)) {
		return unwrapped.map((el) => pruneObjectAllPaths(el, paths));
	}
	if (isPlainRecord(unwrapped)) {
		return pruneObjectAllPaths(unwrapped, paths);
	}
	return {};
}

const sharedMergePromotedKeys = new Set<string>();

function mergeObjects(objs: readonly unknown[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	sharedMergePromotedKeys.clear();

	for (const rawObj of objs) {
		const u = unwrapLiquidValue(rawObj);
		if (!isPlainRecord(u)) continue;
		for (const key of Object.keys(u)) {
			if (FORBIDDEN_KEYS.has(key)) continue;
			safeMergeKeyValue(out, sharedMergePromotedKeys, key, unwrapLiquidValue(u[key]));
		}
	}

	sharedMergePromotedKeys.clear();
	return out;
}

/**
 * Liquid `merge` filter: combines root keys of objects with `lhs` dictating the output shape:
 * - `Object | merge: Object -> Object`
 * - `Object | merge: Object[] -> Object` (folds all objects in `rhs` into `lhs`)
 * - `Object[] | merge -> Object` (shorthand for `{} | merge: lhs`)
 * - `Object[] | merge: Object -> Object[]` (broadcasts `rhs` into each item of `lhs`)
 * - `Object[] | merge: Object[] -> Object[]` (positional index-by-index zip)
 */
export function mergeFilter(lhs: unknown, rhs?: unknown): unknown {
	const uLhs = unwrapLiquidValue(lhs);
	const uRhs = rhs === undefined ? undefined : unwrapLiquidValue(rhs);

	if (isPlainRecord(uLhs)) {
		if (uRhs === undefined) {
			return mergeObjects([uLhs]);
		}
		if (Array.isArray(uRhs)) {
			return mergeObjects([uLhs, ...(uRhs as readonly unknown[])]);
		}
		if (isPlainRecord(uRhs)) {
			return mergeObjects([uLhs, uRhs]);
		}
		return mergeObjects([uLhs]);
	}

	if (Array.isArray(uLhs)) {
		if (uRhs === undefined) {
			return mergeObjects(uLhs);
		}
		if (isPlainRecord(uRhs)) {
			return uLhs.map((item) => mergeObjects([item, uRhs]));
		}
		if (Array.isArray(uRhs)) {
			const maxLen = Math.max(uLhs.length, uRhs.length);
			const zipped: Record<string, unknown>[] = [];
			for (let i = 0; i < maxLen; i++) {
				if (i < uLhs.length && i < uRhs.length) {
					zipped.push(mergeObjects([uLhs[i], uRhs[i]]));
				} else if (i < uLhs.length) {
					zipped.push(mergeObjects([uLhs[i]]));
				} else {
					zipped.push(mergeObjects([uRhs[i]]));
				}
			}
			return zipped;
		}
		return uLhs.map((item) => mergeObjects([item]));
	}

	return {};
}

/**
 * Liquid `percentage` (`percent`) filter: computes `(value / total) * 100` as a finite
 * floating-point number, or `null` if either operand is non-numeric, `null`, `""`, or if `total === 0`.
 */
export function percentageFilter(value: unknown, total: unknown): number | null {
	const numVal = parseFiniteRangeNumber(value);
	const numTotal = parseFiniteRangeNumber(total);
	if (numVal === null || numTotal === null || numTotal === 0) {
		return null;
	}
	const pct = (numVal / numTotal) * 100;
	if (!Number.isFinite(pct)) {
		return null;
	}
	return pct === 0 ? 0 : pct;
}

const REMOVED_EXP_FILTERS: readonly string[] = Object.freeze([
	'group_by_exp',
	'where_exp',
	'reject_exp',
	'find_exp',
	'find_index_exp',
	'has_exp',
]);

function seedFallbackFilters(): void {
	const entries: readonly [string, (...args: unknown[]) => unknown][] = [
		['pick', pickFilter],
		['prune', pruneFilter],
		['merge', mergeFilter],
		['percentage', percentageFilter],
		['percent', percentageFilter],
		['aggregate', aggregateFilter],
		['agg', aggregateFilter],
		['sort', sortFilter],
		['sort_natural', sortNaturalFilter],
		['group_by', groupByFilter],
		['where', whereFilter],
		['reject', rejectFilter],
		['find', findFilter],
		['find_index', findIndexFilter],
		['has', hasFilter],
		['map', mapFilter],
		['uniq', uniqFilter],
		['sum', sumFilter],
		['table', tableFilter],
	];
	for (const [name, fn] of entries) {
		registerFallbackFilter(name, fn as FilterImplOptions);
	}
}

seedFallbackFilters();

/**
 * Registers Rhizome's payload-shaping, aggregation, sorting, grouping, and collection
 * filters on `liquid`, and removes the redundant `*_exp` filters.
 */
export function registerPayloadLiquidFilters(liquid: Liquid): void {
	attachLiquidInstanceToOptions(liquid);

	for (const expFilterName of REMOVED_EXP_FILTERS) {
		delete (liquid.filters as Record<string, unknown>)[expFilterName];
	}

	const bindContextFilter = (
		fn: (this: LiquidFilterThis, input: unknown, ...args: unknown[]) => unknown,
	) => {
		return function (
			this: { context: Context; liquid: Liquid },
			input: unknown,
			...args: unknown[]
		) {
			return fn.call(this, input, ...args);
		};
	};

	liquid.registerFilter('pick', bindContextFilter(pickFilter));
	liquid.registerFilter('prune', pruneFilter);
	liquid.registerFilter('merge', mergeFilter);
	liquid.registerFilter('percentage', percentageFilter);
	liquid.registerFilter('percent', percentageFilter);
	liquid.registerFilter('aggregate', bindContextFilter(aggregateFilter));
	liquid.registerFilter('agg', bindContextFilter(aggregateFilter));
	liquid.registerFilter('sort', bindContextFilter(sortFilter));
	liquid.registerFilter('sort_natural', bindContextFilter(sortNaturalFilter));
	liquid.registerFilter('group_by', bindContextFilter(groupByFilter));
	liquid.registerFilter('where', bindContextFilter(whereFilter));
	liquid.registerFilter('reject', bindContextFilter(rejectFilter));
	liquid.registerFilter('find', bindContextFilter(findFilter));
	liquid.registerFilter('find_index', bindContextFilter(findIndexFilter));
	liquid.registerFilter('has', bindContextFilter(hasFilter));
	liquid.registerFilter('map', bindContextFilter(mapFilter));
	liquid.registerFilter('uniq', bindContextFilter(uniqFilter));
	liquid.registerFilter('sum', bindContextFilter(sumFilter));
	liquid.registerFilter('table', bindContextFilter(tableFilter));
}
