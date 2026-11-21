import { FORBIDDEN_KEYS } from '@core/search';
import { checkFilterRenderLimit, FILTER_LIMIT_CHECK_STRIDE } from './render-limits';
import {
	evaluateSelectorOnItem,
	hasExplicitTrailingAsClause,
	isPlainRecord,
	type LiquidFilterThis,
	type ParsedPathSelector,
	parseSingleSelectorString,
	shallowClonePlainRecord,
	stripOuterQuotes,
} from './selector-evaluator';
import { canonicalRhizomeValueKey, isVacuousSortOrGroupValue } from './sort-group-filters';
import { readContextTemporalMeta, unwrapLiquidValue } from './temporal-drop';

function extractLinksFromCandidate(candidate: unknown, out: Record<string, unknown>[]): void {
	const u = unwrapLiquidValue(candidate);
	if (!isPlainRecord(u)) {
		return;
	}
	if (Array.isArray(u.links)) {
		for (let i = 0; i < u.links.length; i++) {
			const linkEl = unwrapLiquidValue(u.links[i]);
			if (isPlainRecord(linkEl)) {
				out.push(linkEl);
			}
		}
		return;
	}
	if ('resolvedPath' in u) {
		out.push(u);
	}
}

/**
 * Liquid `link_paths` filter: `note | link_paths` or `note.links | link_paths[: "up"]`.
 * Extracts deduplicated non-null `resolvedPath` strings in first-seen order from a note match,
 * an array of `NormalizedLink` records, or an array of note matches, optionally filtered
 * case-insensitively by `link.property`.
 */
export function linkPathsFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	propertyArg?: unknown,
): string[] {
	const unwrapped = unwrapLiquidValue(input);
	if (unwrapped === null || unwrapped === undefined) {
		return [];
	}

	let targetPropLower: string | null = null;
	if (propertyArg !== undefined && propertyArg !== null) {
		const uProp = unwrapLiquidValue(propertyArg);
		if (typeof uProp !== 'string') {
			return [];
		}
		const cleaned = stripOuterQuotes(uProp).trim().toLowerCase();
		if (cleaned.length === 0) {
			return [];
		}
		targetPropLower = cleaned;
	}

	const linkRecords: Record<string, unknown>[] = [];
	if (Array.isArray(unwrapped)) {
		for (let i = 0; i < unwrapped.length; i++) {
			if ((i & (FILTER_LIMIT_CHECK_STRIDE - 1)) === 0) {
				checkFilterRenderLimit(this);
			}
			extractLinksFromCandidate(unwrapped[i], linkRecords);
		}
	} else {
		extractLinksFromCandidate(unwrapped, linkRecords);
	}

	if (linkRecords.length === 0) {
		return [];
	}

	const seen = new Set<string>();
	const paths: string[] = [];
	for (let i = 0; i < linkRecords.length; i++) {
		if ((i & (FILTER_LIMIT_CHECK_STRIDE - 1)) === 0) {
			checkFilterRenderLimit(this);
		}
		const rec = linkRecords[i]!;
		const resolvedPath = unwrapLiquidValue(rec.resolvedPath);
		if (typeof resolvedPath !== 'string' || resolvedPath.length === 0) {
			continue;
		}
		if (targetPropLower !== null) {
			const linkProp = unwrapLiquidValue(rec.property);
			if (typeof linkProp !== 'string' || linkProp.trim().toLowerCase() !== targetPropLower) {
				continue;
			}
		}
		if (!seen.has(resolvedPath)) {
			seen.add(resolvedPath);
			paths.push(resolvedPath);
		}
	}

	return paths;
}

function parseLookupSelector(raw: unknown): {
	readonly selector: ParsedPathSelector;
	readonly hasAsTarget: boolean;
} | null {
	const u = unwrapLiquidValue(raw);
	if (typeof u !== 'string') {
		return null;
	}
	const trimmed = u.trim();
	if (trimmed.length === 0) {
		return null;
	}
	const parsed = parseSingleSelectorString(trimmed);
	if (!parsed) {
		return null;
	}
	return {
		selector: parsed,
		hasAsTarget: hasExplicitTrailingAsClause(trimmed),
	};
}

function evalGraphSelector(
	item: unknown,
	selector: ParsedPathSelector,
	filterThis: LiquidFilterThis | void,
): unknown {
	if (!selector.isNullLiteral && selector.segments.length === 0 && selector.filterRaw === null) {
		return unwrapLiquidValue(item);
	}
	return evaluateSelectorOnItem(item, selector, filterThis);
}

function assignAtSegments(
	rootObj: Record<string, unknown>,
	segments: readonly string[],
	value: unknown,
): Record<string, unknown> {
	const clone = shallowClonePlainRecord(rootObj);
	let cursor = clone;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i]!;
		if (FORBIDDEN_KEYS.has(seg)) {
			return clone;
		}
		const existing = unwrapLiquidValue(cursor[seg]);
		const nextObj = isPlainRecord(existing) ? shallowClonePlainRecord(existing) : {};
		cursor[seg] = nextObj;
		cursor = nextObj;
	}
	const leaf = segments[segments.length - 1]!;
	if (!FORBIDDEN_KEYS.has(leaf)) {
		cursor[leaf] = value;
	}
	return clone;
}

