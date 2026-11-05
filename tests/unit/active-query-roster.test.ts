import type { App, CachedMetadata, MarkdownPostProcessorContext, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import {
	ActiveQueryRoster,
	hashVaultQueryMatch,
	hashVaultQueryResult,
} from '../../src/adapters/active-query-roster';
import { processRhizomeCodeBlock } from '../../src/adapters/rhizome-codeblock';
import { runVaultQuery, type VaultQueryResult } from '../../src/adapters/vault-query-runner';
import {
	parseRhizomeTemplatePass1,
	renderParsedRhizomeTemplate,
} from '../../src/core/templates/template-engine';
import RhizomePlugin from '../../src/main';
import {
	createMockManifest,
	FileSystemAdapter,
	type MarkdownRenderChild,
	MarkdownRenderer,
} from '../support/mock-obsidian-app';

interface MutableNote {
	path: string;
	mtime?: number;
	content?: string;
	cache?: Partial<CachedMetadata> | null;
}

function createMutableVaultApp(initialNotes: MutableNote[]) {
	let notes = [...initialNotes];
	let getMarkdownFilesCalls = 0;
	const metadataListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
	const vaultListeners: Record<string, Array<(...args: unknown[]) => void>> = {};

	const makeFile = (n: MutableNote) => {
		const slashIdx = n.path.lastIndexOf('/');
		const name = slashIdx === -1 ? n.path : n.path.slice(slashIdx + 1);
		const parentPath = slashIdx === -1 ? '/' : n.path.slice(0, slashIdx);
		const dotIdx = name.lastIndexOf('.');
		const basename = dotIdx === -1 ? name : name.slice(0, dotIdx);
		const extension = dotIdx === -1 ? '' : name.slice(dotIdx + 1);
		return {
			path: n.path,
			name,
			basename,
			extension,
			parent: { path: parentPath },
			stat: {
				ctime: 1700000000000,
				mtime: n.mtime ?? 1700000000000,
				size: 100,
			},
		};
	};

	const adapter = new FileSystemAdapter() as FileSystemAdapter & {
		read?: (path: string) => Promise<string>;
	};
	adapter.read = async (path: string) => {
		const found = notes.find((n) => n.path === path);
		if (!found || typeof found.content !== 'string') {
			throw new Error(`ENOENT: ${path}`);
		}
		return found.content;
	};

	const app = {
		vault: {
			configDir: 'mock-config',
			adapter,
			getMarkdownFiles: () => {
				getMarkdownFilesCalls++;
				return notes.map(makeFile);
			},
			getFileByPath: (path: string) => {
				const found = notes.find((n) => n.path === path);
				return found ? makeFile(found) : null;
			},
			cachedRead: async (file: { path: string }) => {
				const found = notes.find((n) => n.path === file.path);
				if (!found || typeof found.content !== 'string') {
					throw new Error(`ENOENT: ${file.path}`);
				}
				return found.content;
			},
			on: (event: string, cb: (...args: unknown[]) => void) => {
				(vaultListeners[event] ??= []).push(cb);
				return {};
			},
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const found = notes.find((n) => n.path === file.path);
				return found?.cache ?? null;
			},
			getFirstLinkpathDest: () => null,
			on: (event: string, cb: (...args: unknown[]) => void) => {
				(metadataListeners[event] ??= []).push(cb);
				return {};
			},
		},
		workspace: {
			onLayoutReady: () => {},
			getLeavesOfType: () => [],
			revealLeaf: async () => {},
		},
	};

	return {
		app: app as unknown as App,
		setNotes(next: MutableNote[]) {
			notes = [...next];
		},
		emitMetadataChanged(path: string) {
			const found = notes.find((n) => n.path === path);
			const file = makeFile(found ?? { path });
			for (const cb of metadataListeners['changed'] ?? []) {
				cb(file, found?.content ?? '', found?.cache ?? null);
			}
		},
		emitMetadataDeleted(path: string, prevCache: Partial<CachedMetadata> | null = null) {
			const file = makeFile({ path });
			for (const cb of metadataListeners['deleted'] ?? []) {
				cb(file, prevCache);
			}
		},
		emitVaultRename(newPath: string, oldPath: string) {
			const found = notes.find((n) => n.path === newPath);
			const file = makeFile(found ?? { path: newPath });
			for (const cb of vaultListeners['rename'] ?? []) {
				cb(file, oldPath);
			}
		},
		getScanCount() {
			return getMarkdownFilesCalls;
		},
		resetScanCount() {
			getMarkdownFilesCalls = 0;
		},
	};
}

