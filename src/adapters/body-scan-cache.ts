import type { App, CachedMetadata, TFile } from 'obsidian';
import {
	digestBodyScanResult,
	scanNoteBody,
	type ExtractedTaskInput,
	type ObsidianBodyScannerCacheInput,
} from '@core/scanner';
import {
	hasInternalRhizomeFlag,
	INTERNAL_RHIZOME_CODES,
	type InlinePropertyInput,
} from '@core/search';
import type { LoggerPort } from '@ports/logger-port';
import { BodyScanIdbStore, type PersistedBodyScanRecord } from './body-scan-idb';
import { markSensitive } from './logger-format';

export const EMPTY_BODY_DIGEST = digestBodyScanResult({
	inlineProperties: [],
	tasks: [],
});

const EMPTY_INLINE_PROPERTIES: readonly InlinePropertyInput[] = Object.freeze([]);
const EMPTY_TASKS: readonly ExtractedTaskInput[] = Object.freeze([]);
const RECONCILE_BATCH_SIZE = 25;
const IDB_FLUSH_DEBOUNCE_MS = 250;

export interface BodyScanCacheEntry {
	readonly path: string;
	readonly mtime: number;
	readonly size: number;
	readonly bodyDigest: string;
	readonly bodyRev: number;
	readonly inlineProperties: readonly InlinePropertyInput[];
	readonly tasks: readonly ExtractedTaskInput[];
}

function isIgnoredMetadata(cache: CachedMetadata | null | undefined): boolean {
	return hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY);
}

function resolveDbName(app: App): string {
	const rawAppId = (app as { appId?: unknown }).appId;
	const suffix =
		typeof rawAppId === 'string' && rawAppId.trim().length > 0 ? rawAppId.trim() : 'default';
	return `rhizome-${suffix}`;
}

/**
 * In-memory cache of raw per-note body scan extracts (`inlineProperties` and `tasks`),
 * backed by native IndexedDB persistence and gated by 64-bit `bodyDigest` true-change checks.
 *
 * @remarks
 * (design, 2026-11-19) Decouples Markdown body scanning from `NormalizedDocumentCache`:
 * prose-only edits that do not alter any task or inline property keep the note's `bodyRev`
 * unchanged, preventing downstream document re-normalization and reactive query nudges.
 * Stored `mtime` values are clamped via `Math.min(stat.mtime, now)` so future-dated files
 * cannot permanently mask subsequent edits.
 */
export class BodyScanCache {
	private readonly app: App;
	private readonly logger: LoggerPort | undefined;
	private readonly idb: BodyScanIdbStore;
	private readonly nowFn: () => number;
	private readonly store = new Map<string, BodyScanCacheEntry>();
	private readonly pendingPuts = new Map<string, PersistedBodyScanRecord>();
	private readonly pendingDeletes = new Set<string>();
	private readonly pendingRenames = new Map<string, string>();
	private readonly pendingRenameOrigins = new Map<string, string>();
	private readonly preHydrationDeletes = new Set<string>();
	private hydrationCompleted = false;
	private flushTimer: number | null = null;
	private nextRev = 1;
	private reconcileToken = 0;
	private disposed = false;

	constructor(
		app: App,
		logger?: LoggerPort,
		idbStore?: BodyScanIdbStore,
		nowFn: () => number = () => Date.now(),
	) {
		this.app = app;
		this.logger = logger;
		this.idb = idbStore ?? new BodyScanIdbStore(resolveDbName(app));
		this.nowFn = nowFn;
	}

	get size(): number {
		return this.store.size;
	}

	getEntry(path: string): BodyScanCacheEntry | undefined {
		return this.store.get(path);
	}

	getBodyRevision(path: string): number {
		return this.store.get(path)?.bodyRev ?? 0;
	}

	getInlineProperties(path: string): readonly InlinePropertyInput[] {
		return this.store.get(path)?.inlineProperties ?? EMPTY_INLINE_PROPERTIES;
	}

