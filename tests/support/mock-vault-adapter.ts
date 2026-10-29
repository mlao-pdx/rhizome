/**
 * Minimal in-memory stand-in for the subset of Obsidian's `DataAdapter`
 * that `ObsidianLoggerAdapter` (`src/adapters/obsidian-logger-adapter.ts`)
 * calls: `exists`, `mkdir`, `stat`, `write`, `append`, `remove`, `list`.
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
	remove(path: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
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
			const byteSize = new TextEncoder().encode(content).byteLength;
			return { type: 'file', ctime: 0, mtime: 0, size: byteSize };
		},
		async write(path, data) {
			files.set(path, data);
		},
		async append(path, data) {
			files.set(path, (files.get(path) ?? '') + data);
		},
		async remove(path) {
			files.delete(path);
		},
		async list(dirPath) {
			const prefix = `${dirPath}/`;
			const matchedFiles: string[] = [];
			const matchedFolders: string[] = [];
			for (const filePath of files.keys()) {
				if (filePath.startsWith(prefix)) {
					const rest = filePath.slice(prefix.length);
					if (!rest.includes('/')) {
						matchedFiles.push(filePath);
					}
				}
			}
			for (const folderPath of dirs.values()) {
				if (folderPath.startsWith(prefix)) {
					const rest = folderPath.slice(prefix.length);
					if (rest.length > 0 && !rest.includes('/')) {
						matchedFolders.push(folderPath);
					}
				}
			}
			return { files: matchedFiles, folders: matchedFolders };
		},
	};
}
