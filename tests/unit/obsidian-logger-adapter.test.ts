import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import type { App } from 'obsidian';
import { ObsidianLoggerAdapter } from '../../src/adapters/obsidian-logger-adapter';
import { noticeMessages } from '../support/mock-obsidian-app';
import { createInMemoryDataAdapter, type InMemoryDataAdapter } from '../support/mock-vault-adapter';

const TEST_PLUGIN_ID = 'rhizome';
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
	beforeEach(() => {
		noticeMessages.length = 0;
	});

	it('touches no vault I/O while logging is disabled', async () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: false,
				logLevel: 'debug',
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
				logLevel: 'debug',
			}),
			TEST_PLUGIN_ID,
		);

		logger.log('debug', 'hello', { count: 1 });

		await vi.waitFor(() => {
			expect(adapter.files.get(LOG_PATH)).toBeDefined();
		});
		const content = adapter.files.get(LOG_PATH) ?? '';
		expect(content).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[DEBUG] hello \{"count":1\}\n$/,
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
				logLevel: 'debug',
			}),
			TEST_PLUGIN_ID,
		);

		logger.log('debug', 'new line after rotation');

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
				logLevel: 'debug',
			}),
			TEST_PLUGIN_ID,
		);

		logger.log('debug', 'rotated line');

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
				logLevel: 'debug',
			}),
			TEST_PLUGIN_ID,
		);

		// Two near-simultaneous calls both observe the file over the cap;
		// without serialization the second rotate() would race the first.
		logger.log('debug', 'line A');
		logger.log('debug', 'line B');

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
				logLevel: 'debug',
			}),
			TEST_PLUGIN_ID,
		);

		await logger.clearLogs();

		expect(adapter.files.has(LOG_PATH)).toBe(false);
		expect(adapter.files.has(BACKUP_PATH)).toBe(false);
	});

	describe('revealLogFolder', () => {
		const mockFolder = { path: '_rhizome/logs' };

		it('shows a Notice when the log folder does not exist yet', async () => {
			const adapter = createInMemoryDataAdapter();
			const logger = new ObsidianLoggerAdapter(
				createApp(adapter),
				() => ({ loggingEnabled: true, logLevel: 'warn' }),
				TEST_PLUGIN_ID,
			);

			await logger.revealLogFolder();

			expect(noticeMessages).toEqual([
				'No log folder yet — enable logging in settings and trigger an action first.',
			]);
		});

		it('reveals in core Files when only file-explorer is available', async () => {
			const adapter = createInMemoryDataAdapter();
			const revealInFolder = vi.fn();
			const leaf = { view: { revealInFolder } };
			const revealLeaf = vi.fn(async () => {});
			const app = {
				vault: {
					adapter,
					getAbstractFileByPath: () => mockFolder,
				},
				workspace: {
					getLeavesOfType: () => [leaf],
					revealLeaf,
				},
			} as unknown as App;
			const logger = new ObsidianLoggerAdapter(
				app,
				() => ({ loggingEnabled: true, logLevel: 'warn' }),
				TEST_PLUGIN_ID,
			);

			await logger.revealLogFolder();

			expect(revealLeaf).toHaveBeenCalledWith(leaf);
			expect(revealInFolder).toHaveBeenCalledWith(mockFolder);
			expect(noticeMessages).toEqual([]);
		});

		it('reveals in Notebook Navigator when only Notebook Navigator is available', async () => {
			const adapter = createInMemoryDataAdapter();
			const navigateToFolder = vi.fn(async () => true);
			const app = {
				vault: {
					adapter,
					getAbstractFileByPath: () => mockFolder,
				},
				workspace: {
					getLeavesOfType: () => [],
					revealLeaf: async () => {},
				},
				plugins: {
					plugins: {
						'notebook-navigator': {
							api: {
								navigation: {
									navigateToFolder,
								},
							},
						},
					},
				},
			} as unknown as App;
			const logger = new ObsidianLoggerAdapter(
				app,
				() => ({ loggingEnabled: true, logLevel: 'warn' }),
				TEST_PLUGIN_ID,
			);

			await logger.revealLogFolder();

			expect(navigateToFolder).toHaveBeenCalledWith(mockFolder);
			expect(noticeMessages).toEqual([]);
		});

		it('reveals in core Files first and then Notebook Navigator when both are available', async () => {
			const adapter = createInMemoryDataAdapter();
			const callOrder: string[] = [];
			const revealInFolder = vi.fn(() => {
				callOrder.push('files');
			});
			const leaf = { view: { revealInFolder } };
			const navigateToFolder = vi.fn(async () => {
				callOrder.push('notebook-navigator');
				return true;
			});
			const app = {
				vault: {
					adapter,
					getAbstractFileByPath: () => mockFolder,
				},
				workspace: {
					getLeavesOfType: () => [leaf],
					revealLeaf: async () => {},
				},
				plugins: {
					plugins: {
						'notebook-navigator': {
							api: {
								navigation: {
									navigateToFolder,
								},
							},
						},
					},
				},
			} as unknown as App;
			const logger = new ObsidianLoggerAdapter(
				app,
				() => ({ loggingEnabled: true, logLevel: 'warn' }),
				TEST_PLUGIN_ID,
			);

			await logger.revealLogFolder();

			expect(callOrder).toEqual(['files', 'notebook-navigator']);
			expect(noticeMessages).toEqual([]);
		});

		it('shows the fallback path Notice when Notebook Navigator returns false and Files is unavailable', async () => {
			const adapter = createInMemoryDataAdapter();
			const navigateToFolder = vi.fn(async () => false);
			const app = {
				vault: {
					adapter,
					getAbstractFileByPath: () => mockFolder,
				},
				workspace: {
					getLeavesOfType: () => [],
					revealLeaf: async () => {},
				},
				plugins: {
					plugins: {
						'notebook-navigator': {
							api: {
								navigation: {
									navigateToFolder,
								},
							},
						},
					},
				},
			} as unknown as App;
			const logger = new ObsidianLoggerAdapter(
				app,
				() => ({ loggingEnabled: true, logLevel: 'warn' }),
				TEST_PLUGIN_ID,
			);

			await logger.revealLogFolder();

			expect(navigateToFolder).toHaveBeenCalledWith(mockFolder);
			expect(noticeMessages).toEqual(['Log folder: _rhizome/logs']);
		});

		it('reveals in core Files when file-explorer view is deferred until revealLeaf resolves', async () => {
			const adapter = createInMemoryDataAdapter();
			const revealInFolder = vi.fn();
			const leaf: { view: unknown } = { view: {} };
			const revealLeaf = vi.fn(async () => {
				leaf.view = { revealInFolder };
			});
			const app = {
				vault: {
					adapter,
					getAbstractFileByPath: () => mockFolder,
				},
				workspace: {
					getLeavesOfType: () => [leaf],
					revealLeaf,
				},
			} as unknown as App;
			const logger = new ObsidianLoggerAdapter(
				app,
				() => ({ loggingEnabled: true, logLevel: 'warn' }),
				TEST_PLUGIN_ID,
			);

			await logger.revealLogFolder();

			expect(revealLeaf).toHaveBeenCalledWith(leaf);
			expect(revealInFolder).toHaveBeenCalledWith(mockFolder);
			expect(noticeMessages).toEqual([]);
		});

		it('shows the fallback path Notice when neither Files nor Notebook Navigator is available', async () => {
			const adapter = createInMemoryDataAdapter();
			const app = {
				vault: {
					adapter,
					getAbstractFileByPath: () => mockFolder,
				},
				workspace: {
					getLeavesOfType: () => [],
					revealLeaf: async () => {},
				},
			} as unknown as App;
			const logger = new ObsidianLoggerAdapter(
				app,
				() => ({ loggingEnabled: true, logLevel: 'warn' }),
				TEST_PLUGIN_ID,
			);

			await logger.revealLogFolder();

			expect(noticeMessages).toEqual(['Log folder: _rhizome/logs']);
		});
	});
});
