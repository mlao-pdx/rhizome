import type { GroupByBucket } from './group-by-filter';
import {
	formatHorizonAtom,
	getNonVacuousKeys,
	isGroupByBucket,
	type ListRenderEnv,
	type ListStyleMarker,
	parseListArguments,
	renderArrayAtDepth,
	renderGroupBucketAtDepth,
	renderKeyValueEntriesAtDepth,
} from './list-filter';
import {
	isPlainRecord,
	type LiquidFilterThis,
	type ParsedPathSelector,
	pickFromObject,
	splitTopLevelSelectorList,
	stripOuterQuotes,
} from './selector-evaluator';
import { isVacuousSortOrGroupValue, readContextLanguage } from './sort-group-filters';
import { formatTableScalar } from './table-filter';
import {
	normalizeInitialHeadingLevel,
	readContextHeadingLevel,
	unwrapLiquidValue,
} from './temporal-drop';

export { parseHeadingTagArgs, registerHeadingTag } from './heading-tag';

/**
 * Valid level specifier for `{% heading ... %}` and `| heading`: an integer `1..6`
 * or a single-step relative adjustment (`'promote'` or `'demote'`).
 */
export type HeadingLevelSpec = 1 | 2 | 3 | 4 | 5 | 6 | 'promote' | 'demote';

/**
 * Parsed arguments for the Liquid `heading` filter.
 */
export interface ParsedHeadingArguments {
	readonly levelSpec: HeadingLevelSpec | null;
	readonly styles: readonly ListStyleMarker[];
	readonly selectors: readonly ParsedPathSelector[];
}

/**
 * Minimal structural shape of an Obsidian `HeadingCache` entry for resolving the host
 * note's enclosing heading level above a `rhizome` codeblock.
 */
export interface HostHeadingCacheLike {
	readonly level?: number;
	readonly position?: {
		readonly start?: {
			readonly line?: number;
		};
	};
}

/**
 * Resolves the 1..6 heading level of the last heading in the host note whose 0-based
 * `position.start.line` precedes `lineStart`, or `0` when no heading precedes the codeblock.
 */
export function resolveCodeBlockHeadingLevel(
	headings: readonly HostHeadingCacheLike[] | null | undefined,
	lineStart: number | null | undefined,
): number {
	if (
		!headings ||
		!Array.isArray(headings) ||
		typeof lineStart !== 'number' ||
		!Number.isFinite(lineStart) ||
		lineStart <= 0
	) {
		return 0;
	}
	const list: readonly HostHeadingCacheLike[] = headings;
	let bestLine = -1;
	let bestLevel = 0;
	for (const h of list) {
		const hLine = h.position?.start?.line;
		const hLevel = h.level;
		if (
			typeof hLine === 'number' &&
			Number.isFinite(hLine) &&
			typeof hLevel === 'number' &&
			Number.isFinite(hLevel) &&
			hLine < lineStart &&
			hLine >= bestLine
		) {
			bestLine = hLine;
			bestLevel = normalizeInitialHeadingLevel(hLevel);
		}
	}
	return bestLevel;
}

/**
 * Parses a single value as a `HeadingLevelSpec` (`1..6`, `'promote'`, or `'demote'`),
 * returning `null` if it does not match.
 */
export function parseHeadingLevelSpec(raw: unknown): HeadingLevelSpec | null {
	const u = unwrapLiquidValue(raw);
	if (typeof u === 'number') {
		if (Number.isInteger(u) && u >= 1 && u <= 6) {
			return u as 1 | 2 | 3 | 4 | 5 | 6;
		}
		return null;
	}
	if (typeof u === 'string') {
		const cleaned = stripOuterQuotes(u.trim()).trim();
		if (/^[1-6]$/.test(cleaned)) {
			return Number(cleaned) as 1 | 2 | 3 | 4 | 5 | 6;
		}
		const lower = cleaned.toLowerCase();
		if (lower === 'promote') return 'promote';
		if (lower === 'demote') return 'demote';
	}
	return null;
}

/**
 * Applies a `HeadingLevelSpec` to `currentLevel` without clamping.
 */
export function resolveHeadingLevel(currentLevel: number, spec: HeadingLevelSpec | null): number {
	if (spec === null) return currentLevel;
	if (spec === 'promote') return currentLevel - 1;
	if (spec === 'demote') return currentLevel + 1;
	return spec;
}

/**
 * Clamps a logical heading level to the valid Markdown ATX heading range `1..6`.
 */
