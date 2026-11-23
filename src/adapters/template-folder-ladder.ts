import { type App, normalizePath, TFile } from 'obsidian';
import { deepFreeze } from '@core/cache/deep-freeze';
import { scanNoteBody } from '@core/scanner';
import {
	normalizeObsidianMetadata,
	type ResolvedEngineConfig,
	type ResolveLinkPathFn,
} from '@core/search';
import {
	isPathInTemplateFolders,
	type ReadDirectoryChildrenFn,
	type TemplateFolderConfig,
	type TemplateFolderLadder,
	type TemplateMetadataObject,
} from '@core/templates';
import type { NewNoteDefaultFolderRung } from '../settings';
import { type BacklinkSnapshot, copyWithBacklinks } from './backlink-index';
import { toVaultQueryMatch } from './vault-query-runner';

const PROTECTED_LOGS_FOLDER_LOWER = '◊rhizome/logs';

interface NotebookNavigatorPluginCandidate {
	readonly selectedFolder?: unknown;
	readonly api?: {
		readonly selectedFolder?: unknown;
		readonly getSelectedFolder?: () => unknown;
		readonly selection?: {
			readonly selectedFolder?: unknown;
			readonly getSelectedFolder?: () => unknown;
		};
		readonly navigation?: {
			readonly selectedFolder?: unknown;
			readonly getSelectedFolder?: () => unknown;
		};
	};
}

interface AppWithNotebookNavigator {
	readonly plugins?: {
		readonly enabledPlugins?: ReadonlySet<string>;
		readonly plugins?: Readonly<Record<string, NotebookNavigatorPluginCandidate | undefined>>;
	};
}

function extractFolderPathCandidate(raw: unknown): string | null {
	if (typeof raw === 'string') {
		return raw;
	}
	if (raw && typeof raw === 'object' && 'path' in raw) {
		const p = (raw as { path?: unknown }).path;
		if (typeof p === 'string') {
			return p;
		}
	}
	return null;
}

/**
 * Normalizes a candidate folder path to a clean vault-relative folder string (`""` for vault root,
 * no leading/trailing `/`) or returns `null` when the candidate is invalid or points inside
 * `templatesFolder`, `partialsFolder`, `layoutsFolder`, `configDir`, dot-directories, or `◊Rhizome/logs`.
 */
export function sanitizeLadderFolderCandidate(
	rawCandidate: unknown,
	folderConfig: TemplateFolderConfig,
): string | null {
	const extracted = extractFolderPathCandidate(rawCandidate);
	if (extracted === null) {
		return null;
	}
	const trimmed = extracted.trim();
	if (trimmed === '' || trimmed === '/' || trimmed === '.') {
		return '';
	}

	const normalized = normalizePath(trimmed).replace(/^\/+|\/+$/g, '');
	if (normalized === '' || normalized === '.') {
		return '';
	}

	const segments = normalized.split('/');
	for (const seg of segments) {
		const cleanSeg = seg.trim();
		if (
			cleanSeg.length === 0 ||
			cleanSeg === '.' ||
			cleanSeg === '..' ||
			cleanSeg.startsWith('.')
		) {
			return null;
		}
	}

	const lower = normalized.toLowerCase();
	const normConfigDir =
		typeof folderConfig.configDir === 'string'
			? folderConfig.configDir
					.trim()
					.replace(/\\/g, '/')
					.replace(/^\/+|\/+$/g, '')
					.toLowerCase()
			: '';

	if (
		normConfigDir.length > 0 &&
		(lower === normConfigDir || lower.startsWith(`${normConfigDir}/`))
	) {
		return null;
	}
	if (
		lower === PROTECTED_LOGS_FOLDER_LOWER ||
		lower.startsWith(`${PROTECTED_LOGS_FOLDER_LOWER}/`)
	) {
		return null;
	}
	if (isPathInTemplateFolders(`${normalized}/__probe__.md`, folderConfig)) {
		return null;
	}

	return normalized;
}

