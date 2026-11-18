import type { App, CachedMetadata, TFile as ObsidianTFile } from 'obsidian';

import { createMockApp, TFile } from './mock-obsidian-app';

export interface NoteModel {
	readonly id: number;
	path: string;
	basename: string;
	mtime: number;
	size: number;
	ignored: boolean;
	deleted: boolean;
	status: string;
	tags: readonly string[];
	links: readonly string[];
	cacheVersion: number;
	extension: 'md' | 'canvas';
}

export interface VaultState {
	notes: NoteModel[];
}

export function noteModel(overrides: Partial<NoteModel> & { id: number }): NoteModel {
	const basename = overrides.basename ?? `n${overrides.id}`;
	return {
		id: overrides.id,
		path: overrides.path ?? `notes/${basename}.md`,
		basename,
		mtime: overrides.mtime ?? 1_700_000_000_000,
		size: overrides.size ?? 100,
		ignored: overrides.ignored ?? false,
		deleted: overrides.deleted ?? false,
		status: overrides.status ?? 'active',
		tags: overrides.tags ?? [],
		links: overrides.links ?? [],
		cacheVersion: overrides.cacheVersion ?? 0,
		extension: overrides.extension ?? 'md',
	};
}

function cloneState(state: VaultState): VaultState {
	return {
		notes: state.notes.map((note) => ({
			...note,
			tags: [...note.tags],
			links: [...note.links],
		})),
	};
}

function findLiveByBasename(notes: readonly NoteModel[], raw: string): NoteModel | undefined {
	const key = raw.trim().toLowerCase().replace(/^\.\//, '').replace(/\.md$/, '');
	const byPath = notes.find(
		(note) => !note.deleted && note.path.toLowerCase().replace(/\.md$/, '') === key,
	);
	if (byPath) return byPath;
	return notes.find((note) => !note.deleted && note.basename.toLowerCase() === key);
}

function computeResolvedLinks(state: VaultState): Record<string, Record<string, number>> {
	const links: Record<string, Record<string, number>> = {};
	for (const note of state.notes) {
		if (note.deleted) continue;
		const destinations: Record<string, number> = {};
		for (const raw of note.links) {
			const target = findLiveByBasename(state.notes, raw);
			if (!target) continue;
			destinations[target.path] = (destinations[target.path] ?? 0) + 1;
		}
		if (Object.keys(destinations).length > 0) {
			links[note.path] = destinations;
		}
	}
	return links;
}

function makeCachedMetadata(note: NoteModel): CachedMetadata {
	const frontmatter: Record<string, unknown> = { status: note.status };
	if (note.ignored) {
		frontmatter['◊InternalRhizome'] = { '001': 'Do not index or query.' };
	}
	return {
		frontmatter,
		tags: note.tags.map((tag) => ({ tag, position: {} as never })),
		links: note.links.map((link) => ({
			link,
			original: `[[${link}]]`,
			position: {} as never,
		})),
	};
}

function makeTFile(note: NoteModel): TFile {
	const slashIdx = note.path.lastIndexOf('/');
	const name = slashIdx === -1 ? note.path : note.path.slice(slashIdx + 1);
	const file = new TFile() as TFile & { deleted?: boolean };
	file.path = note.path;
	file.name = name;
	file.basename = name.replace(/\.[^.]+$/, '');
	file.extension = note.extension;
	file.parent = { path: slashIdx === -1 ? '' : note.path.slice(0, slashIdx) };
	file.stat = { ctime: note.mtime, mtime: note.mtime, size: note.size };
	if (note.deleted) {
		(file as { deleted?: boolean }).deleted = true;
	}
	return file;
}

export interface CacheVault {
	readonly app: App;
	state: VaultState;
	readonly files: readonly ObsidianTFile[];
	readonly caches: Map<string, CachedMetadata>;
	setState(next: VaultState): void;
	resolveLinkPath: (raw: string, sourcePath?: string) => string | null;
	cacheFor(path: string): CachedMetadata | null;
}

/**
 * Builds a mutable mock vault for cache properties. `setState` replaces the model and refreshes
 * file objects and per-note metadata-cache object identity, which is what the revision token
 * observes.
 */
export function createCacheVault(initial: VaultState): CacheVault {
	let state = cloneState(initial);
	const files: TFile[] = [];
	const fileByPath = new Map<string, TFile>();
	const caches = new Map<string, CachedMetadata>();
	const cacheSignatures = new Map<string, string>();
	const links: Record<string, Record<string, number>> = {};

	const materialize = (): void => {
		const previousCaches = new Map(caches);
		const previousSignatures = new Map(cacheSignatures);
		files.length = 0;
		caches.clear();
		cacheSignatures.clear();
		for (const note of state.notes) {
			const existing = fileByPath.get(note.path);
			const file =
				existing !== undefined &&
				existing.stat.mtime === note.mtime &&
				existing.stat.size === note.size &&
				(existing as { deleted?: boolean }).deleted === (note.deleted || undefined)
					? existing
					: makeTFile(note);
			fileByPath.set(note.path, file);
			files.push(file);
			if (note.extension === 'md' && !note.deleted) {
				const signature = JSON.stringify([
					note.ignored,
					note.status,
					note.tags,
					note.links,
					note.cacheVersion,
				]);
				const previous = previousCaches.get(note.path);
				if (previous !== undefined && previousSignatures.get(note.path) === signature) {
					caches.set(note.path, previous);
					cacheSignatures.set(note.path, signature);
				} else {
					caches.set(note.path, makeCachedMetadata(note));
					cacheSignatures.set(note.path, signature);
				}
			}
		}
		for (const path of [...fileByPath.keys()]) {
			if (!files.some((file) => file.path === path)) {
				fileByPath.delete(path);
			}
		}
		const computed = computeResolvedLinks(state);
		for (const key of Object.keys(links)) delete links[key];
		Object.assign(links, computed);
	};
	materialize();

	const app = createMockApp({
		files,
		getFileCache: (file) => (file?.path ? (caches.get(file.path) ?? null) : null),
		resolvedLinks: links,
	}) as App & {
		vault: App['vault'] & {
			getFiles: () => TFile[];
			getFileByPath: (path: string) => TFile | null;
		};
	};

	(app.vault as unknown as { getFiles: () => TFile[] }).getFiles = () => files;
	(app.vault as unknown as { getMarkdownFiles: () => TFile[] }).getMarkdownFiles = () =>
		files.filter((file) => file.extension === 'md');
	(app.vault as unknown as { getFileByPath: (path: string) => TFile | null }).getFileByPath = (
		path,
	) => files.find((file) => file.path === path) ?? null;
	(
		app.metadataCache as unknown as { getFirstLinkpathDest: (raw: string) => TFile | null }
	).getFirstLinkpathDest = (raw) => {
		const target = findLiveByBasename(state.notes, raw);
		if (!target) return null;
		return files.find((file) => file.path === target.path) ?? null;
	};

	return {
		app,
		get state() {
			return state;
		},
		set state(next: VaultState) {
			state = cloneState(next);
			materialize();
		},
		files: files as unknown as readonly ObsidianTFile[],
		caches,
		setState(next: VaultState): void {
			state = cloneState(next);
			materialize();
		},
		resolveLinkPath: (raw: string): string | null => {
			const target = findLiveByBasename(state.notes, raw);
			return target ? target.path : null;
		},
		cacheFor(path: string): CachedMetadata | null {
			return caches.get(path) ?? null;
		},
	};
}

export { cloneState };
