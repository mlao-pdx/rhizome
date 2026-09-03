import { App, PluginSettingTab, Setting } from 'obsidian';
import type { LogLevel } from '@ports/logger-port';
import { LEVEL_ORDER } from './adapters/logger-format';
import MyPlugin from './main';

export interface MyPluginSettings {
	exampleSetting: string;
	/** Diagnostics: write logs to the vault. Off by default. */
	loggingEnabled: boolean;
	/** Diagnostics: minimum severity written once logging is enabled. */
	logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	exampleSetting: 'default',
	loggingEnabled: false,
	logLevel: 'warn',
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Settings #1')
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder('Enter your secret')
					.setValue(this.plugin.settings.exampleSetting)
					.onChange(async (value) => {
						this.plugin.settings.exampleSetting = value;
						await this.plugin.saveSettings();
					}),
			);

		this.displayDiagnostics(containerEl);
	}

	/**
	 * Diagnostics section: local, developer-facing logging only. There is
	 * no usage analytics or telemetry, per this project's own policy.
	 * Nothing is written until "Write diagnostic logs to vault" is turned
	 * on.
	 */
	private displayDiagnostics(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Diagnostics').setHeading();

		new Setting(containerEl)
			.setName('Write diagnostic logs to vault')
			.setDesc(
				`Appends timestamped lines to ${this.plugin.loggerAdapter.logPath} for bug reports. ` +
					'Off by default; nothing is written until enabled. Vault content in a log ' +
					'line is wrapped in «guillemets» — strip everything between « and » before ' +
					'sharing a log file.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.loggingEnabled).onChange(async (value) => {
					this.plugin.settings.loggingEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName('Log level')
			.setDesc(
				'Minimum severity written to the log file. Only takes effect while logging is enabled.',
			)
			.addDropdown((dropdown) => {
				for (const level of LEVEL_ORDER) {
					dropdown.addOption(level, level);
				}
				dropdown
					.setValue(this.plugin.settings.logLevel)
					.setDisabled(!this.plugin.settings.loggingEnabled)
					.onChange(async (value) => {
						this.plugin.settings.logLevel = value as LogLevel;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Reveal log folder')
			.setDesc(
				`Opens ${this.plugin.loggerAdapter.logsFolderPath} in Obsidian\u2019s file explorer.`,
			)
			.addButton((button) =>
				button.setButtonText('Reveal log folder').onClick(() => {
					void this.plugin.loggerAdapter.revealLogFolder();
				}),
			);

		new Setting(containerEl)
			.setName('Clear logs')
			.setDesc(
				`Deletes ${this.plugin.loggerAdapter.logFileName} and ${this.plugin.loggerAdapter.backupFileName}, if present.`,
			)
			.addButton((button) =>
				button
					.setWarning()
					.setButtonText('Clear logs')
					.onClick(async () => {
						await this.plugin.loggerAdapter.clearLogs();
					}),
			);
	}
}