function probeNotebookNavigatorFolder(app: App, folderConfig: TemplateFolderConfig): string | null {
	try {
		const pluginsHolder = (app as unknown as AppWithNotebookNavigator).plugins;
		if (
			pluginsHolder?.enabledPlugins instanceof Set &&
			!pluginsHolder.enabledPlugins.has('notebook-navigator')
		) {
			return null;
		}
		const plugin = pluginsHolder?.plugins?.['notebook-navigator'];
		if (!plugin) {
			return null;
		}
		const candidates: Array<() => unknown> = [
			() => plugin.api?.selection?.getSelectedFolder?.(),
			() => plugin.api?.navigation?.getSelectedFolder?.(),
			() => plugin.api?.getSelectedFolder?.(),
			() => plugin.api?.selection?.selectedFolder,
			() => plugin.api?.navigation?.selectedFolder,
			() => plugin.api?.selectedFolder,
			() => plugin.selectedFolder,
		];
		for (const readCandidate of candidates) {
			let raw: unknown;
			try {
				raw = readCandidate();
			} catch {
				continue;
			}
			if (raw !== undefined && raw !== null) {
				const sanitized = sanitizeLadderFolderCandidate(raw, folderConfig);
				if (sanitized !== null) {
					return sanitized;
				}
			}
		}
	} catch {
		// Defensive plugin boundary: fall back down the ladder if Notebook Navigator changes shape.
	}
	return null;
}

function resolveActiveNoteParentFolder(
	app: App,
	folderConfig: TemplateFolderConfig,
	activeFileOverride?: Pick<TFile, 'path' | 'parent'> | null,
): string | null {
	const workspaceWithActive = app.workspace as {
		getActiveFile?: () => TFile | null;
	};
	const activeFile =
		activeFileOverride !== undefined
			? activeFileOverride
			: typeof workspaceWithActive?.getActiveFile === 'function'
				? workspaceWithActive.getActiveFile()
				: null;
	if (!activeFile || typeof activeFile.path !== 'string' || activeFile.path.length === 0) {
		return null;
	}
	if (isPathInTemplateFolders(activeFile.path, folderConfig)) {
		return null;
	}
	const lowerFilePath = normalizePath(activeFile.path).toLowerCase();
	if (lowerFilePath.startsWith(`${PROTECTED_LOGS_FOLDER_LOWER}/`)) {
		return null;
	}
	const rawParent =
		activeFile.parent?.path && activeFile.parent.path !== '/'
			? activeFile.parent.path
			: activeFile.path.includes('/')
				? activeFile.path.slice(0, activeFile.path.lastIndexOf('/'))
				: '';
	return sanitizeLadderFolderCandidate(rawParent, folderConfig);
}

function probeObsidianFilesSettingFolder(
	app: App,
	folderConfig: TemplateFolderConfig,
	rawActiveNoteFolder: string | null,
): string | null {
	const vaultWithConfig = app.vault as {
		getConfig?: (key: string) => unknown;
	};
	if (typeof vaultWithConfig.getConfig !== 'function') {
		return null;
	}
	try {
		const locationMode = vaultWithConfig.getConfig('newFileLocation');
		if (locationMode === 'root' || locationMode === undefined || locationMode === null) {
			return '';
		}
		if (locationMode === 'current') {
			return rawActiveNoteFolder ?? '';
		}
		if (locationMode === 'folder') {
			const configuredPath = vaultWithConfig.getConfig('newFileFolderPath');
			return sanitizeLadderFolderCandidate(configuredPath, folderConfig);
		}
	} catch {
		// Fall back down the ladder if getConfig throws.
	}
	return null;
}

/**
 * Resolves all four `template.folders.*` rungs via graceful degradation:
 * `notebookNavigator -> obsidianFiles -> activeNote -> ""` (vault root),
 * skipping any folder inside `templatesFolder`, `partialsFolder`, `layoutsFolder`, `configDir`,
 * or `◊Rhizome/logs`.
 */