describe('Deterministic payload hashing', () => {
	it('produces identical digests for equivalent matches regardless of property key order', async () => {
		const { app } = createMutableVaultApp([
			{
				path: 'notes/a.md',
				cache: {
					frontmatter: { b: 2, a: 1 },
					tags: [{ tag: '#project', position: {} as never }],
				},
			},
		]);
		const res1 = await runVaultQuery(app, { q: '#project' }, { timeZone: 'UTC' });
		const match1 = res1['q']![0]!;
		const match2 = {
			...match1,
			properties: { a: 1, b: 2 },
		};
		expect(hashVaultQueryMatch(match1)).toBe(hashVaultQueryMatch(match2));
		expect(hashVaultQueryResult({ q: [match1] })).toBe(hashVaultQueryResult({ q: [match2] }));
	});

	it('distinguishes omitted query keys from empty result arrays and changed properties', async () => {
		const { app } = createMutableVaultApp([
			{
				path: 'notes/a.md',
				cache: { frontmatter: { status: 'open' } },
			},
		]);
		const resOpen = await runVaultQuery(app, { q: '' }, { timeZone: 'UTC' });
		const matchOpen = resOpen['q']![0]!;
		const matchDone = {
			...matchOpen,
			properties: { status: 'done' },
		};

		expect(hashVaultQueryResult({})).not.toBe(hashVaultQueryResult({ q: [] }));
		expect(hashVaultQueryResult({ q: [matchOpen] })).not.toBe(
			hashVaultQueryResult({ q: [matchDone] }),
		);
	});
});

