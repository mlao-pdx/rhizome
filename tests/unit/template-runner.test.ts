import type {
	App,
	Editor,
	MarkdownPostProcessorContext,
	PluginManifest,
	TFile as ObsidianTFile,
} from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { processRhizomeCodeBlock } from '../../src/adapters/rhizome-codeblock';
import {
	executeCreateNoteFromTemplate,
	executeInsertFromTemplate,
	openCreateNoteFromTemplatePicker,
} from '../../src/adapters/template-runner';
import RhizomePlugin from '../../src/main';
import type { RhizomeSettingTab } from '../../src/settings';
import { MockElement } from '../support/mock-dom';
import {
	createMockApp,
	createMockManifest,
	MarkdownRenderer,
	noticeMessages,
	openedModals,
	TFile,
	TFolder,
} from '../support/mock-obsidian-app';

function makeFile(path: string): ObsidianTFile {
	const slash = path.lastIndexOf('/');
	const name = slash === -1 ? path : path.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const f = new TFile();
	f.path = path;
	f.name = name;
	f.basename = dot === -1 ? name : name.slice(0, dot);
	f.extension = dot === -1 ? '' : name.slice(dot + 1);
	f.parent = { path: slash === -1 ? '' : path.slice(0, slash) };
	f.stat = {
		ctime: Date.UTC(2026, 10, 20, 10, 0, 0),
		mtime: Date.UTC(2026, 10, 21, 12, 0, 0),
		size: 120,
	};
	return f as unknown as ObsidianTFile;
}

interface InMemoryVaultHarness {
	app: App;
	plugin: RhizomePlugin;
	files: ObsidianTFile[];
	folders: Set<string>;
	contents: Map<string, string>;
	frontmatters: Map<string, Record<string, unknown>>;
	fileCaches: Map<string, Record<string, unknown>>;
	openedTabs: Array<{ path: string; active: boolean }>;
	putNote: (path: string, body: string, cache?: Record<string, unknown>) => ObsidianTFile;
}

async function createRunnerHarness(activeFilePath?: string): Promise<InMemoryVaultHarness> {
	const files: ObsidianTFile[] = [];
	const folders = new Set<string>();
	const contents = new Map<string, string>();
	const frontmatters = new Map<string, Record<string, unknown>>();
	const fileCaches = new Map<string, Record<string, unknown>>();
	const openedTabs: Array<{ path: string; active: boolean }> = [];

	const rawApp = createMockApp({
		files,
		markdownFiles: files,
		fileCache: fileCaches,
	}) as {
		vault: Record<string, unknown>;
		workspace: Record<string, unknown>;
		fileManager?: Record<string, unknown>;
	};

	const putNote = (
		path: string,
		body: string,
		cache: Record<string, unknown> = {},
	): ObsidianTFile => {
		const existing = files.find((x) => x.path === path);
		const tf = existing ?? makeFile(path);
		if (!existing) {
			files.push(tf);
		}
		contents.set(path, body);
		fileCaches.set(path, cache);
		if (cache.frontmatter && typeof cache.frontmatter === 'object') {
			frontmatters.set(path, { ...(cache.frontmatter as Record<string, unknown>) });
		}
		const slash = path.lastIndexOf('/');
		if (slash > 0) {
			const parts = path.slice(0, slash).split('/');
			let acc = '';
			for (const p of parts) {
				acc = acc ? `${acc}/${p}` : p;
				folders.add(acc);
			}
		}
		return tf;
	};

	rawApp.vault['read'] = async (file: ObsidianTFile) => contents.get(file.path) ?? '';
	rawApp.vault['cachedRead'] = async (file: ObsidianTFile) => contents.get(file.path) ?? '';
	rawApp.vault['getAllLoadedFiles'] = () => [
		...files,
		...[...folders].map((p) => {
			const fld = new TFolder();
			fld.path = p;
			return fld;
		}),
	];
	rawApp.vault['getAbstractFileByPath'] = (p: string) => {
		const f = files.find((x) => x.path === p);
		if (f) return f;
		if (folders.has(p)) {
			const fld = new TFolder();
			fld.path = p;
			return fld;
		}
		return null;
	};
	rawApp.vault['createFolder'] = async (p: string) => {
		folders.add(p);
		const fld = new TFolder();
		fld.path = p;
		return fld;
	};
	rawApp.vault['create'] = async (p: string, data: string) => {
		return putNote(p, data, {});
	};
	rawApp.fileManager = {
		processFrontMatter: async (
			file: ObsidianTFile,
			fn: (fm: Record<string, unknown>) => void,
		): Promise<void> => {
			const fm = frontmatters.get(file.path) ?? {};
			fn(fm);
			frontmatters.set(file.path, fm);
			fileCaches.set(file.path, { ...(fileCaches.get(file.path) ?? {}), frontmatter: fm });
		},
	};
	rawApp.workspace['getActiveFile'] = () =>
		activeFilePath ? (files.find((f) => f.path === activeFilePath) ?? null) : null;
	rawApp.workspace['getLeaf'] = () => ({
		openFile: async (file: ObsidianTFile, state?: { active?: boolean }) => {
			openedTabs.push({ path: file.path, active: state?.active === true });
		},
	});

	const baseApp = rawApp as unknown as App;
	const plugin = new RhizomePlugin(baseApp, createMockManifest() as PluginManifest);
	await plugin.onload();

	return {
		app: baseApp,
		plugin,
		files,
		folders,
		contents,
		frontmatters,
		fileCaches,
		openedTabs,
		putNote,
	};
}

