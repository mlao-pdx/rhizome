import { XxHash64Accumulator } from '../hash/xxhash64';

/** Per-source destination maps, shaped like `MetadataCache.resolvedLinks`. */
export type ResolvedLinksBySource = Readonly<
	Record<string, Readonly<Record<string, number>> | undefined>
>;

/** Target path → source path → link count. */
export type TargetSources = Map<string, Map<string, number>>;

function finiteCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Hashes one target's source mix (`{ path, count }` pairs) into a 32-bit value.
 *
 * @remarks
 * (design, 2026-11-18) Backlink visibility depends only on a target's source mix, not on which
 * source happened to change. Hashing sorted source paths and counts gives a stable per-target
 * fingerprint, which the rolling multiset hash can subtract and re-add in O(1) per affected
 * target instead of rebuilding the whole inverse index.
 */
export function hashTargetSources(
	sources: Readonly<Record<string, number>>,
	ignoredSources?: ReadonlySet<string>,
): number {
	const acc = new XxHash64Accumulator();
	const paths = Object.keys(sources)
		.filter((path) => !ignoredSources?.has(path))
		.sort();
	acc.updateTag(0x60, paths.length);
	for (const path of paths) {
		const count = finiteCount(sources[path]);
		if (count === undefined) continue;
		acc.updateString(path);
		acc.updateNumber(count);
	}
	return acc.digest().hi >>> 0;
}

/**
 * Builds the path-keyed inverse index (`target → sources`) used by the delta helpers.
 */
export function buildTargetSources(
	links: ResolvedLinksBySource,
	ignoredSources?: ReadonlySet<string>,
): TargetSources {
	const result: TargetSources = new Map();
	for (const sourcePath of Object.keys(links)) {
		if (ignoredSources?.has(sourcePath)) continue;
		const destinations = links[sourcePath];
		if (!destinations || typeof destinations !== 'object') continue;
		for (const targetPath of Object.keys(destinations)) {
			const count = finiteCount(destinations[targetPath]);
			if (count === undefined) continue;
			let sources = result.get(targetPath);
			if (!sources) {
				sources = new Map();
				result.set(targetPath, sources);
			}
			sources.set(sourcePath, count);
		}
	}
	return result;
}

/** Computes a 32-bit canonical hash for every target in a path-keyed inverse index. */
export function hashTargetMap(targetSources: TargetSources): Map<string, number> {
	const hashes = new Map<string, number>();
	for (const [target, sources] of targetSources) {
		const record = Object.create(null) as Record<string, number>;
		for (const [source, count] of sources) {
			record[source] = count;
		}
		hashes.set(target, hashTargetSources(record));
	}
	return hashes;
}

/**
 * Additive multiset hash over per-target hashes (sum modulo 2³²).
 *
 * @remarks
 * (design, 2026-11-18) A backlink delta touches only a handful of targets. Summing target hashes
 * lets the adapter ask "did anything visible change?" in O(1) after subtracting and re-adding the
 * affected entries, and the sum is order-independent so the same target set always yields the
 * same digest.
 */
export class RollingMultisetHash {
	private sum = 0;

	/** Adds a target hash to the multiset. */
	add(hash: number): void {
		this.sum = (this.sum + (hash >>> 0)) >>> 0;
	}

	/** Removes a target hash from the multiset. */
	remove(hash: number): void {
		this.sum = (this.sum - (hash >>> 0)) >>> 0;
	}

	/** Current sum modulo 2³². */
	digest(): number {
		return this.sum >>> 0;
	}
}

function recordsEqual(
	a: Readonly<Record<string, number>> | undefined,
	b: Readonly<Record<string, number>> | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (finiteCount(a[key]) !== finiteCount(b[key])) return false;
	}
	return true;
}

/**
 * Returns every target path whose projected backlinks may differ between `oldLinks` and
 * `newLinks`, plus targets of sources whose ignored status changed.
 *
 * @remarks
 * (design, 2026-11-18) Targets are affected, not sources: moving a link from A to B changes A's
 * and B's backlink lists while the linking note's own document is untouched. Ignored-status
 * changes are passed explicitly because a source can gain or lose the `DO_NOT_INDEX_OR_QUERY`
 * flag without its `resolvedLinks` entry changing.
 */
export function diffSources(
	oldLinks: ResolvedLinksBySource,
	newLinks: ResolvedLinksBySource,
	ignoredChanges: Iterable<string> = [],
): Set<string> {
	const affected = new Set<string>();
	const sources = new Set<string>([...Object.keys(oldLinks), ...Object.keys(newLinks)]);

	for (const source of sources) {
		const oldDest = oldLinks[source];
		const newDest = newLinks[source];
		if (recordsEqual(oldDest, newDest)) continue;
		if (oldDest) {
			for (const target of Object.keys(oldDest)) {
				affected.add(target);
			}
		}
		if (newDest) {
			for (const target of Object.keys(newDest)) {
				affected.add(target);
			}
		}
	}

	for (const source of ignoredChanges) {
		const oldDest = oldLinks[source];
		const newDest = newLinks[source];
		if (oldDest) {
			for (const target of Object.keys(oldDest)) {
				affected.add(target);
			}
		}
		if (newDest) {
			for (const target of Object.keys(newDest)) {
				affected.add(target);
			}
		}
	}

	return affected;
}
