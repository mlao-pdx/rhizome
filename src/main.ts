import { CapacitorAdapter, FileSystemAdapter, Plugin, type App } from 'obsidian';
import { DexiePersistenceAdapter } from './adapters/dexie-persistence-adapter';
import { ObsidianLoggerAdapter } from './adapters/obsidian-logger-adapter';
import { deriveVaultScope } from './adapters/persistence-db-name';
import { PluginDataStore } from './adapters/plugin-data-store';
import { DEFAULT_SETTINGS, type RhizomeSettings, RhizomeSettingTab } from './settings';

/**
 * `app.appId` is Obsidian's per-vault instance id (the vault-registry key),
 * absent from the public typings. Typed optional — honest about the
 * fallback: when it is missing, `deriveVaultScope` hashes the vault root.
 *
 * @see docs/dev/indexeddb-database-identity.md
 */
interface ExtendedApp extends App {
	readonly appId?: string;
}

export default class RhizomePlugin extends Plugin {
	settings!: RhizomeSettings;
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
		// Startup stays light: the scope is the appId, or — only when that
		// is unusable — one small hash of the vault root; the database
		// itself is opened lazily on first use. An adapter that is neither
		// FileSystemAdapter nor CapacitorAdapter yields no vault root, and
		// without an appId `deriveVaultScope` throws rather than ever
		// opening an unscoped database.
		const adapter = this.app.vault.adapter;
		const vaultRootPath =
			adapter instanceof FileSystemAdapter
				? adapter.getBasePath()
				: adapter instanceof CapacitorAdapter
					? adapter.getFullPath('')
					: undefined;
		const vaultScope = await deriveVaultScope((this.app as ExtendedApp).appId, vaultRootPath);
		this.persistence = new DexiePersistenceAdapter(
			this.manifest.id,
			'cache',
			vaultScope,
			this.loggerAdapter,
		);
		this.register(() => this.persistence.close());

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new RhizomeSettingTab(this.app, this));
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