export function resolveTemplateFolderLadder(
	app: App,
	folderConfig: TemplateFolderConfig,
	startingRung: NewNoteDefaultFolderRung = 'notebookNavigator',
	activeFileOverride?: Pick<TFile, 'path' | 'parent'> | null,
): TemplateFolderLadder {
	const rawActiveNote = resolveActiveNoteParentFolder(app, folderConfig, activeFileOverride);
	const rawObsidianFiles = probeObsidianFilesSettingFolder(app, folderConfig, rawActiveNote);
	const rawNotebookNavigator = probeNotebookNavigatorFolder(app, folderConfig);

	const activeNote = rawActiveNote ?? '';
	const obsidianFiles = rawObsidianFiles ?? activeNote;
	const notebookNavigator = rawNotebookNavigator ?? obsidianFiles;

	let defaultFolder: string;
	switch (startingRung) {
		case 'notebookNavigator':
			defaultFolder = notebookNavigator;
			break;
		case 'obsidianFiles':
			defaultFolder = obsidianFiles;
			break;
		case 'activeNote':
			defaultFolder = activeNote;
			break;
		case 'vaultRoot':
			defaultFolder = '';
			break;
	}

	return Object.freeze({
		notebookNavigator,
		obsidianFiles,
		activeNote,
		default: defaultFolder,
	});
}

/**
 * Ephemerally scans and normalizes a template `TFile` (without inserting it into `BodyScanCache`
 * or `NormalizedDocumentCache`) to construct the frozen `template` context object (`TemplateMetadataObject`).
 */
export async function buildTemplateMetadataSnapshot(
	app: App,
	templateFile: TFile,
	folderConfig: TemplateFolderConfig,
	startingRung: NewNoteDefaultFolderRung,
	resolvedConfig: ResolvedEngineConfig,
	options?: {
		readonly templateText?: string | undefined;
		readonly backlinks?: BacklinkSnapshot | undefined;
		readonly isIgnoredFile?: ((file: TFile) => boolean) | undefined;
		readonly activeFileOverride?: Pick<TFile, 'path' | 'parent'> | null | undefined;
	},
): Promise<TemplateMetadataObject> {
	const cache = app.metadataCache.getFileCache(templateFile);
	let text = options?.templateText;
	if (typeof text !== 'string') {
		try {
			text = await app.vault.cachedRead(templateFile);
		} catch {
			text = '';
		}
	}

	const scanned = scanNoteBody(text, cache);
	const resolveLinkPath: ResolveLinkPathFn = (rawTarget, linkSourcePath) =>
		app.metadataCache.getFirstLinkpathDest?.(rawTarget, linkSourcePath)?.path ?? null;

	const baseDoc = normalizeObsidianMetadata(
		templateFile,
		cache,
		resolvedConfig,
		scanned.inlineProperties,
		resolveLinkPath,
		scanned.tasks,
	);

	const docWithBacklinks =
		options?.backlinks !== undefined && options?.isIgnoredFile !== undefined
			? copyWithBacklinks(baseDoc, options.backlinks, templateFile, options.isIgnoredFile)
			: baseDoc;
	const match = toVaultQueryMatch(docWithBacklinks);
	const folders = resolveTemplateFolderLadder(
		app,
		folderConfig,
		startingRung,
		options?.activeFileOverride,
	);

	return deepFreeze({
		file: match.file,
		aliases: match.aliases,
		aliasLocations: match.aliasLocations,
		tags: match.tags,
		tagLocations: match.tagLocations,
		cssclasses: match.cssclasses,
		headings: match.headings,
		links: match.links,
		embeds: match.embeds,
		blocks: match.blocks,
		tasks: match.tasks,
		properties: match.properties,
		propertyLocations: match.propertyLocations,
		backlinks: match.backlinks,
		folders,
	});
}

interface FolderLikeNode {
	readonly path?: unknown;
	readonly name?: unknown;
	readonly children?: ReadonlyArray<FolderLikeNode>;
}

function isFolderLikeWithChildren(
	node: unknown,
): node is FolderLikeNode & { readonly children: ReadonlyArray<FolderLikeNode> } {
	return Boolean(
		node &&
		typeof node === 'object' &&
		'children' in node &&
		Array.isArray((node as FolderLikeNode).children),
	);
}

/**
 * Creates a lazy folder-scoped path lookup (`ReadDirectoryChildrenFn`) that inspects only the
 * direct children of a requested parent folder (`TFolder.children` via `vault.getRoot()` /
 * `vault.getAbstractFileByPath()`) instead of scanning the entire vault on every render,
 * falling back to a single memoized vault index when folder trees are unavailable (e.g. unit mocks).
 */
