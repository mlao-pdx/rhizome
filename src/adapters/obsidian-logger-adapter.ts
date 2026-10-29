import { App, Notice, type TAbstractFile, normalizePath } from 'obsidian';
import type { LogEntryMeta, LoggerPort, LogLevel } from '@ports/logger-port';
import { formatLogLine, LOG_FILE_HEADER, shouldLog } from './logger-format';

/** Maximum size, in bytes, of a single Markdown log segment before rolling over to a new epoch file. */
export const SEGMENT_CAP_BYTES = 512 * 1024;

/** Debounce interval, in milliseconds, used to coalesce bursts of `log()` calls into one disk write. */
export const FLUSH_DEBOUNCE_MS = 50;

const HEADER_BYTES = new TextEncoder().encode(LOG_FILE_HEADER).byteLength;
const SEGMENT_FILE_RE = /(?:^|\/)\d+\.md$/;

interface NotebookNavigatorNavigationApi {
	navigateToFolder?: (folder: TAbstractFile | string) => Promise<boolean>;
}

interface AppWithPlugins extends App {
	plugins?: {
		plugins?: {
			'notebook-navigator'?: {
				api?: {
					navigation?: NotebookNavigatorNavigationApi;
				};
			};
		};
	};
}

export interface ObsidianLoggerSettings {
	readonly loggingEnabled: boolean;
	readonly logLevel: LogLevel;
}

function byteLength(str: string): number {
	return new TextEncoder().encode(str).byteLength;
}

/**
 * Obsidian-backed `LoggerPort` adapter. Owns the enabled/level checks,
 * Markdown table formatting, debounced batch queueing, 512 KB epoch-file
 * segmentation, and vault file writes — via `Vault.adapter` (`DataAdapter`).
 *
 * Sensitivity marking of vault-derived content is the *caller's*
 * responsibility (see `LoggerPort`); this adapter delegates `‼️...‼️`
 * redaction to `logger-format.ts`.
 *
 * @remarks
 * (design, 2026-10-29) Writes Markdown table segments under
 * `◊<pluginName>/logs/<epochMs>.md` with `◊InternalRhizome: \{ "001": ... \}`
 * frontmatter, coalescing burst writes via a short debounce and opening a
 * new `<epochMs>.md` segment whenever the active file would exceed 512 KB.
 *
 * SUPERSEDED (design, 2026-08-01): Originally wrote plain-text lines to
 * `_<pluginId>/logs/<pluginId>.log` with single-backup `.log.1` rotation at
 * 5 MB. Replaced by `◊Rhizome/logs/<epochMs>.md` Markdown segments so users
 * can inspect logs directly in Obsidian and delete the `‼️Description‼️`
 * column before sharing.
 */
export class ObsidianLoggerAdapter implements LoggerPort {
	readonly systemRootPath: string;
	readonly logsFolderPath: string;

	private pendingLines: string[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private writeQueue: Promise<void> = Promise.resolve();
	private activeSegmentPath: string | undefined;
	private lastSegmentEpoch = 0;

	constructor(
		private readonly app: App,
		/**
		 * Live settings accessor.
		 *
		 * @remarks
		 * Read so that settings changes take effect on the next call
		 * without needing to re-wire this adapter.
		 */
		private readonly getSettings: () => ObsidianLoggerSettings,
		pluginName: string = 'Rhizome',
		private readonly debounceMs: number = FLUSH_DEBOUNCE_MS,
	) {
		const trimmed = pluginName.trim() || 'Rhizome';
		const normalizedTitle = `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}`;
		this.systemRootPath = normalizePath(`◊${normalizedTitle}`);
		this.logsFolderPath = normalizePath(`${this.systemRootPath}/logs`);
	}

	/** Path of the currently active `<epochMs>.md` segment file, if one has been opened. */
	get currentLogPath(): string | undefined {
		return this.activeSegmentPath;
	}

	log(level: LogLevel, message: string, meta: LogEntryMeta): void {
		const settings = this.getSettings();
		// No I/O at all below the configured threshold or while disabled —
		// this check must happen before any file access, not after.
		if (!settings.loggingEnabled || !shouldLog(settings.logLevel, level)) {
			return;
		}
		const line = formatLogLine(new Date().toISOString(), level, message, meta);
		this.pendingLines.push(line);
		this.scheduleFlush();
	}

	/**
	 * Immediately flushes any buffered log rows onto the serialized write queue
	 * and resolves once all queued writes have settled.
	 */
	flush(): Promise<void> {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.pendingLines.length > 0) {
			const batch = this.pendingLines.splice(0, this.pendingLines.length);
			this.writeQueue = this.writeQueue
				.then(() => this.writeBatch(batch))
				.catch(() => undefined);
		}
		return this.writeQueue;
	}

