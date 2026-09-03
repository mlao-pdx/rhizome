import { FileSystemAdapter, Plugin } from 'obsidian';
import { DexiePersistenceAdapter } from './adapters/dexie-persistence-adapter';
import { ObsidianLoggerAdapter } from './adapters/obsidian-logger-adapter';
import { PluginDataStore } from './adapters/plugin-data-store';
import { DEFAULT_SETTINGS, type MyPluginSettings, SampleSettingTab } from './settings';

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;
	loggerAdapter!: ObsidianLoggerAdapter;
	dataStore!: PluginDataStore;
	persistence!: DexiePersistenceAdapter;

	override async onload() {
		this.dataStore = new PluginDataStore(
			() => this.loadData(),
			(data) => this.saveData(data),
			DEFAULT_SETTINGS,
		);
		await this.loadSettings();

		// Wired here so it exists before any future core/service constructor
		// needs it injected; reads settings live, so no re-wiring is needed
		// when the user flips the Diagnostics toggle.
		this.loggerAdapter = new ObsidianLoggerAdapter(
			this.app,
			() => this.settings,
			this.manifest.id,
		);
		this.loggerAdapter.log('info', `${this.manifest.name} loaded`, {
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
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	override onunload() {
		this.loggerAdapter?.log('info', `${this.manifest.name} unloaded`);
	}

	async loadSettings() {
		this.settings = await this.dataStore.loadSettings();
	}

	async saveSettings() {
		await this.dataStore.saveSettings(this.settings);
	}
}
