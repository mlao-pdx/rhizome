import { describe, expect, it } from 'vitest';
import type { MyPluginSettings } from '../../src/settings';
import { isValidVaultInstanceId } from '../../src/adapters/database-identity';
import { PluginDataStore, type PluginData } from '../../src/adapters/plugin-data-store';
import { createInMemoryPluginData } from '../support/plugin-data-fake';

const DEFAULTS: MyPluginSettings = {
	exampleSetting: 'default',
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

	it('reads the structured { settings, vaultInstanceId } shape', async () => {
		const { store } = createStore({
			settings: { exampleSetting: 'custom' },
			vaultInstanceId: 'stored-id',
		});
		expect(await store.loadSettings()).toEqual({ ...DEFAULTS, exampleSetting: 'custom' });
	});

	it('forgivingly reads the legacy flat settings shape instead of discarding it', async () => {
		const { store } = createStore({ exampleSetting: 'legacy', loggingEnabled: true });
		expect(await store.loadSettings()).toEqual({
			...DEFAULTS,
			exampleSetting: 'legacy',
			loggingEnabled: true,
		});
	});

	it('treats garbage as defaults rather than throwing', async () => {
		const { store } = createStore('not-an-object');
		expect(await store.loadSettings()).toEqual(DEFAULTS);
	});
});

describe('PluginDataStore.ensureVaultInstanceId', () => {
	it('returns a valid stored vaultInstanceId without writing', async () => {
		const { data, store } = createStore({ settings: DEFAULTS, vaultInstanceId: 'stored-id' });
		expect(await store.ensureVaultInstanceId()).toBe('stored-id');
		expect(data.writes).toHaveLength(0);
	});

	it.each([
		['missing', { settings: DEFAULTS }],
		['empty string', { settings: DEFAULTS, vaultInstanceId: '' }],
		['non-string', { settings: DEFAULTS, vaultInstanceId: 42 }],
	])('mints and persists when the stored id is %s', async (_label, initial) => {
		const { data, store } = createStore(initial);
		const id = await store.ensureVaultInstanceId();
		expect(isValidVaultInstanceId(id)).toBe(true);
		expect(data.writes).toHaveLength(1);
		const written = data.writes[0] as PluginData;
		expect(written.vaultInstanceId).toBe(id);
		expect(written.settings).toEqual(DEFAULTS);
	});

	it('persists the minted id before resolving (authoritative before any database work)', async () => {
		const { data, store } = createStore();
		const id = await store.ensureVaultInstanceId();
		// The write is durable by the time the promise resolves.
		expect((data.writes[0] as PluginData).vaultInstanceId).toBe(id);
	});

	it('is idempotent: sequential calls return the same id with one write', async () => {
		const { data, store } = createStore();
		const first = await store.ensureVaultInstanceId();
		const second = await store.ensureVaultInstanceId();
		expect(second).toBe(first);
		expect(data.writes).toHaveLength(1);
	});

	it('concurrent calls yield one id and one write', async () => {
		const { data, store } = createStore();
		const results = await Promise.all([
			store.ensureVaultInstanceId(),
			store.ensureVaultInstanceId(),
			store.ensureVaultInstanceId(),
		]);
		expect(new Set(results).size).toBe(1);
		expect(data.writes).toHaveLength(1);
	});

	it('a failed mint can be retried', async () => {
		let failNext = true;
		const data = createInMemoryPluginData();
		const store = new PluginDataStore(
			data.loadData,
			async (value) => {
				if (failNext) {
					failNext = false;
					throw new Error('saveData failed');
				}
				await data.saveData(value);
			},
			DEFAULTS,
		);
		await expect(store.ensureVaultInstanceId()).rejects.toThrow('saveData failed');
		const id = await store.ensureVaultInstanceId();
		expect(isValidVaultInstanceId(id)).toBe(true);
		expect(data.writes).toHaveLength(1);
	});
});

describe('PluginDataStore.saveSettings', () => {
	it('persists the full settings object under the settings key', async () => {
		const { data, store } = createStore();
		await store.saveSettings({ ...DEFAULTS, exampleSetting: 'changed' });
		const written = data.writes[0] as PluginData;
		expect(written.settings.exampleSetting).toBe('changed');
		expect(written.vaultInstanceId).toBeUndefined();
	});

	it('interleaved settings save and identity mint do not clobber each other', async () => {
		const { data, store } = createStore();
		await Promise.all([
			store.saveSettings({ ...DEFAULTS, exampleSetting: 'changed' }),
			store.ensureVaultInstanceId(),
			store.saveSettings({ ...DEFAULTS, exampleSetting: 'changed-again' }),
		]);
		const last = data.writes[data.writes.length - 1] as PluginData;
		expect(last.settings.exampleSetting).toBe('changed-again');
		expect(isValidVaultInstanceId(last.vaultInstanceId)).toBe(true);
		// No write lost either intermediate state permanently.
		expect(data.writes.length).toBeGreaterThanOrEqual(3);
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
		await expect(store.saveSettings({ ...DEFAULTS, exampleSetting: 'lost' })).rejects.toThrow(
			'disk full',
		);
		await store.saveSettings({ ...DEFAULTS, exampleSetting: 'kept' });
		expect(data.writes).toHaveLength(1);
		expect((data.writes[0] as PluginData).settings.exampleSetting).toBe('kept');
	});
});