export function clampHeadingLevel(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
	if (!Number.isFinite(level)) return 1;
	return Math.max(1, Math.min(6, Math.trunc(level))) as 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Parses variadic arguments for the `heading` filter into an optional one-off `levelSpec`
 * (`1..6`, `'promote'`, `'demote'`) and `list` `styles` + `selectors`.
 */
export function parseHeadingArguments(args: readonly unknown[]): ParsedHeadingArguments {
	if (args.length === 0) {
		const { styles, selectors } = parseListArguments([]);
		return Object.freeze({ levelSpec: null, styles, selectors });
	}

	const firstArg = unwrapLiquidValue(args[0]);
	if (typeof firstArg === 'number') {
		const spec = parseHeadingLevelSpec(firstArg);
		if (spec !== null) {
			const { styles, selectors } = parseListArguments(args.slice(1));
			return Object.freeze({ levelSpec: spec, styles, selectors });
		}
	} else if (typeof firstArg === 'string') {
		const pieces = splitTopLevelSelectorList(firstArg);
		if (pieces.length > 0) {
			const spec = parseHeadingLevelSpec(pieces[0]);
			if (spec !== null) {
				const remaining = [...pieces.slice(1), ...args.slice(1)];
				const { styles, selectors } = parseListArguments(remaining);
				return Object.freeze({ levelSpec: spec, styles, selectors });
			}
		}
	}

	const { styles, selectors } = parseListArguments(args);
	return Object.freeze({ levelSpec: null, styles, selectors });
}

function formatHeadingEntry(level: number, rawText: string): string | null {
	const normalized = rawText.replace(/\r\n|\r|\n/g, ' ').trim();
	if (normalized.length === 0) return null;
	const clamped = clampHeadingLevel(level);
	return `${'#'.repeat(clamped)} ${normalized}`;
}

function renderGroupBucketAsHeading(
	bucket: GroupByBucket,
	level: number,
	env: ListRenderEnv,
	itemIndex = 0,
): string[] {
	if (level > 6) {
		return renderGroupBucketAtDepth(bucket, 1, itemIndex, env).lines;
	}

	let headline: string;
	if (isVacuousSortOrGroupValue(bucket.name)) {
		headline = 'Missing value';
	} else {
		const uName = unwrapLiquidValue(bucket.name);
		headline = formatTableScalar(uName) ?? formatHorizonAtom(uName) ?? '{...}';
	}

	const lines: string[] = [];
	const headerLine = formatHeadingEntry(level, headline);
	if (headerLine !== null) {
		lines.push(headerLine);
	}

	const nestedGroups = Array.isArray(bucket.groups) ? bucket.groups : undefined;
	const bucketItems = Array.isArray(bucket.items) ? bucket.items : [];

	if (nestedGroups && nestedGroups.length > 0) {
		let childIdx = 0;
		for (const g of nestedGroups) {
			if (!isGroupByBucket(g)) continue;
			lines.push(...renderGroupBucketAsHeading(g, level + 1, env, childIdx));
			childIdx++;
		}
	} else if (bucketItems.length > 0) {
		lines.push(...renderArrayAtDepth(bucketItems, 1, env, true).lines);
	}

	return lines;
}

function renderRecordEntriesAsHeading(
	obj: Record<string, unknown>,
	keys: readonly string[],
	level: number,
	env: ListRenderEnv,
): string[] {
	if (level > 6) {
		return renderKeyValueEntriesAtDepth(obj, keys, 1, env).lines;
	}

	const lines: string[] = [];
	for (const k of keys) {
		const rawVal = obj[k];
		if (isVacuousSortOrGroupValue(rawVal)) continue;
		const v = unwrapLiquidValue(rawVal);
		const scalar = formatTableScalar(v);

		if (scalar !== null) {
			const headerLine = formatHeadingEntry(level, k);
			if (headerLine !== null) {
				lines.push(headerLine, scalar.replace(/\r\n|\r/g, '\n'));
			}
			continue;
		}

		if (isGroupByBucket(v)) {
			const headerLine = formatHeadingEntry(level, k);
			if (headerLine !== null) lines.push(headerLine);
			lines.push(...renderGroupBucketAsHeading(v, level + 1, env, 0));
			continue;
		}

		if (isPlainRecord(v)) {
			const childKeys = getNonVacuousKeys(v);
			if (childKeys.length === 0) continue;
			const childLines = renderRecordEntriesAsHeading(v, childKeys, level + 1, env);
			if (childLines.length === 0) continue;
			const headerLine = formatHeadingEntry(level, k);
			if (headerLine !== null) lines.push(headerLine);
			lines.push(...childLines);
			continue;
		}

		if (Array.isArray(v)) {
			const childRes = renderArrayAtDepth(v, 1, env, false);
			if (childRes.lines.length === 0) continue;
			const headerLine = formatHeadingEntry(level, k);
			if (headerLine !== null) lines.push(headerLine);
			lines.push(...childRes.lines);
		}
	}
	return lines;
}

/**
 * Liquid `heading` filter: pure, side-effect-free filter that emits Markdown ATX headings
 * (`#`..`######`) at the current logical heading level (or a one-off `1..6`, `'promote'`,
 * or `'demote'` override), rendering `group_by` bucket trees as nested headings that
 * automatically transition to `list` past `H6`.
 */
export function headingFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	...args: unknown[]
): string {
	const unwrapped = unwrapLiquidValue(input);
	if (isVacuousSortOrGroupValue(unwrapped)) {
		return '';
	}

	const { levelSpec, styles, selectors } = parseHeadingArguments(args);
	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const language = readContextLanguage(ctx);
	const ambientLevel = readContextHeadingLevel(ctx);
	const resolvedLevel = resolveHeadingLevel(ambientLevel, levelSpec);
	const clampedLevel = clampHeadingLevel(resolvedLevel);
	const startBucketLevel = Math.max(1, Math.trunc(resolvedLevel));

	const env: ListRenderEnv = {
		styles,
		selectors,
		filterThis: this,
		language,
	};

	let lines: string[] = [];

	if (isGroupByBucket(unwrapped)) {
		lines = renderGroupBucketAsHeading(unwrapped, startBucketLevel, env, 0);
	} else if (Array.isArray(unwrapped)) {
		let bucketIdx = 0;
		for (const rawEl of unwrapped) {
			if (isVacuousSortOrGroupValue(rawEl)) continue;
			const el = unwrapLiquidValue(rawEl);

			if (isGroupByBucket(el)) {
				lines.push(...renderGroupBucketAsHeading(el, startBucketLevel, env, bucketIdx));
				bucketIdx++;
				continue;
			}

			if (isPlainRecord(el)) {
				const obj = selectors.length > 0 ? pickFromObject(el, selectors, this) : el;
				const keys = getNonVacuousKeys(obj);
				if (keys.length === 0) continue;
				const firstKey = keys[0]!;
				const firstVal = unwrapLiquidValue(obj[firstKey]);

				if (keys.length === 1) {
					const scalar = formatTableScalar(firstVal);
					if (scalar !== null) {
						const hLine = formatHeadingEntry(clampedLevel, scalar);
						if (hLine !== null) lines.push(hLine);
					} else if (isGroupByBucket(firstVal)) {
						lines.push(
							...renderGroupBucketAsHeading(
								firstVal,
								startBucketLevel,
								env,
								bucketIdx,
							),
						);
						bucketIdx++;
					} else {
						lines.push(...renderRecordEntriesAsHeading(obj, keys, clampedLevel, env));
					}
					continue;
				}

				const firstScalar = formatTableScalar(firstVal);
				if (firstScalar !== null) {
					const hLine = formatHeadingEntry(clampedLevel, firstScalar);
					if (hLine !== null) lines.push(hLine);
					lines.push(
						...renderRecordEntriesAsHeading(obj, keys.slice(1), clampedLevel + 1, env),
					);
				} else {
					lines.push(...renderRecordEntriesAsHeading(obj, keys, clampedLevel, env));
				}
				continue;
			}

			if (selectors.length > 0) continue;

			const scalar = formatTableScalar(el);
			if (scalar !== null) {
				const hLine = formatHeadingEntry(clampedLevel, scalar);
				if (hLine !== null) lines.push(hLine);
				continue;
			}

			if (Array.isArray(el)) {
				const nonVacuous = el.filter((sub) => !isVacuousSortOrGroupValue(sub));
				if (nonVacuous.length === 0) continue;
				const headAtom = formatHorizonAtom(nonVacuous[0]);
				if (headAtom === null) continue;
				const hLine = formatHeadingEntry(clampedLevel, headAtom);
				if (hLine !== null) lines.push(hLine);
				if (nonVacuous.length > 1) {
					lines.push(...renderArrayAtDepth(nonVacuous.slice(1), 1, env, false).lines);
				}
			}
		}
	} else if (isPlainRecord(unwrapped)) {
		const obj = selectors.length > 0 ? pickFromObject(unwrapped, selectors, this) : unwrapped;
		const keys = getNonVacuousKeys(obj);
		if (keys.length === 0) return '';
		lines = renderRecordEntriesAsHeading(obj, keys, clampedLevel, env);
	} else {
		if (selectors.length > 0) return '';
		const scalar = formatTableScalar(unwrapped);
		if (scalar !== null) {
			const hLine = formatHeadingEntry(clampedLevel, scalar);
			if (hLine !== null) lines = [hLine];
		}
	}

	return lines.length > 0 ? `\n${lines.join('\n')}\n` : '';
}
