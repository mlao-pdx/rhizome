import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import type { App } from 'obsidian';
import { ObsidianLoggerAdapter } from '../../src/adapters/obsidian-logger-adapter';
import { createInMemoryDataAdapter, type InMemoryDataAdapter } from '../support/mock-vault-adapter';

const TEST_PLUGIN_ID = 'sample-plugin';
const LOG_PATH = `_${TEST_PLUGIN_ID}/logs/${TEST_PLUGIN_ID}.log`;
const BACKUP_PATH = `_${TEST_PLUGIN_ID}/logs/${TEST_PLUGIN_ID}.log.1`;
const ROTATION_CAP_BYTES = 5 * 1024 * 1024;

function createApp(adapter: InMemoryDataAdapter): App {
	return {
		vault: {
			adapter,
			getAbstractFileByPath: () => null,
		},
		workspace: {
			getLeavesOfType: () => [],
			revealLeaf: async () => {},
		},
	} as unknown as App;
}

describe('ObsidianLoggerAdapter', () => {
	it('touches no vault I/O while logging is disabled', async () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: false,
				logLevel: 'trace',
			}),
			TEST_PLUGIN_ID,
		);

		logger.log('error', 'should not write');
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(adapter.files.size).toBe(0);
		expect(adapter.dirs.size).toBe(0);
	});

	it('does not write below the configured level', async () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'warn',
			}),
			TEST_PLUGIN_ID,
		);

		logger.log('debug', 'should not write');
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(adapter.files.size).toBe(0);
	});

	it('writes a formatted line to the derived log path', async () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'info',
			}),
			TEST_PLUGIN_ID,
		);

		logger.log('info', 'hello', { count: 1 });

		await vi.waitFor(() => {
			expect(adapter.files.get(LOG_PATH)).toBeDefined();
		});
		const content = adapter.files.get(LOG_PATH) ?? '';
		expect(content).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO] hello \{"count":1\}\n$/,
		);
		expect(adapter.dirs.has(`_${TEST_PLUGIN_ID}/logs`)).toBe(true);
	});

	it('rotates the log file to its backup once the size cap is exceeded', async () => {
		const adapter = createInMemoryDataAdapter();
		adapter.dirs.add(`_${TEST_PLUGIN_ID}/logs`);
		adapter.files.set(LOG_PATH, 'x'.repeat(ROTATION_CAP_BYTES + 1));
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'info',
			}),
			TEST_PLUGIN_ID,
		);

		logger.log('info', 'new line after rotation');

		await vi.waitFor(() => {
			expect(adapter.files.get(BACKUP_PATH)).toBeDefined();
		});
		expect(adapter.files.get(BACKUP_PATH)?.length).toBe(ROTATION_CAP_BYTES + 1);
		expect(adapter.files.get(LOG_PATH)).toContain('new line after rotation');
	});

	it('overwrites a prior backup on a second rotation, never accumulating generations', async () => {
		const adapter = createInMemoryDataAdapter();
		adapter.dirs.add(`_${TEST_PLUGIN_ID}/logs`);
		adapter.files.set(LOG_PATH, 'x'.repeat(ROTATION_CAP_BYTES + 1));
		adapter.files.set(BACKUP_PATH, 'stale backup');
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'info',
			}),
			TEST_PLUGIN_ID,
		);

		logger.log('info', 'rotated line');

		await vi.waitFor(() => {
			expect(adapter.files.get(BACKUP_PATH)).not.toBe('stale backup');
		});
		expect(adapter.files.get(BACKUP_PATH)?.length).toBe(ROTATION_CAP_BYTES + 1);
	});

	it('serializes concurrent log() calls so a race on rotation never loses a line or the backup', async () => {
		const adapter = createInMemoryDataAdapter();
		adapter.dirs.add(`_${TEST_PLUGIN_ID}/logs`);
		adapter.files.set(LOG_PATH, 'x'.repeat(ROTATION_CAP_BYTES + 1));
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'info',
			}),
			TEST_PLUGIN_ID,
		);

		// Two near-simultaneous calls both observe the file over the cap;
		// without serialization the second rotate() would race the first.
		logger.log('info', 'line A');
		logger.log('info', 'line B');

		await vi.waitFor(() => {
			expect(adapter.files.get(LOG_PATH)).toContain('line B');
		});
		const backup = adapter.files.get(BACKUP_PATH);
		expect(backup).toBeDefined();
		expect(backup?.length).toBe(ROTATION_CAP_BYTES + 1);
		expect(adapter.files.get(LOG_PATH)).toContain('line A');
		expect(adapter.files.get(LOG_PATH)).toContain('line B');
	});

	it('clearLogs deletes both the log file and its backup', async () => {
		const adapter = createInMemoryDataAdapter();
		adapter.files.set(LOG_PATH, 'a');
		adapter.files.set(BACKUP_PATH, 'b');
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'info',
			}),
			TEST_PLUGIN_ID,
		);

		await logger.clearLogs();

		expect(adapter.files.has(LOG_PATH)).toBe(false);
		expect(adapter.files.has(BACKUP_PATH)).toBe(false);
	});
});
