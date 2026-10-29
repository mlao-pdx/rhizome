import type { App, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import RhizomePlugin from '../../src/main';
import {
	createdSettings,
	createMockApp,
	createMockManifest,
	openedModals,
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

	it('diagnoseQuery() evaluates against the vault and returns matches, paths, and propertyDiagnostics', async () => {
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

		const result = await plugin.diagnoseQuery('#project [status: active]');
		expect(result.executable).toBe(true);
		expect(result.paths).toEqual(['notes/alpha.md']);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.file.path).toBe('notes/alpha.md');
		expect(result.diagnostics).toEqual([]);
		expect(result.propertyDiagnostics).toEqual([]);

		const matchAllResult = await plugin.diagnoseQuery();
		expect(matchAllResult.executable).toBe(true);
		expect(matchAllResult.paths).toEqual(['notes/alpha.md']);

		const explainMd = await plugin.explainQuery('#project [status: active]', {
			timeZone: 'UTC',
			referenceTimeMs: 1700000000000,
		});
		expect(explainMd).toContain('# Query Explain Plan');
		expect(explainMd).toContain('## Logic Breakdown');
		expect(explainMd).toContain('## Diagnostics');
		expect(explainMd).toContain('## Concept Reference');
	});
});