	getTasks(path: string): readonly ExtractedTaskInput[] {
		return this.store.get(path)?.tasks ?? EMPTY_TASKS;
	}

	/**
	 * Hydrates the in-memory map from IndexedDB on startup without overwriting any
	 * entry that was already populated by a newer live event.
	 */
	async hydrateFromIndexedDB(): Promise<number> {
		if (this.disposed) {
			return 0;
		}
		const records = await this.idb.getAll();
		if (this.disposed) {
			return 0;
		}
		const pendingRenames = new Map(this.pendingRenames);
		const preHydrationDeletes = new Set(this.preHydrationDeletes);
		this.hydrationCompleted = true;
		this.clearPreHydrationTracking();

		if (records.length === 0) {
			return 0;
		}
		const now = this.nowFn();
		const retiredOrigins: string[] = [];
		let hydrated = 0;
		for (const rec of records) {
			if (!rec || typeof rec.path !== 'string' || rec.path.length === 0) {
				continue;
			}
			if (preHydrationDeletes.has(rec.path)) {
				retiredOrigins.push(rec.path);
				continue;
			}
			const targetPath = pendingRenames.get(rec.path) ?? rec.path;
			const wasRenamed = targetPath !== rec.path;
			if (wasRenamed) {
				retiredOrigins.push(rec.path);
			}
			const existing = this.store.get(targetPath);
			if (existing !== undefined && existing.mtime >= rec.mtime) {
				continue;
			}
			const clampedMtime = Math.min(rec.mtime, now);
			const bodyRev =
				existing !== undefined
					? existing.bodyDigest === rec.bodyDigest
						? existing.bodyRev
						: ++this.nextRev
					: rec.bodyDigest === EMPTY_BODY_DIGEST
						? 0
						: ++this.nextRev;
			const entry: BodyScanCacheEntry = {
				path: targetPath,
				mtime: clampedMtime,
				size: rec.size,
				bodyDigest: rec.bodyDigest,
				bodyRev,
				inlineProperties: rec.inlineProperties ?? EMPTY_INLINE_PROPERTIES,
				tasks: rec.tasks ?? EMPTY_TASKS,
			};
			this.store.set(targetPath, entry);
			if (wasRenamed) {
				this.queuePut(entry);
			}
			hydrated++;
		}
		for (const oldOrigin of retiredOrigins) {
			if (!this.store.has(oldOrigin) && !this.pendingPuts.has(oldOrigin)) {
				this.pendingDeletes.add(oldOrigin);
				this.scheduleFlush();
			}
		}
		return hydrated;
	}

	/**
	 * Synchronously scans `text` for `file` and updates the in-memory cache.
	 * Returns `true` iff the note's effective `bodyDigest` changed (or a non-empty entry was evicted).
	 */
	ingestFromText(
		file: Pick<TFile, 'path' | 'stat'>,
		text: string,
		cache?: CachedMetadata | ObsidianBodyScannerCacheInput | null,
	): boolean {
		if (this.disposed) {
			return false;
		}
		if (isIgnoredMetadata(cache as CachedMetadata | null | undefined)) {
			return this.delete(file.path);
		}

		if (!this.hydrationCompleted) {
			const origin = this.resolvePreHydrationOrigin(file.path);
			if (origin !== null && origin !== file.path) {
				this.deletePendingRename(origin);
				this.preHydrationDeletes.add(origin);
				if (!this.store.has(origin) && !this.pendingPuts.has(origin)) {
					this.pendingDeletes.add(origin);
					this.scheduleFlush();
				}
			}
		}

		const now = this.nowFn();
		const rawMtime = file.stat?.mtime ?? 0;
		const clampedMtime = Math.min(rawMtime, now);
		const size = file.stat?.size ?? 0;

		const scanned = scanNoteBody(text, cache);
		const nextDigest =
			scanned.inlineProperties.length === 0 && scanned.tasks.length === 0
				? EMPTY_BODY_DIGEST
				: digestBodyScanResult(scanned);

		const prev = this.store.get(file.path);
		const digestChanged =
			prev === undefined ? nextDigest !== EMPTY_BODY_DIGEST : prev.bodyDigest !== nextDigest;

		const bodyRev = digestChanged ? ++this.nextRev : prev !== undefined ? prev.bodyRev : 0;

		const nextEntry: BodyScanCacheEntry = {
			path: file.path,
			mtime: clampedMtime,
			size,
			bodyDigest: nextDigest,
			bodyRev,
			inlineProperties:
				scanned.inlineProperties.length === 0
					? EMPTY_INLINE_PROPERTIES
					: scanned.inlineProperties,
			tasks: scanned.tasks.length === 0 ? EMPTY_TASKS : scanned.tasks,
		};
		this.store.set(file.path, nextEntry);

		if (
			prev === undefined ||
			prev.mtime !== clampedMtime ||
			prev.size !== size ||
			prev.bodyDigest !== nextDigest
		) {
			this.queuePut(nextEntry);
		}

		return digestChanged;
	}

