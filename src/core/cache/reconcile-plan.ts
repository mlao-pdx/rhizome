/**
 * Live, Obsidian-derived state for one Markdown note considered during reconciliation.
 */
export interface ReconcileFileState {
	readonly path: string;
	/** File modification time in epoch milliseconds. */
	readonly mtime: number;
	/** File size in bytes. */
	readonly size: number;
	/**
	 * Opaque revision token minted by the adapter. It changes when the note's `CachedMetadata`
	 * object identity changes and when its link-resolution inputs change.
	 */
	readonly revision: string;
	/** Whether the note carries the `DO_NOT_INDEX_OR_QUERY` flag. */
	readonly ignored: boolean;
}

/**
 * The key stored alongside a cached document.
 */
export interface ReconcileCacheKey {
	readonly path: string;
	readonly mtime: number;
	readonly size: number;
	readonly revision: string;
	/** Normalization fingerprint of the engine config the document was normalized with. */
	readonly fingerprint: string;
}

/**
 * Paths that must be added, re-normalized, or dropped by the document cache.
 */
export interface ReconcilePlan {
	readonly add: string[];
	readonly update: string[];
	readonly remove: string[];
}

function keyMatches(
	state: ReconcileFileState,
	stored: ReconcileCacheKey,
	expectedFingerprint: string,
): boolean {
	return (
		stored.mtime === state.mtime &&
		stored.size === state.size &&
		stored.revision === state.revision &&
		stored.fingerprint === expectedFingerprint
	);
}

/**
 * Plans the minimal set of cache writes needed to reconcile stored keys with live file state.
 *
 * @remarks
 * (design, 2026-11-18) Reconciliation is intentionally independent of event delivery: it compares
 * every live Markdown file against its stored key, so a dropped `changed`/`deleted`/`resolve`
 * event only delays convergence until the next pass instead of leaving permanent staleness. The
 * revision token folds in both the `CachedMetadata` identity (to close the same-millisecond
 * `mtime` lag) and the note's link-resolution signature, which is what makes a target create,
 * rename, or delete converge even when no `resolve` event reaches the adapter. Events are
 * therefore hints, not forced rewrites: a `resolve` or dependent-marking event can never update a
 * document whose key did not change. Ignored notes are never stored, so a live ignored file that
 * is still present produces a removal.
 */
export function planReconcile(
	current: readonly ReconcileFileState[],
	stored: readonly ReconcileCacheKey[],
	expectedFingerprint: string,
): ReconcilePlan {
	const storedByPath = new Map<string, ReconcileCacheKey>();
	for (const key of stored) {
		storedByPath.set(key.path, key);
	}

	const add: string[] = [];
	const update: string[] = [];
	const seen = new Set<string>();

	for (const state of current) {
		seen.add(state.path);
		const existing = storedByPath.get(state.path);
		if (state.ignored) {
			continue;
		}
		if (existing === undefined) {
			add.push(state.path);
			continue;
		}
		if (!keyMatches(state, existing, expectedFingerprint)) {
			update.push(state.path);
		}
	}

	const remove: string[] = [];
	for (const path of storedByPath.keys()) {
		if (!seen.has(path)) {
			remove.push(path);
		}
	}
	for (const state of current) {
		if (state.ignored && storedByPath.has(state.path)) {
			remove.push(state.path);
		}
	}

	return { add, update, remove };
}
