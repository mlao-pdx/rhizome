import { type App, type CachedMetadata, type TFile } from 'obsidian';
import { deepFreeze } from '@core/cache/deep-freeze';
import { digestNormalizedDocument } from '@core/cache/doc-digest';
import type { ReconcileCacheKey } from '@core/cache/reconcile-plan';
import { XxHash64Accumulator } from '@core/hash/xxhash64';
import {
	hasInternalRhizomeFlag,
	INTERNAL_RHIZOME_CODES,
	normalizeObsidianMetadata,
	type NormalizedDocument,
	type ResolvedEngineConfig,
	type ResolveLinkPathFn,
} from '@core/search';
import type { DocumentCachePort } from '@ports/document-cache-port';
import type { LoggerPort } from '@ports/logger-port';
import { markSensitive } from './logger-format';

/**
 * Key that identifies the vault state a cached document was normalized from.
 */
export type DocumentCacheKey = ReconcileCacheKey;

/** Counters emitted by one reconciliation pass. */
export interface DocumentCacheStats {
	readonly add: number;
	readonly update: number;
	readonly remove: number;
	/**
	 * Entries whose stored key matched the live state and that were neither added nor rewritten.
	 * Ignored notes are never counted; `uncached` is reported independently.
	 */
	readonly hits: number;
	/** Entries that required a rewrite because their stored key no longer matched (`update`). */
	readonly stale: number;
	/** Notes with no `CachedMetadata` (`getFileCache` returned `null`) when they were considered. */
	readonly uncached: number;
}

/** Result of reconciling the cache against live vault state. */
export interface CacheReconcileResult {
	readonly stats: DocumentCacheStats;
	/** Whether any cached document was added, updated, or removed during this pass. */
	readonly changed: boolean;
}

interface CachedLinkSnapshot {
	readonly resolved: Readonly<Record<string, number>> | null;
	readonly unresolved: Readonly<Record<string, number>> | null;
	readonly signature: string;
}

const NO_LINKS_SNAPSHOT: CachedLinkSnapshot = Object.freeze({
	resolved: null,
	unresolved: null,
	signature: '0',
});

interface CacheEntry {
	readonly doc: NormalizedDocument;
	readonly key: DocumentCacheKey;
	readonly metaRev?: number | undefined;
	linkSnapshot?: CachedLinkSnapshot | undefined;
	lastSeenPass?: number | undefined;
}

interface PendingNormalizeItem {
	readonly file: TFile;
	readonly cache: CachedMetadata | null;
	readonly mtime: number;
	readonly size: number;
	readonly metaRev: number;
	readonly linkSnapshot: CachedLinkSnapshot;
}

function isIgnoredCache(cache: CachedMetadata | null | undefined): boolean {
	return hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY);
}

function hasAnyLinks(cache: CachedMetadata | null | undefined): boolean {
	return (
		(cache?.links?.length ?? 0) > 0 ||
		(cache?.embeds?.length ?? 0) > 0 ||
		(cache?.frontmatterLinks?.length ?? 0) > 0
	);
}

