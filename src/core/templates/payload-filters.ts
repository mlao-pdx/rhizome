import { FORBIDDEN_KEYS, mergeKeyValue } from '@core/search';
import type { Context, Liquid } from 'liquidjs';
import { aggregateFilter } from './aggregate-filter';
import { parseFiniteRangeNumber, TemporalDrop, unwrapLiquidValue } from './temporal-drop';

/**
 * Parsed deep-path selector for `pick` and `aggregate` (`agg`), mapping a non-empty
 * sequence of case-sensitive path `segments` to its target `outputKey` (either the
 * leaf segment or an explicit `"<path> as <alias>"` rename).
 */
export interface ParsedPathSelector {
	readonly segments: readonly string[];
	readonly outputKey: string;
}

const AS_ALIAS_RE = /^(.*?)\s+as\s+([^\s.]+)$/i;

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

function splitCleanSegments(rawPath: string): string[] | null {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) return null;
	const parts = trimmed.split('.');
	const segments: string[] = [];
	for (const part of parts) {
		const seg = part.trim();
		if (seg.length === 0 || FORBIDDEN_KEYS.has(seg)) {
			return null;
		}
		segments.push(seg);
	}
	return segments.length > 0 ? segments : null;
}

function parseSingleSelectorString(raw: string): ParsedPathSelector | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;

	const asMatch = AS_ALIAS_RE.exec(trimmed);
	if (asMatch) {
		const rawPath = asMatch[1] ?? '';
		const alias = (asMatch[2] ?? '').trim();
		if (alias.length === 0 || FORBIDDEN_KEYS.has(alias)) {
			return null;
		}
		const segments = splitCleanSegments(rawPath);
		if (!segments) return null;
		return Object.freeze({ segments: Object.freeze(segments), outputKey: alias });
	}

	const segments = splitCleanSegments(trimmed);
	if (!segments) return null;
	const leaf = segments[segments.length - 1]!;
	return Object.freeze({ segments: Object.freeze(segments), outputKey: leaf });
}

/**
 * Parses variadic filter arguments for `pick` and `aggregate` (`agg`), supporting:
 * - String selectors: `"file.basename"`, `"properties.status as state"`
 * - Array arguments containing string selectors (e.g., `pick: keys_array`)
 * - LiquidJS named-argument `[alias, path]` 2-tuples when `alias` has no dots and is a valid key
 */
