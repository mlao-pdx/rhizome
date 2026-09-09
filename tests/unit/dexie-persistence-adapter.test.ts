import { afterEach, describe, expect, it, vi } from 'vitest';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { ExampleRecord } from '../../src/ports/persistence-port';
import type { LogLevel } from '../../src/ports/logger-port';
import {
	DexiePersistenceAdapter,
	PluginDatabase,
} from '../../src/adapters/dexie-persistence-adapter';
import { derivePersistenceDbName } from '../../src/adapters/persistence-db-name';

const PLUGIN_ID = 'rhizome';
const DATABASE_ID = 'cache';
const VAULT_SCOPE = 'test-app-id';
const DB_NAME = derivePersistenceDbName({
	pluginId: PLUGIN_ID,
	databaseId: DATABASE_ID,
	vaultScope: VAULT_SCOPE,
});

interface LoggerSpy {
	readonly logger: {
		log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
	};
	readonly calls: Array<{ level: LogLevel; message: string }>;
}

function createLoggerSpy(): LoggerSpy {
	const calls: Array<{ level: LogLevel; message: string }> = [];
	return {
		calls,
		logger: {
			log: (level, message) => {
				calls.push({ level, message });
			},
		},
	};
}

function createAdapter(factory: IDBFactory) {
	const spy = createLoggerSpy();
	const adapter = new DexiePersistenceAdapter(PLUGIN_ID, DATABASE_ID, VAULT_SCOPE, spy.logger, {
		indexedDB: factory,
		IDBKeyRange,
	});
	return { adapter, logCalls: spy.calls };
}

function openDb(factory: IDBFactory): PluginDatabase {
	return new PluginDatabase(DB_NAME, { indexedDB: factory, IDBKeyRange });
}

/** Seeds application rows at the derived address, then closes the seed connection. */
async function seedDatabase(factory: IDBFactory, rows: ExampleRecord[]): Promise<void> {
	const db = openDb(factory);
	for (const row of rows) {
		await db.records.put(row);
	}
	db.close();
}

describe('DexiePersistenceAdapter', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('derives its address as {pluginId}/{databaseId}/{vaultScope}', () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory);
		expect(adapter.dbName).toBe(DB_NAME);
		expect(adapter.dbName).toBe('rhizome/cache/test-app-id');
	});

	it('opens no database until first use', async () => {
		const factory = new IDBFactory();
		const openSpy = vi.spyOn(factory, 'open');
		const { adapter } = createAdapter(factory);

		expect(await factory.databases()).toEqual([]);
		expect(openSpy).not.toHaveBeenCalled();

		await adapter.get(1);

		expect((await factory.databases()).map((info) => info.name)).toEqual([DB_NAME]);
	});

	it('opens through the injected factory via DexieOptions, never the ambient globals', async () => {
		const factory = new IDBFactory();
		const openSpy = vi.spyOn(factory, 'open');
		const { adapter } = createAdapter(factory);

		await adapter.put({ id: 1, value: 'a' });

		expect(openSpy).toHaveBeenCalledTimes(1);
		expect(openSpy.mock.calls[0]?.[0]).toBe(DB_NAME);
	});

	it('reuses an existing database at its address, rows included — no verification, no wipe', async () => {
		const factory = new IDBFactory();
		await seedDatabase(factory, [{ id: 1, value: 'kept' }]);
		const { adapter } = createAdapter(factory);

		expect(await adapter.get(1)).toEqual({ id: 1, value: 'kept' });
	});

	it('supports the get/put/delete round-trip', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory);

		await adapter.put({ id: 7, value: 'seven' });
		expect(await adapter.get(7)).toEqual({ id: 7, value: 'seven' });
		await adapter.delete(7);
		expect(await adapter.get(7)).toBeUndefined();
		await expect(adapter.delete(7)).resolves.toBeUndefined();
	});

	it('putMany is atomic: a mid-transaction failure rolls the whole batch back', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory);

		await expect(
			adapter.putMany([
				{ id: 1, value: 'a' },
				{ value: 'missing id' } as unknown as ExampleRecord,
				{ id: 3, value: 'c' },
			]),
		).rejects.toThrow();

		expect(await adapter.get(1)).toBeUndefined();
		expect(await adapter.get(3)).toBeUndefined();
	});

	it('clear() empties every row, and the database itself survives for reuse', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory);

		await adapter.put({ id: 1, value: 'a' });
		await adapter.put({ id: 2, value: 'b' });
		await adapter.clear();
		expect(await adapter.get(1)).toBeUndefined();
		expect(await adapter.get(2)).toBeUndefined();

		// The database at the address is not deleted or recreated by
		// clear(): a row written afterwards survives a fresh adapter over
		// the same factory.
		await adapter.put({ id: 9, value: 'after-clear' });
		adapter.close();
		const { adapter: reborn } = createAdapter(factory);
		expect(await reborn.get(9)).toEqual({ id: 9, value: 'after-clear' });
		expect((await factory.databases()).map((info) => info.name)).toEqual([DB_NAME]);
		reborn.close();
	});

	it('close() is idempotent, before and after bootstrap', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory);
		adapter.close();
		expect(() => adapter.close()).not.toThrow();

		const { adapter: used } = createAdapter(factory);
		await used.get(1);
		used.close();
		expect(() => used.close()).not.toThrow();
	});

	it('operations after close() reject', async () => {
		const factory = new IDBFactory();
		const { adapter, logCalls } = createAdapter(factory);
		await adapter.get(1);
		adapter.close();

		await expect(adapter.get(1)).rejects.toThrow(/closed/i);
		expect(logCalls.some((call) => call.level === 'error')).toBe(true);
	});

	it('concurrent first calls bootstrap exactly once', async () => {
		const factory = new IDBFactory();
		const openSpy = vi.spyOn(factory, 'open');
		const { adapter } = createAdapter(factory);

		await Promise.all([adapter.get(1), adapter.put({ id: 2, value: 'b' }), adapter.get(3)]);

		expect(openSpy).toHaveBeenCalledTimes(1);
		expect((await factory.databases()).map((info) => info.name)).toEqual([DB_NAME]);
	});

	it('bootstrap failures log and rethrow without latching, so the next call retries', async () => {
		const factory = new IDBFactory();
		const { adapter, logCalls } = createAdapter(factory);
		const openSpy = vi
			.spyOn(PluginDatabase.prototype, 'open')
			.mockRejectedValueOnce(new Error('open failed'));

		await expect(adapter.get(1)).rejects.toThrow('open failed');
		expect(logCalls.some((call) => call.level === 'error')).toBe(true);

		// Not latched: the second call retries the bootstrap and succeeds.
		await expect(adapter.get(1)).resolves.toBeUndefined();
		expect(openSpy).toHaveBeenCalledTimes(2);
	});

	it('logs and rethrows ordinary operation failures (after a successful bootstrap)', async () => {
		const factory = new IDBFactory();
		const { adapter, logCalls } = createAdapter(factory);

		// Bootstrap cleanly first, then fail a subsequent operation: a record
		// with no primary key is rejected by IndexedDB with a DataError.
		await adapter.get(999);
		const before = logCalls.length;
		await expect(adapter.put({ value: 'no id' } as unknown as ExampleRecord)).rejects.toThrow();

		expect(logCalls.length).toBeGreaterThan(before);
		expect(logCalls.some((call) => call.level === 'error')).toBe(true);

		// The adapter is still usable — the failure did not latch.
		await adapter.put({ id: 1, value: 'recover' });
		expect(await adapter.get(1)).toEqual({ id: 1, value: 'recover' });
	});
});
