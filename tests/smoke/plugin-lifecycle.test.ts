import type { App, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import MyPlugin from '../../src/main';
import { createMockApp, createMockManifest } from '../support/mock-obsidian-app';

function createPlugin(): MyPlugin {
	const app = createMockApp() as App;
	const manifest = createMockManifest() as PluginManifest;
	return new MyPlugin(app, manifest);
}

describe('MyPlugin lifecycle (smoke)', () => {
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
		expect(plugin.settings.exampleSetting).toBe('default');
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
		expect(plugin.loggerAdapter.logsFolderPath).toBe('_sample-plugin/logs');
	});
});
