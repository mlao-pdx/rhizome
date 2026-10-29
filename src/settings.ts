import { App, Modal, PluginSettingTab, Setting } from 'obsidian';
import type { LogLevel } from '@ports/logger-port';
import { LEVEL_ORDER } from './adapters/logger-format';
import RhizomePlugin from './main';

export interface RhizomeSettings {
	/** Diagnostics: write logs to the vault. Off by default. */
	loggingEnabled: boolean;
	/** Diagnostics: minimum severity written once logging is enabled. */
	logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: RhizomeSettings = {
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

	override display(): void {
		const { containerEl } = this;

		containerEl.empty();

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
				`Writes log to ${this.plugin.loggerAdapter.logsFolderPath}/<epoch>.md for bug reports. ` +
					'Off by default; nothing is written until enabled. Sensitive vault content is redacted in the ' +
					'Description column and exposed in the ‼️Description‼️ column — decide which sensitive data to ' +
					'delete before sharing a log file.',
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
				`Opens ${this.plugin.loggerAdapter.logsFolderPath} in Notebook Navigator (when active) or Obsidian\u2019s file explorer.`,
			)
			.addButton((button) =>
				button.setButtonText('Reveal log folder').onClick(() => {
					void this.plugin.loggerAdapter.revealLogFolder();
				}),
			);

		new Setting(containerEl)
			.setName('Clear logs')
			.setDesc(
				`Deletes all diagnostic log files in ${this.plugin.loggerAdapter.logsFolderPath}, if present.`,
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