export function parsePickOrAggSelectors(args: readonly unknown[]): ParsedPathSelector[] {
	const selectors: ParsedPathSelector[] = [];

	const visitArg = (arg: unknown, allowNamedTuple: boolean): void => {
		const u = unwrapLiquidValue(arg);
		if (typeof u === 'string') {
			const parsed = parseSingleSelectorString(u);
			if (parsed) selectors.push(parsed);
			return;
		}
		if (Array.isArray(u)) {
			// Detect a LiquidJS named argument tuple `[key, val]` only at the top-level arg list
			// when `u[0]` has no dots/spaces and `u[1]` is a string path without ` as `.
			if (
				allowNamedTuple &&
				u.length === 2 &&
				typeof u[0] === 'string' &&
				typeof u[1] === 'string' &&
				!/[\s.]/.test(u[0].trim()) &&
				!AS_ALIAS_RE.test(u[0]) &&
				!AS_ALIAS_RE.test(u[1]) &&
				u[1].includes('.')
			) {
				const alias = u[0].trim();
				const segments = splitCleanSegments(u[1]);
				if (alias.length > 0 && !FORBIDDEN_KEYS.has(alias) && segments) {
					selectors.push(
						Object.freeze({ segments: Object.freeze(segments), outputKey: alias }),
					);
					return;
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
 * Parses variadic filter arguments for `prune` into an array of case-sensitive path segment arrays.
 */
export function parsePrunePaths(args: readonly unknown[]): (readonly string[])[] {
	const paths: (readonly string[])[] = [];

	const visitArg = (arg: unknown): void => {
		const u = unwrapLiquidValue(arg);
		if (typeof u === 'string') {
			const asMatch = AS_ALIAS_RE.exec(u.trim());
			const rawPath = asMatch ? (asMatch[1] ?? '') : u;
			const segments = splitCleanSegments(rawPath);
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

/**
 * Walks `segments` case-sensitively on `root`, returning `null` if any intermediate step
 * is missing, non-record, or in `FORBIDDEN_KEYS`, and normalizing `undefined` to `null`.
 */
export function readDeepPath(root: unknown, segments: readonly string[]): unknown {
	let current: unknown = unwrapLiquidValue(root);
	for (const seg of segments) {
		if (FORBIDDEN_KEYS.has(seg) || !isPlainRecord(current) || !(seg in current)) {
			return null;
		}
		current = unwrapLiquidValue(current[seg]);
	}
	return current === undefined ? null : current;
}

const sharedPromotedKeys = new Set<string>();

function pickFromObject(
	item: unknown,
	selectors: readonly ParsedPathSelector[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const u = unwrapLiquidValue(item);
	if (!isPlainRecord(u)) {
		return out;
	}
	sharedPromotedKeys.clear();
	for (const { segments, outputKey } of selectors) {
		if (FORBIDDEN_KEYS.has(outputKey)) continue;
		const val = readDeepPath(u, segments);
		mergeKeyValue(out, sharedPromotedKeys, outputKey, val);
	}
	sharedPromotedKeys.clear();
	return out;
}

/**
 * Liquid `pick` filter: extracts one or more root or deep-dotted paths from an object
 * (or each object in an array of objects) into a new flat plain object.
 * Resolves same-leaf collisions via the shared vacuous-aware `mergeKeyValue` rule.
 */
export function pickFilter(input: unknown, ...args: unknown[]): unknown {
	const selectors = parsePickOrAggSelectors(args);
	const unwrapped = unwrapLiquidValue(input);
	if (Array.isArray(unwrapped)) {
		return unwrapped.map((el) => pickFromObject(el, selectors));
	}
	if (isPlainRecord(unwrapped)) {
		return pickFromObject(unwrapped, selectors);
	}
	return {};
}

function shallowClonePlainRecord(obj: Record<string, unknown>): Record<string, unknown> {
	const clone: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		clone[key] = obj[key];
	}
	return clone;
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
	if (FORBIDDEN_KEYS.has(head) || !(head in clone)) {
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

function mergeObjects(objs: readonly unknown[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	sharedPromotedKeys.clear();

	for (const rawObj of objs) {
		const u = unwrapLiquidValue(rawObj);
		if (!isPlainRecord(u)) continue;
		for (const key of Object.keys(u)) {
			if (FORBIDDEN_KEYS.has(key)) continue;
			mergeKeyValue(out, sharedPromotedKeys, key, unwrapLiquidValue(u[key]));
		}
	}

	sharedPromotedKeys.clear();
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

/**
 * Registers Rhizome's payload-shaping and aggregation filters (`pick`, `prune`, `merge`,
 * `aggregate`, `agg`, `percentage`, and `percent`) on `liquid`.
 */
export function registerPayloadLiquidFilters(liquid: Liquid): void {
	liquid.registerFilter('pick', pickFilter);
	liquid.registerFilter('prune', pruneFilter);
	liquid.registerFilter('merge', mergeFilter);
	liquid.registerFilter('percentage', percentageFilter);
	liquid.registerFilter('percent', percentageFilter);
	liquid.registerFilter(
		'aggregate',
		function (this: { context: Context }, input: unknown, ...args: unknown[]) {
			return aggregateFilter.call(this, input, ...args);
		},
	);
	liquid.registerFilter(
		'agg',
		function (this: { context: Context }, input: unknown, ...args: unknown[]) {
			return aggregateFilter.call(this, input, ...args);
		},
	);
}