/**
 * Liquid `lookup` filter:
 * `items | lookup: otherArray, localSelector[, foreignSelector = "file.path"]`
 *
 * Builds an `O(N)` index over `otherArray` keyed by `foreignSelector` (using
 * `canonicalRhizomeValueKey`). When `localSelector` (or `foreignSelector`) includes an
 * `as <target.path>` clause, clones each input record and attaches the resolved match(es)
 * at `<target.path>`; otherwise projects the resolved match(es) directly, preserving the
 * scalar vs array shape of `localSelector`.
 */
export function lookupFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	otherArrayArg?: unknown,
	localSelectorArg?: unknown,
	foreignSelectorArg?: unknown,
): unknown {
	const unwrappedInput = unwrapLiquidValue(input);
	const isSingleRecordInput = !Array.isArray(unwrappedInput) && isPlainRecord(unwrappedInput);
	if (!Array.isArray(unwrappedInput) && !isSingleRecordInput) {
		return [];
	}

	const localParsed = parseLookupSelector(localSelectorArg);
	if (!localParsed) {
		return isSingleRecordInput ? null : [];
	}

	const effectiveForeignRaw =
		foreignSelectorArg === undefined || foreignSelectorArg === null
			? 'file.path'
			: foreignSelectorArg;
	const foreignParsed = parseLookupSelector(effectiveForeignRaw);
	if (!foreignParsed) {
		return isSingleRecordInput ? null : [];
	}

	const targetSegments = localParsed.hasAsTarget
		? localParsed.selector.outputSegments
		: foreignParsed.hasAsTarget
			? foreignParsed.selector.outputSegments
			: null;

	const uOther = unwrapLiquidValue(otherArrayArg);
	const otherItems: readonly unknown[] = Array.isArray(uOther)
		? uOther
		: isPlainRecord(uOther)
			? [uOther]
			: [];

	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);

	const foreignIndex = new Map<string, unknown[]>();
	for (let i = 0; i < otherItems.length; i++) {
		if ((i & (FILTER_LIMIT_CHECK_STRIDE - 1)) === 0) {
			checkFilterRenderLimit(this);
		}
		const foreignItem = unwrapLiquidValue(otherItems[i]);
		if (foreignItem === null || foreignItem === undefined) {
			continue;
		}
		const fVal = evalGraphSelector(foreignItem, foreignParsed.selector, this);
		if (isVacuousSortOrGroupValue(fVal)) {
			continue;
		}
		if (Array.isArray(fVal)) {
			const fList: readonly unknown[] = fVal;
			for (let j = 0; j < fList.length; j++) {
				const sub = fList[j];
				if (isVacuousSortOrGroupValue(sub)) continue;
				const k = canonicalRhizomeValueKey(sub, timeZone, referenceTimeMs);
				let bucket = foreignIndex.get(k);
				if (!bucket) {
					bucket = [];
					foreignIndex.set(k, bucket);
				}
				bucket.push(foreignItem);
			}
		} else {
			const k = canonicalRhizomeValueKey(fVal, timeZone, referenceTimeMs);
			let bucket = foreignIndex.get(k);
			if (!bucket) {
				bucket = [];
				foreignIndex.set(k, bucket);
			}
			bucket.push(foreignItem);
		}
	}

	const resolveForItem = (rawItem: unknown): unknown => {
		const item = unwrapLiquidValue(rawItem);
		const lVal = evalGraphSelector(item, localParsed.selector, this);
		let resolved: unknown;
		if (Array.isArray(lVal)) {
			const lList: readonly unknown[] = lVal;
			const matched: unknown[] = [];
			const seen = new Set<unknown>();
			for (let j = 0; j < lList.length; j++) {
				const sub = lList[j];
				if (isVacuousSortOrGroupValue(sub)) continue;
				const k = canonicalRhizomeValueKey(sub, timeZone, referenceTimeMs);
				const bucket = foreignIndex.get(k);
				if (!bucket) continue;
				for (let b = 0; b < bucket.length; b++) {
					const cand = bucket[b]!;
					if (!seen.has(cand)) {
						seen.add(cand);
						matched.push(cand);
					}
				}
			}
			resolved = matched;
		} else if (isVacuousSortOrGroupValue(lVal)) {
			resolved = null;
		} else {
			const k = canonicalRhizomeValueKey(lVal, timeZone, referenceTimeMs);
			const bucket = foreignIndex.get(k);
			resolved = bucket && bucket.length > 0 ? bucket[0]! : null;
		}

		if (targetSegments !== null) {
			if (isPlainRecord(item)) {
				return assignAtSegments(item, targetSegments, resolved);
			}
			return item;
		}
		return resolved;
	};

	if (isSingleRecordInput) {
		return resolveForItem(unwrappedInput);
	}

	const items = unwrappedInput as readonly unknown[];
	const out: unknown[] = new Array(items.length);
	for (let i = 0; i < items.length; i++) {
		if ((i & (FILTER_LIMIT_CHECK_STRIDE - 1)) === 0) {
			checkFilterRenderLimit(this);
		}
		out[i] = resolveForItem(items[i]);
	}
	return out;
}
