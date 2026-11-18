import { type App, type TFile } from 'obsidian';
import {
	buildTargetSources,
	diffSources,
	hashTargetSources,
	RollingMultisetHash,
	type TargetSources,
} from '@core/backlinks/backlink-delta';
import { deepFreeze } from '@core/cache/deep-freeze';
import type { BacklinkRef, NormalizedDocument } from '@core/search';

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
 */
export function copyWithBacklinks(
	doc: NormalizedDocument,
	snapshot: BacklinkSnapshot,
	target: TFile,
	isIgnored: (file: TFile) => boolean,
): NormalizedDocument {
	return deepFreeze({
		...doc,
		backlinks: projectBacklinks(snapshot, target, isIgnored),
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

function toRecord(sources: ReadonlyMap<string, number>): Record<string, number> {
	const record = Object.create(null) as Record<string, number>;
	for (const [source, count] of sources) {
		record[source] = count;
	}
	return record;
}

function normalizeResolvedLinks(raw: unknown): Record<string, number> | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const record = Object.create(null) as Record<string, number>;
	let any = false;
	for (const [target, count] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof count === 'number' && Number.isFinite(count)) {
			record[target] = count;
			any = true;
		}
	}
	const empty = Object.create(null) as Record<string, number>;
	return any ? record : empty;
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
		if (a[key] !== b[key]) return false;
	}
	return true;
}

/**
 * Lazy, atomic in-memory inverse index over `MetadataCache.resolvedLinks`.
 *
 * @remarks
 * (design, 2026-11-18) The published snapshot is never mutated: a fresh map is compared
 * structurally and swapped in. `applyDirtySources` updates a path-keyed inverse index only for
 * sources whose `resolvedLinks` entry changed, re-projects the affected targets, and uses a
 * rolling target hash to skip the snapshot swap when nothing visible changed. `rebuild()` remains
 * the full-build oracle. Non-Markdown sources such as `.canvas` are retained; only Markdown
 * targets and ignored Markdown sources are filtered.
 */
export class BacklinkIndex {
	private readonly app: App;
	private readonly isIgnored: (file: TFile) => boolean;
	private current: BacklinkSnapshot | null = null;
	private currentRevision = 0;
	private pathSources: TargetSources | null = null;
	private appliedSources = new Map<string, Record<string, number>>();
	private ignoredTargets = new Set<string>();
	private rolling = new RollingMultisetHash();

	constructor(app: App, isIgnored: (file: TFile) => boolean) {
		this.app = app;
		this.isIgnored = isIgnored;
	}

	/** Whether the lazy first build has happened. */
	get isBuilt(): boolean {
		return this.current !== null;
	}

	/** Increments only when a rebuild produces a structurally different snapshot. */
	get revision(): number {
		return this.currentRevision;
	}

	/** Returns the current snapshot, building it lazily on first use. */
	snapshot(): BacklinkSnapshot {
		if (this.current === null) {
			this.build();
			this.currentRevision++;
		}
		return this.current!;
	}

	/** Rebuilds only if the first build has already happened. Returns whether the snapshot changed. */
	rebuild(): boolean {
		if (this.current === null) {
			return false;
		}
		const previous = this.current;
		const next = this.build();
		if (snapshotsEqual(previous, next)) {
			return false;
		}
		this.currentRevision++;
		return true;
	}

	/**
	 * Applies `resolvedLinks` changes for the given source paths and ignore-flag changes.
	 * Returns whether the projected snapshot changed.
	 */
	applyDirtySources(sources: Iterable<string>, ignoredChanges: Iterable<string> = []): boolean {
		if (this.current === null || this.pathSources === null) {
			this.build();
			this.currentRevision++;
			return true;
		}

		const ignoredList = [...ignoredChanges];
		const dirty = new Set<string>(sources);
		for (const path of ignoredList) {
			dirty.add(path);
		}

		const files = this.readFiles();
		const liveByPath = new Map<string, TFile>();
		for (const file of files) {
			if (isLiveTFile(file)) {
				liveByPath.set(file.path, file);
			}
		}
		const ignoredNow = new Set<string>();
		for (const [path, file] of liveByPath) {
			if (isMarkdownPath(path) && this.isIgnored(file)) {
				ignoredNow.add(path);
			}
		}

		const resolvedLinks = this.readResolvedLinks();
		const oldRecords: Record<string, Record<string, number> | undefined> = Object.create(
			null,
		) as Record<string, Record<string, number> | undefined>;
		const newRecords: Record<string, Record<string, number> | undefined> = Object.create(
			null,
		) as Record<string, Record<string, number> | undefined>;

		for (const path of dirty) {
			oldRecords[path] = this.appliedSources.get(path);
			const source = liveByPath.get(path);
			const next =
				source === undefined || ignoredNow.has(path)
					? undefined
					: normalizeResolvedLinks(resolvedLinks[path]);
			newRecords[path] = next;
		}

		const affected = diffSources(oldRecords, newRecords, ignoredList);
		const beforeDigest = this.rolling.digest();

		for (const path of dirty) {
			const oldRecord = this.appliedSources.get(path);
			const newRecord = newRecords[path];
			if (recordsEqual(oldRecord, newRecord)) {
				continue;
			}
			const oldDest = oldRecord ?? {};
			const newDest = newRecord ?? {};
			for (const target of Object.keys(oldDest)) {
				this.removeContribution(target, path);
			}
			for (const target of Object.keys(newDest)) {
				this.addContribution(target, path, newDest[target]!);
			}
			if (newRecord === undefined) {
				this.appliedSources.delete(path);
			} else {
				this.appliedSources.set(path, newRecord);
			}
		}

		for (const path of ignoredNow) {
			this.removeTarget(path);
			affected.add(path);
		}

		// Un-ignoring a target restores inbound links that were filtered out of the previous
		// projection even though no source's `resolvedLinks` record changed.
		for (const path of this.ignoredTargets) {
			if (ignoredNow.has(path) || !isMarkdownPath(path) || !liveByPath.has(path)) {
				continue;
			}
			for (const [source, record] of this.appliedSources) {
				const count = record[path];
				if (count !== undefined) {
					this.addContribution(path, source, count);
					affected.add(path);
				}
			}
		}
		this.ignoredTargets = ignoredNow;

		let targetSetChanged = false;
		for (const target of this.current.keys()) {
			const live = liveByPath.get(target.path);
			if (
				live === undefined ||
				live !== target ||
				!isLiveTFile(target) ||
				(isMarkdownPath(target.path) && this.isIgnored(target))
			) {
				targetSetChanged = true;
				break;
			}
		}

		if (!targetSetChanged && beforeDigest === this.rolling.digest()) {
			return false;
		}
		return this.swapProjectedSnapshot(liveByPath, affected);
	}

