import { type App, type CachedMetadata, type TFile } from 'obsidian';
import { deepFreeze } from '@core/cache/deep-freeze';
import { digestNormalizedDocument } from '@core/cache/doc-digest';
import {
	planReconcile,
	type ReconcileCacheKey,
	type ReconcileFileState,
} from '@core/cache/reconcile-plan';
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

/**
 * Key that identifies the vault state a cached document was normalized from.
 */
export type DocumentCacheKey = ReconcileCacheKey;

/** Counters emitted by one reconciliation pass. */
export interface DocumentCacheStats {
	readonly add: number;
	readonly update: number;
	readonly remove: number;
	readonly hits: number;
	readonly uncached: number;
}

/** Result of reconciling the cache against live vault state. */
export interface CacheReconcileResult {
	readonly stats: DocumentCacheStats;
	/** Paths whose resolved-link entries may have changed since the last pass. */
	readonly dirtySources: ReadonlySet<string>;
	/** Paths whose `DO_NOT_INDEX_OR_QUERY` status changed since the last pass. */
	readonly ignoredChanges: ReadonlySet<string>;
}

interface CacheEntry {
	readonly doc: NormalizedDocument;
	readonly key: DocumentCacheKey;
}

function isIgnoredCache(cache: CachedMetadata | null | undefined): boolean {
	return hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY);
}

function hashRecord(record: unknown): string {
	const acc = new XxHash64Accumulator();
	acc.updateValue(record ?? null);
	return acc.digest().hex;
}

function normalizeLinkKey(raw: string): string {
	return raw.trim().toLowerCase().replace(/^\.\//, '').replace(/\.md$/, '');
}

function pathKeyVariants(path: string): string[] {
	const normalized = normalizeLinkKey(path);
	const slashIdx = normalized.lastIndexOf('/');
	const basename = slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1);
	return normalized === basename ? [normalized] : [normalized, basename];
}

function documentLinkKeys(doc: NormalizedDocument): string[] {
	const keys = new Set<string>();
	for (const link of [...doc.links, ...doc.embeds]) {
		for (const key of pathKeyVariants(link.rawTarget)) {
			keys.add(key);
		}
		if (link.resolvedPath !== null) {
			for (const key of pathKeyVariants(link.resolvedPath)) {
				keys.add(key);
			}
		}
	}
	return [...keys];
}

/**
 * In-memory cache of metadata-only `NormalizedDocument`s with event-independent reconciliation.
 *
 * @remarks
 * (design, 2026-11-18) Entries are keyed by path and carry a stat/identity revision and the engine
 * config fingerprint they were normalized with. `reconcile` compares every live Markdown file
 * against its stored key, so convergence does not depend on any particular event arriving. The
 * revision token folds in the `CachedMetadata` object identity (closing the same-millisecond
 * `mtime` lag) and the note's `resolvedLinks`/`unresolvedLinks` signature (catching cross-note
 * resolution changes). Documents are deep-frozen at insert and never receive `backlinks`;
 * projection attaches backlinks to a fresh object at the point of use.
 */
export class NormalizedDocumentCache implements DocumentCachePort<
	NormalizedDocument,
	DocumentCacheKey
