import { type App, type CachedMetadata, Plugin, type TAbstractFile, TFile } from 'obsidian';
import { hasInternalRhizomeFlag, INTERNAL_RHIZOME_CODES } from '@core/search';
import { isPathInTemplateFolders, type TemplateFolderConfig } from '@core/templates';
import { ActiveQueryRoster } from './adapters/active-query-roster';
import { BacklinkIndex } from './adapters/backlink-index';
import { BodyScanCache } from './adapters/body-scan-cache';
import { CodeBlockRenderCache } from './adapters/codeblock-render-cache';
import { createRhizomeEditorExtension } from './adapters/codemirror/rhizome-editor-extension';
import { InlineHostResolver } from './adapters/inline-host-resolver';
import { NormalizedDocumentCache } from './adapters/normalized-document-cache';
import { ObsidianLoggerAdapter } from './adapters/obsidian-logger-adapter';
import { PluginDataStore } from './adapters/plugin-data-store';
import { RenderSentinelStore } from './adapters/render-sentinel-store';
import { processRhizomeCodeBlock } from './adapters/rhizome-codeblock';
import { processRhizomeInlineSpans } from './adapters/rhizome-inline-postprocessor';
import {
	insertInlineExpressionAtSelection,
	RhizomeInlineSuggest,
} from './adapters/rhizome-inline-suggest';
import {
	openCreateNoteFromTemplatePicker,
	openInsertFromTemplatePicker,
} from './adapters/template-runner';
import {
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
	inlineHostResolver!: InlineHostResolver;
	backlinkIndex!: BacklinkIndex;
	bodyScanCache!: BodyScanCache;
	documentCache!: NormalizedDocumentCache;
	codeBlockRenderCache!: CodeBlockRenderCache;
	renderSentinelStore!: RenderSentinelStore;
	private vaultReady = false;
	private readonly vaultReadyWaiters = new Set<() => void>();

	override async onload() {
		this.settings = { ...DEFAULT_SETTINGS };
		this.vaultReady = false;
		this.vaultReadyWaiters.clear();

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

		const isTemplateFolderNote = (path: unknown): boolean =>
			isMarkdownPath(path) && isPathInTemplateFolders(path, this.getTemplateFolderConfig());

		this.backlinkIndex = new BacklinkIndex(
			this.app,
			(file) => this.isIgnoredNote(file),
			this.loggerAdapter,
		);
		this.bodyScanCache = new BodyScanCache(
			this.app,
			this.loggerAdapter,
			undefined,
			undefined,
			(path) => isTemplateFolderNote(path),
		);
		this.documentCache = new NormalizedDocumentCache(
			this.app,
			this.loggerAdapter,
			this.bodyScanCache,
			(file) => this.isIgnoredNote(file),
		);
		this.documentCache.setReady(false);
		this.codeBlockRenderCache = new CodeBlockRenderCache();
		this.renderSentinelStore = new RenderSentinelStore(this.app, this.loggerAdapter);
		void this.renderSentinelStore.hydrate();
		this.activeQueryRoster = new ActiveQueryRoster(
			this.app,
			this.loggerAdapter,
			this.backlinkIndex,
			this.documentCache,
		);
		this.inlineHostResolver = new InlineHostResolver(
			this.app,
			this.loggerAdapter,
			this.backlinkIndex,
			this.documentCache,
			(file) => this.isIgnoredNote(file),
		);
		this.register(() => this.activeQueryRoster.clear());
		this.register(() => this.inlineHostResolver.dispose());
		this.register(() => this.backlinkIndex.dispose());
		this.register(() => this.bodyScanCache.dispose());
		this.register(() => this.documentCache.clear());
		this.register(() => this.codeBlockRenderCache.clear());
		this.register(() => this.renderSentinelStore.dispose());
		this.register(() => {
			for (const wake of [...this.vaultReadyWaiters]) {
				wake();
			}
			this.vaultReadyWaiters.clear();
		});

		let refreshTimer: number | null = null;
		let resetTimer: number | null = null;

		const runRefresh = (): void => {
			this.activeQueryRoster.clearRefreshScheduled();
			if (this.activeQueryRoster.size > 0) {
				void this.activeQueryRoster.nudge(Date.now(), { onlyIfChanged: true });
			}
		};
		const scheduleRefresh = (): void => {
			this.activeQueryRoster.notifyRefreshScheduled();
			if (refreshTimer !== null) {
				window.clearTimeout(refreshTimer);
			}
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				runRefresh();
			}, REACTIVE_QUERY_DEBOUNCE_MS);
		};
		const scheduleTemplateReset = (): void => {
			this.activeQueryRoster.markVaultDirty();
			if (this.activeQueryRoster.size === 0) {
				this.activeQueryRoster.resetAll();
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

		const startupTasks: Array<Promise<void>> = [];
		const markVaultReady = (): void => {
			if (this.vaultReady) return;
			this.vaultReady = true;
			this.documentCache.setReady(true);
			this.backlinkIndex.dispose();
			this.activeQueryRoster.markVaultDirty();
			this.inlineHostResolver.notifyIndexRebuilt();
			for (const wake of [...this.vaultReadyWaiters]) {
				wake();
			}
			this.vaultReadyWaiters.clear();
			if (this.activeQueryRoster.size > 0) {
				scheduleRefresh();
			}
			startupTasks.push(
				(async () => {
					const hydrated = await this.bodyScanCache.hydrateFromIndexedDB();
					if (hydrated > 0) {
						this.activeQueryRoster.markVaultDirty();
						this.inlineHostResolver.notifyIndexRebuilt();
						if (this.activeQueryRoster.size > 0) {
							scheduleRefresh();
						}
					}
					let bodiesReconciled = false;
					await this.bodyScanCache.reconcileVaultBodies(() => {
						bodiesReconciled = true;
						scheduleRefresh();
					});
					if (bodiesReconciled) {
						this.inlineHostResolver.notifyIndexRebuilt();
					}
				})(),
			);
		};

		this.registerEvent(this.app.metadataCache.on('resolved', markVaultReady));

		// Vault and metadata events schedule a trailing debounced pass; reconciliation against
		// live vault state happens once when the pass runs. Excluded (DO_NOT_INDEX_OR_QUERY)
		// notes are ignored unless they were previously indexed and need eviction.
		this.registerEvent(
			this.app.metadataCache.on('changed', (file, data, cache) => {
				if (isTemplateFolderNote(file?.path)) {
					scheduleTemplateReset();
				}
				if (typeof file?.path !== 'string' || file.path.length === 0) {
					return;
				}
				if (!isMarkdownPath(file.path)) {
					scheduleRefresh();
					return;
				}
				const nextCache = cache ?? this.app.metadataCache.getFileCache(file);
				const ignored =
					isDoNotIndexFrontmatter(nextCache) || isTemplateFolderNote(file.path);
				if (ignored) {
					this.bodyScanCache.delete(file.path);
				} else if (typeof data === 'string') {
					this.bodyScanCache.ingestFromText(file, data, nextCache);
				}
				// Excluded notes (DO_NOT_INDEX_OR_QUERY or template folders) are ignored.
				// Exception: if the note is currently present in documentCache, tracked as a
				// backlink source, or actively subscribed by an inline host, allow through.
				if (
					ignored &&
					this.documentCache.get(file.path) === undefined &&
					!this.backlinkIndex.hasSource(file.path) &&
					!this.inlineHostResolver.hasActivePath(file.path)
				) {
					return;
				}
				this.inlineHostResolver.notifyMetadataChanged(file.path);
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
					scheduleRefresh();
					return;
				}
				this.bodyScanCache.delete(file.path);
				const lastCache = prevCache ?? this.app.metadataCache.getFileCache(file);
				// Excluded notes (DO_NOT_INDEX_OR_QUERY or template folders) are ignored on deletion unless they are
				// still present in documentCache, backlinkIndex, or inlineHostResolver.
				if (
					(isDoNotIndexFrontmatter(lastCache) || isTemplateFolderNote(file.path)) &&
					this.documentCache.get(file.path) === undefined &&
					!this.backlinkIndex.hasSource(file.path) &&
					!this.inlineHostResolver.hasActivePath(file.path)
				) {
					return;
				}
				this.inlineHostResolver.notifyMetadataChanged(file.path);
				scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (typeof oldPath === 'string' && typeof file?.path === 'string') {
					const movedOutOfTemplates =
						isTemplateFolderNote(oldPath) && !isTemplateFolderNote(file.path);
					const movedIntoTemplates = isTemplateFolderNote(file.path);
					const wasCachedInDocumentStore =
						this.documentCache.get(oldPath) !== undefined ||
						this.documentCache.get(file.path) !== undefined;
					this.bodyScanCache.rename(oldPath, file.path);
					if (movedIntoTemplates) {
						this.documentCache.delete(oldPath);
						this.documentCache.delete(file.path);
					} else if (movedOutOfTemplates) {
						void this.bodyScanCache.reconcileVaultBodies(() => {
							scheduleRefresh();
						});
					}
					const renamedCache = getAbstractFileCache(this.app, file);
					// Excluded notes (DO_NOT_INDEX_OR_QUERY or template folders) are ignored on rename unless oldPath
					// or newPath was cached in documentCache or tracked in backlinkIndex, in which case
					// reconciliation must run to evict the stale entry and refresh active queries.
					const untrackedIgnored =
						isMarkdownPath(file.path) &&
						(isDoNotIndexFrontmatter(renamedCache) || movedIntoTemplates) &&
						!wasCachedInDocumentStore &&
						!this.backlinkIndex.hasSource(oldPath) &&
						!this.backlinkIndex.hasSource(file.path);
					this.activeQueryRoster.handleFileRename(oldPath, file.path, !untrackedIgnored);
					if (!untrackedIgnored) {
						this.backlinkIndex.notifyRename();
						scheduleRefresh();
					}
					this.inlineHostResolver.notifyFileRename(oldPath, file.path);
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
				// Excluded Markdown notes (DO_NOT_INDEX_OR_QUERY, e.g. diagnostic logs) are
				// ignored. Exception: allow through if still present in documentCache or
				// backlinkIndex so reconciliation evicts the note.
				if (
					isMarkdownPath(file.path) &&
					this.isIgnoredNote(file) &&
					this.documentCache.get(file.path) === undefined &&
					!this.backlinkIndex.hasSource(file.path)
				) {
					return;
				}
				// Fast-reject no-op resolve events when neither backlinks nor the note's own
				// cached link resolution changed, avoiding unnecessary timer/log cycles.
				if (
					this.backlinkIndex.isBuilt &&
					!this.backlinkIndex.hasSourceChanged(file.path) &&
					!this.documentCache.hasLinkResolutionChanged(file)
				) {
					return;
				}
				this.inlineHostResolver.notifyLinksResolved();
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
			processRhizomeCodeBlock(source, el, ctx, this, 'rhizome'),
		);
		this.registerMarkdownCodeBlockProcessor('rhizome-sample', (source, el, ctx) =>
			processRhizomeCodeBlock(source, el, ctx, this, 'rhizome-sample'),
		);
		this.registerMarkdownPostProcessor((el, ctx) => processRhizomeInlineSpans(el, ctx, this));
		this.registerEditorSuggest(new RhizomeInlineSuggest(this.app));
		this.addCommand({
			id: 'create-note-from-template',
			name: 'Create new note from template',
			callback: () => {
				void openCreateNoteFromTemplatePicker(this);
			},
		});
		this.addCommand({
			id: 'insert-from-template',
			name: 'Insert from template',
			editorCallback: (editor, ctx) => {
				void openInsertFromTemplatePicker(this, editor, ctx.file);
			},
		});
		this.addCommand({
			id: 'insert-inline-expression',
			name: 'Insert inline expression',
			editorCallback: (editor) => {
				insertInlineExpressionAtSelection(editor);
			},
		});
		this.registerEditorExtension(
			createRhizomeEditorExtension(
				this.app,
				this.loggerAdapter,
				this.backlinkIndex,
				this.documentCache,
				this.inlineHostResolver,
				(signal) => this.waitForVaultReady(signal),
			),
		);

		this.app.workspace.onLayoutReady(() => {
			markVaultReady();
			if (this.settings.loggingEnabled) {
				new DiagnosticsLoggingModal(this.app, this).open();
			}
		});
		if (startupTasks.length > 0) {
			await Promise.all(startupTasks);
		}
	}

	waitForVaultReady(signal?: AbortSignal): Promise<void> {
		if (this.vaultReady || signal?.aborted) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const settle = (): void => {
				this.vaultReadyWaiters.delete(settle);
				signal?.removeEventListener('abort', settle);
				resolve();
			};
			this.vaultReadyWaiters.add(settle);
			signal?.addEventListener('abort', settle, { once: true });
		});
	}

	async rebuildIndex(): Promise<void> {
		await this.bodyScanCache.clearAll();
		await this.renderSentinelStore.clearAll();
		this.codeBlockRenderCache.clear();
		this.documentCache.clear();
		this.backlinkIndex.dispose();
		this.activeQueryRoster.markVaultDirty();
		await this.bodyScanCache.reconcileVaultBodies(() => {
			this.activeQueryRoster.markVaultDirty();
		});
		this.activeQueryRoster.resetAll();
		this.inlineHostResolver.notifyIndexRebuilt();
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
		return (
			isDoNotIndexFrontmatter(getAbstractFileCache(this.app, file)) ||
			isPathInTemplateFolders(file.path, this.getTemplateFolderConfig())
		);
	}

	handleTemplateFoldersChanged(): void {
		const folderCfg = this.getTemplateFolderConfig();
		if (this.documentCache) {
			for (const cachedPath of [...this.documentCache.keys()]) {
				if (isPathInTemplateFolders(cachedPath, folderCfg)) {
					this.documentCache.delete(cachedPath);
				}
			}
		}
		this.codeBlockRenderCache?.clear();
		this.backlinkIndex?.dispose();
		this.activeQueryRoster?.markVaultDirty();
		void this.bodyScanCache?.reconcileVaultBodies(() => {
			this.activeQueryRoster?.markVaultDirty();
			this.activeQueryRoster?.resetAll();
			this.inlineHostResolver?.notifyIndexRebuilt();
		});
		this.activeQueryRoster?.resetAll();
		this.inlineHostResolver?.notifyIndexRebuilt();
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
				isIgnoredFile: (file) => this.isIgnoredNote(file),
			},
			this.loggerAdapter,
		);
		if (onUpdate || typeof options?.onReset === 'function') {
			this.activeQueryRoster?.register(queries, options, result, onUpdate);
		}
		return result;
	}
}
