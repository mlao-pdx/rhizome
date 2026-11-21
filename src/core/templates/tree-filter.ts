import { FORBIDDEN_KEYS } from '@core/search';
import { checkFilterRenderLimit, FILTER_LIMIT_CHECK_STRIDE } from './render-limits';
import {
	evaluateSelectorOnItem,
	isPlainRecord,
	type LiquidFilterThis,
	type ParsedPathSelector,
	parseSingleSelectorString,
} from './selector-evaluator';
import { canonicalRhizomeValueKey, isVacuousSortOrGroupValue } from './sort-group-filters';
import { readContextTemporalMeta, unwrapLiquidValue } from './temporal-drop';

/** Maximum hierarchy nesting depth expanded by `tree` before truncating deeper branches. */
export const MAX_TREE_DEPTH = 64;

/** Maximum total `TreeNode` instances materialized by a single `tree` filter call. */
export const MAX_TREE_NODES = 10_000;

/**
 * Hierarchical node produced by the Liquid `tree` filter and natively rendered by `list`.
 */
export interface TreeNode {
	readonly item: unknown;
	readonly children: readonly TreeNode[];
	readonly depth: number;
	readonly size: number;
}

const TREE_NODE_KEYS: ReadonlySet<string> = new Set(['item', 'children', 'depth', 'size']);

/**
 * Structural type guard for `TreeNode` objects produced by `tree`.
 */
export function isTreeNode(val: unknown): val is TreeNode {
	const u = unwrapLiquidValue(val);
	if (!isPlainRecord(u)) {
		return false;
	}
	const ownKeys = Object.keys(u).filter((k) => !FORBIDDEN_KEYS.has(k));
	if (ownKeys.length !== 4) {
		return false;
	}
	for (const k of ownKeys) {
		if (!TREE_NODE_KEYS.has(k)) {
			return false;
		}
	}
	if (
		!Object.prototype.hasOwnProperty.call(u, 'item') ||
		!Object.prototype.hasOwnProperty.call(u, 'children') ||
		!Object.prototype.hasOwnProperty.call(u, 'depth') ||
		!Object.prototype.hasOwnProperty.call(u, 'size')
	) {
		return false;
	}
	const children = unwrapLiquidValue(u.children);
	const depth = unwrapLiquidValue(u.depth);
	const size = unwrapLiquidValue(u.size);
	return (
		Array.isArray(children) &&
		typeof depth === 'number' &&
		Number.isInteger(depth) &&
		depth >= 0 &&
		typeof size === 'number' &&
		Number.isFinite(size) &&
		size >= 0
	);
}

function resolveTreeSelector(raw: unknown): ParsedPathSelector | null {
	const u = unwrapLiquidValue(raw);
	if (typeof u !== 'string') return null;
	const trimmed = u.trim();
	if (trimmed.length === 0) return null;
	return parseSingleSelectorString(trimmed);
}

function evalTreeSelector(
	item: unknown,
	selector: ParsedPathSelector,
	filterThis: LiquidFilterThis | void,
): unknown {
	if (!selector.isNullLiteral && selector.segments.length === 0 && selector.filterRaw === null) {
		return unwrapLiquidValue(item);
	}
	return evaluateSelectorOnItem(item, selector, filterThis);
}

/**
 * Liquid `tree` filter:
 * `items | tree: parentSelector[, roots][, idSelector = "file.path"]`
 *
 * Reconstructs nested `{ item, children, depth, size }` `TreeNode` hierarchies from a flat
 * item collection in `O(N)` adjacency time:
 * - Multi-parent DAG items appear under each resolved parent with per-branch ancestor cycle detection.
 * - When `roots` is omitted, items with no resolved non-self parent in `items` become top-level
 *   roots in input order, and disconnected / pure cycles break deterministically at the first
 *   unvisited item in input order.
 * - Enforces `MAX_TREE_DEPTH = 64` and `MAX_TREE_NODES = 10,000`.
 */
