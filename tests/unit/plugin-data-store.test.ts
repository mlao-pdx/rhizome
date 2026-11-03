import { describe, expect, it } from 'vitest';
import type { RhizomeSettings } from '../../src/settings';
import { PluginDataStore, type PluginData } from '../../src/adapters/plugin-data-store';
import { createInMemoryPluginData } from '../support/plugin-data-fake';

const DEFAULTS: RhizomeSettings = {
	templatesFolder: '◊Rhizome/templates',
	partialsFolder: '◊Rhizome/partials',
	layoutsFolder: '◊Rhizome/layouts',
	loggingEnabled: false,
	logLevel: 'warn',
};

function createStore(initial?: unknown) {
	const data = createInMemoryPluginData(initial);
	const store = new PluginDataStore(data.loadData, data.saveData, DEFAULTS);
	return { data, store };
}

describe('PluginDataStore.loadSettings', () => {
	it('resolves defaults when loadData resolves undefined', async () => {
		const { store } = createStore();
		expect(await store.loadSettings()).toEqual(DEFAULTS);
	});

	it('reads the structured { settings } shape', async () => {
		const { store } = createStore({
			settings: { loggingEnabled: true },
		});
		expect(await store.loadSettings()).toEqual({ ...DEFAULTS, loggingEnabled: true });
	});

	it('forgivingly reads the legacy flat settings shape instead of discarding it', async () => {
		const { store } = createStore({ loggingEnabled: true, logLevel: 'debug' });
		expect(await store.loadSettings()).toEqual({
			...DEFAULTS,
			loggingEnabled: true,
			logLevel: 'debug',
		});
	});

	it('falls back to the default logLevel when a legacy or invalid logLevel is persisted', async () => {
		const { store } = createStore({
			settings: { loggingEnabled: true, logLevel: 'info' },
		});
		expect(await store.loadSettings()).toEqual({
			...DEFAULTS,
			loggingEnabled: true,
			logLevel: 'warn',
		});
	});

	it('treats garbage as defaults rather than throwing', async () => {
		const { store } = createStore('not-an-object');
		expect(await store.loadSettings()).toEqual(DEFAULTS);
	});

	it('normalizes valid template folders and falls back to defaults for unsafe folder paths', async () => {
		const { store } = createStore({
			settings: {
				templatesFolder: '  /Custom/Templates/ ',
				partialsFolder: '../escape',
				layoutsFolder: '◊Rhizome/logs/layouts',
			},
		});
		expect(await store.loadSettings()).toEqual({
			...DEFAULTS,
			templatesFolder: 'Custom/Templates',
			partialsFolder: '◊Rhizome/partials',
			layoutsFolder: '◊Rhizome/layouts',
		});
	});
});

describe('PluginDataStore.saveSettings', () => {
	it('persists the full settings object under the settings key', async () => {
		const { data, store } = createStore();
		await store.saveSettings({ ...DEFAULTS, loggingEnabled: true });
		const written = data.writes[0] as PluginData;
		expect(written.settings.loggingEnabled).toBe(true);
	});

	it('concurrent settings saves are serialized in order', async () => {
		const { data, store } = createStore();
		await Promise.all([
			store.saveSettings({ ...DEFAULTS, loggingEnabled: true }),
			store.saveSettings({ ...DEFAULTS, loggingEnabled: true, logLevel: 'debug' }),
		]);
		const last = data.writes[data.writes.length - 1] as PluginData;
		expect(last.settings.logLevel).toBe('debug');
		expect(data.writes).toHaveLength(2);
	});

	it('a failed write rejects the caller but does not poison the queue', async () => {
		let failNext = true;
		const data = createInMemoryPluginData();
		const store = new PluginDataStore(
			data.loadData,
			async (value) => {
				if (failNext) {
					failNext = false;
					throw new Error('disk full');
				}
				await data.saveData(value);
			},
			DEFAULTS,
		);
		await expect(store.saveSettings({ ...DEFAULTS, loggingEnabled: true })).rejects.toThrow(
			'disk full',
		);
		await store.saveSettings({ ...DEFAULTS, logLevel: 'debug' });
		expect(data.writes).toHaveLength(1);
		expect((data.writes[0] as PluginData).settings.logLevel).toBe('debug');
	});
});
