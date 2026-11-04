import { FORBIDDEN_KEYS } from '@core/search';
import type { GroupByBucket } from './group-by-filter';
import {
	isPlainRecord,
	type LiquidFilterThis,
	type ParsedPathSelector,
	parsePickOrAggSelectors,
	pickFromObject,
	splitTopLevelSelectorList,
	stripOuterQuotes,
} from './selector-evaluator';
import { isVacuousSortOrGroupValue, readContextLanguage } from './sort-group-filters';
import {
	formatEllipsizedObject,
	formatTableScalar,
	getConjunctionListFormatter,
} from './table-filter';
import { unwrapLiquidValue } from './temporal-drop';

/**
 * Supported per-level Markdown list marker tokens (`'-'` for unordered bullets, `'1.'` for ordered items).
 */
export type ListStyleMarker = '-' | '1.';

/**
 * Parsed arguments for the Liquid `list` filter, separating per-level `styles` from leaf `selectors`.
 */
export interface ParsedListArguments {
	readonly styles: readonly ListStyleMarker[];
	readonly selectors: readonly ParsedPathSelector[];
}

const DEFAULT_LIST_STYLES: readonly ListStyleMarker[] = Object.freeze([
	'-',
	'-',
	'-',
	'-',
	'-',
	'-',
]);

const GROUP_BY_BUCKET_KEYS: ReadonlySet<string> = new Set(['name', 'items', 'size', 'groups']);

function isStyleToken(raw: string): raw is ListStyleMarker | '...' {
	return raw === '-' || raw === '1.' || raw === '...';
}

function isNamedSelectorTuple(u: readonly unknown[]): boolean {
	if (u.length !== 2 || typeof u[0] !== 'string' || typeof u[1] !== 'string') {
		return false;
	}
	const rawKey = u[0].trim();
	const rawVal = u[1].trim();
	const isQuotedKey =
		(rawKey.startsWith('"') && rawKey.endsWith('"')) ||
		(rawKey.startsWith("'") && rawKey.endsWith("'"));
	const unquotedKey = stripOuterQuotes(rawKey);
	const unquotedVal = stripOuterQuotes(rawVal);
	if (isStyleToken(unquotedKey) || isStyleToken(unquotedVal)) {
		return false;
	}
	return (
		(isQuotedKey || !/[\s.|]/.test(unquotedKey)) &&
		!/\s+as\s+/i.test(unquotedKey) &&
		!/\s+as\s+/i.test(rawVal) &&
		(isQuotedKey || rawVal.includes('.') || rawVal.includes('|'))
	);
}

/**
 * Parses variadic arguments for the `list` filter into resolved level `styles` and leaf `selectors`.
 *
 * Style tokens (`'-'`, `'1.'`, `'...'`) configure bullet markers per depth level:
 * - No style tokens defaults to `['-', '-', '-', '-', '-', '-']` (6 levels of `'-'`).
 * - A trailing `'...'` repeats the preceding marker (or `'-'` if first) up to `Math.max(6, explicit.length)`.
 * - Explicit markers without `'...'` configure exact depth `N = explicit.length`, placing the inline
 *   horizon at depth `N + 1`.
 */
export function parseListArguments(args: readonly unknown[]): ParsedListArguments {
	const explicitStyles: ListStyleMarker[] = [];
	let hasEllipsis = false;
	const selectorArgs: unknown[] = [];

	const visitPiece = (piece: string): void => {
		const unquoted = stripOuterQuotes(piece.trim());
		if (unquoted.length === 0) return;
		if (unquoted === '-' || unquoted === '1.') {
			if (!hasEllipsis) {
				explicitStyles.push(unquoted);
			}
			return;
		}
		if (unquoted === '...') {
			hasEllipsis = true;
			return;
		}
		selectorArgs.push(piece);
	};

	const visitArg = (arg: unknown, allowNamedTuple: boolean): void => {
		const u = unwrapLiquidValue(arg);
		if (typeof u === 'string') {
			for (const piece of splitTopLevelSelectorList(u)) {
				visitPiece(piece);
			}
			return;
		}
		if (Array.isArray(u)) {
			if (allowNamedTuple && isNamedSelectorTuple(u)) {
				selectorArgs.push(u);
				return;
			}
			for (const item of u) {
				visitArg(item, false);
			}
		}
	};

	for (const arg of args) {
		visitArg(arg, true);
	}

	let styles: readonly ListStyleMarker[];
	if (explicitStyles.length === 0 && !hasEllipsis) {
		styles = DEFAULT_LIST_STYLES;
	} else if (hasEllipsis) {
		const fillMarker: ListStyleMarker =
			explicitStyles.length > 0 ? explicitStyles[explicitStyles.length - 1]! : '-';
		const targetLen = Math.max(6, explicitStyles.length);
		while (explicitStyles.length < targetLen) {
			explicitStyles.push(fillMarker);
		}
		styles = Object.freeze(explicitStyles);
	} else {
		styles = Object.freeze(explicitStyles);
	}

	const selectors = Object.freeze(parsePickOrAggSelectors(selectorArgs));
	return Object.freeze({ styles, selectors });
}

