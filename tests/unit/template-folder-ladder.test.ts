import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import {
	resolveTemplateFolderLadder,
	sanitizeLadderFolderCandidate,
} from '../../src/adapters/template-folder-ladder';
import type { TemplateFolderConfig } from '../../src/core/templates';

const FOLDER_CFG: TemplateFolderConfig = {
	templatesFolder: '◊Rhizome/templates',
	partialsFolder: '◊Rhizome/partials',
	layoutsFolder: '◊Rhizome/layouts',
	configDir: 'mock-config',
};

interface FakeLadderAppOptions {
	nnFolder?: string | { path: string } | null;
	nnEnabled?: boolean;
	newFileLocation?: 'root' | 'current' | 'folder' | undefined;
	newFileFolderPath?: string;
	activeFilePath?: string | null;
}

function makeFakeLadderApp(opts: FakeLadderAppOptions = {}): App {
	const enabledPlugins = new Set<string>();
	if (opts.nnEnabled !== false && opts.nnFolder !== undefined) {
		enabledPlugins.add('notebook-navigator');
	}
	const activeFile =
		opts.activeFilePath !== undefined && opts.activeFilePath !== null
			? {
					path: opts.activeFilePath,
					parent: {
						path: opts.activeFilePath.includes('/')
							? opts.activeFilePath.slice(0, opts.activeFilePath.lastIndexOf('/'))
							: '/',
					},
				}
			: null;

	return {
		vault: {
			configDir: 'mock-config',
			getConfig: (key: string) => {
				if (key === 'newFileLocation') return opts.newFileLocation;
				if (key === 'newFileFolderPath') return opts.newFileFolderPath;
				return undefined;
			},
		},
		workspace: {
			getActiveFile: () => activeFile,
		},
		plugins:
			opts.nnFolder !== undefined
				? {
						enabledPlugins,
						plugins: {
							'notebook-navigator': {
								api: {
									selection: {
										getSelectedFolder: () => opts.nnFolder,
									},
								},
							},
						},
					}
				: undefined,
	} as unknown as App;
}

describe('resolveTemplateFolderLadder & sanitizeLadderFolderCandidate', () => {
	it('resolves all four rungs independently when Notebook Navigator, Obsidian Files, and Active Note are all populated', () => {
		const app = makeFakeLadderApp({
			nnFolder: { path: 'Work/Projects' },
			newFileLocation: 'folder',
			newFileFolderPath: 'Inbox',
			activeFilePath: 'Areas/Reading/Book.md',
		});

		expect(resolveTemplateFolderLadder(app, FOLDER_CFG, 'notebookNavigator')).toEqual({
			notebookNavigator: 'Work/Projects',
			obsidianFiles: 'Inbox',
			activeNote: 'Areas/Reading',
			default: 'Work/Projects',
		});
		expect(resolveTemplateFolderLadder(app, FOLDER_CFG, 'obsidianFiles').default).toBe('Inbox');
		expect(resolveTemplateFolderLadder(app, FOLDER_CFG, 'activeNote').default).toBe(
			'Areas/Reading',
		);
		expect(resolveTemplateFolderLadder(app, FOLDER_CFG, 'vaultRoot').default).toBe('');
	});

	it('degrades gracefully when Notebook Navigator is absent or disabled, and supports newFileLocation root & current', () => {
		const appDisabledNn = makeFakeLadderApp({
			nnFolder: 'Work/IgnoredBecauseDisabled',
			nnEnabled: false,
			newFileLocation: 'current',
			activeFilePath: 'Journal/2026/Today.md',
		});

		expect(resolveTemplateFolderLadder(appDisabledNn, FOLDER_CFG, 'notebookNavigator')).toEqual(
			{
				notebookNavigator: 'Journal/2026',
				obsidianFiles: 'Journal/2026',
				activeNote: 'Journal/2026',
				default: 'Journal/2026',
			},
		);

		const appRoot = makeFakeLadderApp({
			newFileLocation: 'root',
			activeFilePath: 'Journal/2026/Today.md',
		});
		expect(resolveTemplateFolderLadder(appRoot, FOLDER_CFG, 'notebookNavigator')).toEqual({
			notebookNavigator: '',
			obsidianFiles: '',
			activeNote: 'Journal/2026',
			default: '',
		});
	});

	it('skips templatesFolder, partialsFolder, layoutsFolder, configDir, and ◊Rhizome/logs on every rung', () => {
		expect(sanitizeLadderFolderCandidate('◊Rhizome/templates', FOLDER_CFG)).toBeNull();
		expect(sanitizeLadderFolderCandidate('◊Rhizome/templates/Sub', FOLDER_CFG)).toBeNull();
		expect(sanitizeLadderFolderCandidate('◊Rhizome/partials', FOLDER_CFG)).toBeNull();
		expect(sanitizeLadderFolderCandidate('◊Rhizome/layouts', FOLDER_CFG)).toBeNull();
		expect(sanitizeLadderFolderCandidate('◊Rhizome/logs', FOLDER_CFG)).toBeNull();
		expect(sanitizeLadderFolderCandidate('mock-config/plugins', FOLDER_CFG)).toBeNull();
		expect(sanitizeLadderFolderCandidate('.hidden-cfg/plugins', FOLDER_CFG)).toBeNull();
		expect(sanitizeLadderFolderCandidate('/', FOLDER_CFG)).toBe('');

		// Editing a template inside templatesFolder while Notebook Navigator ALSO has templatesFolder selected
		// degrades cleanly instead of creating new notes inside ◊Rhizome/templates!
		const appWhileEditingTemplate = makeFakeLadderApp({
			nnFolder: '◊Rhizome/templates',
			newFileLocation: 'folder',
			newFileFolderPath: '◊Rhizome/partials',
			activeFilePath: '◊Rhizome/templates/Daily.md',
		});
		expect(
			resolveTemplateFolderLadder(appWhileEditingTemplate, FOLDER_CFG, 'notebookNavigator'),
		).toEqual({
			notebookNavigator: '',
			obsidianFiles: '',
			activeNote: '',
			default: '',
		});
	});
});
