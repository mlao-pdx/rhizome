import { type App, type TFile } from 'obsidian';
import {
	buildTargetSources,
	normalizeResolvedLinks,
	recordsEqual,
	type TargetSources,
} from '@core/backlinks/backlink-delta';
import { deepFreeze } from '@core/cache/deep-freeze';
import type { BacklinkRef, NormalizedDocument } from '@core/search';
import type { LoggerPort } from '@ports/logger-port';

/**
 * Inverse of `MetadataCache.resolvedLinks`: target note → linking source → link count.
 * Keys use `TFile` identity so renames (which mutate `TFile.path` in place) do not
 * require a rebuild.
 */
export type BacklinkSnapshot = ReadonlyMap<TFile, ReadonlyMap<TFile, number>>;

function isMarkdownPath(path: string): boolean {
	return path.toLowerCase().endsWith('.md');
}

/**
 * Centralizes the undocumented runtime `deleted` flag on `TFile`.
 */
export function isLiveTFile(file: TFile): boolean {
	return (file as { deleted?: boolean }).deleted !== true;
}

function compareBacklinkRefs(a: BacklinkRef, b: BacklinkRef): number {
	if (a.count !== b.count) {
		return b.count - a.count;
	}
	if (a.path < b.path) return -1;
	if (a.path > b.path) return 1;
	return 0;
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
	deepFreeze(backlinks);
	return Object.freeze({
		...doc,
		backlinks,
	});
}

function snapshotsEqual(a: BacklinkSnapshot, b: BacklinkSnapshot): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [target, sourcesA] of a) {
		const sourcesB = b.get(target);
		if (!sourcesB || sourcesB.size !== sourcesA.size) {
			return false;
		}
		for (const [source, count] of sourcesA) {
			if (sourcesB.get(source) !== count) {
				return false;
			}
		}
	}
	return true;
}

interface LiveVaultFiles {
	readonly liveByPath: Map<string, TFile>;
	readonly markdownTargets: Set<string>;
	readonly ignoredPaths: Set<string>;
}

/**
 * Lazy, atomic in-memory inverse index over `MetadataCache.resolvedLinks`.
 *
 * @remarks
 * (design, 2026-11-18) The published snapshot is never mutated: `reconcile()` compares live
 * non-ignored sources and Markdown targets against the last applied state, exits in O(sources +
 * targets) without allocating when nothing changed, and otherwise builds a fresh snapshot and
 * swaps it in only when structurally different. Non-Markdown sources such as `.canvas` are
 * retained; only Markdown targets and ignored Markdown notes (`DO_NOT_INDEX_OR_QUERY`) are
 * filtered.
 */
export class BacklinkIndex {
	private readonly app: App;
	private readonly isIgnored: (file: TFile) => boolean;
	private readonly logger: LoggerPort | undefined;
	private current: BacklinkSnapshot | null = null;
	private currentRevision = 0;
	private appliedSources = new Map<string, Record<string, number>>();
	private appliedTargets = new Set<string>();

	constructor(app: App, isIgnored: (file: TFile) => boolean, logger?: LoggerPort) {
		this.app = app;
		this.isIgnored = isIgnored;
		this.logger = logger;
	}

	/** Whether the lazy first build has happened. */
	get isBuilt(): boolean {
		return this.current !== null;
	}

	/** Increments only when a build/reconcile produces a structurally different snapshot. */
	get revision(): number {
		return this.currentRevision;
	}

	/** Whether `sourcePath` is currently tracked as a backlink source in the applied snapshot. */
	hasSource(sourcePath: string): boolean {
		return this.appliedSources.has(sourcePath);
	}

	/**
	 * Checks in O(out-degree) whether `sourcePath`'s live `resolvedLinks` entry differs from
	 * the record last applied to this index. Returns `true` when the index has not been built yet.
	 */
	hasSourceChanged(sourcePath: string): boolean {
		if (this.current === null) {
			return true;
		}
		const resolvedLinks = this.readResolvedLinks();
		const previous = this.appliedSources.get(sourcePath);
		const current = normalizeResolvedLinks(resolvedLinks[sourcePath]);
		return !recordsEqual(previous, current);
	}