export function createVaultDirectoryChildrenLookup(app: App): ReadDirectoryChildrenFn {
	return (parentDir: string): Iterable<string> => {
		const vaultWithTree = app.vault as {
			getRoot?: () => unknown;
			getAbstractFileByPath?: (path: string) => unknown;
		};

		const rootCandidate =
			typeof vaultWithTree.getRoot === 'function'
				? vaultWithTree.getRoot()
				: typeof vaultWithTree.getAbstractFileByPath === 'function'
					? vaultWithTree.getAbstractFileByPath('/')
					: null;

		if (isFolderLikeWithChildren(rootCandidate)) {
			if (parentDir === '') {
				const out: string[] = [];
				for (const child of rootCandidate.children) {
					if (typeof child?.path === 'string' && child.path.length > 0) {
						out.push(child.path);
					}
				}
				return out;
			}

			// Fast exact-case O(1) lookup first, then case-insensitive segment walk from root.
			const exactNode =
				typeof vaultWithTree.getAbstractFileByPath === 'function'
					? vaultWithTree.getAbstractFileByPath(parentDir)
					: null;
			if (isFolderLikeWithChildren(exactNode)) {
				const out: string[] = [];
				for (const child of exactNode.children) {
					if (typeof child?.path === 'string' && child.path.length > 0) {
						out.push(child.path);
					}
				}
				return out;
			}

			let cursor: FolderLikeNode & { readonly children: ReadonlyArray<FolderLikeNode> } =
				rootCandidate;
			let matchedAll = true;
			for (const seg of parentDir.split('/')) {
				const segLower = seg.toLowerCase();
				const nextFolder = cursor.children.find((child) => {
					if (!isFolderLikeWithChildren(child)) return false;
					if (typeof child.name === 'string') {
						return child.name.toLowerCase() === segLower;
					}
					if (typeof child.path === 'string') {
						const tail = child.path.slice(child.path.lastIndexOf('/') + 1);
						return tail.toLowerCase() === segLower;
					}
					return false;
				});
				if (!nextFolder || !isFolderLikeWithChildren(nextFolder)) {
					matchedAll = false;
					break;
				}
				cursor = nextFolder;
			}
			if (matchedAll) {
				const out: string[] = [];
				for (const child of cursor.children) {
					if (typeof child?.path === 'string' && child.path.length > 0) {
						out.push(child.path);
					}
				}
				return out;
			}
			return [];
		}

		const targetDirLower = parentDir.toLowerCase();
		const bucket: string[] = [];
		for (const p of collectVaultExistingPaths(app)) {
			const norm = normalizePath(p).replace(/^\/+|\/+$/g, '');
			if (norm.length === 0) continue;
			const slashIdx = norm.lastIndexOf('/');
			const dirLower = slashIdx === -1 ? '' : norm.slice(0, slashIdx).toLowerCase();
			if (dirLower === targetDirLower) {
				bucket.push(norm);
			}
		}
		return bucket;
	};
}

/**
 * Collects all existing vault file and folder paths for fallback collision seeding.
 */
export function collectVaultExistingPaths(app: App): string[] {
	const paths: string[] = [];
	const vaultWithAll = app.vault as {
		getAllLoadedFiles?: () => ReadonlyArray<{ readonly path?: unknown }>;
		getFiles?: () => ReadonlyArray<{ readonly path?: unknown }>;
	};
	if (typeof vaultWithAll.getAllLoadedFiles === 'function') {
		for (const item of vaultWithAll.getAllLoadedFiles()) {
			if (typeof item?.path === 'string' && item.path.length > 0 && item.path !== '/') {
				paths.push(item.path);
			}
		}
		return paths;
	}
	if (typeof vaultWithAll.getFiles === 'function') {
		for (const item of vaultWithAll.getFiles()) {
			if (typeof item?.path === 'string' && item.path.length > 0) {
				paths.push(item.path);
			}
		}
		return paths;
	}
	for (const md of app.vault.getMarkdownFiles()) {
		paths.push(md.path);
	}
	return paths;
}
