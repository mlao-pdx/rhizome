import {
	App,
	Modal,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	type SettingDefinitionPage,
} from 'obsidian';
import {
	DEFAULT_LAYOUTS_FOLDER,
	DEFAULT_PARTIALS_FOLDER,
	DEFAULT_TEMPLATES_FOLDER,
} from '@core/templates';
import type { LogLevel } from '@ports/logger-port';
import { LEVEL_ORDER } from './adapters/logger-format';
import { mergeSettings } from './adapters/plugin-data-store';
import RhizomePlugin from './main';

export interface RhizomeSettings {
	/** Vault-relative folder path for LiquidJS top-level templates (`root`). */
	templatesFolder: string;
	/** Vault-relative folder path for LiquidJS partials (`{% render %}` and `{% include %}`). */
	partialsFolder: string;
	/** Vault-relative folder path for LiquidJS layouts (`{% layout %}`). */
	layoutsFolder: string;
	/** Diagnostics: write logs to the vault. Off by default. */
	loggingEnabled: boolean;
	/** Diagnostics: minimum severity written once logging is enabled. */
	logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: RhizomeSettings = {
	templatesFolder: DEFAULT_TEMPLATES_FOLDER,
	partialsFolder: DEFAULT_PARTIALS_FOLDER,
	layoutsFolder: DEFAULT_LAYOUTS_FOLDER,
	loggingEnabled: false,
	logLevel: 'warn',
};

/**
 * Startup modal shown via `workspace.onLayoutReady` when diagnostic logging
 * is still enabled from a previous session, preventing silent disk usage.
 */
export class DiagnosticsLoggingModal extends Modal {
	private selectedLevel: LogLevel;

