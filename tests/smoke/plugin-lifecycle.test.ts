import type {
	App,
	PluginManifest,
	SettingDefinitionControl,
	SettingDefinitionGroup,
	SettingDefinitionPage,
	SettingDefinitionRender,
	SettingGroup,
} from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import RhizomePlugin from '../../src/main';
import type { RhizomeSettings, RhizomeSettingTab } from '../../src/settings';
import {
	createdSettings,
	createMockApp,
	createMockManifest,
	openedModals,
	Setting,
} from '../support/mock-obsidian-app';

function createPlugin(): RhizomePlugin {
	const app = createMockApp() as App;
	const manifest = createMockManifest() as PluginManifest;
	return new RhizomePlugin(app, manifest);
}

describe('RhizomePlugin lifecycle (smoke)', () => {
	it('onload() does not throw', async () => {
		const plugin = createPlugin();
		await plugin.onload();
	});

	it('onunload() does not throw', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(() => plugin.onunload()).not.toThrow();
	});

	it('settings load with defaults when loadData() resolves undefined', async () => {
		openedModals.length = 0;
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.settings.loggingEnabled).toBe(false);
		expect(plugin.settings.logLevel).toBe('warn');
		expect(openedModals).toHaveLength(0);
	});

	it('constructs a loggerAdapter during onload()', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.loggerAdapter).toBeDefined();
	});

	it('derives the log folder path from the manifest name with the ◊ system prefix', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.loggerAdapter.logsFolderPath).toBe('◊Rhizome/logs');
	});

	it('opens DiagnosticsLoggingModal on layout ready when loggingEnabled is true and allows changing level or turning off logging', async () => {
		openedModals.length = 0;
		createdSettings.length = 0;
		const plugin = createPlugin();
		plugin.loadData = async () => ({
			settings: { loggingEnabled: true, logLevel: 'debug' },
		});
		const savedData: unknown[] = [];
		plugin.saveData = async (data: unknown) => {
			savedData.push(data);
		};

		await plugin.onload();

		expect(openedModals).toHaveLength(1);
		const modal = openedModals[0]!;
		expect(modal.title).toBe('Diagnostic logging is enabled');
		expect(modal.paragraphs[0]).toContain('◊Rhizome/logs/');
		expect(modal.paragraphs[0]).toContain('"debug"');

		const dropdown = createdSettings.flatMap((s) => s.dropdowns)[0]!;
		expect(dropdown.value).toBe('debug');
		dropdown.changeHandler?.('warn');

		const buttons = createdSettings.flatMap((s) => s.buttons);
		expect(buttons.map((b) => b.buttonText)).toEqual(['Turn off logging', 'Continue logging']);

		await buttons[0]!.clickHandler?.({} as MouseEvent);
		expect(plugin.settings.loggingEnabled).toBe(false);
		expect(plugin.settings.logLevel).toBe('warn');
		expect(modal.isOpen).toBe(false);
		expect(savedData).toHaveLength(1);
	});

	it('registers a declarative RhizomeSettingTab with the Diagnostics sub-page bar anchored at the bottom of the opening page', async () => {
		const plugin = createPlugin();
		plugin.loadData = async () => ({
			settings: { loggingEnabled: false, logLevel: 'warn' },
			vaultInstanceId: 'vault-id-1234',
		});
		const savedData: unknown[] = [];
		plugin.saveData = async (data: unknown) => {
			savedData.push(data);
		};

		await plugin.onload();

		const settingTab = (plugin as unknown as { settingTabs: RhizomeSettingTab[] })
			.settingTabs[0]!;
		expect(settingTab).toBeDefined();

		const definitions = settingTab.getSettingDefinitions();
		expect(definitions.length).toBeGreaterThanOrEqual(2);

		const templatesGroup = definitions[0] as SettingDefinitionGroup<keyof RhizomeSettings>;
		expect(templatesGroup.type).toBe('group');
		expect(templatesGroup.heading).toBe('Templates');
		expect(templatesGroup.items?.map((item) => item.name)).toEqual([
			'Templates folder',
			'Partials folder',
			'Layouts folder',
		]);

		// Ordering invariant: the Diagnostics sub-page entry bar must always be the final item.
		const lastItem = definitions.at(-1) as SettingDefinitionPage<keyof RhizomeSettings>;
		expect(lastItem.type).toBe('page');
		expect(lastItem.name).toBe('Diagnostics');

		const resolveDisplayValue = () =>
			typeof lastItem.displayValue === 'function'
				? lastItem.displayValue()
				: lastItem.displayValue;
		const resolveStatus = () =>
			typeof lastItem.status === 'function' ? lastItem.status() : lastItem.status;

		expect(resolveDisplayValue()).toBe('Off');
		expect(resolveStatus()).toBeNull();

		const pageItems = lastItem.items ?? [];
		expect(pageItems.map((item) => ('name' in item ? item.name : undefined))).toEqual([
			'Write diagnostic logs to vault',
			'Log level',
			'Reveal log folder',
			'Clear logs',
		]);

		const logLevelItem = pageItems[1] as SettingDefinitionControl<keyof RhizomeSettings>;
		const isLogLevelDisabled = () =>
			typeof logLevelItem.control.disabled === 'function'
				? logLevelItem.control.disabled()
				: Boolean(logLevelItem.control.disabled);
		expect(isLogLevelDisabled()).toBe(true);

		// Folder path normalization and PluginDataStore persistence (preserving vaultInstanceId)
		expect(settingTab.getControlValue('templatesFolder')).toBe('◊Rhizome/templates');
		await settingTab.setControlValue('templatesFolder', '  /Custom/Templates/ ');
		expect(settingTab.getControlValue('templatesFolder')).toBe('Custom/Templates');
		const lastSaved = savedData.at(-1) as {
			settings: RhizomeSettings;
			vaultInstanceId?: string;
		};
		expect(lastSaved.settings.templatesFolder).toBe('Custom/Templates');
		expect(lastSaved.vaultInstanceId).toBe('vault-id-1234');

		await settingTab.setControlValue('partialsFolder', '  /Custom/Partials/ ');
		expect(settingTab.getControlValue('partialsFolder')).toBe('Custom/Partials');

		await settingTab.setControlValue('layoutsFolder', '  /Custom/Layouts/ ');
		expect(settingTab.getControlValue('layoutsFolder')).toBe('Custom/Layouts');

		// Toggling loggingEnabled updates the sub-page disabled predicate, bar status, and calls update()
		const updateSpy = vi.spyOn(settingTab, 'update');
		await settingTab.setControlValue('loggingEnabled', true);
		expect(updateSpy).toHaveBeenCalledTimes(1);
		expect(isLogLevelDisabled()).toBe(false);
		expect(resolveDisplayValue()).toBe('Logging (warn)');
		expect(resolveStatus()).toBe('warning');

		await settingTab.setControlValue('logLevel', 'debug');
		expect(updateSpy).toHaveBeenCalledTimes(2);
		expect(resolveDisplayValue()).toBe('Logging (debug)');

		// Reveal log folder and Clear logs action buttons on the Diagnostics sub-page
		const revealSpy = vi
			.spyOn(plugin.loggerAdapter, 'revealLogFolder')
			.mockResolvedValue(undefined);
		const clearSpy = vi.spyOn(plugin.loggerAdapter, 'clearLogs').mockResolvedValue(undefined);

		const revealItem = pageItems[2] as SettingDefinitionRender;
		const revealSetting = new Setting({});
		revealItem.render(revealSetting as never, {} as SettingGroup);
		expect(revealSetting.buttons[0]?.buttonText).toBe('Reveal log folder');
		revealSetting.buttons[0]?.clickHandler?.({} as MouseEvent);
		expect(revealSpy).toHaveBeenCalledTimes(1);

		const clearItem = pageItems[3] as SettingDefinitionRender;
		const clearSetting = new Setting({});
		clearItem.render(clearSetting as never, {} as SettingGroup);
		expect(clearSetting.buttons[0]?.buttonText).toBe('Clear logs');
		expect(clearSetting.buttons[0]?.isDestructive).toBe(true);
		await clearSetting.buttons[0]?.clickHandler?.({} as MouseEvent);
		expect(clearSpy).toHaveBeenCalledTimes(1);
	});

	it('query() evaluates against the vault and returns matched note payloads keyed by query name', async () => {
		const app = createMockApp() as App;
		const mockFile = {
			path: 'notes/alpha.md',
			name: 'alpha.md',
			basename: 'alpha',
			extension: 'md',
			parent: { path: 'notes' },
			stat: { ctime: 1700000000000, mtime: 1700000000000, size: 120 },
		};
		app.vault.getMarkdownFiles = () => [mockFile as never];
		app.metadataCache.getFileCache = () => ({
			frontmatter: { status: 'active' },
			tags: [{ tag: '#project', position: {} as never }],
		});

		const manifest = createMockManifest() as PluginManifest;
		const plugin = new RhizomePlugin(app, manifest);
		await plugin.onload();

		const result = await plugin.query(
			{
				activeProjects: '#project [status: active]',
				allNotes: '',
			},
			{
				timeZone: 'UTC',
				referenceTimeMs: 1700000000000,
			},
		);
		expect(Object.keys(result)).toEqual(['activeProjects', 'allNotes']);
		expect(result['activeProjects']).toHaveLength(1);
		expect(result['allNotes']).toHaveLength(1);
		expect(result['activeProjects']?.[0]).toBe(result['allNotes']?.[0]);
		expect(result['activeProjects']?.[0]?.file.path).toBe('notes/alpha.md');
		expect(result['activeProjects']?.[0]?.tagLocations).toEqual([
			{
				tag: 'project',
				source: 'body',
				origin: '[[notes/alpha.md|alpha]]',
			},
		]);
		expect('normalizationFingerprint' in (result['activeProjects']?.[0] ?? {})).toBe(false);
		expect('propertyOccurrences' in (result['activeProjects']?.[0] ?? {})).toBe(false);
		expect('context' in result).toBe(false);
		expect('diagnostics' in result).toBe(false);
		expect('matches' in result).toBe(false);
		expect('paths' in result).toBe(false);
		expect('propertyDiagnostics' in result).toBe(false);

		const emptyResult = await plugin.query();
		expect(emptyResult).toEqual({});
	});

	it('explainQuery() generates a Markdown explanation plan without scanning vault notes', async () => {
		const plugin = createPlugin();
		await plugin.onload();

		const explainMd = await plugin.explainQuery('#project [status: active]', {
			timeZone: 'UTC',
			referenceTimeMs: 1700000000000,
		});
		expect(explainMd).toContain('# Query Explain Plan');
		expect(explainMd).toContain('## Logic Breakdown');
		expect(explainMd).toContain('## Diagnostics');
		expect(explainMd).toContain('## Concept Reference');

		const defaultExplainMd = await plugin.explainQuery();
		expect(defaultExplainMd).toContain('# Query Explain Plan');
	});

	it('debounces reactive query nudges by 500 ms on .md metadataCache.changed, metadataCache.deleted, and vault.rename events', async () => {
		vi.useFakeTimers();
		try {
			const app = createMockApp() as App & {
				vault: { trigger: (event: string, ...args: unknown[]) => void };
				metadataCache: { trigger: (event: string, ...args: unknown[]) => void };
			};
			let notes = [
				{
					path: 'notes/alpha.md',
					name: 'alpha.md',
					basename: 'alpha',
					extension: 'md',
					parent: { path: 'notes' },
					stat: { ctime: 1700000000000, mtime: 1700000000000, size: 120 },
				},
			];
			app.vault.getMarkdownFiles = () => notes as never;
			app.metadataCache.getFileCache = () => ({
				tags: [{ tag: '#project', position: {} as never }],
			});

			const plugin = new RhizomePlugin(app, createMockManifest() as PluginManifest);
			await plugin.onload();

			const updates: unknown[] = [];
			await plugin.query(
				{ projects: '#project' },
				{ timeZone: 'UTC', referenceTimeMs: 1700000000000 },
				(next) => {
					updates.push(next);
				},
			);
			expect(plugin.activeQueryRoster.size).toBe(1);

			const nudgeSpy = vi.spyOn(plugin.activeQueryRoster, 'nudge');

			// Non-markdown events are ignored
			app.metadataCache.trigger('changed', { path: 'assets/image.png' });
			app.metadataCache.trigger('deleted', { path: 'docs/manual.pdf' });
			app.vault.trigger('rename', { path: 'assets/new.png' }, 'assets/old.png');
			await vi.advanceTimersByTimeAsync(600);
			expect(nudgeSpy).not.toHaveBeenCalled();

			// Rapid burst of .md events coalesces into a single 500 ms trailing nudge
			notes = [
				...notes,
				{
					path: 'notes/beta.md',
					name: 'beta.md',
					basename: 'beta',
					extension: 'md',
					parent: { path: 'notes' },
					stat: { ctime: 1700000000000, mtime: 1700000000000, size: 120 },
				},
			];
			app.metadataCache.trigger('changed', { path: 'notes/beta.md' });
			await vi.advanceTimersByTimeAsync(200);
			app.vault.trigger('rename', { path: 'notes/beta.md' }, 'notes/draft.md');
			await vi.advanceTimersByTimeAsync(200);
			app.metadataCache.trigger('deleted', { path: 'notes/temp.md' });

			// Only 400 ms since first, 0 ms since last -> not fired yet
			expect(nudgeSpy).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(500);
			expect(nudgeSpy).toHaveBeenCalledTimes(1);
			expect(updates).toHaveLength(1);

			// Notes with ◊InternalRhizome: { "001": ... } (DO_NOT_INDEX_OR_QUERY) are ignored
			nudgeSpy.mockClear();
			const doNotIndexCache = {
				frontmatter: {
					'◊InternalRhizome': {
						'001': 'Do not index or query.',
					},
				},
			};
			app.metadataCache.getFileCache = (file) =>
				file?.path?.startsWith('◊Rhizome/logs/')
					? doNotIndexCache
					: { tags: [{ tag: '#project', position: {} as never }] };

			app.metadataCache.trigger(
				'changed',
				{ path: '◊Rhizome/logs/1700000000000.md' },
				'',
				doNotIndexCache,
			);
			app.metadataCache.trigger('changed', { path: '◊Rhizome/logs/1700000000001.md' });
			app.metadataCache.trigger(
				'deleted',
				{ path: '◊Rhizome/logs/1700000000000.md' },
				doNotIndexCache,
			);
			app.vault.trigger(
				'rename',
				{ path: '◊Rhizome/logs/1700000000002.md' },
				'◊Rhizome/logs/1700000000001.md',
			);
			await vi.advanceTimersByTimeAsync(600);
			expect(nudgeSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