describe('template-runner, Live Preview simulation & template-folder index exclusion', () => {
	beforeEach(() => {
		openedModals.length = 0;
		noticeMessages.length = 0;
	});

	it('creates multiple notes from a multi-block template, auto-creates parent folders, writes frontmatter via processFrontMatter, and focuses only the final active tab', async () => {
		const h = await createRunnerHarness('Projects/Current/Context.md');
		h.putNote('Projects/Current/Context.md', 'active context');
		h.putNote('Projects/Current/Existing.md', 'body', {
			tags: [{ tag: '#seed', position: {} }],
		});
		h.putNote('Projects/Current/Alpha.md', 'already exists');

		const tpl = h.putNote(
			'◊Rhizome/templates/Project Pack.md',
			[
				'---',
				'tags:',
				'  - pack',
				'---',
				'Documentation ignored outside fences.',
				'````markdown',
				'```rhizome',
				'Ignored example block',
				'```',
				'````',
				'',
				'```rhizome',
				'{%- targetPath template.folders.default | append: "/Alpha" active -%}',
				'{%- frontmatter "template.tags as tags, \'p1\' as tier" -%}',
				'First={{ this.file.name }}|trigger={{ ◊.trigger }}',
				'```',
				'',
				'```rhizome',
				'{%- targetPath "Projects/Current/Sub/Beta" closed -%}',
				'Closed={{ this.file.path }}',
				'```',
				'',
				'```rhizome',
				'{%- targetPath "Projects/Current/Gamma" active -%}',
				'{%- frontmatter "\'seed\' as tags" -%}',
				'{%- query related -%}tag:@this.tags{%- endquery -%}',
				'Related={{ query.related[0].file.basename }}',
				'```',
			].join('\n'),
			{
				frontmatter: { tags: ['pack'] },
			},
		);

		const res = await executeCreateNoteFromTemplate(h.plugin, tpl);
		expect(res.ok).toBe(true);
		expect(res.createdFiles.map((f) => f.path)).toEqual([
			'Projects/Current/Alpha 1.md',
			'Projects/Current/Sub/Beta.md',
			'Projects/Current/Gamma.md',
		]);
		expect(h.folders.has('Projects/Current/Sub')).toBe(true);
		expect(h.contents.get('Projects/Current/Alpha 1.md')).toBe(
			'First=Alpha 1.md|trigger=newNote',
		);
		expect(h.frontmatters.get('Projects/Current/Alpha 1.md')).toEqual({
			tags: ['pack'],
			tier: 'p1',
		});
		expect(h.contents.get('Projects/Current/Gamma.md')).toContain('Related=Existing');

		// Block 0 (active, earlier) opens inactive; Block 1 (closed) opens no tab; Block 2 (final active) opens active!
		expect(h.openedTabs).toEqual([
			{ path: 'Projects/Current/Alpha 1.md', active: false },
			{ path: 'Projects/Current/Gamma.md', active: true },
		]);
	});

	it('aborts all-or-nothing during preflight when a later block fails, writing zero files and opening TemplateErrorModal', async () => {
		const h = await createRunnerHarness();
		const tpl = h.putNote(
			'◊Rhizome/templates/Broken Multi.md',
			[
				'```rhizome',
				'{% targetPath "NewFolder/ShouldNotBeCreated" %}',
				'Valid block 1',
				'```',
				'',
				'```rhizome',
				'{% targetPath "../IllegalTraversal" %}',
				'Broken block 2',
				'```',
			].join('\n'),
		);

		const res = await executeCreateNoteFromTemplate(h.plugin, tpl);
		expect(res.ok).toBe(false);
		expect(res.createdFiles).toHaveLength(0);
		expect(h.folders.has('NewFolder')).toBe(false);
		expect(h.contents.has('NewFolder/ShouldNotBeCreated.md')).toBe(false);
		expect(openedModals).toHaveLength(1);
		expect(openedModals[0]?.title).toBe('Cannot create note from template');
	});

	it('joins multi-block outputs with \\n\\n via editor.replaceSelection in atCursor mode and leaves host this untouched', async () => {
		const h = await createRunnerHarness('Notes/Host.md');
		const hostFile = h.putNote('Notes/Host.md', '## Section\n\n', {
			frontmatter: { status: 'draft' },
			headings: [{ heading: 'Section', level: 2, position: { start: { line: 0 } } }],
		});
		const tpl = h.putNote(
			'◊Rhizome/templates/Snippet.md',
			[
				'```rhizome',
				'{%- targetPath "Ignored/InAtCursor" -%}',
				'{%- frontmatter "\'mutated\' as status" -%}',
				'{%- heading demote -%}{{ "Part 1 for " | append: this.file.basename | append: " (" | append: this.properties.status | append: ")" | heading }}{%- endheading -%}',
				'```',
				'',
				'```rhizome',
				'Part 2 ({{ ◊.trigger }} from {{ template.file.basename }})',
				'```',
			].join('\n'),
		);

		let replacedText: string | null = null;
		const fakeEditor = {
			getCursor: () => ({ line: 2, ch: 0 }),
			replaceSelection: (txt: string) => {
				replacedText = txt;
			},
		} as unknown as Editor;

		const res = await executeInsertFromTemplate(h.plugin, fakeEditor, hostFile, tpl);
		expect(res.ok).toBe(true);
		expect(replacedText).toBe(
			'\n### Part 1 for Host (draft)\n\n\nPart 2 (atCursor from Snippet)',
		);
		expect(h.frontmatters.get('Notes/Host.md')).toEqual({ status: 'draft' });
	});

	it('discovers only templates with >= 1 top-level rhizome block in TemplatePickerModal', async () => {
		const h = await createRunnerHarness();
		h.putNote(
			'◊Rhizome/templates/DocsOnly.md',
			'# Just docs\n````md\n```rhizome\nx\n```\n````',
		);
		h.putNote('◊Rhizome/templates/Sub/Executable.md', '```rhizome\nHi\n```');

		await openCreateNoteFromTemplatePicker(h.plugin);
		expect(openedModals).toHaveLength(1);
		const picker = openedModals[0] as unknown as {
			getItems: () => Array<{ displayPath: string; blockCount: number }>;
		};
		expect(picker.getItems()).toEqual([
			expect.objectContaining({ displayPath: 'Sub/Executable', blockCount: 1 }),
		]);
	});

	it('simulates newNote mode in Live Preview inside templatesFolder without creating files', async () => {
		const h = await createRunnerHarness();
		h.putNote('Notes/RealProject.md', 'body', {
			tags: [{ tag: '#simtag', position: {} }],
		});
		const blockSource = [
			'{% targetPath "SimFolder/PreviewNote" %}',
			'{% frontmatter "\'simtag\' as tags" %}',
			'{% query q %}tag:@this.tags{% endquery %}',
			'{{ ◊.trigger }}|{{ this.file.path }}|{{ query.q[0].file.basename }}',
		].join('\n');
		h.putNote('◊Rhizome/templates/LiveSim.md', `\`\`\`rhizome\n${blockSource}\n\`\`\``);

		let renderedMarkdown = '';
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, md) => {
				renderedMarkdown = md;
			});

		try {
			const container = new MockElement('div') as unknown as HTMLElement;
			const postCtx = {
				sourcePath: '◊Rhizome/templates/LiveSim.md',
				addChild: () => {},
				getSectionInfo: () => null,
			} as unknown as MarkdownPostProcessorContext;

			await processRhizomeCodeBlock(blockSource, container, postCtx, h.plugin);

			expect(renderedMarkdown.trim()).toBe('newNote|SimFolder/PreviewNote.md|RealProject');
			expect(h.contents.has('SimFolder/PreviewNote.md')).toBe(false);
			expect(h.folders.has('SimFolder')).toBe(false);
		} finally {
			renderSpy.mockRestore();
		}
	});

	it('excludes template/partial/layout folders from queries & caches and evicts/indexes live when folder settings change', async () => {
		const h = await createRunnerHarness();
		h.putNote('Notes/Normal.md', '- [ ] normal task', {
			tags: [{ tag: '#shared', position: {} }],
		});
		h.putNote('◊Rhizome/templates/Tpl.md', '- [ ] tpl task', {
			tags: [{ tag: '#shared', position: {} }],
		});
		h.putNote('◊Rhizome/partials/Part.md', '- [ ] part task', {
			tags: [{ tag: '#shared', position: {} }],
		});
		h.putNote('◊Rhizome/layouts/Lay.md', '- [ ] lay task', {
			tags: [{ tag: '#shared', position: {} }],
		});
		h.putNote('CustomTemplates/FutureTpl.md', '- [ ] future tpl', {
			tags: [{ tag: '#shared', position: {} }],
		});

		const beforeChange = await h.plugin.query({ shared: '#shared' }, { timeZone: 'UTC' });
		expect(beforeChange['shared']?.map((m) => m.file.path).sort()).toEqual([
			'CustomTemplates/FutureTpl.md',
			'Notes/Normal.md',
		]);
		expect(h.plugin.documentCache.get('◊Rhizome/templates/Tpl.md')).toBeUndefined();
		expect(h.plugin.documentCache.get('CustomTemplates/FutureTpl.md')).toBeDefined();

		// Change templatesFolder in Settings -> CustomTemplates/FutureTpl.md evicted immediately,
		// and ◊Rhizome/templates/Tpl.md becomes a regular indexed note!
		const settingTab = (h.plugin as unknown as { settingTabs: RhizomeSettingTab[] })
			.settingTabs[0]!;
		await settingTab.setControlValue('templatesFolder', 'CustomTemplates');

		expect(h.plugin.documentCache.get('CustomTemplates/FutureTpl.md')).toBeUndefined();

		const afterChange = await h.plugin.query({ shared: '#shared' }, { timeZone: 'UTC' });
		expect(afterChange['shared']?.map((m) => m.file.path).sort()).toEqual([
			'Notes/Normal.md',
			'◊Rhizome/templates/Tpl.md',
		]);
	});

	it('marks activeQueryRoster dirty when an indexed note without outgoing links is renamed into templatesFolder', async () => {
		const h = await createRunnerHarness();
		const movingFile = h.putNote('Notes/Standalone.md', 'plain body', {
			tags: [{ tag: '#standalone', position: {} }],
		});

		let latestPaths: string[] = [];
		const initial = await h.plugin.query(
			{ q: '#standalone' },
			{ timeZone: 'UTC' },
			(updated) => {
				latestPaths = updated['q']?.map((m) => m.file.path) ?? [];
			},
		);
		latestPaths = initial['q']?.map((m) => m.file.path) ?? [];
		expect(latestPaths).toEqual(['Notes/Standalone.md']);

		// Rename 'Notes/Standalone.md' -> '◊Rhizome/templates/Standalone.md'
		const oldPath = movingFile.path;
		movingFile.path = '◊Rhizome/templates/Standalone.md';
		(movingFile as unknown as { parent: { path: string } }).parent = {
			path: '◊Rhizome/templates',
		};
		const cbs = h.fileCaches.get(oldPath) ?? {};
		h.fileCaches.set(movingFile.path, cbs);
		h.fileCaches.delete(oldPath);

		const vaultWithTrigger = h.app.vault as unknown as {
			trigger: (event: string, ...args: unknown[]) => void;
		};
		vaultWithTrigger.trigger('rename', movingFile, oldPath);

		await h.plugin.activeQueryRoster.nudge(Date.now(), { onlyIfChanged: true });
		expect(latestPaths).toEqual([]);
	});

	it('discovers rhizome-sample blocks in TemplatePickerModal, inserts inline [!danger] callouts in atCursor without opening TemplateErrorModal, and opens TemplateErrorModal on query errors in newNote', async () => {
		const h = await createRunnerHarness('Notes/Host.md');
		const hostFile = h.putNote('Notes/Host.md', 'Host body\n');
		const sampleTpl = h.putNote(
			'◊Rhizome/templates/SampleAuthored.md',
			[
				'```rhizome-sample',
				'{% targetPath "Created/FromSample" %}',
				'Hello from rhizome-sample!',
				'```',
			].join('\n'),
		);

		await openCreateNoteFromTemplatePicker(h.plugin);
		expect(openedModals).toHaveLength(1);
		const picker = openedModals[0] as unknown as {
			getItems: () => Array<{ displayPath: string; blockCount: number }>;
		};
		expect(picker.getItems()).toEqual([
			expect.objectContaining({ displayPath: 'SampleAuthored', blockCount: 1 }),
		]);
		openedModals.length = 0;

		// Full execution in newNote creates the note cleanly from a rhizome-sample block without explain callouts
		const createOk = await executeCreateNoteFromTemplate(h.plugin, sampleTpl);
		expect(createOk.ok).toBe(true);
		expect(h.contents.get('Created/FromSample.md')?.trim()).toBe('Hello from rhizome-sample!');

		// Query error in newNote aborts with 0 disk mutations and opens TemplateErrorModal
		const brokenQueryTpl = h.putNote(
			'◊Rhizome/templates/BrokenQuery.md',
			[
				'```rhizome-sample',
				'{% targetPath "Created/NeverWritten" %}',
				'{% query q %}[unclosed_filter{% endquery %}',
				'Body {{ query.q.size }}',
				'```',
			].join('\n'),
		);
		const createFail = await executeCreateNoteFromTemplate(h.plugin, brokenQueryTpl);
		expect(createFail.ok).toBe(false);
		expect(h.contents.has('Created/NeverWritten.md')).toBe(false);
		expect(openedModals).toHaveLength(1);
		expect(openedModals[0]?.title).toBe('Cannot create note from template');
		expect(createFail.errorGroups[0]?.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
		openedModals.length = 0;

		// atCursor with a valid block + broken block inserts joined output via single replaceSelection and NEVER opens TemplateErrorModal
		const mixedAtCursorTpl = h.putNote(
			'◊Rhizome/templates/MixedInsert.md',
			[
				'```rhizome',
				'Healthy Block 1',
				'```',
				'',
				'```rhizome-sample',
				'{% query bad %}[broken{% endquery %}',
				'```',
			].join('\n'),
		);
		let replaceCalls = 0;
		let replacedSelection = '';
		const fakeEditor = {
			getCursor: () => ({ line: 0, ch: 0 }),
			replaceSelection: (txt: string) => {
				replaceCalls++;
				replacedSelection = txt;
			},
		} as unknown as Editor;

		const insertRes = await executeInsertFromTemplate(
			h.plugin,
			fakeEditor,
			hostFile,
			mixedAtCursorTpl,
		);
		expect(insertRes.ok).toBe(false);
		expect(openedModals).toHaveLength(0);
		expect(replaceCalls).toBe(1);
		expect(replacedSelection).toContain('Healthy Block 1');
		expect(replacedSelection).toContain('> [!danger] Query Error: `SYNTAX_ERROR`');
	});
});