	/** Returns the current snapshot, building it lazily on first use. */
	snapshot(): BacklinkSnapshot {
		if (this.current === null) {
			this.current = this.build();
			this.currentRevision++;
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
	 * Returns whether the projected snapshot changed.
	 */
	reconcile(): boolean {
		const startedAt = Date.now();
		if (this.current === null) {
			const initial = this.build();
			this.current = initial;
			this.currentRevision++;
			const changed = initial.size > 0;
			this.logReconcile(startedAt, this.appliedSources.size, initial.size, changed);
			return changed;
		}

		const { liveByPath, markdownTargets, ignoredPaths } = this.collectLiveFiles();
		const resolvedLinks = this.readResolvedLinks();
		const nextSources = new Map<string, Record<string, number>>();
		for (const sourcePath of Object.keys(resolvedLinks)) {
			if (!liveByPath.has(sourcePath)) {
				continue;
			}
			const destinations = normalizeResolvedLinks(resolvedLinks[sourcePath]);
			if (destinations !== undefined) {
				nextSources.set(sourcePath, destinations);
			}
		}

		const affectedTargets = new Set<string>();
		let changedSourceCount = 0;

		for (const [sourcePath, oldDest] of this.appliedSources) {
			const newDest = nextSources.get(sourcePath);
			if (!recordsEqual(oldDest, newDest)) {
				changedSourceCount++;
				for (const target of Object.keys(oldDest)) {
					affectedTargets.add(target);
				}
				if (newDest) {
					for (const target of Object.keys(newDest)) {
						affectedTargets.add(target);
					}
				}
			}
		}
		for (const [sourcePath, newDest] of nextSources) {
			if (!this.appliedSources.has(sourcePath)) {
				changedSourceCount++;
				for (const target of Object.keys(newDest)) {
					affectedTargets.add(target);
				}
			}
		}

		let targetSetChanged = false;
		for (const [target, sources] of this.current) {
			if (liveByPath.get(target.path) !== target || !markdownTargets.has(target.path)) {
				targetSetChanged = true;
				affectedTargets.add(target.path);
				continue;
			}
			for (const source of sources.keys()) {
				if (liveByPath.get(source.path) !== source) {
					targetSetChanged = true;
					affectedTargets.add(target.path);
					break;
				}
			}
		}
		for (const targetPath of markdownTargets) {
			if (!this.appliedTargets.has(targetPath)) {
				targetSetChanged = true;
				affectedTargets.add(targetPath);
			}
		}
		for (const targetPath of this.appliedTargets) {
			if (!markdownTargets.has(targetPath)) {
				targetSetChanged = true;
				affectedTargets.add(targetPath);
			}
		}

		if (changedSourceCount === 0 && !targetSetChanged) {
			this.logReconcile(startedAt, 0, 0, false);
			return false;
		}

		const previous = this.current;
		const next = this.buildFromState(liveByPath, markdownTargets, ignoredPaths, nextSources);
		if (snapshotsEqual(previous, next)) {
			this.logReconcile(startedAt, changedSourceCount, affectedTargets.size, false);
			return false;
		}
		this.current = next;
		this.currentRevision++;
		this.logReconcile(startedAt, changedSourceCount, affectedTargets.size, true);
		return true;
	}

	/** Drops the snapshot so the next `snapshot()` or `reconcile()` rebuilds from scratch. */
	dispose(): void {
		this.current = null;
		this.appliedSources.clear();
		this.appliedTargets.clear();
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

	private collectLiveFiles(): LiveVaultFiles {
		const files = this.readFiles();
		const liveByPath = new Map<string, TFile>();
		const markdownTargets = new Set<string>();
		const ignoredPaths = new Set<string>();

		for (const file of files) {
			if (!isLiveTFile(file)) {
				continue;
			}
			if (isMarkdownPath(file.path)) {
				if (this.isIgnored(file)) {
					ignoredPaths.add(file.path);
					continue;
				}
				markdownTargets.add(file.path);
			}
			liveByPath.set(file.path, file);
		}

		return { liveByPath, markdownTargets, ignoredPaths };
	}

	private build(): BacklinkSnapshot {
		const { liveByPath, markdownTargets, ignoredPaths } = this.collectLiveFiles();
		const resolvedLinks = this.readResolvedLinks();
		const nextSources = new Map<string, Record<string, number>>();
		for (const sourcePath of Object.keys(resolvedLinks)) {
			if (!liveByPath.has(sourcePath)) {
				continue;
			}
			const destinations = normalizeResolvedLinks(resolvedLinks[sourcePath]);
			if (destinations !== undefined) {
				nextSources.set(sourcePath, destinations);
			}
		}
		return this.buildFromState(liveByPath, markdownTargets, ignoredPaths, nextSources);
	}

	private buildFromState(
		liveByPath: ReadonlyMap<string, TFile>,
		markdownTargets: Set<string>,
		ignoredPaths: ReadonlySet<string>,
		nextSources: Map<string, Record<string, number>>,
	): BacklinkSnapshot {
		const filteredLinks = Object.create(null) as Record<
			string,
			Record<string, number> | undefined
		>;
		for (const [sourcePath, destinations] of nextSources) {
			filteredLinks[sourcePath] = destinations;
		}

		const pathSources = buildTargetSources(filteredLinks, ignoredPaths);
		for (const target of [...pathSources.keys()]) {
			if (!markdownTargets.has(target)) {
				pathSources.delete(target);
			}
		}

		this.appliedSources = nextSources;
		this.appliedTargets = markdownTargets;
		return this.projectSnapshot(pathSources, liveByPath);
	}

	private projectSnapshot(
		pathSources: TargetSources,
		liveByPath: ReadonlyMap<string, TFile>,
	): BacklinkSnapshot {
		const next = new Map<TFile, Map<TFile, number>>();
		for (const [targetPath, sources] of pathSources) {
			const target = liveByPath.get(targetPath);
			if (!target) continue;
			const projected = new Map<TFile, number>();
			for (const [sourcePath, count] of sources) {
				const source = liveByPath.get(sourcePath);
				if (!source || !isLiveTFile(source)) continue;
				projected.set(source, count);
			}
			if (projected.size > 0) {
				next.set(target, projected);
			}
		}
		return next;
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
