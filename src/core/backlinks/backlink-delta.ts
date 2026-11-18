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
 * Normalizes a raw `MetadataCache.resolvedLinks[sourcePath]` entry into a clean
 * `targetPath → count` dictionary, or `undefined` when the source has no finite link counts.
 */
export function normalizeResolvedLinks(raw: unknown): Record<string, number> | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const record = Object.create(null) as Record<string, number>;
	let any = false;
	for (const [target, count] of Object.entries(raw as Record<string, unknown>)) {
		const valid = finiteCount(count);
		if (valid !== undefined) {
			record[target] = valid;
			any = true;
		}
	}
	return any ? record : undefined;
}

/**
 * Compares two per-source destination count records for structural equality.
 * Treats `undefined` and an empty record (`{}`) as equal since both represent zero links.
 */
export function recordsEqual(
	a: Readonly<Record<string, number>> | undefined,
	b: Readonly<Record<string, number>> | undefined,
): boolean {
	if (a === b) return true;
	const aKeys = a ? Object.keys(a).filter((k) => finiteCount(a[k]) !== undefined) : [];
	const bKeys = b ? Object.keys(b).filter((k) => finiteCount(b[k]) !== undefined) : [];
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!b || !Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (finiteCount(a![key]) !== finiteCount(b[key])) return false;
	}
	return true;
}

/**
 * Builds the path-keyed inverse index (`target → sources`), skipping ignored sources and targets.
 */
export function buildTargetSources(
	links: ResolvedLinksBySource,
	ignoredPaths?: ReadonlySet<string>,
): TargetSources {
	const result: TargetSources = new Map();
	for (const sourcePath of Object.keys(links)) {
		if (ignoredPaths?.has(sourcePath)) continue;
		const destinations = links[sourcePath];
		if (!destinations || typeof destinations !== 'object') continue;
		for (const targetPath of Object.keys(destinations)) {
			if (ignoredPaths?.has(targetPath)) continue;
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
