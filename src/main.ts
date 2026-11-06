import { type App, type CachedMetadata, Plugin, type TAbstractFile, TFile } from 'obsidian';
import { hasInternalRhizomeFlag, INTERNAL_RHIZOME_CODES } from '@core/search';
import { isPathInTemplateFolders, type TemplateFolderConfig } from '@core/templates';
import { ActiveQueryRoster } from './adapters/active-query-roster';
import { BacklinkIndex } from './adapters/backlink-index';
import { createRhizomeEditorExtension } from './adapters/codemirror/rhizome-editor-extension';
import { ObsidianLoggerAdapter } from './adapters/obsidian-logger-adapter';
import { PluginDataStore } from './adapters/plugin-data-store';
import { processRhizomeCodeBlock } from './adapters/rhizome-codeblock';
import {
	explainVaultQuery,
	runVaultQuery,
	type VaultQueryCallback,
	type VaultQueryOptions,
	type VaultQueryResult,
} from './adapters/vault-query-runner';
import {
	DEFAULT_SETTINGS,
	DiagnosticsLoggingModal,
	type RhizomeSettings,
	RhizomeSettingTab,
} from './settings';

const REACTIVE_QUERY_DEBOUNCE_MS = 500;

function isMarkdownPath(path: unknown): boolean {
	return typeof path === 'string' && path.toLowerCase().endsWith('.md');
}

function isDoNotIndexFrontmatter(cache: CachedMetadata | null | undefined): boolean {
	return hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY);
}

function getAbstractFileCache(
	app: App,
	file: TAbstractFile | null | undefined,
): CachedMetadata | null {
	if (!file) {
		return null;
	}
	if (file instanceof TFile) {
		return app.metadataCache.getFileCache(file);
	}
	if (typeof file.path === 'string' && typeof app.metadataCache.getCache === 'function') {
		return app.metadataCache.getCache(file.path);
	}
	return null;
}

export default class RhizomePlugin extends Plugin {
	declare settings: RhizomeSettings;
	loggerAdapter!: ObsidianLoggerAdapter;
	dataStore!: PluginDataStore;
	activeQueryRoster!: ActiveQueryRoster;
	backlinkIndex!: BacklinkIndex;

