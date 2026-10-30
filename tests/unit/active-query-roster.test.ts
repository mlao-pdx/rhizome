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
	cache?: Partial<CachedMetadata> | null;
}

function createMutableVaultApp(initialNotes: MutableNote[]) {
	let notes = [...initialNotes];
	let getMarkdownFilesCalls = 0;

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

	const app = {
		vault: {
			configDir: 'mock-config',
			adapter: new FileSystemAdapter(),
			getMarkdownFiles: () => {
				getMarkdownFilesCalls++;
				return notes.map(makeFile);
			},
			on: () => ({}),
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const found = notes.find((n) => n.path === file.path);
				return found?.cache ?? null;
			},
			getFirstLinkpathDest: () => null,
			on: () => ({}),
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
			'{% for item in tasks %}- {{ item.file.basename }}\n{% endfor %}',
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
			'{% for item in tasks %}{{ item.label }}{% endfor %}',
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
			'{% for item in tasks %}- {{ item.file.basename }}\n{% endfor %}',
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
});