describe('ActiveQueryRoster & reactive plugin.query()', () => {
	it('does not add one-shot query() calls without onUpdate to the active roster', async () => {
		const { app } = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		const plugin = new RhizomePlugin(app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const res = await plugin.query({ tasks: '#task' }, { timeZone: 'UTC' });
		expect(res['tasks']).toHaveLength(1);
		expect(plugin.activeQueryRoster.size).toBe(0);
	});

	it('invokes onUpdate only when matched note payload changes (add, modify, rename, delete)', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: {
					frontmatter: { status: 'todo' },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
			{
				path: 'notes/unrelated.md',
				cache: {
					frontmatter: { status: 'archived' },
				},
			},
		]);
		const roster = new ActiveQueryRoster(harness.app);
		const initial = await runVaultQuery(
			harness.app,
			{ tasks: '#task' },
			{ timeZone: 'UTC', referenceTimeMs: 1700000000000 },
		);

		const updates: VaultQueryResult[] = [];
		roster.register({ tasks: '#task' }, { timeZone: 'UTC' }, initial, (next) => {
			updates.push(next);
		});
		expect(roster.size).toBe(1);

		// 1. Nudge with no change -> no callback
		await roster.nudge(1700000000000);
		expect(updates).toHaveLength(0);

		// 2. Unrelated note modified -> no callback
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: {
					frontmatter: { status: 'todo' },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
			{
				path: 'notes/unrelated.md',
				cache: {
					frontmatter: { status: 'updated-unrelated' },
				},
			},
		]);
		await roster.nudge(1700000000000);
		expect(updates).toHaveLength(0);

		// 3. Matched note frontmatter modified -> callback fired
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: {
					frontmatter: { status: 'in-progress' },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
		]);
		await roster.nudge(1700000000000);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.['tasks']?.[0]?.properties['status']).toBe('in-progress');

		// 4. Matching note added -> callback fired
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: {
					frontmatter: { status: 'in-progress' },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
			{
				path: 'notes/beta.md',
				cache: {
					frontmatter: { status: 'todo' },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
		]);
		await roster.nudge(1700000000000);
		expect(updates).toHaveLength(2);
		expect(updates[1]?.['tasks']?.map((m) => m.file.path)).toEqual([
			'notes/alpha.md',
			'notes/beta.md',
		]);

		// 5. Matched note renamed -> callback fired
		harness.setNotes([
			{
				path: 'notes/alpha-renamed.md',
				cache: {
					frontmatter: { status: 'in-progress' },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
			{
				path: 'notes/beta.md',
				cache: {
					frontmatter: { status: 'todo' },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
		]);
		await roster.nudge(1700000000000);
		expect(updates).toHaveLength(3);
		expect(updates[2]?.['tasks']?.map((m) => m.file.path)).toEqual([
			'notes/alpha-renamed.md',
			'notes/beta.md',
		]);

		// 6. Matched note deleted -> callback fired
		harness.setNotes([
			{
				path: 'notes/beta.md',
				cache: {
					frontmatter: { status: 'todo' },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
		]);
		await roster.nudge(1700000000000);
		expect(updates).toHaveLength(4);
		expect(updates[3]?.['tasks']?.map((m) => m.file.path)).toEqual(['notes/beta.md']);
	});

	it('deduplicates identical query strings across multiple subscribers into a single vault scan', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/one.md',
				cache: {
					tags: [
						{ tag: '#task', position: {} as never },
						{ tag: '#urgent', position: {} as never },
					],
				},
			},
		]);
		const roster = new ActiveQueryRoster(harness.app);

		// Two subscribers sharing '#task', plus one unique query '#urgent', plus one invalid query
		const sub1Queries = { myTasks: '#task', broken: '[unclosed' };
		const sub2Queries = { duplicateTasks: '#task', urgentTasks: '#urgent' };

		const init1 = await runVaultQuery(harness.app, sub1Queries, { timeZone: 'UTC' });
		const init2 = await runVaultQuery(harness.app, sub2Queries, { timeZone: 'UTC' });

		const updates1: VaultQueryResult[] = [];
		const updates2: VaultQueryResult[] = [];

		roster.register(sub1Queries, { timeZone: 'UTC' }, init1, (res) => {
			updates1.push(res);
		});
		roster.register(sub2Queries, { timeZone: 'UTC' }, init2, (res) => {
			updates2.push(res);
		});
		expect(roster.size).toBe(2);

		// Add a new note matching both #task and #urgent
		harness.setNotes([
			{
				path: 'notes/one.md',
				cache: {
					tags: [
						{ tag: '#task', position: {} as never },
						{ tag: '#urgent', position: {} as never },
					],
				},
			},
			{
				path: 'notes/two.md',
				cache: {
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
		]);
		harness.resetScanCount();

		await roster.nudge(1700000000000);

		// Only 1 vault scan executed for both subscribers
		expect(harness.getScanCount()).toBe(1);
		expect(updates1).toHaveLength(1);
		expect(updates2).toHaveLength(1);
		expect(updates1[0]?.['myTasks']?.map((m) => m.file.path)).toEqual([
			'notes/one.md',
			'notes/two.md',
		]);
		// Failed query key 'broken' remains omitted so {% query %} renders its explain plan
		expect(Object.prototype.hasOwnProperty.call(updates1[0], 'broken')).toBe(false);
		expect(updates2[0]?.['duplicateTasks']?.map((m) => m.file.path)).toEqual([
			'notes/one.md',
			'notes/two.md',
		]);
		expect(updates2[0]?.['urgentTasks']?.map((m) => m.file.path)).toEqual(['notes/one.md']);
	});

	it('unregisters subscribers when AbortSignal aborts or unsubscribe is called', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/one.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		const roster = new ActiveQueryRoster(harness.app);
		const ac = new AbortController();
		const initial = await runVaultQuery(
			harness.app,
			{ tasks: '#task' },
			{ timeZone: 'UTC', signal: ac.signal },
		);

		const updates: VaultQueryResult[] = [];
		roster.register(
			{ tasks: '#task' },
			{ timeZone: 'UTC', signal: ac.signal },
			initial,
			(res) => {
				updates.push(res);
			},
		);
		expect(roster.size).toBe(1);

		ac.abort();
		expect(roster.size).toBe(0);

		harness.setNotes([]);
		harness.resetScanCount();
		await roster.nudge(1700000000000);
		expect(harness.getScanCount()).toBe(0);
		expect(updates).toHaveLength(0);
	});

	it('registers reset-only (0-query) subscribers without scanning them during nudge(), and resetAll() deregisters all subscribers and invokes onReset', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/one.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		const roster = new ActiveQueryRoster(harness.app);

		let resetCount1 = 0;
		let resetCount2 = 0;
		const acAborted = new AbortController();
		let abortedResetCalls = 0;

		// 1. 0-query reset-only subscriber
		roster.register(
			{},
			{
				onReset: () => {
					resetCount1++;
				},
			},
			{},
		);

		// 2. Query + onUpdate + onReset subscriber
		const init = await runVaultQuery(harness.app, { tasks: '#task' }, { timeZone: 'UTC' });
		roster.register(
			{ tasks: '#task' },
			{
				timeZone: 'UTC',
				onReset: () => {
					resetCount2++;
				},
			},
			init,
			() => {},
		);

		// 3. Aborted subscriber
		roster.register(
			{},
			{
				signal: acAborted.signal,
				onReset: () => {
					abortedResetCalls++;
				},
			},
			{},
		);
		acAborted.abort();

		expect(roster.size).toBe(2);

		// Nudge should only scan for the active query subscriber, ignoring the 0-query subscriber
		harness.resetScanCount();
		await roster.nudge(1700000000000);
		expect(harness.getScanCount()).toBe(1);

		// resetAll() clears the roster and invokes non-aborted onReset callbacks
		roster.resetAll();
		expect(roster.size).toBe(0);
		expect(resetCount1).toBe(1);
		expect(resetCount2).toBe(1);
		expect(abortedResetCalls).toBe(0);
	});
});

