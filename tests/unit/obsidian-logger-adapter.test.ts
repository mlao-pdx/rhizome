import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import type { App } from 'obsidian';
import { LOG_FILE_HEADER } from '../../src/adapters/logger-format';
import {
	ObsidianLoggerAdapter,
	SEGMENT_CAP_BYTES,
} from '../../src/adapters/obsidian-logger-adapter';
import { noticeMessages } from '../support/mock-obsidian-app';
import { createInMemoryDataAdapter, type InMemoryDataAdapter } from '../support/mock-vault-adapter';

const TEST_PLUGIN_NAME = 'Rhizome';
const LOGS_FOLDER = '◊Rhizome/logs';

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

	it('derives systemRootPath as ◊Rhizome and logsFolderPath as ◊Rhizome/logs', () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({ loggingEnabled: false, logLevel: 'warn' }),
			TEST_PLUGIN_NAME,
			0,
		);
		expect(logger.systemRootPath).toBe('◊Rhizome');
		expect(logger.logsFolderPath).toBe(LOGS_FOLDER);
	});

	it('touches no vault I/O while logging is disabled', async () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: false,
				logLevel: 'debug',
			}),
			TEST_PLUGIN_NAME,
			0,
		);

		logger.log('error', 'should not write', { source: 'test' });
		await logger.flush();

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
			TEST_PLUGIN_NAME,
			0,
		);

		logger.log('debug', 'should not write', { source: 'test' });
		await logger.flush();

		expect(adapter.files.size).toBe(0);
	});

	it('writes a Markdown table file with ◊InternalRhizome frontmatter under ◊Rhizome/logs/<epoch>.md', async () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'debug',
			}),
			TEST_PLUGIN_NAME,
			0,
		);

		logger.log('debug', 'Compiled ‼️query1‼️', {
			source: 'query.compile',
			durationMs: 7,
			count: 1,
		});
		await logger.flush();

		expect(adapter.dirs.has('◊Rhizome')).toBe(true);
		expect(adapter.dirs.has(LOGS_FOLDER)).toBe(true);
		const logPath = logger.currentLogPath;
		expect(logPath).toMatch(/^◊Rhizome\/logs\/\d+\.md$/);

		const content = adapter.files.get(logPath!) ?? '';
		expect(content.startsWith(LOG_FILE_HEADER)).toBe(true);
		expect(content).toContain(
			'| DEBUG | query.compile | 7 ms | 1 | Compiled xxxxx9 | Compiled ‼️query1‼️ |',
		);
	});

	it('coalesces debounced log calls into a single segment write', async () => {
		const adapter = createInMemoryDataAdapter();
		const writeSpy = vi.spyOn(adapter, 'write');
		const appendSpy = vi.spyOn(adapter, 'append');
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'debug',
			}),
			TEST_PLUGIN_NAME,
			25,
		);

		logger.log('debug', 'line 1', { source: 'test' });
		logger.log('debug', 'line 2', { source: 'test' });
		expect(adapter.files.size).toBe(0);

		await vi.waitFor(() => {
			expect(adapter.files.size).toBe(1);
		});
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(appendSpy).not.toHaveBeenCalled();
		const logPath = logger.currentLogPath!;
		const content = adapter.files.get(logPath) ?? '';
		expect(content).toContain('line 1');
		expect(content).toContain('line 2');
	});

	it('segments into a new <epoch>.md file when the active file would exceed 512 KB', async () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'debug',
			}),
			TEST_PLUGIN_NAME,
			0,
		);

		logger.log('debug', 'first segment line', { source: 'test' });
		await logger.flush();

		const firstPath = logger.currentLogPath!;
		adapter.files.set(firstPath, 'x'.repeat(SEGMENT_CAP_BYTES));

		logger.log('debug', 'second segment line', { source: 'test' });
		await logger.flush();

		const secondPath = logger.currentLogPath!;
		expect(secondPath).not.toBe(firstPath);
		expect(adapter.files.get(firstPath)?.length).toBe(SEGMENT_CAP_BYTES);
		const secondContent = adapter.files.get(secondPath) ?? '';
		expect(secondContent.startsWith(LOG_FILE_HEADER)).toBe(true);
		expect(secondContent).toContain('second segment line');
	});

	it('clearLogs deletes <epoch>.md segment files in ◊Rhizome/logs while preserving non-segment files', async () => {
		const adapter = createInMemoryDataAdapter();
		const logger = new ObsidianLoggerAdapter(
			createApp(adapter),
			() => ({
				loggingEnabled: true,
				logLevel: 'debug',
			}),
			TEST_PLUGIN_NAME,
			0,
		);

		logger.log('debug', 'entry 1', { source: 'test' });
		await logger.flush();
		const firstPath = logger.currentLogPath!;
		adapter.files.set(`${LOGS_FOLDER}/1700000000000.md`, 'old segment');
		adapter.files.set(`${LOGS_FOLDER}/user-note.md`, 'keep me');

		await logger.clearLogs();

		expect(adapter.files.has(firstPath)).toBe(false);
		expect(adapter.files.has(`${LOGS_FOLDER}/1700000000000.md`)).toBe(false);
		expect(adapter.files.get(`${LOGS_FOLDER}/user-note.md`)).toBe('keep me');
		expect(logger.currentLogPath).toBeUndefined();
	});

	describe('revealLogFolder', () => {
		const mockFolder = { path: LOGS_FOLDER };

		it('shows a Notice when the log folder does not exist yet', async () => {
			const adapter = createInMemoryDataAdapter();
			const logger = new ObsidianLoggerAdapter(
				createApp(adapter),
				() => ({ loggingEnabled: true, logLevel: 'warn' }),
				TEST_PLUGIN_NAME,
				0,
			);

			await logger.revealLogFolder();

			expect(noticeMessages).toEqual([
				'No log folder yet — enable logging in settings and trigger an action first.',
			]);
		});

		it('prefers Notebook Navigator over core Files when both are available', async () => {
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
				TEST_PLUGIN_NAME,
				0,
			);

			await logger.revealLogFolder();

			expect(callOrder).toEqual(['notebook-navigator']);
			expect(revealInFolder).not.toHaveBeenCalled();
			expect(noticeMessages).toEqual([]);
		});

		it('falls back to core Files when Notebook Navigator is unavailable or returns false', async () => {
			const adapter = createInMemoryDataAdapter();
			const revealInFolder = vi.fn();
			const leaf = { view: { revealInFolder } };
			const revealLeaf = vi.fn(async () => {});
			const navigateToFolder = vi.fn(async () => false);
			const app = {
				vault: {
					adapter,
					getAbstractFileByPath: () => mockFolder,
				},
				workspace: {
					getLeavesOfType: () => [leaf],
					revealLeaf,
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
				TEST_PLUGIN_NAME,
				0,
			);

			await logger.revealLogFolder();

			expect(navigateToFolder).toHaveBeenCalledWith(mockFolder);
			expect(revealLeaf).toHaveBeenCalledWith(leaf);
			expect(revealInFolder).toHaveBeenCalledWith(mockFolder);
			expect(noticeMessages).toEqual([]);
		});

		it('shows the fallback path Notice when neither Notebook Navigator nor Files can reveal the folder', async () => {
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
				TEST_PLUGIN_NAME,
				0,
			);

			await logger.revealLogFolder();

			expect(noticeMessages).toEqual([`Log folder: ${LOGS_FOLDER}`]);
		});
	});
});
