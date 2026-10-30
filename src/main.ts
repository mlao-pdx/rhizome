import { FileSystemAdapter, Plugin } from 'obsidian';
import { createRhizomeEditorExtension } from './adapters/codemirror/rhizome-editor-extension';
import { DexiePersistenceAdapter } from './adapters/dexie-persistence-adapter';
import { ObsidianLoggerAdapter } from './adapters/obsidian-logger-adapter';
import { PluginDataStore } from './adapters/plugin-data-store';
import { processRhizomeCodeBlock } from './adapters/rhizome-codeblock';
import {
	explainVaultQuery,
	runVaultQuery,
	type VaultQueryOptions,
	type VaultQueryResult,
} from './adapters/vault-query-runner';
import {
	DEFAULT_SETTINGS,
	DiagnosticsLoggingModal,
	type RhizomeSettings,
	RhizomeSettingTab,
} from './settings';

export default class RhizomePlugin extends Plugin {
	declare settings: RhizomeSettings;
	loggerAdapter!: ObsidianLoggerAdapter;
	dataStore!: PluginDataStore;
	persistence!: DexiePersistenceAdapter;

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

		// 'cache' is this plugin's databaseId — part of the IndexedDB
		// address and stable like manifest.id: renaming it orphans every
		// user's existing database (docs/dev/indexeddb-database-identity.md).
		// No I/O happens here: bootstrap is deferred until first use.
		const vaultAdapter = this.app.vault.adapter;
		if (!(vaultAdapter instanceof FileSystemAdapter)) {
			// Cannot happen: this plugin is desktop-only
			// (`manifest.json` sets `isDesktopOnly: true`).
			throw new Error('Expected a FileSystemAdapter vault adapter');
		}
		this.persistence = new DexiePersistenceAdapter(
			this.manifest.id,
			'cache',
			vaultAdapter.getBasePath(),
			() => this.dataStore.ensureVaultInstanceId(),
			this.loggerAdapter,
		);
		this.register(() => this.persistence.close());

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new RhizomeSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor('rhizome', (source, el, ctx) =>
			processRhizomeCodeBlock(source, el, ctx, this),
		);
		this.registerEditorExtension(createRhizomeEditorExtension(this.app, this.loggerAdapter));

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

	async query(
		queries: Readonly<Record<string, string>> = {},
		options?: VaultQueryOptions,
	): Promise<VaultQueryResult> {
		return runVaultQuery(this.app, queries, options, this.loggerAdapter);
	}

	async explainQuery(input: string = '', options?: VaultQueryOptions): Promise<string> {
		return explainVaultQuery(this.app, input, options, this.loggerAdapter);
	}
}
