import type { FS } from 'liquidjs';
import type { TemplateFolderConfig } from './types';

export const DEFAULT_TEMPLATES_FOLDER = '◊Rhizome/templates';
export const DEFAULT_PARTIALS_FOLDER = '◊Rhizome/partials';
export const DEFAULT_LAYOUTS_FOLDER = '◊Rhizome/layouts';

const BLOCKED_PATH_SENTINEL = '__rhizome_blocked_path__';
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const INTERNAL_DO_NOT_INDEX_RE =
	/^---\r?\n[\s\S]*?◊InternalRhizome\s*:\s*(?:\r?\n[ \t]+["']?001["']?\s*:|\{[^\r\n}]*["']?001["']?\s*:)[\s\S]*?\r?\n---/;

/**
 * Resolved, normalized vault-relative folder paths for LiquidJS `root`, `partials`, and `layouts`.
 */
export interface ResolvedTemplateFolders {
	readonly templatesFolder: string;
	readonly partialsFolder: string;
	readonly layoutsFolder: string;
	readonly configDir: string | null;
}

/**
 * Normalizes a vault-relative folder path, rejecting traversal segments (`..`),
 * hidden dot-directories, `configDir`, and `◊Rhizome/logs` by falling back to `defaultFolder`.
 */
export function normalizeTemplateFolderPath(
	rawFolder: string | undefined,
	defaultFolder: string,
	configDir?: string,
): string {
	if (typeof rawFolder !== 'string') {
		return defaultFolder;
	}
	const trimmed = rawFolder
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (trimmed.length === 0 || trimmed.includes('\0') || URL_SCHEME_RE.test(trimmed)) {
		return defaultFolder;
	}
	const segments = trimmed.split('/').filter((seg) => seg.length > 0);
	const normConfigDir =
		typeof configDir === 'string'
			? configDir
					.trim()
					.replace(/\\/g, '/')
					.replace(/^\/+|\/+$/g, '')
					.toLowerCase()
			: '';
	if (segments.length === 0 || segments.some((seg) => seg.startsWith('.'))) {
		return defaultFolder;
	}
	const joined = segments.join('/');
	if (
		(normConfigDir.length > 0 &&
			(joined.toLowerCase() === normConfigDir ||
				joined.toLowerCase().startsWith(`${normConfigDir}/`))) ||
		joined === '◊Rhizome/logs' ||
		joined.startsWith('◊Rhizome/logs/')
	) {
		return defaultFolder;
	}
	return joined;
}

/**
 * Resolves `TemplateFolderConfig` against the default `◊Rhizome/*` folders.
 */
export function resolveTemplateFolders(config?: TemplateFolderConfig): ResolvedTemplateFolders {
	const rawConfigDir =
		typeof config?.configDir === 'string'
			? config.configDir
					.trim()
					.replace(/\\/g, '/')
					.replace(/^\/+|\/+$/g, '')
			: '';
	const configDir = rawConfigDir.length > 0 ? rawConfigDir : null;
	return Object.freeze({
		templatesFolder: normalizeTemplateFolderPath(
			config?.templatesFolder,
			DEFAULT_TEMPLATES_FOLDER,
			configDir ?? undefined,
		),
		partialsFolder: normalizeTemplateFolderPath(
			config?.partialsFolder,
			DEFAULT_PARTIALS_FOLDER,
			configDir ?? undefined,
		),
		layoutsFolder: normalizeTemplateFolderPath(
			config?.layoutsFolder,
			DEFAULT_LAYOUTS_FOLDER,
			configDir ?? undefined,
		),
		configDir,
	});
}

function normalizeRelativeFilePath(dir: string, file: string, ext: string): string {
	if (
		typeof dir !== 'string' ||
		typeof file !== 'string' ||
		file.includes('\0') ||
		dir.includes('\0')
	) {
		return BLOCKED_PATH_SENTINEL;
	}
	const trimmedFile = file.trim();
	if (
		trimmedFile.length === 0 ||
		trimmedFile.startsWith('/') ||
		trimmedFile.startsWith('\\') ||
		URL_SCHEME_RE.test(trimmedFile) ||
		WINDOWS_DRIVE_RE.test(trimmedFile)
	) {
		return BLOCKED_PATH_SENTINEL;
	}

	const normalizedFile = trimmedFile.replace(/\\/g, '/');
	const fileSegments = normalizedFile.split('/');
	if (fileSegments.some((seg) => seg.length === 0 || seg.startsWith('.'))) {
		return BLOCKED_PATH_SENTINEL;
	}

	const normalizedDir = dir
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (normalizedDir.length === 0) {
		return BLOCKED_PATH_SENTINEL;
	}
	const dirSegments = normalizedDir.split('/');
	if (dirSegments.some((seg) => seg.length === 0 || seg.startsWith('.'))) {
		return BLOCKED_PATH_SENTINEL;
	}

	let relPath = `${dirSegments.join('/')}/${fileSegments.join('/')}`;
	if (ext && !relPath.toLowerCase().endsWith(ext.toLowerCase())) {
		relPath += ext;
	}
	return relPath;
}

function isContainedInVaultFolder(root: string, file: string, configDir: string | null): boolean {
	if (
		file === BLOCKED_PATH_SENTINEL ||
		file.includes('\0') ||
		root.includes('\0') ||
		file.startsWith('/') ||
		URL_SCHEME_RE.test(file)
	) {
		return false;
	}
	const normRoot = root
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	const normFile = file
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (normRoot.length === 0 || normFile.length <= normRoot.length + 1) {
		return false;
	}
	if (!normFile.startsWith(`${normRoot}/`)) {
		return false;
	}
	const segments = normFile.split('/');
	if (segments.some((seg) => seg.length === 0 || seg.startsWith('.'))) {
		return false;
	}
	if (
		configDir &&
		(normFile.toLowerCase() === configDir.toLowerCase() ||
			normFile.toLowerCase().startsWith(`${configDir.toLowerCase()}/`))
	) {
		return false;
	}
	if (normFile === '◊Rhizome/logs' || normFile.startsWith('◊Rhizome/logs/')) {
		return false;
	}
	return true;
}

/**
 * Creates a strictly sandboxed, vault-scoped LiquidJS `FS` implementation that:
 * - Never touches Node `fs` or browser `XMLHttpRequest`.
 * - Enforces containment inside the configured `templatesFolder`, `partialsFolder`, and `layoutsFolder`.
 * - Blocks path traversal (`..`), hidden dot-directories, absolute paths, URL schemes, `configDir`,
 *   `◊Rhizome/logs/`, and notes marked with `◊InternalRhizome` code `"001"`.
 */
export function createVaultLiquidFs(
	folders: ResolvedTemplateFolders,
	readTemplateFile?: (vaultRelativePath: string) => Promise<string | null>,
): FS {
	const allowedRoots = [folders.templatesFolder, folders.partialsFolder, folders.layoutsFolder];
	const fileCache = new Map<string, Promise<string | null>>();

	const isAllowedFile = (filepath: string): boolean =>
		allowedRoots.some((root) => isContainedInVaultFolder(root, filepath, folders.configDir));

	const loadSafeFile = (filepath: string): Promise<string | null> => {
		if (!readTemplateFile || !isAllowedFile(filepath)) {
			return Promise.resolve(null);
		}
		let pending = fileCache.get(filepath);
		if (!pending) {
			pending = Promise.resolve()
				.then(() => readTemplateFile(filepath))
				.then((content) => {
					if (typeof content !== 'string') {
						return null;
					}
					if (INTERNAL_DO_NOT_INDEX_RE.test(content)) {
						return null;
					}
					return content;
				})
				.catch(() => null);
			fileCache.set(filepath, pending);
		}
		return pending;
	};

	return {
		sep: '/',
		dirname(filepath: string): string {
			const idx = filepath.lastIndexOf('/');
			return idx <= 0 ? '' : filepath.slice(0, idx);
		},
		resolve(dir: string, file: string, ext: string): string {
			return normalizeRelativeFilePath(dir, file, ext);
		},
		contains(root: string, file: string): boolean {
			return isContainedInVaultFolder(root, file, folders.configDir);
		},
		async exists(filepath: string): Promise<boolean> {
			const content = await loadSafeFile(filepath);
			return content !== null;
		},
		existsSync(_filepath: string): boolean {
			return false;
		},
		async readFile(filepath: string): Promise<string> {
			const content = await loadSafeFile(filepath);
			if (content === null) {
				throw new Error(
					`ENOENT: Template file '${filepath}' does not exist in allowed vault template folders.`,
				);
			}
			return content;
		},
		readFileSync(filepath: string): string {
			throw new Error(
				`Synchronous template file access is disabled for '${filepath}'; use async rendering.`,
			);
		},
	};
}