	private scheduleFlush(): void {
		if (this.debounceMs <= 0) {
			void this.flush();
			return;
		}
		if (this.flushTimer !== undefined) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, this.debounceMs);
	}

	private async nextSegmentPath(): Promise<string> {
		const adapter = this.app.vault.adapter;
		let nextEpoch = Math.max(Date.now(), this.lastSegmentEpoch + 1);
		let candidate = normalizePath(`${this.logsFolderPath}/${nextEpoch}.md`);
		while (await adapter.exists(candidate)) {
			nextEpoch++;
			candidate = normalizePath(`${this.logsFolderPath}/${nextEpoch}.md`);
		}
		this.lastSegmentEpoch = nextEpoch;
		return candidate;
	}

	private async ensureLogsFolder(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.systemRootPath))) {
			await adapter.mkdir(this.systemRootPath);
		}
		if (!(await adapter.exists(this.logsFolderPath))) {
			await adapter.mkdir(this.logsFolderPath);
		}
	}

	private async writeBatch(lines: readonly string[]): Promise<void> {
		if (lines.length === 0) {
			return;
		}
		await this.ensureLogsFolder();
		const adapter = this.app.vault.adapter;

		let currentSize = 0;
		let isNewSegment = false;

		if (this.activeSegmentPath !== undefined) {
			const stat = (await adapter.exists(this.activeSegmentPath))
				? await adapter.stat(this.activeSegmentPath)
				: null;
			if (!stat) {
				this.activeSegmentPath = undefined;
			} else {
				currentSize = stat.size;
			}
		}

		let chunk = '';

		const flushChunk = async (): Promise<void> => {
			if (chunk.length === 0) {
				return;
			}
			if (isNewSegment || this.activeSegmentPath === undefined) {
				this.activeSegmentPath = await this.nextSegmentPath();
				await adapter.write(this.activeSegmentPath, `${LOG_FILE_HEADER}${chunk}`);
			} else {
				await adapter.append(this.activeSegmentPath, chunk);
			}
			chunk = '';
			isNewSegment = false;
		};

		for (const line of lines) {
			const lineBytes = byteLength(line);

			if (this.activeSegmentPath === undefined && !isNewSegment) {
				isNewSegment = true;
				currentSize = HEADER_BYTES;
			} else if (currentSize + lineBytes > SEGMENT_CAP_BYTES) {
				await flushChunk();
				this.activeSegmentPath = undefined;
				isNewSegment = true;
				currentSize = HEADER_BYTES;
			}

			chunk += line;
			currentSize += lineBytes;
		}

		await flushChunk();
	}

	/** Deletes all `<epoch>.md` log segment files inside `logsFolderPath`, if present. */
	async clearLogs(): Promise<void> {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.pendingLines.length = 0;

		const task = this.writeQueue.then(async () => {
			const adapter = this.app.vault.adapter;
			this.activeSegmentPath = undefined;
			if (!(await adapter.exists(this.logsFolderPath))) {
				return;
			}
			if (typeof adapter.list === 'function') {
				const listed = await adapter.list(this.logsFolderPath);
				for (const filePath of listed.files) {
					if (!SEGMENT_FILE_RE.test(filePath)) {
						continue;
					}
					if (await adapter.exists(filePath)) {
						await adapter.remove(filePath);
					}
				}
			}
		});
		this.writeQueue = task.catch(() => undefined);
		await task;
	}

	/**
	 * Reveals the log folder in Notebook Navigator (when available and active),
	 * falling back to Obsidian's core Files explorer, and finally to a `Notice`
	 * stating the path when neither navigation target can reveal it.
	 */
	async revealLogFolder(): Promise<void> {
		await this.flush();
		const folder = this.app.vault.getAbstractFileByPath(this.logsFolderPath);
		if (!folder) {
			new Notice(
				'No log folder yet — enable logging in settings and trigger an action first.',
			);
			return;
		}

		const navigation = (this.app as AppWithPlugins).plugins?.plugins?.['notebook-navigator']
			?.api?.navigation;
		if (typeof navigation?.navigateToFolder === 'function') {
			try {
				const revealedInNotebookNavigator = Boolean(
					await navigation.navigateToFolder(folder),
				);
				if (revealedInNotebookNavigator) {
					return;
				}
			} catch {
				// Fall through to Obsidian's core Files plugin.
			}
		}

		const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
		if (fileExplorerLeaf) {
			try {
				await this.app.workspace.revealLeaf(fileExplorerLeaf);
				const view = fileExplorerLeaf.view as unknown as
					{ revealInFolder?: (file: typeof folder) => void } | undefined;
				if (typeof view?.revealInFolder === 'function') {
					view.revealInFolder(folder);
					return;
				}
			} catch {
				// Fall through to fallback Notice.
			}
		}

		new Notice(`Log folder: ${this.logsFolderPath}`);
	}
}