/**
 * Structural type guard for `GroupByBucket` objects produced by `group_by`.
 */
export function isGroupByBucket(val: unknown): val is GroupByBucket {
	const u = unwrapLiquidValue(val);
	if (!isPlainRecord(u)) return false;

	const ownKeys = Object.keys(u).filter((k) => !FORBIDDEN_KEYS.has(k));
	if (ownKeys.length < 3 || ownKeys.length > 4) return false;
	for (const k of ownKeys) {
		if (!GROUP_BY_BUCKET_KEYS.has(k)) return false;
	}
	if (
		!Object.prototype.hasOwnProperty.call(u, 'name') ||
		!Object.prototype.hasOwnProperty.call(u, 'items') ||
		!Object.prototype.hasOwnProperty.call(u, 'size')
	) {
		return false;
	}
	const items = unwrapLiquidValue(u.items);
	const size = unwrapLiquidValue(u.size);
	const groups = Object.prototype.hasOwnProperty.call(u, 'groups')
		? unwrapLiquidValue(u.groups)
		: undefined;

	return (
		Array.isArray(items) &&
		typeof size === 'number' &&
		Number.isFinite(size) &&
		(groups === undefined || Array.isArray(groups))
	);
}

/**
 * Liquid `sentence` (`array_to_sentence_string`) filter: formats a 1D array of values into
 * natural-language inline prose using locale-aware `Intl.ListFormat` conjunction formatting,
 * or a custom `connector` string when explicitly provided.
 */
export function sentenceFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	connector?: unknown,
): string {
	const unwrapped = unwrapLiquidValue(input);
	if (isVacuousSortOrGroupValue(unwrapped)) {
		return '';
	}

	const rawItems = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
	const renderedItems: string[] = [];

	for (const rawEl of rawItems) {
		if (isVacuousSortOrGroupValue(rawEl)) continue;
		const el = unwrapLiquidValue(rawEl);
		const scalar = formatTableScalar(el);
		if (scalar !== null) {
			renderedItems.push(scalar);
		} else if (isPlainRecord(el)) {
			renderedItems.push(formatEllipsizedObject(el));
		} else if (Array.isArray(el)) {
			renderedItems.push('{...}');
		}
	}

	if (renderedItems.length === 0) {
		return '';
	}

	const uConnector = connector === undefined ? undefined : unwrapLiquidValue(connector);
	if (uConnector !== undefined && uConnector !== null) {
		const connStr =
			typeof uConnector === 'string' ? uConnector : (formatTableScalar(uConnector) ?? '');
		if (renderedItems.length === 1) {
			return renderedItems[0]!;
		}
		if (renderedItems.length === 2) {
			return `${renderedItems[0]!} ${connStr} ${renderedItems[1]!}`;
		}
		return `${renderedItems.slice(0, -1).join(', ')}, ${connStr} ${renderedItems[renderedItems.length - 1]!}`;
	}

	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const language = readContextLanguage(ctx);
	return getConjunctionListFormatter(language).format(renderedItems);
}

/**
 * Internal list subtree render result shared with `heading-filter.ts`.
 */
export interface RenderListResult {
	readonly lines: string[];
	readonly hitHorizon: boolean;
}

/**
 * Shared evaluation environment for `listFilter` and `headingFilter` leaf/post-H6 subtrees.
 */
export interface ListRenderEnv {
	readonly styles: readonly ListStyleMarker[];
	readonly selectors: readonly ParsedPathSelector[];
	readonly filterThis: LiquidFilterThis | void;
	readonly language: string;
}

/**
 * Returns own non-forbidden keys of `obj` whose values are non-vacuous.
 */
export function getNonVacuousKeys(obj: Record<string, unknown>): string[] {
	const keys: string[] = [];
	for (const key of Object.keys(obj)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		if (!isVacuousSortOrGroupValue(obj[key])) {
			keys.push(key);
		}
	}
	return keys;
}

function formatMarker(
	styles: readonly ListStyleMarker[],
	depth: number,
	itemIndex: number,
): string {
	return styles[depth - 1] === '1.' ? `${itemIndex + 1}. ` : '- ';
}

