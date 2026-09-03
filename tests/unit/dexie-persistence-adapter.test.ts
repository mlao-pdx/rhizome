import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { Dexie } from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { ExampleRecord } from '../../src/ports/persistence-port';
import type { LogLevel } from '../../src/ports/logger-port';
import type { DatabaseIdentityRecord } from '../../src/adapters/database-identity';
import { IDENTITY_KEY, IDENTITY_RECORD_FORMAT } from '../../src/adapters/database-identity';
import {
	DexiePersistenceAdapter,
	PluginDatabase,
} from '../../src/adapters/dexie-persistence-adapter';
import { derivePersistenceDbName } from '../../src/adapters/persistence-db-name';
import { noticeMessages } from '../support/mock-obsidian-app';

const PLUGIN_ID = 'sample-plugin';
const DATABASE_ID = 'cache';
const VAULT_ROOT = '/Users/tester/Vaults/main';
const DB_NAME = derivePersistenceDbName({
	pluginId: PLUGIN_ID,
	databaseId: DATABASE_ID,
	vaultRootPath: VAULT_ROOT,
});
const PERSISTED_ID = 'vault-instance-1';

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

function createAdapter(factory: IDBFactory, ensure: () => Promise<string>) {
	const spy = createLoggerSpy();
	const adapter = new DexiePersistenceAdapter(
		PLUGIN_ID,
		DATABASE_ID,
		VAULT_ROOT,
		ensure,
		spy.logger,
		{ indexedDB: factory, IDBKeyRange },
	);
	return { adapter, logCalls: spy.calls };
}

function openDb(factory: IDBFactory): PluginDatabase {
	return new PluginDatabase(DB_NAME, { indexedDB: factory, IDBKeyRange });
}

/** Seeds a database at the derived address, then closes the seed connection. */
async function seedDatabase(
	factory: IDBFactory,
	seed: { identity?: DatabaseIdentityRecord; rows?: ExampleRecord[] },
): Promise<void> {
	const db = openDb(factory);
	if (seed.identity !== undefined) {
		await db.identity.put(seed.identity);
	}
	for (const row of seed.rows ?? []) {
		await db.records.put(row);
	}
	db.close();
}

function identityRecord(vaultInstanceId: string): DatabaseIdentityRecord {
	return { key: IDENTITY_KEY, format: IDENTITY_RECORD_FORMAT, vaultInstanceId };
}

async function readStoredIdentity(factory: IDBFactory): Promise<unknown> {
	const db = openDb(factory);
	try {
		return await db.identity.get(IDENTITY_KEY);
	} finally {
		db.close();
	}
}

/** Creates a database whose keyPaths conflict with `PluginDatabase`'s schema, so opening it fails. */
async function seedUnopenableDatabase(factory: IDBFactory): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = factory.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			db.createObjectStore('identity', { keyPath: 'foo' });
			const records = db.createObjectStore('records', { keyPath: 'bar' });
			records.put({ bar: 1, value: 'poison' });
		};
		request.onsuccess = () => {
			request.result.close();
			resolve();
		};
		request.onerror = () => reject(request.error ?? new Error(`Failed to open ${DB_NAME}`));
	});
}

