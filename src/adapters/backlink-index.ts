import { type App, type TFile } from 'obsidian';
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

/**
 * Lazy, atomic in-memory inverse index over `MetadataCache.resolvedLinks`.
 *
 * @remarks
 * Rebuilds are wholesale and debounced by the caller because adding, deleting, or renaming
 * a note can re-resolve links across many unrelated source notes. The published snapshot is
 * never mutated: a fresh map is compared structurally and swapped in.
 */
export class BacklinkIndex {
	private readonly app: App;
	private readonly isIgnored: (file: TFile) => boolean;
	private current: BacklinkSnapshot | null = null;
	private currentRevision = 0;

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
		const next = this.build();
		if (snapshotsEqual(this.current, next)) {
			return false;
		}
		this.current = next;
		this.currentRevision++;
		return true;
	}

	/** Drops the snapshot so the next `snapshot()` rebuilds lazily. */
	dispose(): void {
		this.current = null;
	}

	/** Attaches this index's current projected backlinks to `doc`. */
	attach(doc: NormalizedDocument, target: TFile): NormalizedDocument {
		return attachBacklinks(doc, this.snapshot(), target, this.isIgnored);
	}

	private build(): BacklinkSnapshot {
		const vault = this.app.vault as {
			getFiles?: () => TFile[];
			getMarkdownFiles?: () => TFile[];
		};
		const files =
			typeof vault.getFiles === 'function'
				? vault.getFiles()
				: typeof vault.getMarkdownFiles === 'function'
					? vault.getMarkdownFiles()
					: [];

		const live = new Map<string, TFile>();
		for (const file of files) {
			if (!isLiveTFile(file)) {
				continue;
			}
			if (isMarkdownPath(file.path) && this.isIgnored(file)) {
				continue;
			}
			live.set(file.path, file);
		}

		const resolvedLinks =
			(this.app.metadataCache as { resolvedLinks?: Record<string, Record<string, number>> })
				.resolvedLinks ?? {};

		const next = new Map<TFile, Map<TFile, number>>();
		for (const sourcePath of Object.keys(resolvedLinks)) {
			const source = live.get(sourcePath);
			if (!source) {
				continue;
			}
			const destinations = resolvedLinks[sourcePath];
			if (!destinations || typeof destinations !== 'object') {
				continue;
			}
			for (const destPath of Object.keys(destinations)) {
				if (!isMarkdownPath(destPath)) {
					continue;
				}
				const target = live.get(destPath);
				if (!target) {
					continue;
				}
				const count = destinations[destPath];
				if (typeof count !== 'number' || !Number.isFinite(count)) {
					continue;
				}
				let sources = next.get(target);
				if (!sources) {
					sources = new Map<TFile, number>();
					next.set(target, sources);
				}
				sources.set(source, count);
			}
		}

		return next;
	}
}