function formatBulletLine(depth: number, marker: string, text: string): string {
	const indent = '  '.repeat(depth - 1);
	const contIndent = '  '.repeat(depth);
	const normalized = text.replace(/\r\n|\r|\n/g, `\n${contIndent}`);
	return `${indent}${marker}${normalized}`;
}

/**
 * Formats an arbitrary value as a single-line horizon atom (`scalar`, `(size+)` bucket badge,
 * or ellipsized `{...}` placeholder), or `null` if vacuous.
 */
export function formatHorizonAtom(val: unknown): string | null {
	if (isVacuousSortOrGroupValue(val)) return null;
	const u = unwrapLiquidValue(val);
	if (isGroupByBucket(u)) {
		const badge = `(${u.size}+)`;
		if (isVacuousSortOrGroupValue(u.name)) {
			return badge;
		}
		const nameAtom = formatHorizonAtom(u.name) ?? '{...}';
		return `${nameAtom} ${badge}`;
	}
	const scalar = formatTableScalar(u);
	if (scalar !== null) return scalar;
	if (isPlainRecord(u)) return formatEllipsizedObject(u);
	if (Array.isArray(u)) return '{...}';
	return null;
}

function formatLeafItemAtHorizon(rawItem: unknown, env: ListRenderEnv): string | null {
	if (isVacuousSortOrGroupValue(rawItem)) return null;
	const u = unwrapLiquidValue(rawItem);
	if (isGroupByBucket(u)) {
		return formatHorizonAtom(u);
	}
	if (isPlainRecord(u)) {
		const obj = env.selectors.length > 0 ? pickFromObject(u, env.selectors, env.filterThis) : u;
		const keys = getNonVacuousKeys(obj);
		if (keys.length === 0) return null;
		if (keys.length === 1) {
			return formatHorizonAtom(obj[keys[0]!]);
		}
		return formatEllipsizedObject(obj);
	}
	if (env.selectors.length > 0) {
		return null;
	}
	return formatHorizonAtom(u);
}

function emitHorizonLine(
	parts: readonly string[],
	maxDepth: number,
	language: string,
): RenderListResult {
	if (parts.length === 0) {
		return { lines: [], hitHorizon: false };
	}
	const joined = getConjunctionListFormatter(language).format(parts);
	return {
		lines: [formatBulletLine(maxDepth + 1, '- ', joined)],
		hitHorizon: true,
	};
}

/**
 * Renders `keys` of a plain record `obj` as Markdown list items at `depth` (1-based).
 */
export function renderKeyValueEntriesAtDepth(
	obj: Record<string, unknown>,
	keys: readonly string[],
	depth: number,
	env: ListRenderEnv,
	startIndex = 0,
): RenderListResult {
	const maxDepth = env.styles.length;
	if (depth > maxDepth) {
		const parts: string[] = [];
		for (const k of keys) {
			const atom = formatHorizonAtom(obj[k]);
			if (atom !== null) {
				parts.push(`${k}: ${atom}`);
			}
		}
		return emitHorizonLine(parts, maxDepth, env.language);
	}

	const lines: string[] = [];
	let hitHorizon = false;
	let itemIdx = startIndex;

	for (const k of keys) {
		const rawVal = obj[k];
		if (isVacuousSortOrGroupValue(rawVal)) continue;
		const v = unwrapLiquidValue(rawVal);
		const marker = formatMarker(env.styles, depth, itemIdx);
		const scalar = formatTableScalar(v);

		if (scalar !== null) {
			lines.push(formatBulletLine(depth, marker, `${k}: ${scalar}`));
			itemIdx++;
			continue;
		}

		if (isGroupByBucket(v)) {
			const bucketRes = renderGroupBucketAtDepth(v, depth + 1, 0, env, true);
			lines.push(formatBulletLine(depth, marker, k), ...bucketRes.lines);
			if (bucketRes.hitHorizon) hitHorizon = true;
			itemIdx++;
			continue;
		}

		if (isPlainRecord(v)) {
			const childKeys = getNonVacuousKeys(v);
			if (childKeys.length === 0) continue;
			const childRes = renderKeyValueEntriesAtDepth(v, childKeys, depth + 1, env);
			if (childRes.lines.length === 0) continue;
			lines.push(formatBulletLine(depth, marker, k), ...childRes.lines);
			if (childRes.hitHorizon) hitHorizon = true;
			itemIdx++;
			continue;
		}

		if (Array.isArray(v)) {
			const childRes = renderArrayAtDepth(v, depth + 1, env, false);
			if (childRes.lines.length === 0) continue;
			lines.push(formatBulletLine(depth, marker, k), ...childRes.lines);
			if (childRes.hitHorizon) hitHorizon = true;
			itemIdx++;
		}
	}

	return { lines, hitHorizon };
}

