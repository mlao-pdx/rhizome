/** Snapshot of pending changes drained at the top of one query/nudge pass. */
export interface DrainedDirtySet {
	/** Paths whose cached Markdown document may need re-normalization. */
	readonly paths: ReadonlySet<string>;
	/** Paths whose `resolvedLinks` entry may have changed (Markdown or otherwise). */
	readonly sources: ReadonlySet<string>;
	/** Paths whose `DO_NOT_INDEX_OR_QUERY` flag changed. */
	readonly ignored: ReadonlySet<string>;
	/** Whether a full structural rebuild was requested instead of an incremental delta. */
	readonly fullRebuild: boolean;
	/** Whether anything at all was pending. */
	readonly changed: boolean;
}

/**
 * Collects event-derived paths for the next pass without writing any cache state itself.
 *
 * @remarks
 * (design, 2026-11-18) Obsidian events arrive in bursts and can be dropped. Collecting them into a
 * set keeps event handling free of cache writes, so one consistent batch is applied at pass
 * start. `sources` is intentionally broader than `paths`: `.canvas` and other non-Markdown files
 * contribute backlinks even though they have no cached normalized document.
 */
export class DirtySet {
	private readonly paths = new Set<string>();
	private readonly sources = new Set<string>();
	private readonly ignored = new Set<string>();
	private fullRebuild = false;

	/** Marks a Markdown note as potentially changed. */
	markPath(path: string): void {
		if (path) this.paths.add(path);
	}

	/** Marks a backlink source (any extension) as potentially changed. */
	markSource(path: string): void {
		if (path) this.sources.add(path);
	}

	/** Marks a note as potentially changed and as a possible backlink source. */
	markChanged(path: string): void {
		this.markPath(path);
		this.markSource(path);
	}

	/** Marks a note whose ignore flag may have changed. */
	markIgnored(path: string): void {
		if (!path) return;
		this.markChanged(path);
		this.ignored.add(path);
	}

	/** Marks both sides of a rename. */
	markRename(oldPath: string, newPath: string): void {
		this.markChanged(oldPath);
		this.markChanged(newPath);
	}

	/** Requests a full backlink rebuild on the next pass. */
	markFullRebuild(): void {
		this.fullRebuild = true;
	}

	/** Consumes the full-rebuild request without touching other pending paths. */
	consumeFullRebuild(): boolean {
		const requested = this.fullRebuild;
		this.fullRebuild = false;
		return requested;
	}

	/** Whether any change is pending. */
	get hasPending(): boolean {
		return this.fullRebuild || this.paths.size > 0 || this.sources.size > 0;
	}

	/** Drains all pending state. */
	drain(): DrainedDirtySet {
		const drained = this.peek();
		this.paths.clear();
		this.sources.clear();
		this.ignored.clear();
		this.fullRebuild = false;
		return drained;
	}

	/** Returns a snapshot of pending state without clearing it. */
	peek(): DrainedDirtySet {
		return {
			paths: new Set(this.paths),
			sources: new Set(this.sources),
			ignored: new Set(this.ignored),
			fullRebuild: this.fullRebuild,
			changed: this.hasPending,
		};
	}

	/** Discards pending state without applying it (used on unload). */
	clear(): void {
		this.paths.clear();
		this.sources.clear();
		this.ignored.clear();
		this.fullRebuild = false;
	}
}
