import type { SourceSpan } from '@core/search';
import type { TargetPathClaimPort, TemplateDiagnostic } from './types';

const ILLEGAL_PATH_CHAR_RE = /[\\:*?"<>|]/;
const NBSP_CHAR_RE = /[\u00A0\u202F]/g;
const PROTECTED_LOGS_PREFIX_LOWER = '◊rhizome/logs';

function hasControlCharacters(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

/**
 * Options for validating a vault-relative target note path.
 */
export interface TargetPathValidationOptions {
	readonly configDir?: string | null | undefined;
	readonly span?: SourceSpan | null | undefined;
	readonly file?: string | null | undefined;
}

/**
 * Result of normalizing and validating a candidate target note path.
 */
export type TargetPathValidationResult =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly diagnostic: TemplateDiagnostic };

function failTargetPath(
	issue: string,
	hint: string,
	options?: TargetPathValidationOptions,
): TargetPathValidationResult {
	return {
		ok: false,
		diagnostic: Object.freeze({
			code: 'INVALID_TARGET_PATH',
			severity: 'error',
			issue,
			hint,
			span: options?.span ?? null,
			file: options?.file ?? null,
		}),
	};
}

/**
 * Normalizes and validates a vault-relative target note path for `"newNote"` creation:
 * - Normalizes non-breaking spaces and collapses repeated `/` separators.
 * - Strips leading `/` (so `{{ template.folders.default }}/Note` works when the folder is `""`).
 * - Appends `.md` if missing (case-insensitive canonicalization to `.md`).
 * - Rejects control characters, OS-illegal filename characters (`\ : * ? " < > |`), traversal (`..`),
 *   dot-prefixed/suffixed segments, `configDir`, and `◊Rhizome/logs`.
 */
export function normalizeAndValidateTargetPath(
	rawPath: unknown,
	options?: TargetPathValidationOptions,
): TargetPathValidationResult {
	if (typeof rawPath !== 'string') {
		return failTargetPath(
			'Target path must evaluate to a non-empty string.',
			"Pass a vault-relative path string to '{% targetPath ... %}', e.g., '{% targetPath \"Projects/Kickoff\" %}'.",
			options,
		);
	}

	if (hasControlCharacters(rawPath)) {
		return failTargetPath(
			'Target path contains control characters or line breaks.',
			'Remove newlines, tabs, and control characters from the target path expression.',
			options,
		);
	}

	if (ILLEGAL_PATH_CHAR_RE.test(rawPath)) {
		return failTargetPath(
			`Target path '${rawPath}' contains characters that are illegal in vault filenames ('\\', ':', '*', '?', '"', '<', '>', '|').`,
			"Strip or replace illegal filename characters before passing the value to '{% targetPath %}'.",
			options,
		);
	}

	const collapsed = rawPath
		.replace(NBSP_CHAR_RE, ' ')
		.trim()
		.replace(/\/+/g, '/')
		.replace(/^\/+/, '');

	if (collapsed.length === 0 || collapsed.endsWith('/')) {
		return failTargetPath(
			`Target path '${rawPath}' does not specify a note filename.`,
			"Include a note name at the end of the path, e.g., 'Projects/Meeting Notes'.",
			options,
		);
	}

	const rawSegments = collapsed.split('/');
	const cleanSegments: string[] = [];

	for (let i = 0; i < rawSegments.length; i++) {
		const seg = rawSegments[i]!.trim();
		const isLast = i === rawSegments.length - 1;

		if (seg.length === 0) {
			return failTargetPath(
				`Target path '${rawPath}' contains an empty path segment.`,
				'Ensure every folder and filename segment in the path is non-empty.',
				options,
			);
		}

		if (seg === '.' || seg === '..') {
			return failTargetPath(
				`Target path '${rawPath}' cannot contain '.' or '..' traversal segments.`,
				'Specify a clean vault-relative path without relative traversal segments.',
				options,
			);
		}

		if (isLast) {
			const hasMdExt = seg.toLowerCase().endsWith('.md');
			const stem = hasMdExt ? seg.slice(0, -3).trim() : seg;
			if (stem.length === 0) {
				return failTargetPath(
					`Target path '${rawPath}' has an empty note name before '.md'.`,
					"Provide a non-empty note name, e.g., 'Untitled.md'.",
					options,
				);
			}
			if (stem.startsWith('.') || stem.endsWith('.')) {
				return failTargetPath(
					`Target note name '${stem}' cannot start or end with a dot ('.').`,
					'Choose a note name that does not begin or end with a period.',
					options,
				);
			}
			cleanSegments.push(`${stem}.md`);
		} else {
			if (seg.startsWith('.') || seg.endsWith('.')) {
				return failTargetPath(
					`Target folder segment '${seg}' in '${rawPath}' cannot start or end with a dot ('.').`,
					'Hidden dot-directories and trailing-dot folder names are not permitted.',
					options,
				);
			}
			cleanSegments.push(seg);
		}
	}

	const joined = cleanSegments.join('/');
	const lowerJoined = joined.toLowerCase();

	const normConfigDir =
		typeof options?.configDir === 'string'
			? options.configDir
					.trim()
					.replace(/\\/g, '/')
					.replace(/^\/+|\/+$/g, '')
					.toLowerCase()
			: '';

	if (
		normConfigDir.length > 0 &&
		(lowerJoined === normConfigDir || lowerJoined.startsWith(`${normConfigDir}/`))
	) {
		return failTargetPath(
			`Target path '${joined}' points inside Obsidian's configuration folder ('${options?.configDir ?? ''}').`,
			'Choose a note path outside the vault configuration directory.',
			options,
		);
	}

	if (
		lowerJoined === PROTECTED_LOGS_PREFIX_LOWER ||
		lowerJoined.startsWith(`${PROTECTED_LOGS_PREFIX_LOWER}/`)
	) {
		return failTargetPath(
			`Target path '${joined}' points inside Rhizome's protected diagnostic logs folder ('◊Rhizome/logs').`,
			"Choose a target folder outside '◊Rhizome/logs'.",
			options,
		);
	}

	return { ok: true, path: joined };
}

function normalizeExistingPathLower(rawPath: string): string {
	return rawPath
		.replace(NBSP_CHAR_RE, ' ')
		.trim()
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.toLowerCase();
}

function extractParentDirLower(normalizedPath: string): {
	readonly parentDir: string;
	readonly parentLower: string;
} {
	const slashIdx = normalizedPath.lastIndexOf('/');
	const parentDir = slashIdx === -1 ? '' : normalizedPath.slice(0, slashIdx);
	return { parentDir, parentLower: parentDir.toLowerCase() };
}

/**
 * Callback returning existing vault paths directly inside `parentDir` (`""` for vault root),
 * allowing `TargetPathClaimRegistry` to load only the target folder's children on demand.
 */
export type ReadDirectoryChildrenFn = (parentDir: string) => Iterable<string>;

/**
 * Stateful per-invocation collision resolver tracking live vault paths (case-insensitively)
 * alongside active per-block claims so repeated `{% targetPath %}` calls within the same block
 * release that block's previous tentative claim while colliding cleanly (`Name 1.md`, `Name 2.md`, ...)
 * against existing vault entries and earlier blocks.
 */
export class TargetPathClaimRegistry implements TargetPathClaimPort {
	private readonly existingLowerPaths = new Set<string>();
	private readonly loadedParentDirs = new Set<string>();
	private readonly readDirectoryChildren: ReadDirectoryChildrenFn | undefined;
	private readonly claimsByBlock = new Map<
		number,
		{ readonly path: string; readonly lowerPath: string; readonly basePath: string }
	>();

	public constructor(existingPathsOrLookup: Iterable<string> | ReadDirectoryChildrenFn = []) {
		if (typeof existingPathsOrLookup === 'function') {
			this.readDirectoryChildren = existingPathsOrLookup;
		} else {
			for (const p of existingPathsOrLookup) {
				this.addExistingPath(p);
			}
		}
	}

	private ensureParentLoaded(normalizedPath: string): void {
		if (!this.readDirectoryChildren) {
			return;
		}
		const { parentDir, parentLower } = extractParentDirLower(normalizedPath);
		if (this.loadedParentDirs.has(parentLower)) {
			return;
		}
		this.loadedParentDirs.add(parentLower);
		for (const childPath of this.readDirectoryChildren(parentDir)) {
			this.addExistingPath(childPath);
		}
	}

	/**
	 * Clears the lazy directory cache so a commit-phase `reverifyClaim` pass re-reads live
	 * folder entries that may have appeared asynchronously during preflight while preserving
	 * all active per-block claims.
	 */
	public resetLoadedDirectories(): void {
		this.loadedParentDirs.clear();
	}

	/**
	 * Records an existing vault file or folder path (case-insensitively) as occupied.
	 */
	public addExistingPath(path: string): void {
		const lower = normalizeExistingPathLower(path);
		if (lower.length > 0) {
			this.existingLowerPaths.add(lower);
		}
	}

	/**
	 * Returns the currently claimed path for `blockIndex`, if any.
	 */
	public getClaim(blockIndex: number): string | undefined {
		return this.claimsByBlock.get(blockIndex)?.path;
	}

	private isTakenForBlock(blockIndex: number, candidateLower: string): boolean {
		if (this.existingLowerPaths.has(candidateLower)) {
			return true;
		}
		for (const [otherBlockIdx, entry] of this.claimsByBlock) {
			if (otherBlockIdx !== blockIndex && entry.lowerPath === candidateLower) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Releases any prior claim held by `blockIndex` and claims `normalizedPath` (or the lowest
	 * available `<Name> <N>.md` sibling on case-insensitive collision).
	 */
	public claim(blockIndex: number, normalizedPath: string): string {
		this.ensureParentLoaded(normalizedPath);
		const prior = this.claimsByBlock.get(blockIndex);
		const baseLower = normalizedPath.toLowerCase();
		const effectiveBasePath =
			prior !== undefined && prior.lowerPath === baseLower ? prior.basePath : normalizedPath;

		if (!this.isTakenForBlock(blockIndex, baseLower)) {
			this.claimsByBlock.set(blockIndex, {
				path: normalizedPath,
				lowerPath: baseLower,
				basePath: effectiveBasePath,
			});
			return normalizedPath;
		}

		return this.claimNextAvailableFromBase(blockIndex, effectiveBasePath);
	}

	/**
	 * Verifies at commit time that `blockIndex`'s preflight claim is still free on disk; if an
	 * external sync created a colliding path mid-preflight, re-claims from `blockIndex`'s original
	 * unsuffixed `basePath` while respecting all sibling blocks' held claims.
	 */
	public reverifyClaim(blockIndex: number, fallbackPath: string): string {
		const existingEntry = this.claimsByBlock.get(blockIndex);
		const currentPath = existingEntry?.path ?? fallbackPath;
		const basePath = existingEntry?.basePath ?? fallbackPath;
		this.ensureParentLoaded(currentPath);

		const currentLower = currentPath.toLowerCase();
		if (!this.isTakenForBlock(blockIndex, currentLower)) {
			this.claimsByBlock.set(blockIndex, {
				path: currentPath,
				lowerPath: currentLower,
				basePath,
			});
			return currentPath;
		}

		return this.claimNextAvailableFromBase(blockIndex, basePath);
	}

	private claimNextAvailableFromBase(blockIndex: number, basePath: string): string {
		this.ensureParentLoaded(basePath);
		const baseLower = basePath.toLowerCase();
		if (!this.isTakenForBlock(blockIndex, baseLower)) {
			this.claimsByBlock.set(blockIndex, {
				path: basePath,
				lowerPath: baseLower,
				basePath,
			});
			return basePath;
		}

		const slashIdx = basePath.lastIndexOf('/');
		const dirPrefix = slashIdx === -1 ? '' : basePath.slice(0, slashIdx + 1);
		const fileName = slashIdx === -1 ? basePath : basePath.slice(slashIdx + 1);
		const hasMd = fileName.toLowerCase().endsWith('.md');
		const stem = hasMd ? fileName.slice(0, -3) : fileName;
		const ext = hasMd ? fileName.slice(-3) : '';

		for (let suffix = 1; ; suffix++) {
			const candidate = `${dirPrefix}${stem} ${suffix}${ext}`;
			const candidateLower = candidate.toLowerCase();
			if (!this.isTakenForBlock(blockIndex, candidateLower)) {
				this.claimsByBlock.set(blockIndex, {
					path: candidate,
					lowerPath: candidateLower,
					basePath,
				});
				return candidate;
			}
		}
	}
}

/**
 * Builds the default initial `"newNote"` seed path (`<folder>/untitled.md`, or `untitled.md` at vault root)
 * and claims a collision-free path for `blockIndex` when `claimRegistry` is provided.
 */
export function resolveInitialNewNoteTargetPath(
	defaultFolder: string,
	blockIndex: number = 0,
	claimRegistry?: TargetPathClaimPort,
	configDir?: string | null,
): string {
	const rawSeed =
		defaultFolder.trim().length > 0 ? `${defaultFolder}/untitled.md` : 'untitled.md';
	const validated = normalizeAndValidateTargetPath(rawSeed, { configDir });
	const cleanSeed = validated.ok ? validated.path : 'untitled.md';
	return claimRegistry ? claimRegistry.claim(blockIndex, cleanSeed) : cleanSeed;
}