> {
	private readonly app: App;
	private readonly logger: LoggerPort | undefined;
	private readonly store = new Map<string, CacheEntry>();
	private readonly metadataRevisions = new WeakMap<object, number>();
	private readonly linkIndex = new Map<string, Set<string>>();
	private lastIgnored = new Set<string>();
	private nextRevision = 1;
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
		this.unindex(path);
		const frozen = deepFreeze(doc);
		this.store.set(path, { doc: frozen, key: Object.freeze({ ...key }) });
		for (const linkKey of documentLinkKeys(frozen)) {
			let sources = this.linkIndex.get(linkKey);
			if (!sources) {
				sources = new Set();
				this.linkIndex.set(linkKey, sources);
			}
			sources.add(path);
		}
	}

	/** Removes an entry. */
	delete(path: string): void {
		this.unindex(path);
		this.store.delete(path);
	}

	/**
	 * Returns cached source paths whose raw link targets or previously resolved paths match any
	 * of the given paths or basenames.
	 */
	dependentSources(targetPaths: Iterable<string>): Set<string> {
		const dependents = new Set<string>();
		for (const targetPath of targetPaths) {
			for (const key of pathKeyVariants(targetPath)) {
				const sources = this.linkIndex.get(key);
				if (!sources) continue;
				for (const source of sources) {
					dependents.add(source);
				}
			}
		}
		return dependents;
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

	/** Clears every entry and the ignore-tracking baseline. */
	clear(): void {
		this.store.clear();
		this.linkIndex.clear();
		this.lastIgnored = new Set();
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
			this.delete(file.path);
			return null;
		}
		const state = this.stateFor(file, cache);
		const stored = this.store.get(file.path);
		if (
			stored !== undefined &&
			stored.key.fingerprint === config.normalizationFingerprint &&
			stored.key.mtime === state.mtime &&
			stored.key.size === state.size &&
			stored.key.revision === state.revision
		) {
			return stored.doc;
		}
		if (stored !== undefined) {
			this.delete(file.path);
		}
		const doc = this.normalize(file, cache, config, resolveLinkPath);
		if (doc !== null) {
			this.set(file.path, doc, this.keyFromState(state, config.normalizationFingerprint));
		}
		return doc;
	}

	/**
	 * Reconciles every stored entry with the live vault state and normalizes only mismatches.
	 *
	 * @remarks
	 * A per-file normalization failure is logged and the entry dropped rather than failing the
	 * whole pass; the cold-build oracle applies the same policy, so which notes are visible never
	 * depends on cache state. `dirtySources` is the union of added, updated, and removed paths plus
	 * ignore-flag changes, which is what the backlink delta needs.
	 */
	reconcile(
		files: readonly TFile[],
		config: ResolvedEngineConfig,
		resolveLinkPath: ResolveLinkPathFn,
		forcedPaths: ReadonlySet<string> = new Set(),
	): CacheReconcileResult {
		const startedAt = Date.now();
		if (!this.ready) {
			return {
				stats: { add: 0, update: 0, remove: 0, hits: 0, uncached: 0 },
				dirtySources: new Set(),
				ignoredChanges: new Set(),
			};
		}
		const current: ReconcileFileState[] = [];
		const statesByPath = new Map<string, ReconcileFileState>();
		const filesByPath = new Map<string, TFile>();
		const cachesByPath = new Map<string, CachedMetadata | null>();
		const currentIgnored = new Set<string>();
		let uncached = 0;

		for (const file of files) {
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
			filesByPath.set(file.path, file);
			cachesByPath.set(file.path, cache);
			const ignored = isIgnoredCache(cache);
			if (ignored) {
				currentIgnored.add(file.path);
			}
			const state = this.stateFor(file, cache, ignored);
			statesByPath.set(file.path, state);
			current.push(state);
		}

		const storedKeys: DocumentCacheKey[] = [];
		for (const entry of this.store.values()) {
			storedKeys.push(entry.key);
		}

		const plan = planReconcile(
			current,
			storedKeys,
			config.normalizationFingerprint,
			forcedPaths,
		);
		const dirtySources = new Set<string>();
		const ignoredChanges = new Set<string>();
		let hits = 0;
		for (const path of statesByPath.keys()) {
			const stored = this.store.get(path);
			if (
				stored !== undefined &&
				stored.key.fingerprint === config.normalizationFingerprint
			) {
				hits++;
			}
		}

		for (const path of plan.remove) {
			this.delete(path);
			dirtySources.add(path);
		}

		let add = 0;
		let update = 0;
		for (const path of plan.add) {
			const file = filesByPath.get(path);
			const state = statesByPath.get(path);
			if (!file || !state) continue;
			const doc = this.normalize(file, cachesByPath.get(path), config, resolveLinkPath);
			if (doc === null) continue;
			this.set(path, doc, this.keyFromState(state, config.normalizationFingerprint));
			dirtySources.add(path);
			add++;
		}
		for (const path of plan.update) {
			const file = filesByPath.get(path);
			const state = statesByPath.get(path);
			if (!file || !state) continue;
			this.delete(path);
			const doc = this.normalize(file, cachesByPath.get(path), config, resolveLinkPath);
			if (doc === null) {
				dirtySources.add(path);
				continue;
			}
			this.set(path, doc, this.keyFromState(state, config.normalizationFingerprint));
			dirtySources.add(path);
			update++;
		}

		for (const path of currentIgnored) {
			if (!this.lastIgnored.has(path)) {
				ignoredChanges.add(path);
				dirtySources.add(path);
			}
		}
		for (const path of this.lastIgnored) {
			if (!currentIgnored.has(path)) {
				ignoredChanges.add(path);
				dirtySources.add(path);
			}
		}
		this.lastIgnored = currentIgnored;

		const stats: DocumentCacheStats = {
			add,
			update,
			remove: plan.remove.length,
			hits,
			uncached,
		};
		this.logger?.log('debug', 'Reconciled normalized document cache', {
			source: 'query.cache',
			durationMs: Math.max(0, Date.now() - startedAt),
			count: add + update + plan.remove.length,
			...stats,
			dirtySourceCount: dirtySources.size,
		});
		return { stats, dirtySources, ignoredChanges };
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

	private unindex(path: string): void {
		const existing = this.store.get(path);
		if (!existing) return;
		for (const linkKey of documentLinkKeys(existing.doc)) {
			const sources = this.linkIndex.get(linkKey);
			if (!sources) continue;
			sources.delete(path);
			if (sources.size === 0) {
				this.linkIndex.delete(linkKey);
			}
		}
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
			this.logger?.log('warn', `Skipped note that failed normalization: ${file.path}`, {
				source: 'query.cache',
				error: String(error),
			});
			return null;
		}
	}

	private stateFor(
		file: TFile,
		cache?: CachedMetadata | null,
		ignored?: boolean,
	): ReconcileFileState {
		const resolvedCache =
			cache === undefined ? this.app.metadataCache.getFileCache(file) : cache;
		return {
			path: file.path,
			mtime: file.stat?.mtime ?? 0,
			size: file.stat?.size ?? 0,
			revision: `${this.metadataRevision(resolvedCache)}:${this.linksSignature(file.path)}`,
			ignored: ignored ?? isIgnoredCache(resolvedCache),
		};
	}

	private keyFromState(state: ReconcileFileState, fingerprint: string): DocumentCacheKey {
		return {
			path: state.path,
			mtime: state.mtime,
			size: state.size,
			revision: state.revision,
			fingerprint,
		};
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

	private linksSignature(path: string): string {
		const metadataCache = this.app.metadataCache as {
			resolvedLinks?: Record<string, Record<string, number>>;
			unresolvedLinks?: Record<string, Record<string, number>>;
		};
		return hashRecord({
			resolved: metadataCache.resolvedLinks?.[path] ?? null,
			unresolved: metadataCache.unresolvedLinks?.[path] ?? null,
		});
	}
}
