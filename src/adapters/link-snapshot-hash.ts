import type { CachedMetadata } from 'obsidian';
import { formatHex64, XxHash64Accumulator } from '@core/hash/xxhash64';

export interface CachedLinkSnapshot {
	readonly resolved: Readonly<Record<string, number>> | null;
	readonly unresolved: Readonly<Record<string, number>> | null;
	readonly signature: string;
}

export const NO_LINKS_SNAPSHOT: CachedLinkSnapshot = Object.freeze({
	resolved: null,
	unresolved: null,
	signature: '0',
});

const sharedEntryAcc = new XxHash64Accumulator();
const sharedFinalAcc = new XxHash64Accumulator();

export function hasAnyLinks(cache: CachedMetadata | null | undefined): boolean {
	return (
		(cache?.links?.length ?? 0) > 0 ||
		(cache?.embeds?.length ?? 0) > 0 ||
		(cache?.frontmatterLinks?.length ?? 0) > 0
	);
}

export function shallowNumberRecordsEqual(
	a: Readonly<Record<string, number>> | null,
	b: Readonly<Record<string, number>> | null,
): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	let aCount = 0;
	for (const k in a) {
		if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
		aCount++;
		if (b[k] !== a[k] || (a[k] === undefined && !Object.prototype.hasOwnProperty.call(b, k))) {
			return false;
		}
	}
	let bCount = 0;
	for (const k in b) {
		if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
		bCount++;
	}
	return aCount === bCount;
}

/**
 * Computes an order-independent 64-bit hex signature over `(targetPath, count)` pairs
 * in `resolved` and `unresolved` without allocating `Object.keys()` arrays or sorting.
 */
export function hashLinkRecordsOrderIndependent(
	resolved: Readonly<Record<string, number>> | null,
	unresolved: Readonly<Record<string, number>> | null,
): string {
	let resolvedCount = 0;
	let resSumHi = 0;
	let resSumLo = 0;
	let resXorHi = 0;
	let resXorLo = 0;

	if (resolved !== null) {
		for (const target in resolved) {
			if (!Object.prototype.hasOwnProperty.call(resolved, target)) continue;
			const count = resolved[target];
			sharedEntryAcc.reset();
			sharedEntryAcc.updateTag(0x61, 1);
			sharedEntryAcc.updateString(target);
			if (typeof count === 'number') {
				sharedEntryAcc.updateNumber(count);
			} else {
				sharedEntryAcc.updateU32(0x11000000);
			}
			const hi = sharedEntryAcc.digestHi();
			const lo = sharedEntryAcc.digestLo();
			resSumHi = (resSumHi + hi) | 0;
			resSumLo = (resSumLo + lo) | 0;
			resXorHi ^= hi;
			resXorLo ^= lo;
			resolvedCount++;
		}
	}

	let unresolvedCount = 0;
	let unresSumHi = 0;
	let unresSumLo = 0;
	let unresXorHi = 0;
	let unresXorLo = 0;

	if (unresolved !== null) {
		for (const target in unresolved) {
			if (!Object.prototype.hasOwnProperty.call(unresolved, target)) continue;
			const count = unresolved[target];
			sharedEntryAcc.reset();
			sharedEntryAcc.updateTag(0x62, 2);
			sharedEntryAcc.updateString(target);
			if (typeof count === 'number') {
				sharedEntryAcc.updateNumber(count);
			} else {
				sharedEntryAcc.updateU32(0x11000000);
			}
			const hi = sharedEntryAcc.digestHi();
			const lo = sharedEntryAcc.digestLo();
			unresSumHi = (unresSumHi + hi) | 0;
			unresSumLo = (unresSumLo + lo) | 0;
			unresXorHi ^= hi;
			unresXorLo ^= lo;
			unresolvedCount++;
		}
	}

	sharedFinalAcc.reset();
	sharedFinalAcc.updateU32(resolved === null ? 0 : 1);
	sharedFinalAcc.updateU32(resolvedCount);
	sharedFinalAcc.updateU32(resSumHi);
	sharedFinalAcc.updateU32(resSumLo);
	sharedFinalAcc.updateU32(resXorHi);
	sharedFinalAcc.updateU32(resXorLo);
	sharedFinalAcc.updateU32(unresolved === null ? 0 : 1);
	sharedFinalAcc.updateU32(unresolvedCount);
	sharedFinalAcc.updateU32(unresSumHi);
	sharedFinalAcc.updateU32(unresSumLo);
	sharedFinalAcc.updateU32(unresXorHi);
	sharedFinalAcc.updateU32(unresXorLo);

	return formatHex64(sharedFinalAcc.digestHi(), sharedFinalAcc.digestLo());
}

export function computeLinkSnapshotFromCache(
	metadataCache: {
		resolvedLinks?: Record<string, Record<string, number>>;
		unresolvedLinks?: Record<string, Record<string, number>>;
	},
	path: string,
	cache: CachedMetadata | null | undefined,
	prev: CachedLinkSnapshot | undefined,
	forceHasLinks = false,
): CachedLinkSnapshot {
	if (!forceHasLinks && !hasAnyLinks(cache)) {
		return NO_LINKS_SNAPSHOT;
	}
	const rawResolved = metadataCache.resolvedLinks?.[path] ?? null;
	const rawUnresolved = metadataCache.unresolvedLinks?.[path] ?? null;
	if (
		prev !== undefined &&
		prev !== NO_LINKS_SNAPSHOT &&
		shallowNumberRecordsEqual(rawResolved, prev.resolved) &&
		shallowNumberRecordsEqual(rawUnresolved, prev.unresolved)
	) {
		return prev;
	}
	const signature = hashLinkRecordsOrderIndependent(rawResolved, rawUnresolved);
	return {
		resolved: rawResolved ? { ...rawResolved } : null,
		unresolved: rawUnresolved ? { ...rawUnresolved } : null,
		signature,
	};
}