describe('processRhizomeCodeBlock reactive DOM lifecycle', () => {
	it('re-renders codeblock DOM on query result updates and unregisters on MarkdownRenderChild unload', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const renderedMarkdowns: string[] = [];
		const renderedComponents: MarkdownRenderChild[] = [];
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown, _el, _sourcePath, component) => {
				renderedMarkdowns.push(markdown);
				renderedComponents.push(component as MarkdownRenderChild);
			});

		let emptyCount = 0;
		const el = {
			empty: () => {
				emptyCount++;
			},
		} as unknown as HTMLElement;

		const addedChildren: MarkdownRenderChild[] = [];
		const ctx = {
			sourcePath: 'dashboard.md',
			addChild: (child: MarkdownRenderChild) => {
				addedChildren.push(child);
			},
		} as unknown as MarkdownPostProcessorContext;

		const source = [
			'{% query tasks %}#task{% endquery %}',
			'{% for item in query.tasks %}- {{ item.file.basename }}\n{% endfor %}',
		].join('\n');

		await processRhizomeCodeBlock(source, el, ctx, plugin);

		expect(plugin.activeQueryRoster.size).toBe(1);
		expect(renderedMarkdowns).toHaveLength(1);
		expect(renderedMarkdowns[0]).toContain('- alpha');
		expect(emptyCount).toBe(1);
		const firstInnerChild = renderedComponents[0]!;
		expect(firstInnerChild.unloaded).toBe(false);

		// Nudge without vault change -> no re-render
		await plugin.activeQueryRoster.nudge();
		expect(renderedMarkdowns).toHaveLength(1);

		// Add a second matching note and nudge -> re-renders and unloads previous inner child
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{
				path: 'notes/beta.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		await plugin.activeQueryRoster.nudge();

		expect(renderedMarkdowns).toHaveLength(2);
		expect(renderedMarkdowns[1]).toContain('- alpha');
		expect(renderedMarkdowns[1]).toContain('- beta');
		expect(emptyCount).toBe(2);
		expect(firstInnerChild.unloaded).toBe(true);
		const secondInnerChild = renderedComponents[1]!;
		expect(secondInnerChild.unloaded).toBe(false);

		// Unload the outer MarkdownRenderChild (simulating note close / scroll out of view)
		const outerChild = addedChildren[0]!;
		outerChild.unload();

		expect(plugin.activeQueryRoster.size).toBe(0);
		expect(secondInnerChild.unloaded).toBe(true);

		renderSpy.mockRestore();
	});

	it('serializes concurrent renderParsedRhizomeTemplate calls on the same ParsedRhizomeTemplate instance', async () => {
		const source = [
			'{% query tasks explain %}#task{% endquery %}',
			'{% for item in query.tasks %}{{ item.label }}{% endfor %}',
		].join('\n');
		const parsed = parseRhizomeTemplatePass1(source);

		let releaseFirstExplain!: () => void;
		const firstExplainGate = new Promise<void>((resolve) => {
			releaseFirstExplain = resolve;
		});

		const render1Promise = renderParsedRhizomeTemplate(
			source,
			parsed,
			{ tasks: [{ label: 'FIRST' }] },
			async () => {
				await firstExplainGate;
				return '# Explain 1';
			},
		);

		const render2Promise = renderParsedRhizomeTemplate(
			source,
			parsed,
			{ tasks: [{ label: 'SECOND' }] },
			async () => '# Explain 2',
		);

		releaseFirstExplain();
		const [res1, res2] = await Promise.all([render1Promise, render2Promise]);

		expect(res1.markdown).toContain('# Explain 1');
		expect(res1.markdown).toContain('FIRST');
		expect(res1.markdown).not.toContain('SECOND');

		expect(res2.markdown).toContain('# Explain 2');
		expect(res2.markdown).toContain('SECOND');
		expect(res2.markdown).not.toContain('FIRST');
	});

	it('drops a stale initial codeblock render if a newer reactive onUpdate triggers before initial Pass 2 completes', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		let explainCalls = 0;
		let releaseInitialExplain!: () => void;
		const initialExplainGate = new Promise<void>((resolve) => {
			releaseInitialExplain = resolve;
		});

		vi.spyOn(plugin, 'explainQuery').mockImplementation(async () => {
			explainCalls++;
			if (explainCalls === 1) {
				await initialExplainGate;
				return '# Initial Explain';
			}
			return '# Updated Explain';
		});

		const renderedMarkdowns: string[] = [];
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown) => {
				renderedMarkdowns.push(markdown);
			});

		const el = { empty: () => {} } as unknown as HTMLElement;
		const ctx = {
			sourcePath: 'dashboard.md',
			addChild: () => {},
		} as unknown as MarkdownPostProcessorContext;

		const source = [
			'{% query tasks explain %}#task{% endquery %}',
			'{% for item in query.tasks %}- {{ item.file.basename }}\n{% endfor %}',
		].join('\n');

		const blockPromise = processRhizomeCodeBlock(source, el, ctx, plugin);

		// Wait until initial query has registered and initial render is paused in explainQuery
		await vi.waitFor(() => {
			expect(explainCalls).toBe(1);
		});

		// Trigger a vault update and nudge while initial render is still in flight
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{
				path: 'notes/beta.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		const nudgePromise = plugin.activeQueryRoster.nudge();

		// Let initial explain finish so the serialized Pass 2 queue drains both renders
		releaseInitialExplain();
		await Promise.all([blockPromise, nudgePromise]);

		// Only the newer generation's output was committed to the DOM
		expect(renderedMarkdowns).toHaveLength(1);
		expect(renderedMarkdowns[0]).toContain('# Updated Explain');
		expect(renderedMarkdowns[0]).toContain('- beta');

		renderSpy.mockRestore();
	});

	it('populates host note metadata via ◊host even in a zero-query codeblock and re-renders when the host note changes', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/host.md',
				cache: {
					frontmatter: { status: 'draft', aliases: ['Initial Alias'] },
					tags: [{ tag: '#journal', position: {} as never }],
				},
			},
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const renderedMarkdowns: string[] = [];
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown) => {
				renderedMarkdowns.push(markdown);
			});

		const el = { empty: () => {} } as unknown as HTMLElement;
		const addedChildren: MarkdownRenderChild[] = [];
		const ctx = {
			sourcePath: 'notes/host.md',
			addChild: (child: MarkdownRenderChild) => {
				addedChildren.push(child);
			},
		} as unknown as MarkdownPostProcessorContext;

		const source =
			'Note={{ this.file.basename }} | Status={{ this.properties.status }} | Alias={{ this.aliases.first }} | Vault={{ vault }}';

		await processRhizomeCodeBlock(source, el, ctx, plugin);

		expect(plugin.activeQueryRoster.size).toBe(1);
		expect(renderedMarkdowns).toHaveLength(1);
		expect(renderedMarkdowns[0]).toContain('Note=host | Status=draft | Alias=Initial Alias');

		// Mutate the host note's frontmatter and nudge the roster
		harness.setNotes([
			{
				path: 'notes/host.md',
				cache: {
					frontmatter: { status: 'published', aliases: ['Updated Alias'] },
					tags: [{ tag: '#journal', position: {} as never }],
				},
			},
		]);
		await plugin.activeQueryRoster.nudge();

		expect(renderedMarkdowns).toHaveLength(2);
		expect(renderedMarkdowns[1]).toContain(
			'Note=host | Status=published | Alias=Updated Alias',
		);

		addedChildren[0]?.unload();
		expect(plugin.activeQueryRoster.size).toBe(0);
		renderSpy.mockRestore();
	});

	it('re-runs Pass 1 and heals or updates mounted rhizome codeblocks when a partial/layout file or folder setting changes', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{
				path: 'notes/project.md',
				cache: { tags: [{ tag: '#project', position: {} as never }] },
			},
			// Note: '◊Rhizome/partials/summary.md' initially does NOT exist
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const renderedMarkdowns: string[] = [];
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown) => {
				renderedMarkdowns.push(markdown);
			});

		const el = { empty: () => {} } as unknown as HTMLElement;
		const addedChildren: MarkdownRenderChild[] = [];
		const ctx = {
			sourcePath: '',
			addChild: (child: MarkdownRenderChild) => {
				addedChildren.push(child);
			},
		} as unknown as MarkdownPostProcessorContext;

		const source = "{% render 'summary' %}";
		await processRhizomeCodeBlock(source, el, ctx, plugin);

		// Initially fails in Pass 1 because '◊Rhizome/partials/summary.md' is missing,
		// but still registers a reset-only subscription on activeQueryRoster!
		expect(plugin.activeQueryRoster.size).toBe(1);
		expect(renderedMarkdowns).toHaveLength(1);
		expect(renderedMarkdowns[0]).toContain(
			'> [!danger] Template Error: `TEMPLATE_RENDER_ERROR`',
		);

		// 1. Create '◊Rhizome/partials/summary.md' with a {% query tasks %} block and trigger resetAll()
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{
				path: 'notes/project.md',
				cache: { tags: [{ tag: '#project', position: {} as never }] },
			},
			{
				path: '◊Rhizome/partials/summary.md',
				content:
					'{% query tasks %}#task{% endquery %}Tasks={{ query.tasks.first.file.basename }}',
				cache: {},
			},
		]);
		plugin.activeQueryRoster.resetAll();

		await vi.waitFor(() => {
			expect(renderedMarkdowns).toHaveLength(2);
		});
		expect(renderedMarkdowns[1]).toContain('Tasks=alpha');
		expect(plugin.activeQueryRoster.size).toBe(1);

		// 2. Edit '◊Rhizome/partials/summary.md' to add a second query `#project` and emit metadataCache 'changed'
		vi.useFakeTimers();
		try {
			harness.setNotes([
				{
					path: 'notes/alpha.md',
					cache: { tags: [{ tag: '#task', position: {} as never }] },
				},
				{
					path: 'notes/project.md',
					cache: { tags: [{ tag: '#project', position: {} as never }] },
				},
				{
					path: '◊Rhizome/partials/summary.md',
					content:
						'{% query tasks %}#task{% endquery %}{% query projs %}#project{% endquery %}Tasks={{ query.tasks.size }},Projs={{ query.projs.first.file.basename }}',
					cache: {},
				},
			]);
			harness.emitMetadataChanged('◊Rhizome/partials/summary.md');
			await vi.advanceTimersByTimeAsync(600);
		} finally {
			vi.useRealTimers();
		}

		await vi.waitFor(() => {
			expect(renderedMarkdowns).toHaveLength(3);
		});
		expect(renderedMarkdowns[2]).toContain('Tasks=1,Projs=project');

		addedChildren[0]?.unload();
		expect(plugin.activeQueryRoster.size).toBe(0);
		renderSpy.mockRestore();
	});

	it('excludes plugin.query execution time from the logged template.render durationMs', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const renderSpy = vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async () => {});
		const originalQuery = plugin.query.bind(plugin);
		vi.spyOn(plugin, 'query').mockImplementation(async (queries, options, onUpdate) => {
			await vi.advanceTimersByTimeAsync(1500);
			return originalQuery(queries, options, onUpdate);
		});

		const logCalls: Array<{
			level: string;
			message: string;
			meta: { source: string; durationMs?: number };
		}> = [];
		vi.spyOn(plugin.loggerAdapter, 'log').mockImplementation((level, message, meta) => {
			logCalls.push({
				level,
				message,
				meta: meta as { source: string; durationMs?: number },
			});
		});

		const el = { empty: () => {} } as unknown as HTMLElement;
		const addedChildren: MarkdownRenderChild[] = [];
		const ctx = {
			sourcePath: 'dashboard.md',
			addChild: (child: MarkdownRenderChild) => {
				addedChildren.push(child);
			},
		} as unknown as MarkdownPostProcessorContext;

		const source = [
			'{% query tasks %}#task{% endquery %}',
			'{% for item in query.tasks %}- {{ item.file.basename }}\n{% endfor %}',
		].join('\n');

		vi.useFakeTimers();
		try {
			await processRhizomeCodeBlock(source, el, ctx, plugin);
		} finally {
			vi.useRealTimers();
		}

		const renderLog = logCalls.find((entry) => entry.meta.source === 'template.render');
		expect(renderLog).toBeDefined();
		expect(renderLog?.meta.durationMs).toBe(0);

		addedChildren[0]?.unload();
		renderSpy.mockRestore();
	});

	it('isolates identical @this.tags queries across multiple open host notes in a single vault scan and updates sourcePath on file rename', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'Projects/Apollo.md',
				cache: {
					frontmatter: { tags: ['space'] },
				},
			},
			{
				path: 'Projects/Ocean.md',
				cache: {
					frontmatter: { tags: ['marine'] },
				},
			},
			{
				path: 'Notes/LunarRover.md',
				cache: {
					frontmatter: { tags: ['space/rover'] },
				},
			},
			{
				path: 'Notes/Submarine.md',
				cache: {
					frontmatter: { tags: ['marine/sub'] },
				},
			},
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const apolloRenders: string[] = [];
		const oceanRenders: string[] = [];
		const apolloEl = { empty: () => {} } as unknown as HTMLElement;
		const oceanEl = { empty: () => {} } as unknown as HTMLElement;
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown, containerEl) => {
				if (containerEl === apolloEl) {
					apolloRenders.push(markdown);
				} else if (containerEl === oceanEl) {
					oceanRenders.push(markdown);
				}
			});

		const children: MarkdownRenderChild[] = [];
		const sharedCodeblock = [
			'{%- query related -%}tag:@this.tags AND ![file.path: = @this.file.path]{%- endquery -%}',
			'Host={{ this.file.basename }} ({{ this.file.path }}) -> {% for n in query.related %}{{ n.file.basename }};{% endfor %}',
		].join('\n');

		await processRhizomeCodeBlock(
			sharedCodeblock,
			apolloEl,
			{
				sourcePath: 'Projects/Apollo.md',
				addChild: (c: MarkdownRenderChild) => children.push(c),
			} as unknown as MarkdownPostProcessorContext,
			plugin,
		);
		await processRhizomeCodeBlock(
			sharedCodeblock,
			oceanEl,
			{
				sourcePath: 'Projects/Ocean.md',
				addChild: (c: MarkdownRenderChild) => children.push(c),
			} as unknown as MarkdownPostProcessorContext,
			plugin,
		);

		expect(apolloRenders).toEqual(['Host=Apollo (Projects/Apollo.md) -> LunarRover;']);
		expect(oceanRenders).toEqual(['Host=Ocean (Projects/Ocean.md) -> Submarine;']);

		// 1. Add a new note Notes/MarsProbe.md tagged #space; Apollo re-renders while Ocean does NOT
		harness.setNotes([
			{
				path: 'Projects/Apollo.md',
				cache: {
					frontmatter: { tags: ['space'] },
				},
			},
			{
				path: 'Projects/Ocean.md',
				cache: {
					frontmatter: { tags: ['marine'] },
				},
			},
			{
				path: 'Notes/LunarRover.md',
				cache: {
					frontmatter: { tags: ['space/rover'] },
				},
			},
			{
				path: 'Notes/MarsProbe.md',
				cache: {
					frontmatter: { tags: ['space/mars'] },
				},
			},
			{
				path: 'Notes/Submarine.md',
				cache: {
					frontmatter: { tags: ['marine/sub'] },
				},
			},
		]);
		await plugin.activeQueryRoster.nudge();

		expect(apolloRenders).toHaveLength(2);
		expect(apolloRenders[1]).toBe('Host=Apollo (Projects/Apollo.md) -> LunarRover;MarsProbe;');
		expect(oceanRenders).toHaveLength(1);

		// 2. Rename Projects/Apollo.md -> Projects/Artemis.md and verify handleFileRename + nudge updates this.file.basename & this.file.path
		harness.setNotes([
			{
				path: 'Projects/Artemis.md',
				cache: {
					frontmatter: { tags: ['space'] },
				},
			},
			{
				path: 'Projects/Ocean.md',
				cache: {
					frontmatter: { tags: ['marine'] },
				},
			},
			{
				path: 'Notes/LunarRover.md',
				cache: {
					frontmatter: { tags: ['space/rover'] },
				},
			},
			{
				path: 'Notes/MarsProbe.md',
				cache: {
					frontmatter: { tags: ['space/mars'] },
				},
			},
			{
				path: 'Notes/Submarine.md',
				cache: {
					frontmatter: { tags: ['marine/sub'] },
				},
			},
		]);
		plugin.activeQueryRoster.handleFileRename('Projects/Apollo.md', 'Projects/Artemis.md');
		await plugin.activeQueryRoster.nudge();

		expect(apolloRenders).toHaveLength(3);
		expect(apolloRenders[2]).toBe(
			'Host=Artemis (Projects/Artemis.md) -> LunarRover;MarsProbe;',
		);

		for (const c of children) c.unload();
		renderSpy.mockRestore();
	});
});
