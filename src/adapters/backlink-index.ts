import { type App, type TFile } from 'obsidian';
import { deepFreeze } from '@core/cache/deep-freeze';
import type { BacklinkRef, NormalizedDocument } from '@core/search';
import type { LoggerPort } from '@ports/logger-port';
import {
	type BacklinkAppliedState,
	type BacklinkSnapshot,
	buildInitialBacklinkSnapshot,
	clearBacklinkState,
	createEmptyBacklinkState,
	hasBacklinkSource,
	hasBacklinkSourceChanged,
	isBacklinkGraphUnchanged,
	isLiveTFile,
	reconcileBacklinkSnapshot,
} from './backlink-reconcile';

export { type BacklinkSnapshot, isLiveTFile };

function compareBacklinkRefs(a: BacklinkRef, b: BacklinkRef): number {
	if (a.count !== b.count) {
		return b.count - a.count;
	}
	if (a.path < b.path) return -1;
	if (a.path > b.path) return 1;
	return 0;
}

export interface CachedSnapshotSourceEntry {
	readonly file: TFile;
	readonly path: string;
	readonly active: boolean;
}

export function backlinkArraysEqual(a: readonly BacklinkRef[], b: readonly BacklinkRef[]): boolean {
	if (a === b) {
		return true;
	}
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		const itemA = a[i]!;
		const itemB = b[i]!;
		if (itemA.count !== itemB.count || itemA.path !== itemB.path) {
			return false;
		}
	}
	return true;
}

export function isSnapshotSourcesUnchanged(
	entries: readonly CachedSnapshotSourceEntry[],
	isIgnored: (file: TFile) => boolean,
): boolean {
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const active = isLiveTFile(entry.file) && !isIgnored(entry.file);
		if (active !== entry.active) {
			return false;
		}
		if (active && entry.file.path !== entry.path) {
			return false;
		}
	}
	return true;
}

export function projectBacklinksWithEntries(
	sources: ReadonlyMap<TFile, number>,
	isIgnored: (file: TFile) => boolean,
): { refs: BacklinkRef[]; entries: CachedSnapshotSourceEntry[] } {
	const refs: BacklinkRef[] = [];
	const entries: CachedSnapshotSourceEntry[] = [];
	for (const [source, count] of sources) {
		const active = isLiveTFile(source) && !isIgnored(source);
		const path = source.path;
		entries.push({ file: source, path, active });
		if (active) {
			refs.push({ path, count });
		}
	}
	refs.sort(compareBacklinkRefs);
	return { refs, entries };
}

/**
 * Projects a target's backlinks into `{ path, count }` records, filtering deleted and
 * ignored sources and sorting count descending then path ascending. A fresh array (and
 * fresh records) is produced on every call so renames are reflected without a rebuild.
 */
export function projectBacklinks(
	snapshot: BacklinkSnapshot,
	target: TFile,
	isIgnored: (file: TFile) => boolean,
): BacklinkRef[] {
	const sources = snapshot.get(target);
	if (!sources) {
		return [];
	}
	const refs: BacklinkRef[] = [];
	for (const [source, count] of sources) {
		if (!isLiveTFile(source) || isIgnored(source)) {
			continue;
		}
		refs.push({ path: source.path, count });
	}
	refs.sort(compareBacklinkRefs);
	return refs;
}

/**
 * Attaches projected backlinks to a per-pass normalized document. `normalizeObsidianMetadata`
 * intentionally stays unaware of `resolvedLinks`; attachment happens here instead.
 */
export function attachBacklinks(
	doc: NormalizedDocument,
	snapshot: BacklinkSnapshot,
	target: TFile,
	isIgnored: (file: TFile) => boolean,
): NormalizedDocument {
	doc.backlinks = projectBacklinks(snapshot, target, isIgnored);
	return doc;
}

const copiedDocWithBacklinksCache = new WeakMap<NormalizedDocument, NormalizedDocument>();

/**
 * Projects backlinks onto a copy of `doc` without mutating the cached document.
 *
 * @remarks
 * (design, 2026-11-18) Cached documents are frozen and exclude backlinks. Host-document
 * resolution still needs a document that carries its backlinks (for `@this.backlinks` and the
 * `◊host` payload), so this builds a frozen shallow copy with only the projected field replaced.
 * Only the new wrapper and the fresh backlinks array need freezing; the spread fields are
 * already deep-frozen cache content.
 */
export function copyWithBacklinks(
	doc: NormalizedDocument,
	snapshot: BacklinkSnapshot,
	target: TFile,
	isIgnored: (file: TFile) => boolean,
): NormalizedDocument {
	const backlinks = projectBacklinks(snapshot, target, isIgnored);
	const cached = copiedDocWithBacklinksCache.get(doc);
	if (
		cached !== undefined &&
		cached.backlinks !== undefined &&
		backlinkArraysEqual(cached.backlinks, backlinks)
	) {
		return cached;
	}
	deepFreeze(backlinks);
	const copy = Object.freeze({
		...doc,
		backlinks,
	});
	copiedDocWithBacklinksCache.set(doc, copy);
	return copy;
}

/**
 * Lazy, atomic in-memory inverse index over `MetadataCache.resolvedLinks`.
 *
 * @remarks
 * (design, 2026-11-18; updated 2026-11-20) Diffs edges by `TFile` identity rather than path
 * strings so pure vault moves/renames update path tables without reconstructing `BacklinkSnapshot`
 * while incrementing `projectionRevision` for consumers that read projected `.path` strings.
 */
