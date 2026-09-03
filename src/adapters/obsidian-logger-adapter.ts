import { App, Notice, normalizePath } from 'obsidian';
import type { LoggerPort, LogLevel } from '@ports/logger-port';
import { formatLogLine, shouldLog } from './logger-format';

/** Rotation cap, in bytes, before the log file is backed up and truncated. */
const ROTATION_CAP_BYTES = 5 * 1024 * 1024;

export interface ObsidianLoggerSettings {
	readonly loggingEnabled: boolean;
	readonly logLevel: LogLevel;
}

/**
 * Obsidian-backed `LoggerPort` adapter. Owns the enabled/level checks,
 * formatting, single-backup rotation, and the vault file writes — via
 * `Vault.adapter` (`DataAdapter`), not `Vault.create`/`Vault.modify`.
 *
 * Redaction of vault-derived content is the *caller's* responsibility (see
 * `LoggerPort`); this adapter never inspects `message`/`meta` for vault
 * content.
 *
 * @remarks
 * Writing via `Vault.adapter` instead of `Vault.create`/`Vault.modify`
 * means the plain-text log file never triggers a `vault.on('modify')`
 * event or gets treated as an indexed note. `logsFolderPath`/`logPath`/
 * `backupPath`/`logFileName`/`backupFileName` are public so
 * `settings.ts`'s diagnostics copy can read them instead of duplicating
 * the derived paths as literal strings.
 */
export class ObsidianLoggerAdapter implements LoggerPort {
	readonly logsFolderPath: string;
	readonly logPath: string;
	readonly backupPath: string;
	readonly logFileName: string;
	readonly backupFileName: string;

	/**
	 * Serializes `writeLine()` calls so concurrent `log()` calls can never
	 * race on rotation.
	 *
	 * @remarks
	 * E.g. two calls both seeing the file at/over the cap and both calling
	 * `rotate()`, where the second `rename()` targets a file the first
	 * already moved away.
	 */
	private writeQueue: Promise<void> = Promise.resolve();

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
		pluginId: string,
	) {
		this.logFileName = `${pluginId}.log`;
		this.backupFileName = `${pluginId}.log.1`;
		this.logsFolderPath = normalizePath(`_${pluginId}/logs`);
		this.logPath = normalizePath(`${this.logsFolderPath}/${this.logFileName}`);
		this.backupPath = normalizePath(`${this.logsFolderPath}/${this.backupFileName}`);
	}

	log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
		const settings = this.getSettings();
		// No I/O at all below the configured threshold or while disabled —
		// this check must happen before any file access, not after.
		if (!settings.loggingEnabled || !shouldLog(settings.logLevel, level)) {
			return;
		}
		const line = formatLogLine(new Date().toISOString(), level, message, meta);
		// log() is synchronous by LoggerPort's contract; the write itself is
		// fire-and-forget. A logging failure must never throw into the
		// caller or surface to the user — that would make diagnostics
		// riskier to call than not logging at all. Chaining onto writeQueue
		// (rather than calling writeLine directly) serializes writes so two
		// near-simultaneous calls can never both observe the rotation cap
		// and race on rotate().
		this.writeQueue = this.writeQueue.then(() => this.writeLine(line)).catch(() => {});
	}

	private async writeLine(line: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.logsFolderPath))) {
			await adapter.mkdir(this.logsFolderPath);
		}
		if (await adapter.exists(this.logPath)) {
			const stat = await adapter.stat(this.logPath);
			if (stat && stat.size >= ROTATION_CAP_BYTES) {
				await this.rotate();
			}
		}
		if (await adapter.exists(this.logPath)) {
			await adapter.append(this.logPath, line);
		} else {
			await adapter.write(this.logPath, line);
		}
	}

	/** Rotates the log file to its backup path, overwriting any prior backup. */
	private async rotate(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(this.backupPath)) {
			await adapter.remove(this.backupPath);
		}
		await adapter.rename(this.logPath, this.backupPath);
	}

	/** Deletes the log file and its backup, if present. */
	async clearLogs(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(this.logPath)) {
			await adapter.remove(this.logPath);
		}
		if (await adapter.exists(this.backupPath)) {
			await adapter.remove(this.backupPath);
		}
	}

	/**
	 * Reveals the log folder in Obsidian's file explorer. Falls back to a
	 * `Notice` stating the path when the folder does not exist yet (no
	 * log has been written) or when the file-explorer view is unavailable.
	 */
	async revealLogFolder(): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(this.logsFolderPath);
		if (!folder) {
			new Notice(
				'No log folder yet — enable logging in settings and trigger an action first.',
			);
			return;
		}
		const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
		const view = fileExplorerLeaf?.view as unknown as
			{ revealInFolder?: (file: typeof folder) => void } | undefined;
		if (fileExplorerLeaf && view?.revealInFolder) {
			await this.app.workspace.revealLeaf(fileExplorerLeaf);
			view.revealInFolder(folder);
		} else {
			new Notice(`Log folder: ${this.logsFolderPath}`);
		}
	}
}