	/** Drops the snapshot so the next `snapshot()` rebuilds lazily. */
	dispose(): void {
		this.current = null;
		this.pathSources = null;
		this.appliedSources.clear();
		this.ignoredTargets.clear();
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

	private build(): BacklinkSnapshot {
		const files = this.readFiles();

		const live = new Map<string, TFile>();
		const ignored = new Set<string>();
		for (const file of files) {
			if (!isLiveTFile(file)) {
				continue;
			}
			if (isMarkdownPath(file.path) && this.isIgnored(file)) {
				ignored.add(file.path);
				continue;
			}
			live.set(file.path, file);
		}

		const resolvedLinks = this.readResolvedLinks();
		const filteredLinks: Record<string, Record<string, number> | undefined> = Object.create(
			null,
		) as Record<string, Record<string, number> | undefined>;
		this.appliedSources = new Map();
		for (const sourcePath of Object.keys(resolvedLinks)) {
			if (!live.has(sourcePath)) {
				continue;
			}
			const destinations = normalizeResolvedLinks(resolvedLinks[sourcePath]);
			if (destinations !== undefined) {
				filteredLinks[sourcePath] = destinations;
				this.appliedSources.set(sourcePath, destinations);
			}
		}

		const pathSources = buildTargetSources(filteredLinks, ignored);
		for (const target of [...pathSources.keys()]) {
			if (!isMarkdownPath(target) || !live.has(target)) {
				pathSources.delete(target);
			}
		}

		this.pathSources = pathSources;
		this.ignoredTargets = ignored;
		this.resetRolling(pathSources);
		this.current = this.projectSnapshot(pathSources, live);
		return this.current;
	}

	private resetRolling(pathSources: TargetSources): void {
		this.rolling = new RollingMultisetHash();
		for (const sources of pathSources.values()) {
			this.rolling.add(hashTargetSources(toRecord(sources)));
		}
	}

	private addContribution(target: string, source: string, count: number): void {
		if (!this.pathSources) return;
		let sources = this.pathSources.get(target);
		const previous = sources ? hashTargetSources(toRecord(sources)) : 0;
		if (!sources) {
			sources = new Map();
			this.pathSources.set(target, sources);
		}
		sources.set(source, count);
		this.adjustRolling(previous, hashTargetSources(toRecord(sources)));
	}

	private removeContribution(target: string, source: string): void {
		if (!this.pathSources) return;
		const sources = this.pathSources.get(target);
		if (!sources) return;
		const previous = hashTargetSources(toRecord(sources));
		sources.delete(source);
		const next = sources.size === 0 ? 0 : hashTargetSources(toRecord(sources));
		this.adjustRolling(previous, next);
		if (sources.size === 0) {
			this.pathSources.delete(target);
		}
	}

	private removeTarget(target: string): void {
		if (!this.pathSources) return;
		const sources = this.pathSources.get(target);
		if (!sources) return;
		this.adjustRolling(hashTargetSources(toRecord(sources)), 0);
		this.pathSources.delete(target);
	}

	private adjustRolling(previous: number, next: number): void {
		this.rolling.remove(previous);
		this.rolling.add(next);
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

	private swapProjectedSnapshot(
		liveByPath: ReadonlyMap<string, TFile>,
		affected: ReadonlySet<string>,
	): boolean {
		const current = this.current;
		if (current === null) {
			return false;
		}
		const next = new Map(current);
		const targetByPath = new Map<string, TFile>();
		for (const [path, file] of liveByPath) {
			if (isMarkdownPath(path)) {
				targetByPath.set(path, file);
			}
		}
		for (const target of [...next.keys()]) {
			if (
				targetByPath.get(target.path) !== target ||
				!isLiveTFile(target) ||
				(isMarkdownPath(target.path) && this.isIgnored(target))
			) {
				next.delete(target);
			}
		}
		for (const targetPath of affected) {
			const target = targetByPath.get(targetPath);
			if (!target) continue;
			const sources = this.pathSources?.get(targetPath);
			if (!sources || sources.size === 0) {
				next.delete(target);
				continue;
			}
			const projected = new Map<TFile, number>();
			for (const [sourcePath, count] of sources) {
				const source = liveByPath.get(sourcePath);
				if (!source || !isLiveTFile(source)) continue;
				projected.set(source, count);
			}
			if (projected.size > 0) {
				next.set(target, projected);
			} else {
				next.delete(target);
			}
		}
		if (snapshotsEqual(current, next)) {
			return false;
		}
		this.current = next;
		this.currentRevision++;
		return true;
	}
}
