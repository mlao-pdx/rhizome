import type { App, CachedMetadata, MarkdownPostProcessorContext, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import {
	ActiveQueryRoster,
	hashVaultQueryMatch,
	hashVaultQueryResult,
} from '../../src/adapters/active-query-roster';
import type { BacklinkIndex, BacklinkSnapshot } from '../../src/adapters/backlink-index';
import {
	countExtractedQueryRecords,
	exceedsLargeMarkdownThreshold,
	exceedsSentinelThreshold,
	formatDynamicStandbyCallout,
	formatLargeRenderStandbyCallout,
	LARGE_MARKDOWN_CHAR_THRESHOLD,
	LARGE_MARKDOWN_LINE_THRESHOLD,
	LARGE_QUERY_RECORD_THRESHOLD,
	measureMarkdownOutput,
	processRhizomeCodeBlock,
} from '../../src/adapters/rhizome-codeblock';
import { RenderSentinelIdbStore } from '../../src/adapters/render-sentinel-idb';
import {
	computeCodeBlockSentinelHash,
	RenderSentinelStore,
} from '../../src/adapters/render-sentinel-store';
import { runVaultQuery, type VaultQueryResult } from '../../src/adapters/vault-query-runner';
import {
	parsedTemplateReferencesHost,
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
			onLayoutReady: (cb: () => unknown) => {
				cb();
			},
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

	it('includes backlink path and count in the payload hash', async () => {
		const { app } = createMutableVaultApp([
			{
				path: 'notes/a.md',
				cache: { tags: [{ tag: '#project', position: {} as never }] },
			},
		]);
		const res = await runVaultQuery(app, { q: '#project' }, { timeZone: 'UTC' });
		const match = res['q']![0]!;

		const one = { ...match, backlinks: [{ path: 'notes/source.md', count: 1 }] };
		const two = { ...match, backlinks: [{ path: 'notes/source.md', count: 2 }] };
		const renamed = {
			...match,
			backlinks: [{ path: 'notes/renamed.md', count: 1 }],
		};

		expect(hashVaultQueryMatch(one)).not.toBe(hashVaultQueryMatch(two));
		expect(hashVaultQueryMatch(one)).not.toBe(hashVaultQueryMatch(renamed));
		expect(hashVaultQueryMatch(match)).not.toBe(hashVaultQueryMatch(one));
	});

	it('includes headingLevel in the payload hash and respects includeHost', async () => {
		const { app } = createMutableVaultApp([
			{
				path: 'notes/a.md',
				cache: { tags: [{ tag: '#project', position: {} as never }] },
			},
			{
				path: 'notes/host.md',
				cache: { frontmatter: { status: 'draft' } },
			},
		]);
		const res1 = await runVaultQuery(
			app,
			{ q: '#project' },
			{ timeZone: 'UTC', sourcePath: 'notes/host.md' },
		);
		const res2 = {
			...res1,
			'◊host': [
				{
					...res1['◊host']![0]!,
					properties: { status: 'published' },
				},
			],
		};

		// Different headingLevel produces different payload hash
		expect(hashVaultQueryResult(res1, { headingLevel: 1 })).not.toBe(
			hashVaultQueryResult(res1, { headingLevel: 2 }),
		);

		// By default includeHost is true, so changing ◊host changes the hash
		expect(hashVaultQueryResult(res1)).not.toBe(hashVaultQueryResult(res2));

		// With includeHost: false, changing ◊host does NOT change the hash, unless headingLevel changes
		expect(hashVaultQueryResult(res1, { includeHost: false, headingLevel: 2 })).toBe(
			hashVaultQueryResult(res2, { includeHost: false, headingLevel: 2 }),
		);
		expect(hashVaultQueryResult(res1, { includeHost: false, headingLevel: 2 })).not.toBe(
			hashVaultQueryResult(res2, { includeHost: false, headingLevel: 3 }),
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

	it('captures one backlink snapshot per nudge pass and reuses it for the batch', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
		]);
		const snapshot: BacklinkSnapshot = new Map();
		const snapshotSpy = vi.fn(() => snapshot);
		const backlinkIndex = { snapshot: snapshotSpy } as unknown as BacklinkIndex;
		const roster = new ActiveQueryRoster(harness.app, undefined, backlinkIndex);
		const initial = await runVaultQuery(harness.app, { tasks: '#task' }, { timeZone: 'UTC' });

		roster.register({ tasks: '#task' }, { timeZone: 'UTC' }, initial, () => {});
		roster.register({ tasks: '#task', other: '#task' }, { timeZone: 'UTC' }, initial, () => {});

		await roster.nudge(1700000000000);
		expect(snapshotSpy).toHaveBeenCalledTimes(1);
		expect(snapshotSpy).toHaveBeenCalledWith();
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

	it('reuses cached query payload and LiquidJS render when a codeblock unmounts and remounts without vault changes', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{
				path: 'dashboard.md',
				cache: {
					headings: [
						{ heading: 'Tasks', level: 2, position: { start: { line: 1 } } } as never,
					],
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
		const querySpy = vi.spyOn(plugin, 'query');

		const logCalls: Array<{ source: string; [key: string]: unknown }> = [];
		vi.spyOn(plugin.loggerAdapter, 'log').mockImplementation((_level, _msg, meta) => {
			logCalls.push(meta);
		});

		const addedChildren: MarkdownRenderChild[] = [];
		const makeCtx = (lineStart: number) =>
			({
				sourcePath: 'dashboard.md',
				addChild: (child: MarkdownRenderChild) => {
					addedChildren.push(child);
				},
				getSectionInfo: () => ({ lineStart, lineEnd: lineStart + 4 }),
			}) as unknown as MarkdownPostProcessorContext;

		const source = [
			'{% query tasks %}#task{% endquery %}',
			'{{ "Section" | heading: "demote" }}',
			'{% for item in query.tasks %}- {{ item.file.basename }}\n{% endfor %}',
		].join('\n');

		// 1. Initial mount runs query and LiquidJS render
		const el1 = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(source, el1, makeCtx(5), plugin);
		expect(querySpy).toHaveBeenCalledTimes(1);
		expect(renderedMarkdowns).toHaveLength(1);
		expect(renderedMarkdowns[0]).toContain('### Section');
		expect(renderedMarkdowns[0]).toContain('- alpha');
		expect(logCalls.filter((c) => c.source === 'template.render')).toHaveLength(1);
		expect(
			logCalls.filter((c) => c.source === 'template.render')[0]?.['cached'],
		).toBeUndefined();

		// Simulate stepping cursor into codeblock (unmount) and stepping back out (remount)
		addedChildren[0]?.unload();
		expect(plugin.activeQueryRoster.size).toBe(0);

		const el2 = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(source, el2, makeCtx(5), plugin);

		// 2. Remount hits CodeBlockRenderCache: skips plugin.query() and skips LiquidJS render,
		// and logs template.render with cached: true, cacheHit: 'remount'
		expect(querySpy).toHaveBeenCalledTimes(1);
		const renderLogs = logCalls.filter((c) => c.source === 'template.render');
		expect(renderLogs).toHaveLength(2);
		expect(renderLogs[1]).toMatchObject({ cached: true, cacheHit: 'remount' });
		expect(renderedMarkdowns).toHaveLength(2);
		expect(renderedMarkdowns[1]).toBe(renderedMarkdowns[0]);
		// And still re-registers with ActiveQueryRoster so subsequent vault updates work!
		expect(plugin.activeQueryRoster.size).toBe(1);

		// 3. Subsequent vault change still updates the remounted codeblock reactively
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{
				path: 'notes/beta.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{
				path: 'dashboard.md',
				cache: {
					headings: [
						{ heading: 'Tasks', level: 2, position: { start: { line: 1 } } } as never,
					],
				},
			},
		]);
		await plugin.activeQueryRoster.nudge();
		expect(renderedMarkdowns).toHaveLength(3);
		expect(renderedMarkdowns[2]).toContain('- beta');

		for (const c of addedChildren) c.unload();
		renderSpy.mockRestore();
	});

	it('suppresses redundant self-edit echo re-render when host note mtime changes, but re-renders when headingLevel above the codeblock changes', async () => {
		let hostHeadingLevel = 2;
		let hostMtime = 1700000000000;
		const makeNotes = () => [
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{
				path: 'README.md',
				mtime: hostMtime,
				cache: {
					headings: [
						{
							heading: 'Section',
							level: hostHeadingLevel,
							position: { start: { line: 1 } },
						} as never,
					],
				},
			},
		];
		const harness = createMutableVaultApp(makeNotes());
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
			sourcePath: 'README.md',
			addChild: (child: MarkdownRenderChild) => {
				addedChildren.push(child);
			},
			getSectionInfo: () => ({ lineStart: 5, lineEnd: 10 }),
		} as unknown as MarkdownPostProcessorContext;

		// Template uses `| heading: "demote"` and query.tasks, but does NOT reference `this` or `@this`
		const source = [
			'{% query tasks %}#task{% endquery %}',
			'{{ "Tasks" | heading: "demote" }}',
			'{% for item in query.tasks %}- {{ item.file.basename }}\n{% endfor %}',
		].join('\n');

		await processRhizomeCodeBlock(source, el, ctx, plugin);
		expect(renderedMarkdowns).toHaveLength(1);
		expect(renderedMarkdowns[0]).toContain('### Tasks');

		// 1. Simulate the 1.5s delayed metadataCache update on README.md after editing the codeblock:
		// README.md mtime changes, but headingLevel (2) and query.tasks matches do not change.
		hostMtime += 1500;
		harness.setNotes(makeNotes());
		await plugin.activeQueryRoster.nudge(hostMtime, { onlyIfChanged: true });

		// No echo re-render triggered!
		expect(renderedMarkdowns).toHaveLength(1);

		// And if the user steps into and out of the codeblock after that trailing nudge,
		// stateRevision was synchronized so getRemountHit() succeeds without calling plugin.query()!
		const querySpy = vi.spyOn(plugin, 'query');
		addedChildren[0]?.unload();
		const elRemount = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(source, elRemount, ctx, plugin);
		expect(querySpy).not.toHaveBeenCalled();
		expect(renderedMarkdowns).toHaveLength(2);
		expect(renderedMarkdowns[1]).toBe(renderedMarkdowns[0]);

		// 2. Now user changes the heading above the codeblock in README.md from ## (2) to ### (3):
		hostHeadingLevel = 3;
		hostMtime += 1500;
		harness.setNotes(makeNotes());
		await plugin.activeQueryRoster.nudge(hostMtime, { onlyIfChanged: true });

		// Heading level change invalidates the payload hash and re-renders with #### Tasks!
		expect(renderedMarkdowns).toHaveLength(3);
		expect(renderedMarkdowns[2]).toContain('#### Tasks');

		for (const c of addedChildren) c.unload();
		renderSpy.mockRestore();
	});

	it('parsedTemplateReferencesHost distinguishes real this/@this usage from plain text, quoted strings, and comments', () => {
		const check = (src: string) =>
			parsedTemplateReferencesHost(src, parseRhizomeTemplatePass1(src));

		// Plain English "this" between two Liquid tags or inside quoted string literals -> false
		expect(check('{{ query.tasks.size }} items in this vault: {{ vault }}')).toBe(false);
		expect(check('{{ "in this section" | heading }}')).toBe(false);
		expect(check("{% assign label = 'this is a test' %}{{ label }}")).toBe(false);
		expect(check('{% comment %}{{ this.file.name }}{% endcomment %}')).toBe(false);
		expect(check('{% raw %}{{ this.file.name }}{% endraw %}')).toBe(false);
		expect(check('{% # {{ this.file.name }} %}')).toBe(false);
		expect(check('{{ item.this }} {{ thisweek }}')).toBe(false);

		// Real `this` in Liquid expressions or `@this` in queries -> true
		expect(check('{{ this.file.basename }}')).toBe(true);
		expect(check('{% if this.properties.status == "active" %}ok{% endif %}')).toBe(true);
		expect(check('{% query q %}tag:@this.tags{% endquery %}')).toBe(true);
	});

	it('isolates Pass 1 cached ParsedRhizomeTemplate instances per host note sourcePath', async () => {
		const harness = createMutableVaultApp([
			{ path: 'notes/a.md', cache: {} },
			{ path: 'notes/b.md', cache: {} },
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const renderSpy = vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async () => {});
		const elA = { empty: () => {} } as unknown as HTMLElement;
		const elB = { empty: () => {} } as unknown as HTMLElement;
		const children: MarkdownRenderChild[] = [];
		const sharedSource = '{{ vault }}';

		await processRhizomeCodeBlock(
			sharedSource,
			elA,
			{
				sourcePath: 'notes/a.md',
				addChild: (c: MarkdownRenderChild) => children.push(c),
			} as unknown as MarkdownPostProcessorContext,
			plugin,
		);
		await processRhizomeCodeBlock(
			sharedSource,
			elB,
			{
				sourcePath: 'notes/b.md',
				addChild: (c: MarkdownRenderChild) => children.push(c),
			} as unknown as MarkdownPostProcessorContext,
			plugin,
		);

		const folders = plugin.getTemplateFolderConfig();
		const rev = plugin.activeQueryRoster.templateRevision;
		const pass1A = plugin.codeBlockRenderCache.getPass1(
			'notes/a.md',
			sharedSource,
			folders,
			rev,
		);
		const pass1B = plugin.codeBlockRenderCache.getPass1(
			'notes/b.md',
			sharedSource,
			folders,
			rev,
		);

		expect(pass1A).toBeDefined();
		expect(pass1B).toBeDefined();
		expect(pass1A?.parsed).not.toBe(pass1B?.parsed);

		for (const c of children) c.unload();
		renderSpy.mockRestore();
	});

	it('exposes calibrated large-render thresholds, dynamic standby formatting, and sentinel thresholds', () => {
		expect(LARGE_QUERY_RECORD_THRESHOLD).toBe(12_000);
		expect(LARGE_MARKDOWN_LINE_THRESHOLD).toBe(5_000);
		expect(LARGE_MARKDOWN_CHAR_THRESHOLD).toBe(100_000);

		const parsed = parseRhizomeTemplatePass1(
			'{% query alpha %}#a{% endquery %}{% query beta %}#b{% endquery %}',
		);
		const fakePayload = {
			alpha: new Array(7_500).fill({}),
			beta: new Array(4_500).fill({}),
			'◊host': [{}],
		} as unknown as VaultQueryResult;
		expect(countExtractedQueryRecords(parsed, fakePayload)).toBe(12_000);

		expect(measureMarkdownOutput('')).toEqual({ chars: 0, lines: 0 });
		expect(measureMarkdownOutput('single line')).toEqual({ chars: 11, lines: 1 });
		expect(measureMarkdownOutput('a\nb\nc')).toEqual({ chars: 5, lines: 3 });

		expect(exceedsLargeMarkdownThreshold({ chars: 100, lines: 4_999 })).toBe(false);
		expect(exceedsLargeMarkdownThreshold({ chars: 100, lines: 5_000 })).toBe(true);
		expect(exceedsLargeMarkdownThreshold({ chars: 99_999, lines: 10 })).toBe(false);
		expect(exceedsLargeMarkdownThreshold({ chars: 100_000, lines: 10 })).toBe(true);

		expect(exceedsSentinelThreshold({ chars: 65_535, lines: 4_999 })).toBe(false);
		expect(exceedsSentinelThreshold({ chars: 65_536, lines: 10 })).toBe(true);
		expect(exceedsSentinelThreshold({ chars: 1_000, lines: 5_000 })).toBe(true);

		expect(formatLargeRenderStandbyCallout(19_951)).toBe(
			'> [!info]\n> The template needs to render across a large result set (~19,951 records).<br>Please stand-by.',
		);
		expect(
			formatDynamicStandbyCallout({
				kind: 'output',
				metrics: { lines: 19_963, chars: 50_000 },
			}),
		).toBe(
			[
				'> [!info]',
				'> The generated Markdown output is large (~19,963 lines).<br>Please stand-by.',
				'>',
				'> If Obsidian stops responding, force-close and reopen the app to pause this codeblock so you can edit it.',
			].join('\n'),
		);
		expect(
			formatDynamicStandbyCallout({
				kind: 'output',
				metrics: { lines: 400, chars: 565_248 },
			}),
		).toBe(
			[
				'> [!info]',
				'> The generated Markdown output is large (~552 KB).<br>Please stand-by.',
				'>',
				'> If Obsidian stops responding, force-close and reopen the app to pause this codeblock so you can edit it.',
			].join('\n'),
		);
		expect(
			formatDynamicStandbyCallout({
				kind: 'output',
				metrics: { lines: 19_963, chars: 2_831_155 },
			}),
		).toBe(
			[
				'> [!info]',
				'> The generated Markdown output is large (~19,963 lines, ~2.7 MB).<br>Please stand-by.',
				'>',
				'> If Obsidian stops responding, force-close and reopen the app to pause this codeblock so you can edit it.',
			].join('\n'),
		);
	});

	it('renders an initial [!info] standby callout at Checkpoint 1 (>= 12,000 records with loop tag) while skipping standby for loop-free summary templates', async () => {
		const harness = createMutableVaultApp([
			{ path: 'notes/alpha.md', cache: {} },
			{ path: 'README.md', cache: {} },
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const seed = await runVaultQuery(harness.app, { q: '' }, { timeZone: 'UTC' });
		const baseMatch = seed['q']![0]!;
		const hostMatch = seed['q']![1]!;
		const largeMatches = new Array<typeof baseMatch>(12_500).fill(baseMatch);
		vi.spyOn(plugin, 'query').mockResolvedValue({
			myQuery: largeMatches,
			'◊host': [hostMatch],
		});

		const renderedMarkdowns: string[] = [];
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown) => {
				renderedMarkdowns.push(markdown);
			});

		const logCalls: Array<{ source: string; [key: string]: unknown }> = [];
		vi.spyOn(plugin.loggerAdapter, 'log').mockImplementation((_level, _msg, meta) => {
			logCalls.push(meta);
		});

		const el = { empty: () => {} } as unknown as HTMLElement;
		const children: MarkdownRenderChild[] = [];
		const ctx = {
			sourcePath: 'README.md',
			addChild: (c: MarkdownRenderChild) => children.push(c),
		} as unknown as MarkdownPostProcessorContext;

		// Produces 12,500 lines (exceeding both Checkpoint 1 and Checkpoint 2),
		// but standby callout must only be rendered once before the final output.
		const source = [
			'{% query myQuery %}#daily{% endquery %}',
			'{% for item in query.myQuery %}- {{ item.file.basename }}\n{% endfor %}',
		].join('\n');

		await processRhizomeCodeBlock(source, el, ctx, plugin);

		expect(renderedMarkdowns).toHaveLength(2);
		expect(renderedMarkdowns[0]).toBe(
			'> [!info]\n> The template needs to render across a large result set (~12,500 records).<br>Please stand-by.',
		);
		expect(renderedMarkdowns[1]).toContain('- alpha\n');

		const renderLogs = logCalls.filter((c) => c.source === 'template.render');
		expect(renderLogs).toHaveLength(1);
		expect(renderLogs[0]).toMatchObject({
			source: 'template.render',
			count: 1,
			records: 12_500,
			standbyShown: true,
			outputLines: 12_502,
		});
		expect(typeof renderLogs[0]?.['parseMs']).toBe('number');
		expect(typeof renderLogs[0]?.['liquidMs']).toBe('number');
		expect(typeof renderLogs[0]?.['markdownRenderMs']).toBe('number');
		expect(typeof renderLogs[0]?.['outputChars']).toBe('number');
		expect(renderLogs[0]?.['durationMs']).toBe(
			(renderLogs[0]?.['parseMs'] as number) +
				(renderLogs[0]?.['liquidMs'] as number) +
				(renderLogs[0]?.['markdownRenderMs'] as number),
		);

		// Loop-free summary template ({{ query.myQuery.size }}) skips Checkpoint 1 on BOTH initial mount AND remount!
		const summarySource =
			'{% query myQuery %}#daily{% endquery %}Count={{ query.myQuery.size }}';
		renderedMarkdowns.length = 0;
		const elSummary1 = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(summarySource, elSummary1, ctx, plugin);
		expect(renderedMarkdowns).toEqual(['Count=12500']);

		children[1]?.unload();
		renderedMarkdowns.length = 0;
		const elSummaryRemount = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(summarySource, elSummaryRemount, ctx, plugin);
		expect(renderedMarkdowns).toEqual(['Count=12500']);

		for (const c of children) c.unload();
		renderSpy.mockRestore();
	});

	it('renders dynamic [!info] standby callout at Checkpoint 2 (>= 5,000 lines or >= 100,000 chars) on initial mount and remount, and suppresses standby on reactive onUpdate', async () => {
		const harness = createMutableVaultApp([
			{ path: 'notes/alpha.md', cache: {} },
			{ path: 'notes/beta.md', cache: {} },
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const seed = await runVaultQuery(harness.app, { q: '' }, { timeZone: 'UTC' });
		const alphaMatch = seed['q']![0]!;
		const betaMatch = seed['q']![1]!;

		let capturedOnUpdate: ((payload: VaultQueryResult) => void | Promise<void>) | undefined;
		const matches5200 = new Array<typeof alphaMatch>(5_200).fill(alphaMatch);
		vi.spyOn(plugin, 'query').mockImplementation(async (_queries, _opts, onUpdate) => {
			capturedOnUpdate = onUpdate;
			return { tasks: matches5200 };
		});

		const renderedMarkdowns: string[] = [];
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown) => {
				renderedMarkdowns.push(markdown);
			});

		const logCalls: Array<{ source: string; [key: string]: unknown }> = [];
		vi.spyOn(plugin.loggerAdapter, 'log').mockImplementation((_level, _msg, meta) => {
			logCalls.push(meta);
		});

		const children: MarkdownRenderChild[] = [];
		const ctx = {
			sourcePath: 'dashboard.md',
			addChild: (c: MarkdownRenderChild) => children.push(c),
		} as unknown as MarkdownPostProcessorContext;

		const source = [
			'{% query tasks %}#task{% endquery %}',
			'{% for item in query.tasks %}- {{ item.file.basename }}\n{% endfor %}',
		].join('\n');

		// 1. Initial mount: 5,200 records (< 12,000 Checkpoint 1), 5,202 lines (>= 5,000 Checkpoint 2, < 100,000 chars)
		const el1 = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(source, el1, ctx, plugin);

		expect(renderedMarkdowns).toHaveLength(2);
		expect(renderedMarkdowns[0]).toBe(
			[
				'> [!info]',
				'> The generated Markdown output is large (~5,202 lines).<br>Please stand-by.',
				'>',
				'> If Obsidian stops responding, force-close and reopen the app to pause this codeblock so you can edit it.',
			].join('\n'),
		);
		expect(renderedMarkdowns[1]).toContain('- alpha\n');

		// 2. Reactive onUpdate on the already-mounted codeblock does NOT flash the standby callout
		renderedMarkdowns.length = 0;
		const matches5201 = [...matches5200, betaMatch];
		await capturedOnUpdate?.({ tasks: matches5201 });
		expect(renderedMarkdowns).toHaveLength(1);
		expect(renderedMarkdowns[0]).toContain('- beta');

		// 3. Unmount and remount at the same stateRevision: remount hit triggers Checkpoint 2 standby callout
		children[0]?.unload();
		renderedMarkdowns.length = 0;
		const elRemount = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(source, elRemount, ctx, plugin);

		expect(renderedMarkdowns).toHaveLength(2);
		expect(renderedMarkdowns[0]).toBe(
			[
				'> [!info]',
				'> The generated Markdown output is large (~5,203 lines).<br>Please stand-by.',
				'>',
				'> If Obsidian stops responding, force-close and reopen the app to pause this codeblock so you can edit it.',
			].join('\n'),
		);
		expect(renderedMarkdowns[1]).toContain('- beta');

		const remountLog = logCalls
			.filter((c) => c.source === 'template.render')
			.find((c) => c['cacheHit'] === 'remount');
		expect(remountLog).toMatchObject({
			cached: true,
			cacheHit: 'remount',
			standbyShown: true,
			records: 5_201,
			outputLines: 5_203,
		});

		for (const c of children) c.unload();
		renderSpy.mockRestore();
	});

	it('defers query-bearing codeblock execution during cold startup until vault metadata is ready', async () => {
		let layoutReadyCallback: (() => void) | null = null;
		const harness = createMutableVaultApp([]);
		(harness.app.workspace as { onLayoutReady: (cb: () => void) => void }).onLayoutReady = (
			cb,
		) => {
			layoutReadyCallback = cb;
		};

		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();
		expect(plugin.documentCache.isReady).toBe(false);

		const renderedByEl = new Map<unknown, string[]>();
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown, el) => {
				const list = renderedByEl.get(el) ?? [];
				list.push(markdown);
				renderedByEl.set(el, list);
			});
		const querySpy = vi.spyOn(plugin, 'query');

		const children: MarkdownRenderChild[] = [];
		const makeCtx = () =>
			({
				sourcePath: 'dashboard.md',
				addChild: (c: MarkdownRenderChild) => children.push(c),
			}) as unknown as MarkdownPostProcessorContext;

		// 1. Static template with neither queries nor `this` renders immediately even before vaultReady
		const elStatic = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock('Hello Rhizome', elStatic, makeCtx(), plugin);
		expect(renderedByEl.get(elStatic)).toEqual(['Hello Rhizome']);

		// 2. Query-bearing block waits at waitForVaultReady without running a wasted 0-match query
		const elQuery = { empty: () => {} } as unknown as HTMLElement;
		const queryBlockPromise = processRhizomeCodeBlock(
			'{% query q %}#ready{% endquery %}Count={{ query.q.size }}',
			elQuery,
			makeCtx(),
			plugin,
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(querySpy).not.toHaveBeenCalled();
		expect(renderedByEl.get(elQuery)).toBeUndefined();

		// Metadata populates and layout becomes ready -> query runs ONCE with ready vault state!
		harness.setNotes([
			{
				path: 'notes/ready.md',
				cache: { tags: [{ tag: '#ready', position: {} as never }] },
			},
			{ path: 'dashboard.md', cache: {} },
		]);
		layoutReadyCallback!();
		await queryBlockPromise;

		expect(querySpy).toHaveBeenCalledTimes(1);
		expect(renderedByEl.get(elQuery)).toEqual(['Count=1']);

		for (const c of children) c.unload();
		renderSpy.mockRestore();
	});

	it('coalesces concurrent Editor + Minimap mounts into 1 query and 1 Liquid render, and skips no-op onUpdate DOM replacement', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: {
					frontmatter: { priority: 1 },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
			{ path: 'dashboard.md', cache: {} },
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		const querySpy = vi.spyOn(plugin, 'query');
		const renderedByEl = new Map<unknown, string[]>();
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown, el) => {
				const list = renderedByEl.get(el) ?? [];
				list.push(markdown);
				renderedByEl.set(el, list);
			});

		const children: MarkdownRenderChild[] = [];
		const makeCtx = () =>
			({
				sourcePath: 'dashboard.md',
				addChild: (c: MarkdownRenderChild) => children.push(c),
			}) as unknown as MarkdownPostProcessorContext;

		const elEditor = { empty: () => {} } as unknown as HTMLElement;
		const elMinimap = { empty: () => {} } as unknown as HTMLElement;
		const source = '{% query tasks %}#task{% endquery %}Count={{ query.tasks.size }}';

		// Mount Editor and Minimap concurrently on the exact same tick
		await Promise.all([
			processRhizomeCodeBlock(source, elEditor, makeCtx(), plugin),
			processRhizomeCodeBlock(source, elMinimap, makeCtx(), plugin),
		]);

		expect(querySpy).toHaveBeenCalledTimes(1);
		expect(renderedByEl.get(elEditor)).toEqual(['Count=1']);
		expect(renderedByEl.get(elMinimap)).toEqual(['Count=1']);
		expect(plugin.activeQueryRoster.size).toBe(2);

		// Property `priority` changes (altering payloadHash so onUpdate runs),
		// but rendered Markdown (`Count=1`) is byte-for-byte identical -> skips MarkdownRenderer.render!
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: {
					frontmatter: { priority: 2 },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
			{ path: 'dashboard.md', cache: {} },
		]);
		await plugin.activeQueryRoster.nudge();
		expect(renderedByEl.get(elEditor)).toEqual(['Count=1']);
		expect(renderedByEl.get(elMinimap)).toEqual(['Count=1']);

		// Adding a second #task note changes rendered Markdown (`Count=2`) -> both containers update!
		harness.setNotes([
			{
				path: 'notes/alpha.md',
				cache: {
					frontmatter: { priority: 2 },
					tags: [{ tag: '#task', position: {} as never }],
				},
			},
			{
				path: 'notes/beta.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{ path: 'dashboard.md', cache: {} },
		]);
		await plugin.activeQueryRoster.nudge();
		expect(renderedByEl.get(elEditor)).toEqual(['Count=1', 'Count=2']);
		expect(renderedByEl.get(elMinimap)).toEqual(['Count=1', 'Count=2']);

		for (const c of children) c.unload();
		renderSpy.mockRestore();
	});

	it('short-circuits quarantined codeblocks with a [!danger] callout + Retry button, caches 3.25 MiB failures on remount, clears sentinels post-paint, and resets on rebuildIndex', async () => {
		const harness = createMutableVaultApp([
			{
				path: 'notes/alpha.md',
				cache: { tags: [{ tag: '#task', position: {} as never }] },
			},
			{ path: 'dashboard.md', cache: {} },
		]);
		const plugin = new RhizomePlugin(harness.app, createMockManifest() as PluginManifest);
		await plugin.onload();

		// Seed an in-memory sentinel store with an orphaned 'running' record from a crashed session
		const sentinelRecords = new Map<string, unknown>();
		const fakeIdb = {
			open: () => {
				const req: Record<string, unknown> = { result: null, onsuccess: null };
				queueMicrotask(() => {
					req.result = {
						objectStoreNames: { contains: () => true },
						deleteObjectStore: () => {},
						createObjectStore: () => ({}),
						transaction: () => {
							const tx: Record<string, unknown> = { oncomplete: null };
							tx['objectStore'] = () => ({
								getAll: () => {
									const g: Record<string, unknown> = {
										result: [...sentinelRecords.values()],
										onsuccess: null,
									};
									queueMicrotask(() =>
										(g['onsuccess'] as (() => void) | null)?.(),
									);
									return g;
								},
								put: (rec: { hash: string }) => {
									sentinelRecords.set(rec.hash, { ...rec });
								},
								delete: (k: string) => sentinelRecords.delete(k),
								clear: () => sentinelRecords.clear(),
							});
							queueMicrotask(() => (tx['oncomplete'] as (() => void) | null)?.());
							return tx;
						},
						close: () => {},
					};
					(req['onsuccess'] as (() => void) | null)?.();
				});
				return req as unknown as IDBOpenDBRequest;
			},
			deleteDatabase: () => ({}) as unknown as IDBOpenDBRequest,
		};

		const source = '{% query tasks %}#task{% endquery %}Items={{ query.tasks.size }}';
		const hash = computeCodeBlockSentinelHash('dashboard.md', source, new Map());
		sentinelRecords.set(hash, {
			hash,
			status: 'running',
			sessionId: 'crashed-session',
			records: 19_000,
			outputChars: 1_500_000,
			outputLines: 19_000,
			lastOkDurationMs: null,
			lastOkChars: null,
			lastOkLines: null,
			updatedAt: 1_000,
		});

		plugin.renderSentinelStore = new RenderSentinelStore(harness.app, plugin.loggerAdapter, {
			idbStore: new RenderSentinelIdbStore(
				'rhizome-sentinels-test',
				fakeIdb as unknown as IDBFactory,
			),
			sessionId: 'current-session',
		});
		await plugin.renderSentinelStore.hydrate();
		expect(plugin.renderSentinelStore.getQuarantined(hash)).toBeDefined();

		const renderedMarkdowns: string[] = [];
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, markdown) => {
				renderedMarkdowns.push(markdown);
			});
		const querySpy = vi.spyOn(plugin, 'query');

		// Mock container element supporting Obsidian's createDiv / createEl so the Retry button mounts
		const listeners = new Map<string, (evt: Event) => void>();
		const mockButton = {
			addEventListener: (type: string, fn: (evt: Event) => void) => {
				listeners.set(type, fn);
			},
			removeEventListener: (type: string) => {
				listeners.delete(type);
			},
		};
		const el = {
			empty: () => {
				listeners.clear();
			},
			createDiv: () => ({
				createEl: () => mockButton,
			}),
		} as unknown as HTMLElement;

		const children: MarkdownRenderChild[] = [];
		const ctx = {
			sourcePath: 'dashboard.md',
			addChild: (c: MarkdownRenderChild) => children.push(c),
		} as unknown as MarkdownPostProcessorContext;

		// 1. Quarantined mount renders [!danger] callout + Retry button with 0 plugin.query calls
		await processRhizomeCodeBlock(source, el, ctx, plugin);
		expect(querySpy).not.toHaveBeenCalled();
		expect(renderedMarkdowns).toHaveLength(1);
		expect(renderedMarkdowns[0]).toContain('[!danger]');
		expect(renderedMarkdowns[0]).toContain('19,000 records');
		expect(renderedMarkdowns[0]).toContain('19,000 lines');
		expect(renderedMarkdowns[0]).toContain('1.4 MB');
		expect(renderedMarkdowns[0]).toContain(
			'remove language identifiers (such as `json`) from fenced codeblocks',
		);
		expect(listeners.has('mousedown')).toBe(true);
		expect(listeners.has('click')).toBe(true);

		// 2. Clicking Retry stops propagation, promotes sentinel to 'probation', and re-renders live!
		let stopped = 0;
		const makeEvt = () =>
			({
				preventDefault: () => {},
				stopPropagation: () => {
					stopped++;
				},
			}) as unknown as Event;
		listeners.get('mousedown')!(makeEvt());
		listeners.get('click')!(makeEvt());
		expect(stopped).toBe(2);

		await new Promise((r) => window.setTimeout(r, 20));
		expect(querySpy).toHaveBeenCalledTimes(1);
		expect(renderedMarkdowns[renderedMarkdowns.length - 1]).toBe('Items=1');

		// 3. Re-quarantine and verify rebuildIndex() clears sentinels and resets open blocks
		sentinelRecords.set(hash, {
			hash,
			status: 'quarantined',
			sessionId: 'current-session',
			records: 19_000,
			outputChars: 1_500_000,
			outputLines: 19_000,
			lastOkDurationMs: null,
			lastOkChars: null,
			lastOkLines: null,
			updatedAt: 2_000,
		});
		plugin.renderSentinelStore = new RenderSentinelStore(harness.app, plugin.loggerAdapter, {
			idbStore: new RenderSentinelIdbStore(
				'rhizome-sentinels-test',
				fakeIdb as unknown as IDBFactory,
			),
			sessionId: 'session-after-quarantine',
		});
		await plugin.renderSentinelStore.hydrate();
		expect(plugin.renderSentinelStore.getQuarantined(hash)).toBeDefined();
		await plugin.rebuildIndex();
		await new Promise((r) => window.setTimeout(r, 20));
		expect(plugin.renderSentinelStore.getQuarantined(hash)).toBeUndefined();

		// 4. Verify 3.25 MiB TEMPLATE_RENDER_ERROR is cached across Live Preview remounts
		const runawaySource = [
			'{% query tasks %}#task{% endquery %}',
			'{% assign big = "x" | append: "x" %}{% for i in (1..22) %}{% assign big = big | append: big %}{% endfor %}{{ big }}',
		].join('\n');
		querySpy.mockClear();
		renderedMarkdowns.length = 0;
		const elRunaway1 = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(runawaySource, elRunaway1, ctx, plugin);
		expect(querySpy).toHaveBeenCalledTimes(1);
		expect(renderedMarkdowns[0]).toContain('TEMPLATE_RENDER_ERROR');
		expect(renderedMarkdowns[0]).toContain('3.25 MiB');

		children[children.length - 1]?.unload();
		const elRunaway2 = { empty: () => {} } as unknown as HTMLElement;
		await processRhizomeCodeBlock(runawaySource, elRunaway2, ctx, plugin);
		// Remount hits CodeBlockRenderCache without re-running plugin.query or LiquidJS!
		expect(querySpy).toHaveBeenCalledTimes(1);
		expect(renderedMarkdowns[1]).toBe(renderedMarkdowns[0]);

		// 5. Verify post-paint sentinel lifecycle holds 'running' across MarkdownRenderer.render until rAF -> setTimeout(0)
		let pendingRaf: FrameRequestCallback | null = null;
		const win = window as unknown as {
			requestAnimationFrame?: (cb: FrameRequestCallback) => number;
		};
		const prevRaf = win.requestAnimationFrame;
		win.requestAnimationFrame = (cb: FrameRequestCallback) => {
			pendingRaf = cb;
			return 1;
		};
		try {
			const heavySource =
				'{% query tasks %}#task{% endquery %}{% assign s = "abcdefghij" %}{% for i in (1..13) %}{% assign s = s | append: s %}{% endfor %}{{ s }}';
			const heavyHash = computeCodeBlockSentinelHash('dashboard.md', heavySource, new Map());
			const elHeavy = { empty: () => {} } as unknown as HTMLElement;
			await processRhizomeCodeBlock(heavySource, elHeavy, ctx, plugin);

			// Immediately after MarkdownRenderer.render resolves (before rAF fires), sentinel is STILL 'running'!
			expect(plugin.renderSentinelStore.getRecord(heavyHash)?.status).toBe('running');
			expect(pendingRaf).toBeTypeOf('function');

			// Fire rAF + trailing macrotask -> sentinel transitions to 'ok' with lastOk stats!
			pendingRaf!(16);
			await new Promise((r) => window.setTimeout(r, 15));
			const completed = plugin.renderSentinelStore.getRecord(heavyHash);
			expect(completed?.status).toBe('ok');
			expect(completed?.lastOkChars).toBe(81_920);

			// 6. Hidden popout ownerDocument cleans up 'running' via ownerWin.setTimeout without stalling on rAF
			let popoutRafCalled = false;
			const popoutWin = {
				document: { visibilityState: 'hidden' },
				requestAnimationFrame: () => {
					popoutRafCalled = true;
					return 1;
				},
				setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
			};
			const elHiddenPopout = {
				empty: () => {},
				ownerDocument: { defaultView: popoutWin },
			} as unknown as HTMLElement;
			const ctxPopout = {
				sourcePath: 'popout.md',
				addChild: (c: MarkdownRenderChild) => children.push(c),
			} as unknown as MarkdownPostProcessorContext;
			const popoutHash = computeCodeBlockSentinelHash('popout.md', heavySource, new Map());
			await processRhizomeCodeBlock(heavySource, elHiddenPopout, ctxPopout, plugin);
			await new Promise((r) => window.setTimeout(r, 15));
			expect(popoutRafCalled).toBe(false);
			expect(plugin.renderSentinelStore.getRecord(popoutHash)?.status).toBe('ok');

			// 7. If MarkdownRenderer.render rejects after markRunning, catch cleans up activeRuns and sentinel
			renderSpy.mockRejectedValueOnce(new Error('Renderer boom'));
			const rejectHash = computeCodeBlockSentinelHash('reject.md', heavySource, new Map());
			const ctxReject = {
				sourcePath: 'reject.md',
				addChild: (c: MarkdownRenderChild) => children.push(c),
			} as unknown as MarkdownPostProcessorContext;
			await expect(
				processRhizomeCodeBlock(
					heavySource,
					{ empty: () => {} } as unknown as HTMLElement,
					ctxReject,
					plugin,
				),
			).rejects.toThrow('Renderer boom');
			await new Promise((r) => window.setTimeout(r, 15));
			expect(plugin.renderSentinelStore.getRecord(rejectHash)).toBeUndefined();
		} finally {
			if (prevRaf === undefined) {
				delete win.requestAnimationFrame;
			} else {
				win.requestAnimationFrame = prevRaf;
			}
		}

		for (const c of children) c.unload();
		renderSpy.mockRestore();
	});

	it('hashVaultQueryMatch differentiates links by property attribution vs prose null', () => {
		const baseMatch = {
			file: {
				path: 'notes/a.md',
				name: 'a.md',
				basename: 'a',
				extension: 'md',
				parent: 'notes',
				created: '2026-01-01T00:00',
				modified: '2026-01-01T00:00',
				size: 42,
			},
			aliases: [],
			aliasLocations: [],
			tags: [],
			tagLocations: [],
			cssclasses: [],
			headings: [],
			links: [
				{
					link: 'Target',
					rawTarget: 'Target',
					resolvedPath: 'notes/Target.md',
					subpath: '',
					displayText: 'Target',
					source: 'inline' as const,
					property: null as string | null,
					origin: '[[notes/a.md|a]]',
				},
			],
			embeds: [],
			blocks: [],
			tasks: [],
			propertyKeys: [],
			properties: Object.create(null) as Record<string, unknown>,
			propertyLocations: [],
			diagnostics: [],
			backlinks: [],
		};

		const upMatch = {
			...baseMatch,
			links: [{ ...baseMatch.links[0]!, property: 'up' }],
		};
		const relatedMatch = {
			...baseMatch,
			links: [{ ...baseMatch.links[0]!, property: 'related' }],
		};

		const hProse = hashVaultQueryMatch(baseMatch);
		const hUp = hashVaultQueryMatch(upMatch);
		const hRelated = hashVaultQueryMatch(relatedMatch);

		expect(hProse).not.toBe(hUp);
		expect(hUp).not.toBe(hRelated);
		expect(hProse).not.toBe(hRelated);
	});

	it('deduplicates identical @query.<name> pipelines across subscribers while isolating distinct @this host contexts transitively', async () => {
		const notes = new Map<
			string,
			{
				file: {
					path: string;
					name: string;
					basename: string;
					extension: string;
					parent: { path: string };
					stat: { ctime: number; mtime: number; size: number };
				};
				cache: Record<string, unknown>;
			}
		>();
		const addNote = (
			path: string,
			fm: Record<string, unknown>,
			fmLinks: Array<{ link: string; key: string }> = [],
		) => {
			const slash = path.lastIndexOf('/');
			const name = path.slice(slash + 1);
			const basename = name.replace(/\.md$/, '');
			notes.set(path, {
				file: {
					path,
					name,
					basename,
					extension: 'md',
					parent: { path: path.slice(0, slash) },
					stat: { ctime: 1700000000000, mtime: 1700000000000, size: 100 },
				},
				cache: { frontmatter: fm, frontmatterLinks: fmLinks },
			});
		};

		addNote('Goals/Alpha.md', { tags: ['goal'] });
		addNote('Goals/Beta.md', { tags: ['goal'] });
		addNote('Projects/P1.md', { tags: ['project'], up: '[[Alpha]]' }, [
			{ link: 'Alpha', key: 'up' },
		]);
		addNote('Projects/P2.md', { tags: ['project'], up: '[[Beta]]' }, [
			{ link: 'Beta', key: 'up' },
		]);
		addNote('Tasks/T1.md', { tags: ['task'], up: '[[P1]]' }, [{ link: 'P1', key: 'up' }]);
		addNote('Tasks/T2.md', { tags: ['task'], up: '[[P2]]' }, [{ link: 'P2', key: 'up' }]);

		const mockApp = {
			vault: {
				configDir: 'mock-config',
				adapter: { read: vi.fn(async () => '{"types":{}}') },
				getMarkdownFiles: () => Array.from(notes.values()).map((n) => n.file),
				getFileByPath: (p: string) => notes.get(p)?.file ?? null,
			},
			metadataCache: {
				getFileCache: (f: { path: string }) => notes.get(f.path)?.cache ?? null,
				getFirstLinkpathDest: (raw: string) => {
					for (const n of notes.values()) {
						if (n.file.basename === raw || n.file.path === raw) return n.file;
					}
					return null;
				},
			},
		} as never;

		const roster = new ActiveQueryRoster(mockApp);
		const alphaUpdates: VaultQueryResult[] = [];
		const betaUpdates: VaultQueryResult[] = [];
		const sharedUpdates1: VaultQueryResult[] = [];
		const sharedUpdates2: VaultQueryResult[] = [];

		// Notice `leaf_tasks` does NOT mention `@this` directly; it depends on `@query.projs`, which uses `@this`!
		const hostPipeline = {
			projs: '[up -> @this]',
			leaf_tasks: '[up -> @query.projs]',
		};
		const sharedPipelineA = {
			g: '#goal',
			all_projs: '[up -> @query.g]',
		};
		const sharedPipelineB = {
			roots: '#goal',
			all_projs: '[up -> @query.roots]',
		};

		roster.register(
			hostPipeline,
			{ timeZone: 'UTC', sourcePath: 'Goals/Alpha.md' },
			{},
			(r) => {
				alphaUpdates.push(r);
			},
		);
		roster.register(hostPipeline, { timeZone: 'UTC', sourcePath: 'Goals/Beta.md' }, {}, (r) => {
			betaUpdates.push(r);
		});
		roster.register(sharedPipelineA, { timeZone: 'UTC' }, {}, (r) => {
			sharedUpdates1.push(r);
		});
		roster.register(sharedPipelineB, { timeZone: 'UTC' }, {}, (r) => {
			sharedUpdates2.push(r);
		});

		await roster.nudge(1700000000000);

		expect(alphaUpdates[0]?.projs?.map((m) => m.file.path)).toEqual(['Projects/P1.md']);
		expect(alphaUpdates[0]?.leaf_tasks?.map((m) => m.file.path)).toEqual(['Tasks/T1.md']);

		expect(betaUpdates[0]?.projs?.map((m) => m.file.path)).toEqual(['Projects/P2.md']);
		expect(betaUpdates[0]?.leaf_tasks?.map((m) => m.file.path)).toEqual(['Tasks/T2.md']);

		expect(sharedUpdates1[0]?.all_projs?.map((m) => m.file.path)).toEqual([
			'Projects/P1.md',
			'Projects/P2.md',
		]);
		expect(sharedUpdates2[0]?.all_projs?.map((m) => m.file.path)).toEqual([
			'Projects/P1.md',
			'Projects/P2.md',
		]);

		// Verify authored query names and suggestions in diagnostic logs (no __q*, __cyc_*, or __missing_* leakage)
		const loggedMessages: string[] = [];
		const rosterWithLogger = new ActiveQueryRoster(mockApp, {
			log: (_level, message, meta) => {
				loggedMessages.push(`${message} ${JSON.stringify(meta ?? {})}`);
			},
		});
		rosterWithLogger.register(
			{
				active_tasks: '#task',
				typo_ref: '[up -> @query.actve_tasks]',
				alpha: 'links -> @query.beta',
				beta: 'links -> @query.alpha',
			},
			{ timeZone: 'UTC' },
			{},
			() => {},
		);
		await rosterWithLogger.nudge(1700000000000);
		const joinedLogs = loggedMessages.join('\n');
		expect(joinedLogs).toContain('‼️typo_ref‼️');
		expect(joinedLogs).toContain('[up -> @query.actve_tasks]');
		expect(joinedLogs).toContain('ERROR_UNKNOWN_QUERY_REF');
		expect(joinedLogs).toContain('‼️alpha‼️');
		expect(joinedLogs).toContain('links -> @query.beta');
		expect(joinedLogs).toContain('ERROR_CIRCULAR_QUERY_REF');
		expect(joinedLogs).not.toContain('__missing_');
		expect(joinedLogs).not.toContain('__cyc_');
	});
});