	/**
	 * Removes `path` from the in-memory cache and queues an IndexedDB deletion.
	 * Returns `true` if the removed entry held non-empty tasks or inline properties.
	 */
	delete(path: string): boolean {
		if (this.disposed || path.length === 0) {
			return false;
		}
		if (!this.hydrationCompleted) {
			const origin = this.resolvePreHydrationOrigin(path);
			if (origin !== null) {
				this.deletePendingRename(origin);
				this.preHydrationDeletes.add(origin);
				if (!this.store.has(origin) && !this.pendingPuts.has(origin)) {
					this.pendingDeletes.add(origin);
					this.scheduleFlush();
				}
			}
		}
		const prev = this.store.get(path);
		if (prev === undefined) {
			return false;
		}
		this.store.delete(path);
		this.pendingPuts.delete(path);
		this.pendingDeletes.add(path);
		this.scheduleFlush();
		return prev.bodyDigest !== EMPTY_BODY_DIGEST;
	}

	/**
	 * Re-keys a cached body-scan entry from `oldPath` to `newPath` across vault moves/renames,
	 * preserving extracted tasks, inline properties, and `bodyRev` without re-reading disk.
	 * Returns `true` if a non-empty entry was moved or overwritten.
	 */
	rename(oldPath: string, newPath: string): boolean {
		if (this.disposed || oldPath.length === 0 || newPath.length === 0 || oldPath === newPath) {
			return false;
		}

		if (!this.hydrationCompleted) {
			const overwrittenOrigin = this.resolvePreHydrationOrigin(newPath);
			const sourceOrigin = this.resolvePreHydrationOrigin(oldPath);
			if (overwrittenOrigin !== null && overwrittenOrigin !== sourceOrigin) {
				this.deletePendingRename(overwrittenOrigin);
				this.preHydrationDeletes.add(overwrittenOrigin);
				if (
					!this.store.has(overwrittenOrigin) &&
					!this.pendingPuts.has(overwrittenOrigin)
				) {
					this.pendingDeletes.add(overwrittenOrigin);
					this.scheduleFlush();
				}
			}
			if (this.store.has(oldPath)) {
				if (sourceOrigin !== null) {
					this.deletePendingRename(sourceOrigin);
					this.preHydrationDeletes.add(sourceOrigin);
				}
			} else if (sourceOrigin !== null) {
				if (sourceOrigin === newPath) {
					this.deletePendingRename(sourceOrigin);
				} else {
					this.setPendingRename(sourceOrigin, newPath);
				}
			}
		}

		const prev = this.store.get(oldPath);
		const existingTarget = this.store.get(newPath);

		if (prev === undefined) {
			if (existingTarget !== undefined) {
				this.store.delete(newPath);
				this.pendingPuts.delete(newPath);
				this.pendingDeletes.add(newPath);
				this.scheduleFlush();
				return existingTarget.bodyDigest !== EMPTY_BODY_DIGEST;
			}
			return false;
		}

		this.store.delete(oldPath);
		this.pendingPuts.delete(oldPath);
		this.pendingDeletes.add(oldPath);

		const bodyRev =
			existingTarget !== undefined && existingTarget.bodyDigest !== prev.bodyDigest
				? ++this.nextRev
				: prev.bodyRev;

		const rekeyed: BodyScanCacheEntry = {
			path: newPath,
			mtime: prev.mtime,
			size: prev.size,
			bodyDigest: prev.bodyDigest,
			bodyRev,
			inlineProperties: prev.inlineProperties,
			tasks: prev.tasks,
		};
		this.store.set(newPath, rekeyed);
		this.queuePut(rekeyed);

		return (
			prev.bodyDigest !== EMPTY_BODY_DIGEST ||
			(existingTarget !== undefined && existingTarget.bodyDigest !== EMPTY_BODY_DIGEST)
		);
	}