export class BacklinkIndex {
	private readonly app: App;
	private readonly isIgnored: (file: TFile) => boolean;
	private readonly logger: LoggerPort | undefined;
	private current: BacklinkSnapshot | null = null;
	private currentRevision = 0;
	private currentProjectionRevision = 0;
	private state: BacklinkAppliedState = createEmptyBacklinkState();

	constructor(app: App, isIgnored: (file: TFile) => boolean, logger?: LoggerPort) {
		this.app = app;
		this.isIgnored = isIgnored;
		this.logger = logger;
	}

	/** Whether the lazy first build has happened. */
	get isBuilt(): boolean {
		return this.current !== null;
	}

	/** Increments only when a build/reconcile produces a structurally different `TFile` snapshot. */
	get revision(): number {
		return this.currentRevision;
	}

	/**
	 * Increments whenever `revision` increments or any tracked `TFile.path` changed across a
	 * rename/move, invalidating downstream caches that depend on projected path strings.
	 */
	get projectionRevision(): number {
		return this.currentProjectionRevision;
	}

	/**
	 * Marks projected backlink path strings as potentially changed after a live `vault.on('rename')`
	 * event even before the next full `reconcile()` runs.
	 */
	notifyRename(): void {
		if (this.current !== null) {
			this.currentProjectionRevision++;
		}
	}

	/** Whether `sourcePath` is currently tracked as a backlink source in the applied snapshot. */
	hasSource(sourcePath: string): boolean {
		return hasBacklinkSource(this.state, sourcePath);
	}

	/**
	 * Checks in O(out-degree) whether `sourcePath`'s live `resolvedLinks` entry differs from
	 * the edges last applied to this index. Returns `true` when the index has not been built yet.
	 */
	hasSourceChanged(sourcePath: string): boolean {
		if (this.current === null) {
			return true;
		}
		return hasBacklinkSourceChanged(this.app, this.state, this.readResolvedLinks(), sourcePath);
	}

	/** Returns the current snapshot, building it lazily on first use. */
	snapshot(): BacklinkSnapshot {
		if (this.current === null) {
			const built = buildInitialBacklinkSnapshot(
				this.readFiles(),
				this.readResolvedLinks(),
				this.isIgnored,
			);
			this.current = built.snapshot;
			this.state = built.state;
			this.currentRevision++;
			this.currentProjectionRevision++;
		}
		return this.current;
	}

	/** Rebuilds only if the first build has already happened. Returns whether the snapshot changed. */
	rebuild(): boolean {
		if (this.current === null) {
			return false;
		}
		return this.reconcile();
	}

	/**
	 * Reconciles the inverse backlink snapshot against live vault files and
	 * `MetadataCache.resolvedLinks`. Builds the initial snapshot if not yet built.
	 * Returns whether the structural `TFile` snapshot changed.
	 */
	reconcile(): boolean {
		const startedAt = Date.now();
		if (this.current === null) {
			const built = buildInitialBacklinkSnapshot(
				this.readFiles(),
				this.readResolvedLinks(),
				this.isIgnored,
			);
			this.current = built.snapshot;
			this.state = built.state;
			this.currentRevision++;
			this.currentProjectionRevision++;
			const changed = built.snapshot.size > 0;
			this.logReconcile(
				startedAt,
				built.state.trackedSources.size,
				built.snapshot.size,
				changed,
			);
			return changed;
		}

		const files = this.readFiles();
		const resolvedLinks = this.readResolvedLinks();
		if (isBacklinkGraphUnchanged(files, resolvedLinks, this.isIgnored, this.state)) {
			this.logReconcile(startedAt, 0, 0, false);
			return false;
		}

		const outcome = reconcileBacklinkSnapshot(
			this.current,
			this.state,
			files,
			resolvedLinks,
			this.isIgnored,
		);
		this.state = outcome.state;
		if (!outcome.structuralChanged) {
			if (outcome.projectionChanged) {
				this.currentProjectionRevision++;
			}
			this.logReconcile(
				startedAt,
				outcome.changedSourceCount,
				outcome.affectedTargetCount,
				false,
			);
			return false;
		}

		this.current = outcome.snapshot;
		this.currentRevision++;
		this.currentProjectionRevision++;
		this.logReconcile(startedAt, outcome.changedSourceCount, outcome.affectedTargetCount, true);
		return true;
	}

	/** Drops the snapshot so the next `snapshot()` or `reconcile()` rebuilds from scratch. */
	dispose(): void {
		this.current = null;
		clearBacklinkState(this.state);
	}

	/** Attaches this index's current projected backlinks to `doc`. */
	attach(doc: NormalizedDocument, target: TFile): NormalizedDocument {
		return attachBacklinks(doc, this.snapshot(), target, this.isIgnored);
	}

	private readFiles(): TFile[] {
		const vault = this.app.vault as {
			getFiles?: () => TFile[];
			getMarkdownFiles?: () => TFile[];
		};
		if (typeof vault.getFiles === 'function') {
			return vault.getFiles();
		}
		return typeof vault.getMarkdownFiles === 'function' ? vault.getMarkdownFiles() : [];
	}

	private readResolvedLinks(): Record<string, Record<string, number>> {
		return (
			(this.app.metadataCache as { resolvedLinks?: Record<string, Record<string, number>> })
				.resolvedLinks ?? {}
		);
	}

	private logReconcile(
		startedAt: number,
		sourceCount: number,
		count: number,
		changed: boolean,
	): void {
		this.logger?.log('debug', 'Reconciled backlink index', {
			source: 'query.backlinks',
			durationMs: Math.max(0, Date.now() - startedAt),
			count,
			sourceCount,
			changed,
		});
	}
}
