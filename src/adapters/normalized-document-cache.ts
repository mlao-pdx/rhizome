import { type App, type CachedMetadata, type TFile } from 'obsidian';
import { deepFreeze } from '@core/cache/deep-freeze';
import { digestNormalizedDocument } from '@core/cache/doc-digest';
import type { ReconcileCacheKey } from '@core/cache/reconcile-plan';
import { XxHash64Accumulator } from '@core/hash/xxhash64';
import {
	hasInternalRhizomeFlag,
	INTERNAL_RHIZOME_CODES,
	normalizeObsidianMetadata,
	rebindDocumentLinks,
	rebindMovedDocument,
	type NormalizedDocument,
	type ResolvedEngineConfig,
	type ResolveLinkPathFn,
} from '@core/search';
import type { DocumentCachePort } from '@ports/document-cache-port';
import type { LoggerPort } from '@ports/logger-port';
import type { BodyScanCache } from './body-scan-cache';
import {
	type CachedLinkSnapshot,
	computeLinkSnapshotFromCache,
	NO_LINKS_SNAPSHOT,
} from './link-snapshot-hash';
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

/** Options for time-sliced `reconcileAsync`. */
export interface AsyncCacheReconcileOptions {
	/** Maximum synchronous work per slice before yielding to the macrotask queue (default: 16 ms). */
	readonly sliceBudgetMs?: number | undefined;
	/** Optional cancellation signal; when aborted, stops early and marks `superseded: true`. */
	readonly signal?: AbortSignal | undefined;
	/** Optional predicate polled at slice boundaries; returning `true` stops early (`superseded: true`). */
	readonly shouldSupersede?: (() => boolean) | undefined;
	/** Optional hook invoked immediately after yielding (e.g. to clear a slice-scoped link memo). */
	readonly onYield?: (() => void) | undefined;
}

/** Result of an asynchronous time-sliced cache reconciliation pass. */
export interface AsyncCacheReconcileResult extends CacheReconcileResult {
	/** True when reconciliation exited early due to `signal` abort, `shouldSupersede()`, or cache reset. */
	readonly superseded: boolean;
	/** True when reconciliation yielded across at least one macrotask slice boundary. */
	readonly yielded?: boolean | undefined;
}

const DEFAULT_SLICE_BUDGET_MS = 16;

interface CacheEntry {
	readonly doc: NormalizedDocument;
	readonly key: DocumentCacheKey;
	readonly ctime?: number | undefined;
	readonly metaRev?: number | undefined;
	readonly bodyRev?: number | undefined;
	readonly generation?: number | undefined;
	linkSnapshot?: CachedLinkSnapshot | undefined;
	lastSeenPass?: number | undefined;
}

interface PendingReconcileItem {
	readonly kind: 'add' | 'update';
	readonly file: TFile;
	readonly expectedPath: string;
	readonly cache: CachedMetadata | null;
	readonly ctime: number;
	readonly mtime: number;
	readonly size: number;
	readonly metaRev: number;
	readonly bodyRev: number;
	readonly linkSnapshot: CachedLinkSnapshot;
	readonly prevEntryAtPath: CacheEntry | undefined;
}

function isIgnoredCache(cache: CachedMetadata | null | undefined): boolean {
	return hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY);
}

function normalizeParentPath(file: TFile): string {
	return file.parent?.path && file.parent.path !== '/' ? file.parent.path : '';
}

function yieldToMacrotask(): Promise<void> {
	if (typeof MessageChannel === 'function') {
		return new Promise<void>((resolve) => {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => {
				channel.port1.close();
				channel.port2.close();
				resolve();
			};
			channel.port2.postMessage(undefined);
		});
	}
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, 0);
	});
}

/**
 * In-memory cache of metadata-only `NormalizedDocument`s with event-independent reconciliation.
 *
 * @remarks
 * (design, 2026-11-18; updated 2026-11-20) Entries are keyed by path in `store` and indexed by
 * `TFile` identity in `entriesByFile` (`WeakMap`) so both link-resolution changes on unmoved
 * notes (`rebindDocumentLinks`) and pure vault moves/renames (`rebindMovedDocument`) reuse
 * already-frozen intrinsic property/tag/alias/task structures without cold re-normalization.
 */