function renderObjectItemInArray(
	rawObj: Record<string, unknown>,
	depth: number,
	itemIndex: number,
	env: ListRenderEnv,
	applyLeafSelectors: boolean,
): RenderListResult {
	const obj =
		applyLeafSelectors && env.selectors.length > 0
			? pickFromObject(rawObj, env.selectors, env.filterThis)
			: rawObj;
	const keys = getNonVacuousKeys(obj);
	if (keys.length === 0) {
		return { lines: [], hitHorizon: false };
	}

	const marker = formatMarker(env.styles, depth, itemIndex);
	const firstKey = keys[0]!;
	const firstVal = unwrapLiquidValue(obj[firstKey]);

	if (keys.length === 1) {
		const scalar = formatTableScalar(firstVal);
		if (scalar !== null) {
			return { lines: [formatBulletLine(depth, marker, scalar)], hitHorizon: false };
		}
		if (isGroupByBucket(firstVal)) {
			return renderGroupBucketAtDepth(firstVal, depth, itemIndex, env);
		}
		return renderKeyValueEntriesAtDepth(obj, keys, depth, env, itemIndex);
	}

	let hitHorizon = false;
	const firstScalar = formatTableScalar(firstVal);
	let headline: string;
	if (firstScalar !== null) {
		headline = firstScalar;
	} else {
		headline = `${firstKey}: ${formatHorizonAtom(firstVal) ?? '{...}'}`;
		hitHorizon = true;
	}

	const restRes = renderKeyValueEntriesAtDepth(obj, keys.slice(1), depth + 1, env);
	if (restRes.hitHorizon) hitHorizon = true;
	return {
		lines: [formatBulletLine(depth, marker, headline), ...restRes.lines],
		hitHorizon,
	};
}

/**
 * Renders a `GroupByBucket` subtree as a Markdown list starting at `depth` (1-based).
 */
export function renderGroupBucketAtDepth(
	bucket: GroupByBucket,
	depth: number,
	itemIndex: number,
	env: ListRenderEnv,
	forceHorizonIfBeyond = false,
): RenderListResult {
	const maxDepth = env.styles.length;
	if (forceHorizonIfBeyond && depth > maxDepth) {
		const atom = formatHorizonAtom(bucket);
		return emitHorizonLine(atom !== null ? [atom] : [], maxDepth, env.language);
	}

	const nestedGroups = Array.isArray(bucket.groups) ? bucket.groups : undefined;
	const bucketItems = Array.isArray(bucket.items) ? bucket.items : [];
	let childRes: RenderListResult = { lines: [], hitHorizon: false };

	if (nestedGroups && nestedGroups.length > 0) {
		if (depth >= maxDepth) {
			const parts: string[] = [];
			for (const g of nestedGroups) {
				const atom = formatHorizonAtom(g);
				if (atom !== null) parts.push(atom);
			}
			childRes = emitHorizonLine(parts, maxDepth, env.language);
		} else {
			const childLines: string[] = [];
			let anyHorizon = false;
			let childIdx = 0;
			for (const g of nestedGroups) {
				if (!isGroupByBucket(g)) continue;
				const gRes = renderGroupBucketAtDepth(g, depth + 1, childIdx, env);
				childLines.push(...gRes.lines);
				if (gRes.hitHorizon) anyHorizon = true;
				childIdx++;
			}
			childRes = { lines: childLines, hitHorizon: anyHorizon };
		}
	} else if (bucketItems.length > 0) {
		childRes = renderArrayAtDepth(bucketItems, depth + 1, env, true);
	}

	const badge = childRes.hitHorizon ? `(${bucket.size}+)` : `(${bucket.size})`;
	let headline: string;
	if (isVacuousSortOrGroupValue(bucket.name)) {
		headline = badge;
	} else {
		const uName = unwrapLiquidValue(bucket.name);
		const nameScalar = formatTableScalar(uName);
		if (nameScalar !== null) {
			headline = `${nameScalar} ${badge}`;
		} else {
			headline = `${formatHorizonAtom(uName) ?? '{...}'} ${badge}`;
		}
	}

	const marker = formatMarker(env.styles, depth, itemIndex);
	return {
		lines: [formatBulletLine(depth, marker, headline), ...childRes.lines],
		hitHorizon: childRes.hitHorizon,
	};
}