export function treeFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	parentSelectorArg?: unknown,
	...restArgs: unknown[]
): TreeNode[] {
	const unwrapped = unwrapLiquidValue(input);
	if (!Array.isArray(unwrapped) || unwrapped.length === 0) {
		return [];
	}

	const parentSelector = resolveTreeSelector(parentSelectorArg);
	if (!parentSelector) {
		return [];
	}

	const hasExplicitRootsArg = restArgs.length >= 1 && restArgs[0] !== undefined;
	const rootsArg = restArgs[0];
	const idSelectorRaw =
		restArgs.length >= 2 && restArgs[1] !== undefined && restArgs[1] !== null
			? restArgs[1]
			: 'file.path';
	const idSelector = resolveTreeSelector(idSelectorRaw);
	if (!idSelector) {
		return [];
	}

	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);

	const items: unknown[] = [];
	for (let i = 0; i < unwrapped.length; i++) {
		if ((i & (FILTER_LIMIT_CHECK_STRIDE - 1)) === 0) {
			checkFilterRenderLimit(this);
		}
		const item = unwrapLiquidValue(unwrapped[i]);
		if (!isVacuousSortOrGroupValue(item)) {
			items.push(item);
		}
	}
	if (items.length === 0) {
		return [];
	}

	// Map canonical ID -> item indices (preserving input order if duplicate IDs exist)
	const indicesById = new Map<string, number[]>();
	const itemIdKeys: Array<string | null> = new Array<string | null>(items.length).fill(null);

	for (let i = 0; i < items.length; i++) {
		if ((i & (FILTER_LIMIT_CHECK_STRIDE - 1)) === 0) {
			checkFilterRenderLimit(this);
		}
		const idVal = evalTreeSelector(items[i], idSelector, this);
		if (isVacuousSortOrGroupValue(idVal) || Array.isArray(idVal)) {
			continue;
		}
		const key = canonicalRhizomeValueKey(idVal, timeZone, referenceTimeMs);
		itemIdKeys[i] = key;
		let list = indicesById.get(key);
		if (!list) {
			list = [];
			indicesById.set(key, list);
		}
		list.push(i);
	}

	// Build parent -> child index adjacency and detect natural roots
	const childrenByParentKey = new Map<string, number[]>();
	const hasResolvedNonSelfParent = new Uint8Array(items.length);

	for (let i = 0; i < items.length; i++) {
		if ((i & (FILTER_LIMIT_CHECK_STRIDE - 1)) === 0) {
			checkFilterRenderLimit(this);
		}
		const pVal = evalTreeSelector(items[i], parentSelector, this);
		if (isVacuousSortOrGroupValue(pVal)) {
			continue;
		}
		const rawParents: readonly unknown[] = Array.isArray(pVal) ? pVal : [pVal];
		const seenParentsForItem = new Set<string>();
		const selfKey = itemIdKeys[i];

		for (let j = 0; j < rawParents.length; j++) {
			const sub = rawParents[j];
			if (isVacuousSortOrGroupValue(sub)) continue;
			const pKey = canonicalRhizomeValueKey(sub, timeZone, referenceTimeMs);
			if (seenParentsForItem.has(pKey)) continue;
			seenParentsForItem.add(pKey);

			if (pKey === selfKey) {
				continue;
			}
			if (indicesById.has(pKey)) {
				hasResolvedNonSelfParent[i] = 1;
			}
			let children = childrenByParentKey.get(pKey);
			if (!children) {
				children = [];
				childrenByParentKey.set(pKey, children);
			}
			children.push(i);
		}
	}

	let totalNodesEmitted = 0;
	let stepCounter = 0;
	const visitedAny = new Uint8Array(items.length);

	const buildNode = (idx: number, depth: number, branchAncestors: Set<number>): TreeNode => {
		if ((++stepCounter & (FILTER_LIMIT_CHECK_STRIDE - 1)) === 0) {
			checkFilterRenderLimit(this);
		}
		if (++totalNodesEmitted > MAX_TREE_NODES) {
			throw new Error(
				`Template tree exceeded maximum limit of ${MAX_TREE_NODES.toLocaleString('en-US')} nodes. Narrow your query or limit the input items.`,
			);
		}

		visitedAny[idx] = 1;
		const item = items[idx]!;
		const idKey = itemIdKeys[idx] ?? null;
		const childNodes: TreeNode[] = [];
		let descendantCount = 0;

		if (idKey !== null && depth < MAX_TREE_DEPTH) {
			const childIndices = childrenByParentKey.get(idKey);
			if (childIndices && childIndices.length > 0) {
				branchAncestors.add(idx);
				for (let c = 0; c < childIndices.length; c++) {
					const childIdx = childIndices[c]!;
					if (branchAncestors.has(childIdx)) {
						continue;
					}
					const childNode = buildNode(childIdx, depth + 1, branchAncestors);
					childNodes.push(childNode);
					descendantCount += 1 + childNode.size;
				}
				branchAncestors.delete(idx);
			}
		}

		return {
			item,
			children: childNodes,
			depth,
			size: descendantCount,
		};
	};

	if (hasExplicitRootsArg) {
		const uRoots = unwrapLiquidValue(rootsArg);
		if (isVacuousSortOrGroupValue(uRoots)) {
			return [];
		}
		const rootCandidates = Array.isArray(uRoots) ? uRoots : [uRoots];
		const rootIndices: number[] = [];
		const seenRootIdx = new Set<number>();

		for (let r = 0; r < rootCandidates.length; r++) {
			const rc = unwrapLiquidValue(rootCandidates[r]);
			if (isVacuousSortOrGroupValue(rc)) continue;
			const idVal = isPlainRecord(rc) ? evalTreeSelector(rc, idSelector, this) : rc;
			if (isVacuousSortOrGroupValue(idVal) || Array.isArray(idVal)) continue;
			const rKey = canonicalRhizomeValueKey(idVal, timeZone, referenceTimeMs);

			const matchedInItems = indicesById.get(rKey);
			if (matchedInItems && matchedInItems.length > 0) {
				for (let m = 0; m < matchedInItems.length; m++) {
					const idx = matchedInItems[m]!;
					if (!seenRootIdx.has(idx)) {
						seenRootIdx.add(idx);
						rootIndices.push(idx);
					}
				}
			} else {
				// Anchor is external to `items` (e.g. `this` host note for `[up ->* @this]`):
				// promote its direct children in `items` as top-level roots.
				const directChildren = childrenByParentKey.get(rKey);
				if (directChildren) {
					for (let c = 0; c < directChildren.length; c++) {
						const idx = directChildren[c]!;
						if (!seenRootIdx.has(idx)) {
							seenRootIdx.add(idx);
							rootIndices.push(idx);
						}
					}
				}
			}
		}

		const result: TreeNode[] = [];
		for (let i = 0; i < rootIndices.length; i++) {
			result.push(buildNode(rootIndices[i]!, 0, new Set<number>()));
		}
		return result;
	}

	const result: TreeNode[] = [];
	for (let i = 0; i < items.length; i++) {
		if (hasResolvedNonSelfParent[i] === 0) {
			result.push(buildNode(i, 0, new Set<number>()));
		}
	}

	// Deterministically break pure or disconnected cycles at the first unvisited item in input order.
	for (let i = 0; i < items.length; i++) {
		if (visitedAny[i] === 0) {
			result.push(buildNode(i, 0, new Set<number>()));
		}
	}

	return result;
}
