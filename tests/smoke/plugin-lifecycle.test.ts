import type { App, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import RhizomePlugin from '../../src/main';
import { createMockApp, createMockManifest } from '../support/mock-obsidian-app';

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
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.settings.loggingEnabled).toBe(false);
		expect(plugin.settings.logLevel).toBe('warn');
	});

	it('constructs a loggerAdapter during onload()', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.loggerAdapter).toBeDefined();
	});

	it('derives the log folder path from the manifest id, not a hardcoded literal', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.loggerAdapter.logsFolderPath).toBe('_rhizome/logs');
	});

	it('query() evaluates against the vault and returns { context, diagnostics, matches }', async () => {
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
		expect(result.context).toEqual({
			timeZone: 'UTC',
			referenceTimeMs: 1700000000000,
			propertyTypes: {},
			normalizationFingerprint: JSON.stringify({ tz: 'UTC', types: [] }),
		});
		expect(result.diagnostics).toEqual({
			executable: true,
			findings: [],
			queries: {
				activeProjects: { executable: true, findings: [] },
				allNotes: { executable: true, findings: [] },
			},
		});
		expect(result.matches['activeProjects']).toHaveLength(1);
		expect(result.matches['allNotes']).toHaveLength(1);
		expect(result.matches['activeProjects']?.[0]).toBe(result.matches['allNotes']?.[0]);
		expect(result.matches['activeProjects']?.[0]?.file.path).toBe('notes/alpha.md');
		expect(result.matches['activeProjects']?.[0]?.tagLocations).toEqual([
			{
				tag: 'project',
				source: 'body',
				origin: '[[notes/alpha.md|alpha]]',
			},
		]);
		expect('normalizationFingerprint' in (result.matches['activeProjects']?.[0] ?? {})).toBe(
			false,
		);
		expect('propertyOccurrences' in (result.matches['activeProjects']?.[0] ?? {})).toBe(false);
		expect('paths' in result).toBe(false);
		expect('propertyDiagnostics' in result).toBe(false);

		const emptyResult = await plugin.query();
		expect(emptyResult.diagnostics).toEqual({
			executable: true,
			findings: [],
			queries: {},
		});
		expect(emptyResult.matches).toEqual({});
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