describe('DexiePersistenceAdapter', () => {
	beforeEach(() => {
		noticeMessages.length = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('derives its address as {pluginId}/{databaseId}/{vaultRootHash}', () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);
		expect(adapter.dbName).toBe(DB_NAME);
		expect(adapter.dbName).toMatch(/^sample-plugin\/cache\/[0-9a-f]{12}$/);
	});

	it('opens no database and mints nothing until first use', async () => {
		const factory = new IDBFactory();
		const ensure = vi.fn(async () => PERSISTED_ID);
		const { adapter } = createAdapter(factory, ensure);

		expect(await factory.databases()).toEqual([]);
		expect(ensure).not.toHaveBeenCalled();

		await adapter.get(1);

		expect((await factory.databases()).map((info) => info.name)).toEqual([DB_NAME]);
		expect(ensure).toHaveBeenCalledTimes(1);
	});

	it('fresh create writes the identity record before any application row exists', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		expect(await adapter.get(999)).toBeUndefined();

		const stored = (await readStoredIdentity(factory)) as DatabaseIdentityRecord;
		expect(stored).toEqual(identityRecord(PERSISTED_ID));
		const inspector = openDb(factory);
		try {
			expect(await inspector.records.count()).toBe(0);
		} finally {
			inspector.close();
		}
	});

	it('reuses the database when the stored identity matches', async () => {
		const factory = new IDBFactory();
		await seedDatabase(factory, {
			identity: identityRecord(PERSISTED_ID),
			rows: [{ id: 1, value: 'kept' }],
		});
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		expect(await adapter.get(1)).toEqual({ id: 1, value: 'kept' });
		expect(await readStoredIdentity(factory)).toEqual(identityRecord(PERSISTED_ID));
	});

	it('recreates — wiping application rows — when the stored identity differs', async () => {
		const factory = new IDBFactory();
		await seedDatabase(factory, {
			identity: identityRecord('some-other-instance'),
			rows: [
				{ id: 1, value: 'stale-1' },
				{ id: 2, value: 'stale-2' },
			],
		});
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		expect(await adapter.get(1)).toBeUndefined();
		expect(await adapter.get(2)).toBeUndefined();
		expect(await readStoredIdentity(factory)).toEqual(identityRecord(PERSISTED_ID));
		expect((await factory.databases()).map((info) => info.name)).toEqual([DB_NAME]);
	});

	it('never serves stale application rows, even to a concurrent first-call burst', async () => {
		const factory = new IDBFactory();
		await seedDatabase(factory, {
			identity: identityRecord('some-other-instance'),
			rows: [
				{ id: 1, value: 'stale-1' },
				{ id: 2, value: 'stale-2' },
			],
		});
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		const [first, second, third] = await Promise.all([
			adapter.get(1),
			adapter.get(2),
			adapter.get(1),
		]);
		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(third).toBeUndefined();
	});

	it('recreates when the identity record is absent', async () => {
		const factory = new IDBFactory();
		await seedDatabase(factory, { rows: [{ id: 1, value: 'stale' }] });
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		expect(await adapter.get(1)).toBeUndefined();
		expect(await readStoredIdentity(factory)).toEqual(identityRecord(PERSISTED_ID));
	});

	it('recreates when the identity record is malformed', async () => {
		const factory = new IDBFactory();
		await seedDatabase(factory, {
			identity: {
				key: IDENTITY_KEY,
				format: 99,
				vaultInstanceId: 'x',
			} as unknown as DatabaseIdentityRecord,
			rows: [{ id: 1, value: 'stale' }],
		});
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		expect(await adapter.get(1)).toBeUndefined();
		expect(await readStoredIdentity(factory)).toEqual(identityRecord(PERSISTED_ID));
	});

	it('mints-and-recreates when no persisted id exists but a database does', async () => {
		const factory = new IDBFactory();
		await seedDatabase(factory, {
			identity: identityRecord('legacy-instance'),
			rows: [{ id: 1, value: 'stale' }],
		});
		const ensure = vi.fn(async () => 'freshly-minted-id');
		const { adapter } = createAdapter(factory, ensure);

		expect(await adapter.get(1)).toBeUndefined();
		expect(ensure).toHaveBeenCalledTimes(1);
		expect(await readStoredIdentity(factory)).toEqual(identityRecord('freshly-minted-id'));
	});

	it('treats a present-but-unopenable database as untrusted and recreates it', async () => {
		const factory = new IDBFactory();
		await seedUnopenableDatabase(factory);
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		expect(await adapter.get(1)).toBeUndefined();
		expect(await readStoredIdentity(factory)).toEqual(identityRecord(PERSISTED_ID));
		expect((await factory.databases()).map((info) => info.name)).toEqual([DB_NAME]);
	});

	it('supports the get/put/delete round-trip', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		await adapter.put({ id: 7, value: 'seven' });
		expect(await adapter.get(7)).toEqual({ id: 7, value: 'seven' });
		await adapter.delete(7);
		expect(await adapter.get(7)).toBeUndefined();
		await expect(adapter.delete(7)).resolves.toBeUndefined();
	});

	it('putMany is atomic: a mid-transaction failure rolls the whole batch back', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

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

	it('clear() empties application rows only — the identity record survives', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);

		await adapter.put({ id: 1, value: 'a' });
		await adapter.put({ id: 2, value: 'b' });
		await adapter.clear();
		expect(await adapter.get(1)).toBeUndefined();
		expect(await adapter.get(2)).toBeUndefined();
		expect(await readStoredIdentity(factory)).toEqual(identityRecord(PERSISTED_ID));

		// A new adapter over the same factory must hit the reuse path: a
		// row written after clear() survives re-bootstrap, which would be
		// impossible if clear() had invalidated the identity.
		await adapter.put({ id: 9, value: 'after-clear' });
		adapter.close();
		const { adapter: reborn } = createAdapter(factory, async () => PERSISTED_ID);
		expect(await reborn.get(9)).toEqual({ id: 9, value: 'after-clear' });
		reborn.close();
	});

	it('close() is idempotent, before and after bootstrap', async () => {
		const factory = new IDBFactory();
		const { adapter } = createAdapter(factory, async () => PERSISTED_ID);
		adapter.close();
		expect(() => adapter.close()).not.toThrow();

		const { adapter: used } = createAdapter(factory, async () => PERSISTED_ID);
		await used.get(1);
		used.close();
		expect(() => used.close()).not.toThrow();
	});

	it('concurrent first calls bootstrap exactly once', async () => {
		const factory = new IDBFactory();
		const ensure = vi.fn(async () => PERSISTED_ID);
		const { adapter } = createAdapter(factory, ensure);

		await Promise.all([adapter.get(1), adapter.put({ id: 2, value: 'b' }), adapter.get(3)]);

		expect(ensure).toHaveBeenCalledTimes(1);
		expect((await factory.databases()).map((info) => info.name)).toEqual([DB_NAME]);
	});

	it('a failed delete of an untrusted database notifies, logs, rejects, and latches', async () => {
		const factory = new IDBFactory();
		await seedDatabase(factory, {
			identity: identityRecord('some-other-instance'),
			rows: [{ id: 1, value: 'stale' }],
		});
		const ensure = vi.fn(async () => PERSISTED_ID);
		const { adapter, logCalls } = createAdapter(factory, ensure);
		vi.spyOn(Dexie.prototype, 'delete').mockRejectedValueOnce(new Error('delete blocked'));

		await expect(adapter.get(1)).rejects.toThrow(/untrusted/i);

		expect(noticeMessages).toHaveLength(1);
		expect(logCalls.some((call) => call.level === 'error')).toBe(true);

		// Latched: the second call rejects without re-bootstrapping,
		// re-notifying, or touching the database.
		await expect(adapter.get(1)).rejects.toThrow(/untrusted/i);
		expect(noticeMessages).toHaveLength(1);
		expect(ensure).toHaveBeenCalledTimes(1);
	});

	it('ordinary bootstrap failures log and rethrow without latching, so the next call retries', async () => {
		const factory = new IDBFactory();
		const ensure = vi
			.fn()
			.mockRejectedValueOnce(new Error('saveData failed'))
			.mockResolvedValue(PERSISTED_ID);
		const { adapter, logCalls } = createAdapter(factory, ensure);

		await expect(adapter.get(1)).rejects.toThrow('saveData failed');
		expect(noticeMessages).toHaveLength(0);
		expect(logCalls.some((call) => call.level === 'error')).toBe(true);

		await expect(adapter.get(1)).resolves.toBeUndefined();
		expect(ensure).toHaveBeenCalledTimes(2);
		expect(await readStoredIdentity(factory)).toEqual(identityRecord(PERSISTED_ID));
	});

	it('logs and rethrows ordinary operation failures (after a successful bootstrap)', async () => {
		const factory = new IDBFactory();
		const { adapter, logCalls } = createAdapter(factory, async () => PERSISTED_ID);

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