	/**
	 * Reconciles all live Markdown files in the vault against the in-memory `BodyScanCache`,
	 * reading and scanning only missing, stale, or future-dated files in batches.
	 */
	async reconcileVaultBodies(onTrueChange?: () => void): Promise<{
		scanned: number;
		hits: number;
		evicted: number;
		changed: number;
	}> {
		if (this.disposed) {
			return { scanned: 0, hits: 0, evicted: 0, changed: 0 };
		}
		const token = ++this.reconcileToken;
		const now = this.nowFn();
		const files = this.app.vault.getMarkdownFiles();
		const livePaths = new Set<string>();
		const misses: TFile[] = [];
		let hits = 0;
		let evicted = 0;
		let changed = 0;

		for (const file of files) {
			if (
				(file as { deleted?: boolean }).deleted ||
				!file.path.toLowerCase().endsWith('.md')
			) {
				continue;
			}
			const cache = this.app.metadataCache.getFileCache(file);
			if (isIgnoredMetadata(cache)) {
				if (this.delete(file.path)) {
					changed++;
				}
				evicted++;
				continue;
			}
			livePaths.add(file.path);

			const stored = this.store.get(file.path);
			const rawMtime = file.stat?.mtime ?? 0;
			const size = file.stat?.size ?? 0;
			if (
				stored !== undefined &&
				rawMtime <= now &&
				stored.mtime === rawMtime &&
				stored.size === size
			) {
				hits++;
				continue;
			}
			misses.push(file);
		}

		for (const existingPath of [...this.store.keys()]) {
			if (!livePaths.has(existingPath)) {
				if (this.delete(existingPath)) {
					changed++;
				}
				evicted++;
			}
		}

		if (changed > 0) {
			onTrueChange?.();
		}

		let scanned = 0;
		for (let i = 0; i < misses.length; i += RECONCILE_BATCH_SIZE) {
			if (this.disposed || token !== this.reconcileToken) {
				break;
			}
			const batch = misses.slice(i, i + RECONCILE_BATCH_SIZE);
			let batchChanged = false;

			for (const file of batch) {
				if (this.disposed || token !== this.reconcileToken) {
					break;
				}
				if ((file as { deleted?: boolean }).deleted) {
					continue;
				}
				const cacheBefore = this.app.metadataCache.getFileCache(file);
				if (isIgnoredMetadata(cacheBefore)) {
					if (this.delete(file.path)) {
						batchChanged = true;
						changed++;
					}
					continue;
				}

				const storedBeforeRead = this.store.get(file.path);
				let text: string;
				try {
					text = await this.app.vault.cachedRead(file);
				} catch (error) {
					const errStr = String(error);
					if (!errStr.includes('ENOENT')) {
						this.logger?.log(
							'warn',
							`Failed to read note body for indexing: ${markSensitive(file.path)}`,
							{
								source: 'scanner.cache',
								error: markSensitive(errStr),
							},
						);
					}
					continue;
				}

				if (this.disposed || token !== this.reconcileToken) {
					break;
				}
				if ((file as { deleted?: boolean }).deleted) {
					continue;
				}

				// Guard against overwriting a live metadataCache.on('changed') update that arrived during cachedRead
				const currentStored = this.store.get(file.path);
				if (currentStored !== undefined && currentStored !== storedBeforeRead) {
					continue;
				}

				const latestCache = this.app.metadataCache.getFileCache(file);
				const fileChanged = this.ingestFromText(file, text, latestCache);
				scanned++;
				if (fileChanged) {
					batchChanged = true;
					changed++;
				}
			}

			if (batchChanged) {
				onTrueChange?.();
			}
		}

		if (!this.disposed && token === this.reconcileToken) {
			this.hydrationCompleted = true;
			this.clearPreHydrationTracking();
		}

		await this.flushToIndexedDB();
		return { scanned, hits, evicted, changed };
	}