function shallowNumberRecordsEqual(
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

function hashRecord(record: unknown): string {
	const acc = new XxHash64Accumulator();
	acc.updateValue(record ?? null);
	return acc.digest().hex;
}

/**
 * In-memory cache of metadata-only `NormalizedDocument`s with event-independent reconciliation.
 *
 * @remarks
 * (design, 2026-11-18) Entries are keyed by path and carry a stat/identity revision and the engine
 * config fingerprint they were normalized with. `reconcile` compares every live Markdown file
 * against its stored key, so convergence does not depend on any particular event arriving. The
 * revision token folds in the `CachedMetadata` object identity (closing the same-millisecond
 * `mtime` lag) and, for notes that actually contain links or embeds, the note's
 * `resolvedLinks`/`unresolvedLinks` signature (catching cross-note resolution changes). Documents
 * are deep-frozen at insert and never receive `backlinks`; projection attaches backlinks to a
 * fresh object at the point of use.
 */
export class NormalizedDocumentCache implements DocumentCachePort<
	NormalizedDocument,
	DocumentCacheKey
> {
	private readonly app: App;
	private readonly logger: LoggerPort | undefined;
	private readonly store = new Map<string, CacheEntry>();
	private readonly metadataRevisions = new WeakMap<object, number>();
	private nextRevision = 1;
	private passCounter = 0;
	private ready = true;

	constructor(app: App, logger?: LoggerPort) {
		this.app = app;
		this.logger = logger;
	}

	/** Number of stored entries. */
	get size(): number {
		return this.store.size;
	}

	/** Whether cold builds are currently allowed. */
	get isReady(): boolean {
		return this.ready;
	}

	/**
	 * Gates cold builds on the vault's `resolved`/layout-ready signal.
	 *
	 * @remarks
	 * (design, 2026-11-18) Before Obsidian finishes resolving metadata, `resolvedLinks` is a
	 * partial view; normalizing then would bake wrong `resolvedPath` values into the cache. While
	 * not ready, `reconcile` is a no-op and `ensureFresh` returns `null`; flipping ready triggers a
	 * full rebuild through the ordinary reconcile path.
	 */
	setReady(ready: boolean): void {
		this.ready = ready;
		if (!ready) {
			this.clear();
		}
	}

	/** Returns the cached document for `path`. */
	get(path: string): NormalizedDocument | undefined {
		return this.store.get(path)?.doc;
	}

	/** Returns the cached key for `path`. */
	getKey(path: string): DocumentCacheKey | undefined {
		return this.store.get(path)?.key;
	}

	/** Returns the cached document only when it was normalized with `fingerprint`. */
	getForConfig(path: string, fingerprint: string): NormalizedDocument | undefined {
		const entry = this.store.get(path);
		return entry?.key.fingerprint === fingerprint ? entry.doc : undefined;
	}

	/** Inserts or replaces a document, freezing its payload. */
	set(path: string, doc: NormalizedDocument, key: DocumentCacheKey): void {
		const frozen = deepFreeze(doc);
		this.store.set(path, { doc: frozen, key: Object.freeze({ ...key }) });
	}

	/** Removes an entry. */
	delete(path: string): void {
		this.store.delete(path);
	}

	/** Removes the entry at `oldPath`; the renamed note is re-normalized under its new path. */
	rename(oldPath: string, _newPath: string): void {
		this.delete(oldPath);
	}

	/** Iterates `[path, document]` pairs. */
	*entries(): IterableIterator<readonly [string, NormalizedDocument]> {
		for (const [path, entry] of this.store) {
			yield [path, entry.doc] as const;
		}
	}

	/** Iterates cached paths. */
	keys(): IterableIterator<string> {
		return this.store.keys();
	}

	/** Clears every entry. */
	clear(): void {
		this.store.clear();
	}

	/**
	 * Checks whether `file`'s stored cache entry is missing or has a stale revision/stat
	 * without mutating the cache. Used to fast-reject no-op `metadataCache.on('resolve')` events.
	 */
	hasLinkResolutionChanged(file: TFile): boolean {
		if (!this.ready) {
			return false;
		}
		const stored = this.store.get(file.path);
		if ((file as { deleted?: boolean }).deleted || !file.path.toLowerCase().endsWith('.md')) {
			return stored !== undefined;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		if (isIgnoredCache(cache)) {
			// Exception: if a previously indexed note gained DO_NOT_INDEX_OR_QUERY, report changed
			// so the next reconciliation pass evicts it from the cache.
			return stored !== undefined;
		}
		if (stored === undefined) {
			return true;
		}
		return !this.isEntryFresh(stored, file, cache, stored.key.fingerprint);
	}

	/**
	 * Normalizes a single file if its cached entry is missing or stale, returning the fresh doc.
	 * Returns `null` for ignored, missing, deleted, or invalid notes.
	 */
	ensureFresh(
		file: TFile,
		config: ResolvedEngineConfig,
		resolveLinkPath: ResolveLinkPathFn,
	): NormalizedDocument | null {
		if (!this.ready || (file as { deleted?: boolean }).deleted) {
			this.delete(file.path);
			return null;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		if (isIgnoredCache(cache)) {
			// Evict any previously cached entry when a note gains DO_NOT_INDEX_OR_QUERY.
			this.delete(file.path);
			return null;
		}
		const stored = this.store.get(file.path);
		if (
			stored !== undefined &&
			this.isEntryFresh(stored, file, cache, config.normalizationFingerprint)
		) {
			return stored.doc;
		}
		const prevLinkSnapshot = stored?.linkSnapshot;
		if (stored !== undefined) {
			this.delete(file.path);
		}
		const doc = this.normalize(file, cache, config, resolveLinkPath);
		if (doc !== null) {
			const mtime = file.stat?.mtime ?? 0;
			const size = file.stat?.size ?? 0;
			const metaRev = this.metadataRevision(cache);
			const linkSnapshot = this.computeLinkSnapshot(file.path, cache, prevLinkSnapshot);
			this.setInternal(
				file.path,
				doc,
				mtime,
				size,
				metaRev,
				linkSnapshot,
				config.normalizationFingerprint,
			);
		}
		return doc;
	}

	/**
	 * Reconciles every stored entry with the live vault state and normalizes only mismatches.
	 *
	 * @remarks
	 * A per-file normalization failure is logged and the entry dropped rather than failing the
	 * whole pass; the cold-build oracle applies the same policy, so which notes are visible never
	 * depends on cache state. Ignored notes (`DO_NOT_INDEX_OR_QUERY`) are never added, and any
	 * previously cached note that gained the ignore flag is evicted.
	 */
	reconcile(
		files: readonly TFile[],
		config: ResolvedEngineConfig,
		resolveLinkPath: ResolveLinkPathFn,
	): CacheReconcileResult {
		const startedAt = Date.now();
		if (!this.ready) {
			return {
				stats: { add: 0, update: 0, remove: 0, hits: 0, stale: 0, uncached: 0 },
				changed: false,
			};
		}

		const passId = ++this.passCounter;
		const fingerprint = config.normalizationFingerprint;
		let uncached = 0;
		let hits = 0;
		let seenStoredCount = 0;
		let toAdd: PendingNormalizeItem[] | undefined;
		let toUpdate: PendingNormalizeItem[] | undefined;

		for (let i = 0; i < files.length; i++) {
			const file = files[i]!;
			if ((file as { deleted?: boolean }).deleted) {
				continue;
			}
			if (!file.path.toLowerCase().endsWith('.md')) {
				continue;
			}
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache === null) {
				uncached++;
			}
			if (isIgnoredCache(cache)) {
				continue;
			}

			const stored = this.store.get(file.path);
			if (stored !== undefined) {
				if (stored.lastSeenPass !== passId) {
					stored.lastSeenPass = passId;
					seenStoredCount++;
				}
				if (this.isEntryFresh(stored, file, cache, fingerprint)) {
					hits++;
					continue;
				}
				const mtime = file.stat?.mtime ?? 0;
				const size = file.stat?.size ?? 0;
				const metaRev = this.metadataRevision(cache);
				const linkSnapshot = this.computeLinkSnapshot(
					file.path,
					cache,
					stored.linkSnapshot,
				);
				toUpdate ??= [];
				toUpdate.push({ file, cache, mtime, size, metaRev, linkSnapshot });
			} else {
				const mtime = file.stat?.mtime ?? 0;
				const size = file.stat?.size ?? 0;
				const metaRev = this.metadataRevision(cache);
				const linkSnapshot = this.computeLinkSnapshot(file.path, cache, undefined);
				toAdd ??= [];
				toAdd.push({ file, cache, mtime, size, metaRev, linkSnapshot });
			}
		}

		let remove = 0;
		if (seenStoredCount < this.store.size) {
			for (const [path, entry] of this.store) {
				if (entry.lastSeenPass !== passId) {
					this.store.delete(path);
					remove++;
				}
			}
		}

		let add = 0;
		if (toAdd !== undefined) {
			for (let i = 0; i < toAdd.length; i++) {
				const item = toAdd[i]!;
				const doc = this.normalize(item.file, item.cache, config, resolveLinkPath);
				if (doc === null) continue;
				this.setInternal(
					item.file.path,
					doc,
					item.mtime,
					item.size,
					item.metaRev,
					item.linkSnapshot,
					fingerprint,
					passId,
				);
				add++;
			}
		}

		let update = 0;
		let removedOnFailedUpdate = 0;
		if (toUpdate !== undefined) {
			for (let i = 0; i < toUpdate.length; i++) {
				const item = toUpdate[i]!;
				this.delete(item.file.path);
				const doc = this.normalize(item.file, item.cache, config, resolveLinkPath);
				if (doc === null) {
					removedOnFailedUpdate++;
					continue;
				}
				this.setInternal(
					item.file.path,
					doc,
					item.mtime,
					item.size,
					item.metaRev,
					item.linkSnapshot,
					fingerprint,
					passId,
				);
				update++;
			}
		}

		const stats: DocumentCacheStats = {
			add,
			update,
			remove,
			hits,
			stale: update,
			uncached,
		};
		const changed = add > 0 || update > 0 || remove > 0 || removedOnFailedUpdate > 0;
		this.logger?.log('debug', 'Reconciled normalized document cache', {
			source: 'query.cache',
			durationMs: Math.max(0, Date.now() - startedAt),
			count: add + update + remove,
			...stats,
			changed,
		});
		return { stats, changed };
	}

	/** Deterministic digest over all cached documents, sorted by path. */
	digest(): string {
		const acc = new XxHash64Accumulator();
		const paths = [...this.store.keys()].sort();
		acc.updateTag(0x51, paths.length);
		for (const path of paths) {
			acc.updateString(path);
			const doc = this.store.get(path)!.doc;
			acc.updateString(digestNormalizedDocument(doc));
		}
		return acc.digest().hex;
	}

	private normalize(
		file: TFile,
		cache: CachedMetadata | null | undefined,
		config: ResolvedEngineConfig,
		resolveLinkPath: ResolveLinkPathFn,
	): NormalizedDocument | null {
		try {
			return normalizeObsidianMetadata(file, cache ?? null, config, [], resolveLinkPath);
		} catch (error) {
			this.logger?.log(
				'warn',
				`Skipped note that failed normalization: ${markSensitive(file.path)}`,
				{
					source: 'query.cache',
					error: String(error),
				},
			);
			return null;
		}
	}

	private setInternal(
		path: string,
		doc: NormalizedDocument,
		mtime: number,
		size: number,
		metaRev: number,
		linkSnapshot: CachedLinkSnapshot,
		fingerprint: string,
		lastSeenPass?: number,
	): void {
		const frozen = deepFreeze(doc);
		const key: DocumentCacheKey = Object.freeze({
			path,
			mtime,
			size,
			revision: `${metaRev}:${linkSnapshot.signature}`,
			fingerprint,
		});
		this.store.set(path, {
			doc: frozen,
			key,
			metaRev,
			linkSnapshot,
			lastSeenPass,
		});
	}

	private isEntryFresh(
		stored: CacheEntry,
		file: TFile,
		cache: CachedMetadata | null | undefined,
		fingerprint: string,
	): boolean {
		const mtime = file.stat?.mtime ?? 0;
		const size = file.stat?.size ?? 0;
		if (
			stored.key.fingerprint !== fingerprint ||
			stored.key.mtime !== mtime ||
			stored.key.size !== size
		) {
			return false;
		}
		const metaRev = this.metadataRevision(cache);
		if (stored.metaRev !== undefined && stored.metaRev !== metaRev) {
			return false;
		}
		const nextLinkSnapshot = this.computeLinkSnapshot(file.path, cache, stored.linkSnapshot);
		if (stored.metaRev !== undefined && stored.linkSnapshot !== undefined) {
			if (nextLinkSnapshot.signature === stored.linkSnapshot.signature) {
				stored.linkSnapshot = nextLinkSnapshot;
				return true;
			}
			return false;
		}
		return stored.key.revision === `${metaRev}:${nextLinkSnapshot.signature}`;
	}

	private metadataRevision(cache: CachedMetadata | null | undefined): number {
		if (cache === null || cache === undefined) {
			return 0;
		}
		let revision = this.metadataRevisions.get(cache);
		if (revision === undefined) {
			revision = this.nextRevision++;
			this.metadataRevisions.set(cache, revision);
		}
		return revision;
	}

	private computeLinkSnapshot(
		path: string,
		cache: CachedMetadata | null | undefined,
		prev: CachedLinkSnapshot | undefined,
	): CachedLinkSnapshot {
		if (!hasAnyLinks(cache)) {
			return NO_LINKS_SNAPSHOT;
		}
		const metadataCache = this.app.metadataCache as {
			resolvedLinks?: Record<string, Record<string, number>>;
			unresolvedLinks?: Record<string, Record<string, number>>;
		};
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
		const signature = hashRecord({
			resolved: rawResolved,
			unresolved: rawUnresolved,
		});
		return {
			resolved: rawResolved ? { ...rawResolved } : null,
			unresolved: rawUnresolved ? { ...rawUnresolved } : null,
			signature,
		};
	}
}