export class NormalizedDocumentCache implements DocumentCachePort<
	NormalizedDocument,
	DocumentCacheKey
> {
	private readonly app: App;
	private readonly logger: LoggerPort | undefined;
	private readonly bodyScanCache: BodyScanCache | undefined;
	private readonly store = new Map<string, CacheEntry>();
	private readonly entriesByFile = new WeakMap<TFile, CacheEntry>();
	private readonly metadataRevisions = new WeakMap<object, number>();
	private nextRevision = 1;
	private passCounter = 0;
	private cacheGeneration = 0;
	private ready = true;
	private reconcileQueue: Promise<void> = Promise.resolve();

	constructor(app: App, logger?: LoggerPort, bodyScanCache?: BodyScanCache) {
		this.app = app;
		this.logger = logger;
		this.bodyScanCache = bodyScanCache;
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
		this.store.set(path, {
			doc: frozen,
			key: Object.freeze({ ...key }),
			generation: this.cacheGeneration,
		});
	}

	/** Removes an entry. */
	delete(path: string): void {
		this.store.delete(path);
	}

	/** Removes the entry at `oldPath`; the renamed note is rebound or normalized under its new path. */
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

	/** Clears every entry and invalidates `entriesByFile` generation references in O(1). */
	clear(): void {
		this.cacheGeneration++;
		this.passCounter++;
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
			return stored !== undefined;
		}
		if (stored === undefined) {
			return true;
		}
		return !this.isEntryFresh(stored, file, cache, stored.key.fingerprint);
	}

	/**
	 * Normalizes or incrementally rebinds a single file if its cached entry is missing or stale.
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
		const ctime = file.stat?.ctime ?? 0;
		const mtime = file.stat?.mtime ?? 0;
		const size = file.stat?.size ?? 0;
		const metaRev = this.metadataRevision(cache);
		const bodyRev = this.bodyScanCache?.getBodyRevision(file.path) ?? 0;
		if (stored !== undefined) {
			this.delete(file.path);
		}
		const doc = this.normalizeOrRebind(
			file,
			cache,
			ctime,
			mtime,
			size,
			metaRev,
			bodyRev,
			config,
			resolveLinkPath,
			stored,
		);
		if (doc !== null) {
			const hasDocLinks = doc.links.length > 0 || doc.embeds.length > 0;
			const linkSnapshot = this.computeLinkSnapshot(
				file.path,
				cache,
				prevLinkSnapshot,
				hasDocLinks,
			);
			this.setInternal(
				file,
				file.path,
				doc,
				ctime,
				mtime,
				size,
				metaRev,
				bodyRev,
				linkSnapshot,
				config.normalizationFingerprint,
			);
		}
		return doc;
	}

	/**
	 * Synchronously reconciles every stored entry with the live vault state and normalizes
	 * or incrementally rebinds only mismatches.
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
		const { hits, uncached, remove, add, update, removedOnFailedUpdate } =
			this.reconcileSyncPass(files, config, resolveLinkPath, passId);

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

	private reconcileSyncPass(
		files: readonly TFile[],
		config: ResolvedEngineConfig,
		resolveLinkPath: ResolveLinkPathFn,
		passId: number,
	): {
		readonly hits: number;
		readonly uncached: number;
		readonly remove: number;
		readonly add: number;
		readonly update: number;
		readonly removedOnFailedUpdate: number;
	} {
		const fingerprint = config.normalizationFingerprint;
		const { hits, uncached, remove, pending } = this.classifyAndEvict(
			files,
			fingerprint,
			passId,
		);

		let add = 0;
		let update = 0;
		let removedOnFailedUpdate = 0;

		if (pending !== undefined) {
			for (let i = 0; i < pending.length; i++) {
				const item = pending[i]!;
				if (item.kind === 'update') {
					this.delete(item.expectedPath);
				}
				const doc = this.normalizeOrRebind(
					item.file,
					item.cache,
					item.ctime,
					item.mtime,
					item.size,
					item.metaRev,
					item.bodyRev,
					config,
					resolveLinkPath,
					item.prevEntryAtPath,
				);
				if (doc === null) {
					if (item.kind === 'update') {
						removedOnFailedUpdate++;
					}
					continue;
				}
				const effectiveLinkSnapshot =
					item.linkSnapshot === NO_LINKS_SNAPSHOT &&
					(doc.links.length > 0 || doc.embeds.length > 0)
						? this.computeLinkSnapshot(item.expectedPath, item.cache, undefined, true)
						: item.linkSnapshot;
				this.setInternal(
					item.file,
					item.expectedPath,
					doc,
					item.ctime,
					item.mtime,
					item.size,
					item.metaRev,
					item.bodyRev,
					effectiveLinkSnapshot,
					fingerprint,
					passId,
				);
				if (item.kind === 'add') {
					add++;
				} else {
					update++;
				}
			}
		}

		return { hits, uncached, remove, add, update, removedOnFailedUpdate };
	}

	/**
	 * Asynchronously reconciles the cache in time-bounded slices (`~16 ms`), committing each
	 * normalized/rebound entry immediately and exiting early (`superseded: true`) if `signal`
	 * aborts or `shouldSupersede()` returns `true`. Concurrent calls are serialized.
	 */
	reconcileAsync(
		files: readonly TFile[],
		config: ResolvedEngineConfig,
		resolveLinkPath: ResolveLinkPathFn,
		options?: AsyncCacheReconcileOptions,
	): Promise<AsyncCacheReconcileResult> {
		const run = () => this.executeReconcileAsync(files, config, resolveLinkPath, options);
		const queued = this.reconcileQueue.then(run, run);
		this.reconcileQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
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

	private async executeReconcileAsync(
		files: readonly TFile[],
		config: ResolvedEngineConfig,
		resolveLinkPath: ResolveLinkPathFn,
		options?: AsyncCacheReconcileOptions,
	): Promise<AsyncCacheReconcileResult> {
		const startedAt = Date.now();
		const isSuperseded = (): boolean =>
			options?.signal?.aborted === true || options?.shouldSupersede?.() === true;

		if (!this.ready) {
			return {
				stats: { add: 0, update: 0, remove: 0, hits: 0, stale: 0, uncached: 0 },
				changed: false,
				superseded: false,
			};
		}
		if (isSuperseded()) {
			return {
				stats: { add: 0, update: 0, remove: 0, hits: 0, stale: 0, uncached: 0 },
				changed: false,
				superseded: true,
			};
		}

		const startGeneration = this.cacheGeneration;
		const passId = ++this.passCounter;
		const fingerprint = config.normalizationFingerprint;
		const sliceBudgetMs = Math.max(0, options?.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS);

		const classified = this.classifyAndEvict(files, fingerprint, passId);
		const hits = classified.hits;
		const uncached = classified.uncached;
		let remove = classified.remove;
		const pending = classified.pending;

		let add = 0;
		let update = 0;
		let removedOnFailedUpdate = 0;
		let superseded = false;
		let hasYielded = false;
		let sliceStartedAt = Date.now();

		if (pending !== undefined && pending.length > 0) {
			for (let i = 0; i < pending.length; i++) {
				if (isSuperseded()) {
					superseded = true;
					break;
				}
				if (i > 0 && Date.now() - sliceStartedAt >= sliceBudgetMs) {
					await yieldToMacrotask();
					hasYielded = true;
					options?.onYield?.();
					sliceStartedAt = Date.now();
					if (
						!this.ready ||
						this.cacheGeneration !== startGeneration ||
						this.passCounter !== passId ||
						isSuperseded()
					) {
						superseded = true;
						break;
					}
				}

				const item = pending[i]!;
				const file = item.file;

				let cache = item.cache;
				let ctime = item.ctime;
				let mtime = item.mtime;
				let size = item.size;
				let metaRev = item.metaRev;
				let bodyRev = item.bodyRev;
				let linkSnapshot = item.linkSnapshot;
				let prevEntry = item.prevEntryAtPath;

				if (hasYielded) {
					if (
						(file as { deleted?: boolean }).deleted ||
						file.path !== item.expectedPath
					) {
						if (this.store.has(item.expectedPath)) {
							this.delete(item.expectedPath);
							removedOnFailedUpdate++;
						}
						continue;
					}
					cache = this.app.metadataCache.getFileCache(file);
					if (isIgnoredCache(cache)) {
						if (this.store.has(item.expectedPath)) {
							this.delete(item.expectedPath);
							removedOnFailedUpdate++;
						}
						continue;
					}
					const liveStored = this.store.get(item.expectedPath);
					prevEntry = liveStored ?? item.prevEntryAtPath;
					if (
						liveStored !== undefined &&
						liveStored !== item.prevEntryAtPath &&
						this.isEntryFresh(liveStored, file, cache, fingerprint)
					) {
						continue;
					}
					ctime = file.stat?.ctime ?? 0;
					mtime = file.stat?.mtime ?? 0;
					size = file.stat?.size ?? 0;
					metaRev = this.metadataRevision(cache);
					bodyRev = this.bodyScanCache?.getBodyRevision(file.path) ?? 0;
					const prevHasLinks =
						prevEntry !== undefined &&
						(prevEntry.doc.links.length > 0 || prevEntry.doc.embeds.length > 0);
					linkSnapshot = this.computeLinkSnapshot(
						file.path,
						cache,
						item.linkSnapshot,
						prevHasLinks,
					);
					if (
						prevEntry !== undefined &&
						prevEntry.key.fingerprint === fingerprint &&
						(prevEntry.ctime === undefined || prevEntry.ctime === ctime) &&
						prevEntry.key.mtime === mtime &&
						prevEntry.key.size === size &&
						(prevEntry.metaRev === undefined || prevEntry.metaRev === metaRev) &&
						(prevEntry.bodyRev === undefined || prevEntry.bodyRev === bodyRev) &&
						prevEntry.linkSnapshot !== undefined &&
						prevEntry.linkSnapshot.signature === linkSnapshot.signature
					) {
						prevEntry.linkSnapshot = linkSnapshot;
						continue;
					}
				}

				if (item.kind === 'update') {
					this.delete(item.expectedPath);
				}

				const doc = this.normalizeOrRebind(
					file,
					cache,
					ctime,
					mtime,
					size,
					metaRev,
					bodyRev,
					config,
					resolveLinkPath,
					prevEntry,
				);
				if (doc === null) {
					if (item.kind === 'update') {
						removedOnFailedUpdate++;
					}
					continue;
				}
				const effectiveLinkSnapshot =
					linkSnapshot === NO_LINKS_SNAPSHOT &&
					(doc.links.length > 0 || doc.embeds.length > 0)
						? this.computeLinkSnapshot(item.expectedPath, cache, undefined, true)
						: linkSnapshot;
				this.setInternal(
					file,
					item.expectedPath,
					doc,
					ctime,
					mtime,
					size,
					metaRev,
					bodyRev,
					effectiveLinkSnapshot,
					fingerprint,
					passId,
				);
				if (item.kind === 'add') {
					add++;
				} else {
					update++;
				}
			}
		}

		if (hasYielded && !superseded) {
			const verifyPassId = ++this.passCounter;
			const vaultWithMd = this.app.vault as { getMarkdownFiles?: () => TFile[] };
			const liveFiles =
				typeof vaultWithMd.getMarkdownFiles === 'function'
					? vaultWithMd.getMarkdownFiles()
					: files;
			const fixup = this.reconcileSyncPass(liveFiles, config, resolveLinkPath, verifyPassId);
			add += fixup.add;
			update += fixup.update;
			remove += fixup.remove;
			removedOnFailedUpdate += fixup.removedOnFailedUpdate;
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
			...(superseded ? { superseded: true } : {}),
		});
		return { stats, changed, superseded, yielded: hasYielded };
	}

	private classifyAndEvict(
		files: readonly TFile[],
		fingerprint: string,
		passId: number,
	): {
		readonly hits: number;
		readonly uncached: number;
		readonly remove: number;
		readonly pending: PendingReconcileItem[] | undefined;
	} {
		let uncached = 0;
		let hits = 0;
		let seenStoredCount = 0;
		let pending: PendingReconcileItem[] | undefined;

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
				const ctime = file.stat?.ctime ?? 0;
				const mtime = file.stat?.mtime ?? 0;
				const size = file.stat?.size ?? 0;
				const metaRev = this.metadataRevision(cache);
				const bodyRev = this.bodyScanCache?.getBodyRevision(file.path) ?? 0;
				const prevHasLinks = stored.doc.links.length > 0 || stored.doc.embeds.length > 0;
				const linkSnapshot = this.computeLinkSnapshot(
					file.path,
					cache,
					stored.linkSnapshot,
					prevHasLinks,
				);
				if (
					this.isEntryFreshWithSnapshot(
						stored,
						ctime,
						mtime,
						size,
						metaRev,
						bodyRev,
						linkSnapshot,
						fingerprint,
					)
				) {
					hits++;
					continue;
				}
				pending ??= [];
				pending.push({
					kind: 'update',
					file,
					expectedPath: file.path,
					cache,
					ctime,
					mtime,
					size,
					metaRev,
					bodyRev,
					linkSnapshot,
					prevEntryAtPath: stored,
				});
			} else {
				const ctime = file.stat?.ctime ?? 0;
				const mtime = file.stat?.mtime ?? 0;
				const size = file.stat?.size ?? 0;
				const metaRev = this.metadataRevision(cache);
				const bodyRev = this.bodyScanCache?.getBodyRevision(file.path) ?? 0;
				const linkSnapshot = this.computeLinkSnapshot(file.path, cache, undefined);
				pending ??= [];
				pending.push({
					kind: 'add',
					file,
					expectedPath: file.path,
					cache,
					ctime,
					mtime,
					size,
					metaRev,
					bodyRev,
					linkSnapshot,
					prevEntryAtPath: undefined,
				});
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

		return { hits, uncached, remove, pending };
	}

	private normalizeOrRebind(
		file: TFile,
		cache: CachedMetadata | null | undefined,
		ctime: number,
		mtime: number,
		size: number,
		metaRev: number,
		bodyRev: number,
		config: ResolvedEngineConfig,
		resolveLinkPath: ResolveLinkPathFn,
		storedAtPath: CacheEntry | undefined,
	): NormalizedDocument | null {
		const fingerprint = config.normalizationFingerprint;

		try {
			if (
				storedAtPath !== undefined &&
				metaRev > 0 &&
				storedAtPath.metaRev === metaRev &&
				storedAtPath.bodyRev !== undefined &&
				storedAtPath.bodyRev === bodyRev &&
				storedAtPath.key.fingerprint === fingerprint &&
				storedAtPath.ctime === ctime &&
				storedAtPath.key.mtime === mtime &&
				storedAtPath.key.size === size &&
				storedAtPath.doc.file.path === file.path &&
				storedAtPath.doc.file.name === file.name &&
				storedAtPath.doc.file.basename === file.basename &&
				storedAtPath.doc.file.extension === file.extension &&
				storedAtPath.doc.file.parent === normalizeParentPath(file)
			) {
				return rebindDocumentLinks(storedAtPath.doc, file.path, resolveLinkPath);
			}

			const byFileCandidate = this.entriesByFile.get(file);
			const moveCandidate =
				storedAtPath ??
				(byFileCandidate !== undefined &&
				byFileCandidate.generation === this.cacheGeneration
					? byFileCandidate
					: undefined);

			if (
				moveCandidate !== undefined &&
				metaRev > 0 &&
				moveCandidate.metaRev === metaRev &&
				moveCandidate.bodyRev !== undefined &&
				moveCandidate.bodyRev === bodyRev &&
				moveCandidate.key.fingerprint === fingerprint
			) {
				return rebindMovedDocument(moveCandidate.doc, file, config, resolveLinkPath);
			}

			const inlineProps = this.bodyScanCache?.getInlineProperties(file.path) ?? [];
			const tasks = this.bodyScanCache?.getTasks(file.path) ?? [];
			return normalizeObsidianMetadata(
				file,
				cache ?? null,
				config,
				inlineProps,
				resolveLinkPath,
				tasks,
			);
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
		file: TFile,
		path: string,
		doc: NormalizedDocument,
		ctime: number,
		mtime: number,
		size: number,
		metaRev: number,
		bodyRev: number,
		linkSnapshot: CachedLinkSnapshot,
		fingerprint: string,
		lastSeenPass?: number,
	): void {
		const frozen = deepFreeze(doc);
		const key: DocumentCacheKey = Object.freeze({
			path,
			mtime,
			size,
			revision: `${metaRev}:${bodyRev}:${linkSnapshot.signature}`,
			fingerprint,
		});
		const entry: CacheEntry = {
			doc: frozen,
			key,
			ctime,
			metaRev,
			bodyRev,
			generation: this.cacheGeneration,
			linkSnapshot,
			lastSeenPass,
		};
		this.store.set(path, entry);
		this.entriesByFile.set(file, entry);
	}

	private isEntryFresh(
		stored: CacheEntry,
		file: TFile,
		cache: CachedMetadata | null | undefined,
		fingerprint: string,
	): boolean {
		const ctime = file.stat?.ctime ?? 0;
		const mtime = file.stat?.mtime ?? 0;
		const size = file.stat?.size ?? 0;
		if (
			stored.key.fingerprint !== fingerprint ||
			(stored.ctime !== undefined && stored.ctime !== ctime) ||
			stored.key.mtime !== mtime ||
			stored.key.size !== size
		) {
			return false;
		}
		const metaRev = this.metadataRevision(cache);
		if (stored.metaRev !== undefined && stored.metaRev !== metaRev) {
			return false;
		}
		const bodyRev = this.bodyScanCache?.getBodyRevision(file.path) ?? 0;
		if (stored.bodyRev !== undefined && stored.bodyRev !== bodyRev) {
			return false;
		}
		const prevHasLinks = stored.doc.links.length > 0 || stored.doc.embeds.length > 0;
		const nextLinkSnapshot = this.computeLinkSnapshot(
			file.path,
			cache,
			stored.linkSnapshot,
			prevHasLinks,
		);
		return this.isEntryFreshWithSnapshot(
			stored,
			ctime,
			mtime,
			size,
			metaRev,
			bodyRev,
			nextLinkSnapshot,
			fingerprint,
		);
	}

	private isEntryFreshWithSnapshot(
		stored: CacheEntry,
		ctime: number,
		mtime: number,
		size: number,
		metaRev: number,
		bodyRev: number,
		nextLinkSnapshot: CachedLinkSnapshot,
		fingerprint: string,
	): boolean {
		if (
			stored.key.fingerprint !== fingerprint ||
			(stored.ctime !== undefined && stored.ctime !== ctime) ||
			stored.key.mtime !== mtime ||
			stored.key.size !== size ||
			(stored.metaRev !== undefined && stored.metaRev !== metaRev) ||
			(stored.bodyRev !== undefined && stored.bodyRev !== bodyRev)
		) {
			return false;
		}
		if (stored.metaRev !== undefined && stored.linkSnapshot !== undefined) {
			if (nextLinkSnapshot.signature === stored.linkSnapshot.signature) {
				stored.linkSnapshot = nextLinkSnapshot;
				return true;
			}
			return false;
		}
		return (
			stored.key.revision === `${metaRev}:${bodyRev}:${nextLinkSnapshot.signature}` ||
			(bodyRev === 0 && stored.key.revision === `${metaRev}:${nextLinkSnapshot.signature}`)
		);
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
		forceHasLinks = false,
	): CachedLinkSnapshot {
		const metadataCache = this.app.metadataCache as {
			resolvedLinks?: Record<string, Record<string, number>>;
			unresolvedLinks?: Record<string, Record<string, number>>;
		};
		return computeLinkSnapshotFromCache(metadataCache, path, cache, prev, forceHasLinks);
	}
}