	constructor(
		app: App,
		private readonly plugin: RhizomePlugin,
	) {
		super(app);
		this.selectedLevel = plugin.settings.logLevel;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		this.setTitle('Diagnostic logging is enabled');

		contentEl.createEl('p', {
			text:
				`Rhizome is currently writing diagnostic logs at the "${this.plugin.settings.logLevel}" ` +
				`level to ${this.plugin.loggerAdapter.logsFolderPath}/. Turn logging off when you are ` +
				'not actively troubleshooting so log files do not accumulate on disk.',
		});

		new Setting(contentEl)
			.setName('Log level')
			.setDesc('Minimum severity written while logging remains enabled.')
			.addDropdown((dropdown) => {
				for (const level of LEVEL_ORDER) {
					dropdown.addOption(level, level);
				}
				dropdown.setValue(this.selectedLevel).onChange((value) => {
					this.selectedLevel = value as LogLevel;
				});
			});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setCta()
					.setButtonText('Turn off logging')
					.onClick(async () => {
						this.plugin.settings.loggingEnabled = false;
						this.plugin.settings.logLevel = this.selectedLevel;
						await this.plugin.saveSettings();
						this.close();
					}),
			)
			.addButton((button) =>
				button.setButtonText('Continue logging').onClick(async () => {
					this.plugin.settings.loggingEnabled = true;
					this.plugin.settings.logLevel = this.selectedLevel;
					await this.plugin.saveSettings();
					this.close();
				}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export class RhizomeSettingTab extends PluginSettingTab {
	plugin: RhizomePlugin;

	constructor(app: App, plugin: RhizomePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Reads the current value for a declarative setting control key from
	 * `this.plugin.settings`.
	 */
	override getControlValue(key: keyof RhizomeSettings): unknown {
		return this.plugin.settings[key];
	}

	/**
	 * Mutates `this.plugin.settings` (normalizing folder paths and validating
	 * `logLevel`) and persists via `PluginDataStore`.
	 *
	 * @remarks
	 * (obsidian-idiom, 2026-10-30) Overridden so declarative `control` bindings
	 * persist through `this.plugin.saveSettings()` (`PluginDataStore`) rather
	 * than Obsidian's default `this.plugin.saveData(this.plugin.settings)`,
	 * which would overwrite the top-level `vaultInstanceId` key in `data.json`.
	 */
	override async setControlValue(key: keyof RhizomeSettings, value: unknown): Promise<void> {
		this.plugin.settings = mergeSettings(DEFAULT_SETTINGS, {
			...this.plugin.settings,
			[key]: value,
		});
		await this.plugin.saveSettings();
		if (key === 'loggingEnabled' || key === 'logLevel') {
			this.update();
		}
	}

	/**
	 * Returns the declarative settings definition tree (Obsidian 1.13+).
	 *
	 * @remarks
	 * (obsidian-idiom, 2026-10-30) Uses Obsidian's declarative settings API
	 * with a navigable `type: 'page'` sub-page for Diagnostics. The
	 * Diagnostics sub-page entry bar MUST always remain the final item in the
	 * returned array so it stays anchored at the bottom of the opening
	 * settings page; insert all new top-level settings and groups above it.
	 */
	override getSettingDefinitions(): SettingDefinitionItem<keyof RhizomeSettings>[] {
		return [
			{
				type: 'group',
				heading: 'Templates',
				items: [
					{
						name: 'Templates folder',
						desc: 'Vault-relative folder where LiquidJS top-level templates are stored.',
						control: {
							type: 'text',
							key: 'templatesFolder',
							defaultValue: DEFAULT_TEMPLATES_FOLDER,
							placeholder: DEFAULT_TEMPLATES_FOLDER,
						},
					},
					{
						name: 'Partials folder',
						desc: 'Vault-relative folder where LiquidJS partials (`{% render %}` and `{% include %}`) are stored.',
						control: {
							type: 'text',
							key: 'partialsFolder',
							defaultValue: DEFAULT_PARTIALS_FOLDER,
							placeholder: DEFAULT_PARTIALS_FOLDER,
						},
					},
					{
						name: 'Layouts folder',
						desc: 'Vault-relative folder where LiquidJS layouts (`{% layout %}`) are stored.',
						control: {
							type: 'text',
							key: 'layoutsFolder',
							defaultValue: DEFAULT_LAYOUTS_FOLDER,
							placeholder: DEFAULT_LAYOUTS_FOLDER,
						},
					},
				],
			},
			// Ordering invariant: the Diagnostics sub-page entry bar must always
			// remain the last item in `getSettingDefinitions()` at the bottom of
			// the opening settings page. Add new setting groups above this line.
			this.getDiagnosticsPageDefinition(),
		];
	}

	/**
	 * Diagnostics sub-page definition: local, developer-facing logging only.
	 * There is no usage analytics or telemetry, per this project's own policy.
	 * Nothing is written until "Write diagnostic logs to vault" is turned on.
	 */
	private getDiagnosticsPageDefinition(): SettingDefinitionPage<keyof RhizomeSettings> {
		const logLevelOptions: Record<string, string> = {};
		for (const level of LEVEL_ORDER) {
			logLevelOptions[level] = level;
		}

		return {
			type: 'page',
			name: 'Diagnostics',
			desc: 'Configure local diagnostic logging for troubleshooting and bug reports.',
			displayValue: () =>
				this.plugin.settings.loggingEnabled
					? `Logging (${this.plugin.settings.logLevel})`
					: 'Off',
			status: () => (this.plugin.settings.loggingEnabled ? 'warning' : null),
			items: [
				{
					name: 'Write diagnostic logs to vault',
					desc:
						`Writes log to ${this.plugin.loggerAdapter.logsFolderPath}/<epoch>.md for bug reports. ` +
						'Off by default; nothing is written until enabled. Sensitive vault content is redacted in the ' +
						'Description column and exposed in the ‼️Description‼️ column — decide which sensitive data to ' +
						'delete before sharing a log file.',
					control: {
						type: 'toggle',
						key: 'loggingEnabled',
						defaultValue: DEFAULT_SETTINGS.loggingEnabled,
					},
				},
				{
					name: 'Log level',
					desc: 'Minimum severity written to the log file. Only takes effect while logging is enabled.',
					control: {
						type: 'dropdown',
						key: 'logLevel',
						defaultValue: DEFAULT_SETTINGS.logLevel,
						options: logLevelOptions,
						disabled: () => !this.plugin.settings.loggingEnabled,
					},
				},
				{
					name: 'Reveal log folder',
					desc: `Opens ${this.plugin.loggerAdapter.logsFolderPath} in Notebook Navigator (when active) or Obsidian\u2019s file explorer.`,
					render: (setting) => {
						setting.addButton((button) =>
							button.setButtonText('Reveal log folder').onClick(() => {
								void this.plugin.loggerAdapter.revealLogFolder();
							}),
						);
					},
				},
				{
					name: 'Clear logs',
					desc: `Deletes all diagnostic log files in ${this.plugin.loggerAdapter.logsFolderPath}, if present.`,
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setDestructive()
								.setButtonText('Clear logs')
								.onClick(async () => {
									await this.plugin.loggerAdapter.clearLogs();
								}),
						);
					},
				},
			],
		};
	}
}
