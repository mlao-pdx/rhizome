/**
 * Minimal in-memory stand-in for the subset of Obsidian's `DataAdapter`
 * that `ObsidianLoggerAdapter` (`src/adapters/obsidian-logger-adapter.ts`)
 * calls: `exists`, `mkdir`, `stat`, `write`, `append`, `rename`, `remove`.
 *
 * Grow this only as the logger adapter (or a future adapter) grows — see
 * `mock-obsidian-app.ts`'s header for the same policy.
 */
export interface InMemoryDataAdapter {
	readonly files: Map<string, string>;
	readonly dirs: Set<string>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	stat(
		path: string,
	): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null>;
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export function createInMemoryDataAdapter(): InMemoryDataAdapter {
	const files = new Map<string, string>();
	const dirs = new Set<string>();

	return {
		files,
		dirs,
		async exists(path) {
			return files.has(path) || dirs.has(path);
		},
		async mkdir(path) {
			dirs.add(path);
		},
		async stat(path) {
			const content = files.get(path);
			if (content === undefined) {
				return dirs.has(path) ? { type: 'folder', ctime: 0, mtime: 0, size: 0 } : null;
			}
			return { type: 'file', ctime: 0, mtime: 0, size: content.length };
		},
		async write(path, data) {
			files.set(path, data);
		},
		async append(path, data) {
			files.set(path, (files.get(path) ?? '') + data);
		},
		async rename(oldPath, newPath) {
			const content = files.get(oldPath);
			if (content !== undefined) {
				files.set(newPath, content);
				files.delete(oldPath);
			}
		},
		async remove(path) {
			files.delete(path);
		},
	};
}
