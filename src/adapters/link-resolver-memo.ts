import type { App } from 'obsidian';

export interface MemoizedLinkResolver {
	readonly resolveLinkPath: (rawTarget: string, sourcePath: string) => string | null;
	readonly clear: () => void;
}

function getParentFolder(sourcePath: string): string {
	const slashIdx = sourcePath.lastIndexOf('/');
	return slashIdx === -1 ? '' : sourcePath.slice(0, slashIdx);
}

/**
 * Creates a pass/slice-scoped memoized `(rawTarget, sourcePath) => resolvedPath` wrapper
 * around `app.metadataCache.getFirstLinkpathDest`.
 *
 * @remarks
 * Non-empty link targets depend only on the source note's parent folder for relative
 * (`./`, `../`) and shortest-path disambiguation, while still forwarding the exact
 * `(rawTarget, sourcePath)` arguments to Obsidian on cache misses. Call `clear()` across
 * async yield boundaries so post-yield link resolution always reflects live vault state.
 */
export function createMemoizedLinkResolver(app: App): MemoizedLinkResolver {
	const byFolder = new Map<string, Map<string, string | null>>();

	const resolveLinkPath = (rawTarget: string, sourcePath: string): string | null => {
		if (rawTarget.length === 0) {
			return app.metadataCache.getFirstLinkpathDest?.(rawTarget, sourcePath)?.path ?? null;
		}
		const folder = getParentFolder(sourcePath);
		let folderMap = byFolder.get(folder);
		if (folderMap !== undefined) {
			const cached = folderMap.get(rawTarget);
			if (cached !== undefined) {
				return cached;
			}
		} else {
			folderMap = new Map<string, string | null>();
			byFolder.set(folder, folderMap);
		}
		const resolved =
			app.metadataCache.getFirstLinkpathDest?.(rawTarget, sourcePath)?.path ?? null;
		folderMap.set(rawTarget, resolved);
		return resolved;
	};

	const clear = (): void => {
		byFolder.clear();
	};

	return { resolveLinkPath, clear };
}