	override async onload() {
		this.settings = { ...DEFAULT_SETTINGS };

		// Wired here so it exists before any core/service constructor
		// needs it injected; reads settings live, so no re-wiring is needed
		// when the user flips the Diagnostics toggle.
		this.loggerAdapter = new ObsidianLoggerAdapter(
			this.app,
			() => this.settings,
			this.manifest.name,
		);

		this.dataStore = new PluginDataStore(
			() => this.loadData(),
			(data) => this.saveData(data),
			DEFAULT_SETTINGS,
			this.loggerAdapter,
		);
		await this.loadSettings();

		this.loggerAdapter.log('debug', `${this.manifest.name} loaded`, {
			source: 'lifecycle',
			version: this.manifest.version,
		});

		this.backlinkIndex = new BacklinkIndex(this.app, (file) => this.isIgnoredNote(file));
		this.activeQueryRoster = new ActiveQueryRoster(
			this.app,
			this.loggerAdapter,
			this.backlinkIndex,
		);
		this.register(() => this.activeQueryRoster.clear());
		this.register(() => this.backlinkIndex.dispose());

		let refreshTimer: number | null = null;
		let resetTimer: number | null = null;
		let indexDirty = false;
		let nudgePending = false;

		const runRefresh = (): void => {
			const dirty = indexDirty;
			const nudge = nudgePending;
			indexDirty = false;
			nudgePending = false;

			let changed = false;
			if (dirty && this.backlinkIndex.isBuilt) {
				changed = this.backlinkIndex.rebuild();
			}
			if ((nudge || changed) && this.activeQueryRoster.size > 0) {
				void this.activeQueryRoster.nudge();
			}
		};
		const scheduleRefresh = (): void => {
			if (refreshTimer !== null) {
				window.clearTimeout(refreshTimer);
			}
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				runRefresh();
			}, REACTIVE_QUERY_DEBOUNCE_MS);
		};
		const scheduleTemplateReset = (): void => {
			if (this.activeQueryRoster.size === 0) {
				return;
			}
			if (resetTimer !== null) {
				window.clearTimeout(resetTimer);
			}
			resetTimer = window.setTimeout(() => {
				resetTimer = null;
				this.activeQueryRoster.resetAll();
			}, REACTIVE_QUERY_DEBOUNCE_MS);
		};
		this.register(() => {
			if (refreshTimer !== null) {
				window.clearTimeout(refreshTimer);
				refreshTimer = null;
			}
			if (resetTimer !== null) {
				window.clearTimeout(resetTimer);
				resetTimer = null;
			}
		});

		const isTemplateFolderNote = (path: unknown): boolean =>
			isMarkdownPath(path) && isPathInTemplateFolders(path, this.getTemplateFolderConfig());

		// Notes with ◊InternalRhizome code "001" (DO_NOT_INDEX_OR_QUERY) are
		// ignored across metadataCache/vault events so internal notes (such as
		// diagnostic log segments) never trigger reactive query nudges. If a
		// user adds "001" to an already-indexed note that matched an active
		// query, suppressing `changed` means that note stays in the subscriber's
		// result until the query is deregistered and re-registered (or another
		// note change triggers a nudge) — an accepted trade-off over extra
		// state-tracking complexity.
		this.registerEvent(
			this.app.metadataCache.on('changed', (file, _data, cache) => {
				if (isTemplateFolderNote(file?.path)) {
					scheduleTemplateReset();
				}
				if (
					isMarkdownPath(file?.path) &&
					!isDoNotIndexFrontmatter(cache ?? this.app.metadataCache.getFileCache(file))
				) {
					indexDirty = true;
					nudgePending = true;
					scheduleRefresh();
				}
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on('deleted', (file, prevCache) => {
				if (isTemplateFolderNote(file?.path)) {
					scheduleTemplateReset();
				}
				if (
					isMarkdownPath(file?.path) &&
					!isDoNotIndexFrontmatter(prevCache ?? this.app.metadataCache.getFileCache(file))
				) {
					indexDirty = true;
					nudgePending = true;
					scheduleRefresh();
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (typeof oldPath === 'string' && typeof file?.path === 'string') {
					this.activeQueryRoster.handleFileRename(oldPath, file.path);
				}
				if (isTemplateFolderNote(file?.path) || isTemplateFolderNote(oldPath)) {
					scheduleTemplateReset();
				}
				if (
					(isMarkdownPath(file?.path) || isMarkdownPath(oldPath)) &&
					!isDoNotIndexFrontmatter(getAbstractFileCache(this.app, file))
				) {
					indexDirty = true;
					nudgePending = true;
					scheduleRefresh();
				}
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on('resolve', (file) => {
				if (this.isIgnoredNote(file)) {
					return;
				}
				indexDirty = true;
				scheduleRefresh();
			}),
		);

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new RhizomeSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor('rhizome', (source, el, ctx) =>
			processRhizomeCodeBlock(source, el, ctx, this),
		);
		this.registerEditorExtension(
			createRhizomeEditorExtension(this.app, this.loggerAdapter, this.backlinkIndex),
		);

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.loggingEnabled) {
				new DiagnosticsLoggingModal(this.app, this).open();
			}
		});
	}

	override onunload() {
		this.loggerAdapter?.log('debug', `${this.manifest.name} unloaded`, {
			source: 'lifecycle',
		});
		void this.loggerAdapter?.flush();
	}

	async loadSettings() {
		this.settings = await this.dataStore.loadSettings();
	}

	async saveSettings() {
		await this.dataStore.saveSettings(this.settings);
	}

	private isIgnoredNote(file: TFile): boolean {
		return isDoNotIndexFrontmatter(getAbstractFileCache(this.app, file));
	}

	getTemplateFolderConfig(): TemplateFolderConfig {
		return {
			templatesFolder: this.settings.templatesFolder,
			partialsFolder: this.settings.partialsFolder,
			layoutsFolder: this.settings.layoutsFolder,
			configDir: this.app.vault.configDir,
		};
	}

	async query(
		queries: Readonly<Record<string, string>> = {},
		options?: VaultQueryOptions,
		onUpdate?: VaultQueryCallback,
	): Promise<VaultQueryResult> {
		const result = await runVaultQuery(
			this.app,
			queries,
			{
				...options,
				backlinks: this.backlinkIndex.snapshot(),
				isIgnoredFile: (file) => this.isIgnoredNote(file),
			},
			this.loggerAdapter,
		);
		if (onUpdate || typeof options?.onReset === 'function') {
			this.activeQueryRoster?.register(queries, options, result, onUpdate);
		}
		return result;
	}

	async explainQuery(input: string = '', options?: VaultQueryOptions): Promise<string> {
		return explainVaultQuery(
			this.app,
			input,
			{
				...options,
				backlinks: this.backlinkIndex.snapshot(),
				isIgnoredFile: (file) => this.isIgnoredNote(file),
			},
			this.loggerAdapter,
		);
	}
}