	/**
	 * Clears all in-memory and persisted IndexedDB entries.
	 */
	async clearAll(): Promise<void> {
		this.reconcileToken++;
		this.clearFlushTimer();
		this.hydrationCompleted = true;
		this.clearPreHydrationTracking();
		this.pendingPuts.clear();
		this.pendingDeletes.clear();
		this.store.clear();
		await this.idb.clear();
	}

	async flushToIndexedDB(): Promise<void> {
		this.clearFlushTimer();
		if (this.disposed || (this.pendingPuts.size === 0 && this.pendingDeletes.size === 0)) {
			return;
		}
		const puts = [...this.pendingPuts.values()];
		const deletes = [...this.pendingDeletes];
		this.pendingPuts.clear();
		this.pendingDeletes.clear();
		await this.idb.flushBatch(puts, deletes);
	}

	dispose(): void {
		this.reconcileToken++;
		this.clearFlushTimer();
		const puts = [...this.pendingPuts.values()];
		const deletes = [...this.pendingDeletes];
		this.clearPreHydrationTracking();
		this.pendingPuts.clear();
		this.pendingDeletes.clear();
		this.store.clear();
		if (puts.length > 0 || deletes.length > 0) {
			void this.idb.flushBatch(puts, deletes).finally(() => this.idb.close());
		} else {
			this.idb.close();
		}
		this.disposed = true;
	}

	private setPendingRename(origin: string, target: string): void {
		const prevTarget = this.pendingRenames.get(origin);
		if (prevTarget !== undefined && this.pendingRenameOrigins.get(prevTarget) === origin) {
			this.pendingRenameOrigins.delete(prevTarget);
		}
		this.pendingRenames.set(origin, target);
		this.pendingRenameOrigins.set(target, origin);
	}

	private deletePendingRename(origin: string): void {
		const prevTarget = this.pendingRenames.get(origin);
		if (prevTarget !== undefined) {
			this.pendingRenames.delete(origin);
			if (this.pendingRenameOrigins.get(prevTarget) === origin) {
				this.pendingRenameOrigins.delete(prevTarget);
			}
		}
	}

	private clearPreHydrationTracking(): void {
		this.pendingRenames.clear();
		this.pendingRenameOrigins.clear();
		this.preHydrationDeletes.clear();
	}

	private resolvePreHydrationOrigin(livePath: string): string | null {
		const mappedOrigin = this.pendingRenameOrigins.get(livePath);
		if (mappedOrigin !== undefined) {
			return mappedOrigin;
		}
		if (!this.preHydrationDeletes.has(livePath) && !this.pendingRenames.has(livePath)) {
			return livePath;
		}
		return null;
	}

	private queuePut(entry: BodyScanCacheEntry): void {
		this.pendingDeletes.delete(entry.path);
		this.pendingPuts.set(entry.path, {
			path: entry.path,
			mtime: entry.mtime,
			size: entry.size,
			bodyDigest: entry.bodyDigest,
			inlineProperties: entry.inlineProperties,
			tasks: entry.tasks,
		});
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.disposed || this.flushTimer !== null || typeof window === 'undefined') {
			return;
		}
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.flushToIndexedDB();
		}, IDB_FLUSH_DEBOUNCE_MS);
	}

	private clearFlushTimer(): void {
		if (this.flushTimer !== null && typeof window !== 'undefined') {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}
}
