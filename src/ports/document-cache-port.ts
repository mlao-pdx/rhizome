/**
 * Storage contract for a keyed, in-memory cache of normalized metadata documents.
 *
 * @remarks
 * (design, 2026-11-18) The cache is deliberately generic over its document and key shapes so this
 * contract stays free of `obsidian` and of the search domain's concrete `NormalizedDocument`
 * type. Adapters implement it against a `Map`; core code never writes to it directly. Every
 * stored document is treated as an immutable snapshot: implementations must freeze payloads on
 * insert and must never expose a value that a later write mutates in place.
 */
export interface DocumentCachePort<TDocument, TKey> {
	/** Returns the cached document for `path`, or `undefined` when absent. */
	get(path: string): TDocument | undefined;
	/** Returns the stored key for `path`, or `undefined` when absent. */
	getKey(path: string): TKey | undefined;
	/** Inserts or replaces the entry for `path`. */
	set(path: string, doc: TDocument, key: TKey): void;
	/** Removes the entry for `path`. */
	delete(path: string): void;
	/** Moves an entry from `oldPath` to `newPath`. */
	rename(oldPath: string, newPath: string): void;
	/** Iterates `[path, document]` pairs in insertion order. */
	entries(): IterableIterator<readonly [string, TDocument]>;
	/** Iterates cached paths in insertion order. */
	keys(): IterableIterator<string>;
	/** Number of stored entries. */
	readonly size: number;
}
