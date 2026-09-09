import { describe, expect, it } from 'vitest';
import type { RhizomeSettings } from '../../src/settings';
import { PluginDataStore, type PluginData } from '../../src/adapters/plugin-data-store';
import { createInMemoryPluginData } from '../support/plugin-data-fake';

const DEFAULTS: RhizomeSettings = {
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
		const { store } = createStore({ settings: { loggingEnabled: true } });
		expect(await store.loadSettings()).toEqual({ ...DEFAULTS, loggingEnabled: true });
	});

	it('forgivingly reads the legacy flat settings shape instead of discarding it', async () => {
		const { store } = createStore({ loggingEnabled: true, logLevel: 'info' });
		expect(await store.loadSettings()).toEqual({
			...DEFAULTS,
			loggingEnabled: true,
			logLevel: 'info',
		});
	});

	it('parses a legacy data.json that still carries a vaultInstanceId, ignoring the key', async () => {
		const { store } = createStore({
			settings: { loggingEnabled: true },
			vaultInstanceId: 'retired-instance-id',
		});
		expect(await store.loadSettings()).toEqual({ ...DEFAULTS, loggingEnabled: true });
	});

	it('treats garbage as defaults rather than throwing', async () => {
		const { store } = createStore('not-an-object');
		expect(await store.loadSettings()).toEqual(DEFAULTS);
	});
});

describe('PluginDataStore.saveSettings', () => {
	it('persists the full settings object under the settings key', async () => {
		const { data, store } = createStore();
		await store.saveSettings({ ...DEFAULTS, loggingEnabled: true });
		expect(data.writes).toHaveLength(1);
		expect(data.writes[0]).toEqual({ settings: { ...DEFAULTS, loggingEnabled: true } });
	});

	it('sheds a legacy vaultInstanceId key on the next write', async () => {
		const { data, store } = createStore({
			settings: DEFAULTS,
			vaultInstanceId: 'retired-instance-id',
		});
		await store.saveSettings({ ...DEFAULTS, loggingEnabled: true });
		expect(data.writes).toHaveLength(1);
		// Read forgivingly, write critically: the retired key is gone from
		// the persisted shape (design principle 6).
		expect(data.writes[0]).toEqual({ settings: { ...DEFAULTS, loggingEnabled: true } });
		expect(data.writes[0] as Record<string, unknown>).not.toHaveProperty('vaultInstanceId');
	});

	it('serialized writes observe each other: the last save wins with earlier state kept', async () => {
		const { data, store } = createStore();
		await Promise.all([
			store.saveSettings({ ...DEFAULTS, loggingEnabled: true }),
			store.saveSettings({ ...DEFAULTS, loggingEnabled: true, logLevel: 'info' }),
		]);
		const last = data.writes[data.writes.length - 1] as PluginData;
		expect(last.settings).toEqual({ ...DEFAULTS, loggingEnabled: true, logLevel: 'info' });
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
		await store.saveSettings({ ...DEFAULTS, logLevel: 'info' });
		expect(data.writes).toHaveLength(1);
		expect((data.writes[0] as PluginData).settings.logLevel).toBe('info');
	});
});
