import { App, Modal, PluginSettingTab, Setting } from 'obsidian';
import {
	DEFAULT_LAYOUTS_FOLDER,
	DEFAULT_PARTIALS_FOLDER,
	DEFAULT_TEMPLATES_FOLDER,
	normalizeTemplateFolderPath,
} from '@core/templates';
import type { LogLevel } from '@ports/logger-port';
import { LEVEL_ORDER } from './adapters/logger-format';
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

	override display(): void {
		const { containerEl } = this;

		containerEl.empty();

		this.displayTemplates(containerEl);
		this.displayDiagnostics(containerEl);
	}

	private displayTemplates(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Templates').setHeading();

		new Setting(containerEl)
			.setName('Templates folder')
			.setDesc('Vault-relative folder where LiquidJS top-level templates are stored.')
			.addText((text) => {
				const t = text as {
					setPlaceholder?: (p: string) => unknown;
					setValue?: (v: string) => unknown;
					onChange?: (cb: (v: string) => unknown) => unknown;
				};
				t.setPlaceholder?.(DEFAULT_TEMPLATES_FOLDER);
				t.setValue?.(this.plugin.settings.templatesFolder);
				t.onChange?.(async (value) => {
					this.plugin.settings.templatesFolder = normalizeTemplateFolderPath(
						value,
						DEFAULT_TEMPLATES_FOLDER,
					);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Partials folder')
			.setDesc(
				'Vault-relative folder where LiquidJS partials (`{% render %}` and `{% include %}`) are stored.',
			)
			.addText((text) => {
				const t = text as {
					setPlaceholder?: (p: string) => unknown;
					setValue?: (v: string) => unknown;
					onChange?: (cb: (v: string) => unknown) => unknown;
				};
				t.setPlaceholder?.(DEFAULT_PARTIALS_FOLDER);
				t.setValue?.(this.plugin.settings.partialsFolder);
				t.onChange?.(async (value) => {
					this.plugin.settings.partialsFolder = normalizeTemplateFolderPath(
						value,
						DEFAULT_PARTIALS_FOLDER,
					);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Layouts folder')
			.setDesc('Vault-relative folder where LiquidJS layouts (`{% layout %}`) are stored.')
			.addText((text) => {
				const t = text as {
					setPlaceholder?: (p: string) => unknown;
					setValue?: (v: string) => unknown;
					onChange?: (cb: (v: string) => unknown) => unknown;
				};
				t.setPlaceholder?.(DEFAULT_LAYOUTS_FOLDER);
				t.setValue?.(this.plugin.settings.layoutsFolder);
				t.onChange?.(async (value) => {
					this.plugin.settings.layoutsFolder = normalizeTemplateFolderPath(
						value,
						DEFAULT_LAYOUTS_FOLDER,
					);
					await this.plugin.saveSettings();
				});
			});
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