/**
 * Renders an array of items as a Markdown list starting at `depth` (1-based).
 */
export function renderArrayAtDepth(
	items: readonly unknown[],
	depth: number,
	env: ListRenderEnv,
	applyLeafSelectors: boolean,
): RenderListResult {
	const maxDepth = env.styles.length;
	if (depth > maxDepth) {
		const parts: string[] = [];
		for (const rawItem of items) {
			const formatted = applyLeafSelectors
				? formatLeafItemAtHorizon(rawItem, env)
				: formatHorizonAtom(rawItem);
			if (formatted !== null) {
				parts.push(formatted);
			}
		}
		return emitHorizonLine(parts, maxDepth, env.language);
	}

	const lines: string[] = [];
	let hitHorizon = false;
	let itemIdx = 0;

	for (const rawEl of items) {
		if (isVacuousSortOrGroupValue(rawEl)) continue;
		const el = unwrapLiquidValue(rawEl);

		if (isGroupByBucket(el)) {
			const bucketRes = renderGroupBucketAtDepth(el, depth, itemIdx, env);
			if (bucketRes.lines.length > 0) {
				lines.push(...bucketRes.lines);
				if (bucketRes.hitHorizon) hitHorizon = true;
				itemIdx++;
			}
			continue;
		}

		if (isPlainRecord(el)) {
			const objRes = renderObjectItemInArray(el, depth, itemIdx, env, applyLeafSelectors);
			if (objRes.lines.length > 0) {
				lines.push(...objRes.lines);
				if (objRes.hitHorizon) hitHorizon = true;
				itemIdx++;
			}
			continue;
		}

		if (applyLeafSelectors && env.selectors.length > 0) {
			continue;
		}

		const scalar = formatTableScalar(el);
		if (scalar !== null) {
			const marker = formatMarker(env.styles, depth, itemIdx);
			lines.push(formatBulletLine(depth, marker, scalar));
			itemIdx++;
			continue;
		}

		if (Array.isArray(el)) {
			const nonVacuous = el.filter((sub) => !isVacuousSortOrGroupValue(sub));
			if (nonVacuous.length === 0) continue;
			const marker = formatMarker(env.styles, depth, itemIdx);
			const headAtom = formatHorizonAtom(nonVacuous[0]);
			if (headAtom === null) continue;
			if (
				unwrapLiquidValue(nonVacuous[0]) !== null &&
				formatTableScalar(nonVacuous[0]) === null
			) {
				hitHorizon = true;
			}
			const restRes =
				nonVacuous.length > 1
					? renderArrayAtDepth(nonVacuous.slice(1), depth + 1, env, false)
					: { lines: [], hitHorizon: false };
			if (restRes.hitHorizon) hitHorizon = true;
			lines.push(formatBulletLine(depth, marker, headAtom), ...restRes.lines);
			itemIdx++;
		}
	}

	return { lines, hitHorizon };
}

/**
 * Liquid `list` filter: renders arrays of scalars, plain objects, nested arrays/objects,
 * or `group_by` bucket trees as Markdown unordered (`- `) or ordered (`1. `) lists with
 * configurable per-level markers (`"-"`, `"1."`, `"..."`), optional leaf `pick` selectors,
 * and an automatic `Intl.ListFormat` inline horizon at depth `N + 1`.
 */
export function listFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	...args: unknown[]
): string {
	const unwrapped = unwrapLiquidValue(input);
	if (isVacuousSortOrGroupValue(unwrapped)) {
		return '';
	}

	const { styles, selectors } = parseListArguments(args);
	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const language = readContextLanguage(ctx);
	const env: ListRenderEnv = {
		styles,
		selectors,
		filterThis: this,
		language,
	};

	if (isGroupByBucket(unwrapped)) {
		return renderGroupBucketAtDepth(unwrapped, 1, 0, env).lines.join('\n');
	}

	if (Array.isArray(unwrapped)) {
		return renderArrayAtDepth(unwrapped, 1, env, true).lines.join('\n');
	}

	if (isPlainRecord(unwrapped)) {
		const obj = selectors.length > 0 ? pickFromObject(unwrapped, selectors, this) : unwrapped;
		const keys = getNonVacuousKeys(obj);
		if (keys.length === 0) return '';
		return renderKeyValueEntriesAtDepth(obj, keys, 1, env).lines.join('\n');
	}

	if (selectors.length > 0) {
		return '';
	}

	const scalar = formatTableScalar(unwrapped);
	if (scalar !== null) {
		const marker = formatMarker(styles, 1, 0);
		return formatBulletLine(1, marker, scalar);
	}

	return '';
}
