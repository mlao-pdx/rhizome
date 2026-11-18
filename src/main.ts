import { type App, type CachedMetadata, Plugin, type TAbstractFile, TFile } from 'obsidian';
import { hasInternalRhizomeFlag, INTERNAL_RHIZOME_CODES } from '@core/search';
import { isPathInTemplateFolders, type TemplateFolderConfig } from '@core/templates';
import { ActiveQueryRoster } from './adapters/active-query-roster';
import { BacklinkIndex } from './adapters/backlink-index';
import { createRhizomeEditorExtension } from './adapters/codemirror/rhizome-editor-extension';
import { DirtySet } from './adapters/dirty-set';
import { NormalizedDocumentCache } from './adapters/normalized-document-cache';
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
	documentCache!: NormalizedDocumentCache;
	dirtySet!: DirtySet;

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
		this.documentCache = new NormalizedDocumentCache(this.app, this.loggerAdapter);
		this.documentCache.setReady(false);
		this.dirtySet = new DirtySet();
		this.activeQueryRoster = new ActiveQueryRoster(
			this.app,
			this.loggerAdapter,
			this.backlinkIndex,
			this.documentCache,
			this.dirtySet,
		);
		this.register(() => this.activeQueryRoster.clear());
		this.register(() => this.backlinkIndex.dispose());
		this.register(() => this.documentCache.clear());
		this.register(() => this.dirtySet.clear());

		let refreshTimer: number | null = null;
		let resetTimer: number | null = null;
		let nudgePending = false;

		const runRefresh = (): void => {
			const nudge = nudgePending;
			nudgePending = false;
			const pending = this.dirtySet.peek();
			const fullRebuild = this.dirtySet.consumeFullRebuild();

			let changed = false;
			if (this.backlinkIndex.isBuilt) {
				if (fullRebuild) {
					this.backlinkIndex.dispose();
				} else {
					changed = this.backlinkIndex.applyDirtySources(
						pending.sources,
						pending.ignored,
					);
				}
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

		const markDependents = (paths: readonly string[]): void => {
			for (const dependent of this.documentCache.dependentSources(paths)) {
				this.dirtySet.markPath(dependent);
			}
		};

		let vaultReady = false;
		const markVaultReady = (): void => {
			if (vaultReady) return;
			vaultReady = true;
			this.documentCache.setReady(true);
			this.dirtySet.markFullRebuild();
			if (this.activeQueryRoster.size > 0) {
				nudgePending = true;
				scheduleRefresh();
			}
		};

		this.registerEvent(this.app.metadataCache.on('resolved', markVaultReady));

		// Every event only records intent in the dirty set; cache writes happen in one
		// batch at the top of the next pass. Notes that gain the ignore flag are still
		// marked so the pass removes them from the cache and from backlinks.
		this.registerEvent(
			this.app.metadataCache.on('changed', (file, _data, cache) => {
				if (isTemplateFolderNote(file?.path)) {
					scheduleTemplateReset();
				}
				if (!isMarkdownPath(file?.path)) {
					if (typeof file?.path === 'string' && file.path.length > 0) {
						this.dirtySet.markSource(file.path);
						scheduleRefresh();
					}
					return;
				}
				const nextCache = cache ?? this.app.metadataCache.getFileCache(file);
				if (
					isDoNotIndexFrontmatter(nextCache) &&
					this.documentCache.get(file.path) === undefined
				) {
					return;
				}
				this.dirtySet.markChanged(file.path);
				markDependents([file.path]);
				nudgePending = true;
				scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on('deleted', (file, prevCache) => {
				if (isTemplateFolderNote(file?.path)) {
					scheduleTemplateReset();
				}
				if (typeof file?.path !== 'string' || file.path.length === 0) {
					return;
				}
				if (!isMarkdownPath(file.path)) {
					this.dirtySet.markChanged(file.path);
					scheduleRefresh();
					return;
				}
				const lastCache = prevCache ?? this.app.metadataCache.getFileCache(file);
				if (
					isDoNotIndexFrontmatter(lastCache) &&
					this.documentCache.get(file.path) === undefined
				) {
					return;
				}
				this.dirtySet.markChanged(file.path);
				markDependents([file.path]);
				nudgePending = true;
				scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (typeof oldPath === 'string' && typeof file?.path === 'string') {
					this.activeQueryRoster.handleFileRename(oldPath, file.path);
					const renamedCache = getAbstractFileCache(this.app, file);
					const untrackedIgnored =
						isDoNotIndexFrontmatter(renamedCache) &&
						this.documentCache.get(oldPath) === undefined &&
						this.documentCache.get(file.path) === undefined;
					if (!untrackedIgnored) {
						this.dirtySet.markRename(oldPath, file.path);
						markDependents([oldPath, file.path]);
						if (isMarkdownPath(file.path) || isMarkdownPath(oldPath)) {
							nudgePending = true;
						}
						scheduleRefresh();
					}
				}
				if (isTemplateFolderNote(file?.path) || isTemplateFolderNote(oldPath)) {
					scheduleTemplateReset();
				}
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on('resolve', (file) => {
				if (typeof file?.path !== 'string' || file.path.length === 0) {
					return;
				}
				if (this.isIgnoredNote(file)) {
					return;
				}
				this.dirtySet.markChanged(file.path);
				markDependents([file.path]);
				nudgePending = true;
				scheduleRefresh();
			}),
		);

		if (__DEV__) {
			this.addCommand({
				id: 'dev-dump-normalized-document-cache',
				name: 'Dump normalized document cache digest',
				callback: () => {
					this.loggerAdapter.log('debug', 'Normalized document cache digest', {
						source: 'query.cache',
						count: this.documentCache.size,
						digest: this.documentCache.digest(),
					});
				},
			});
		}

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new RhizomeSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor('rhizome', (source, el, ctx) =>
			processRhizomeCodeBlock(source, el, ctx, this),
		);
		this.registerEditorExtension(
			createRhizomeEditorExtension(
				this.app,
				this.loggerAdapter,
				this.backlinkIndex,
				this.documentCache,
			),
		);

		this.app.workspace.onLayoutReady(() => {
			markVaultReady();
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
				cache: this.documentCache,
				backlinkIndex: this.backlinkIndex,
				dirtySet: this.dirtySet,
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
				cache: this.documentCache,
				isIgnoredFile: (file) => this.isIgnoredNote(file),
			},
			this.loggerAdapter,
		);
	}
}
