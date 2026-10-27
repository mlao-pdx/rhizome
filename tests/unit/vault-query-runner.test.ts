import type { App, CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import {
	diagnoseVaultQuery,
	parseObsidianTypesJson,
	runVaultQuery,
} from '../../src/adapters/vault-query-runner';

interface MockNoteSpec {
	path: string;
	ctime?: number;
	mtime?: number;
	size?: number;
	deleted?: boolean;
	cache?: Partial<CachedMetadata> | null;
}

interface MockFileEntry {
	path: string;
	name: string;
	basename: string;
	extension: string;
	parent: { path: string };
	deleted?: boolean;
	stat: {
		ctime: number;
		mtime: number;
		size: number;
	};
}

function makeMockFileEntry(spec: MockNoteSpec): MockFileEntry {
	const slashIdx = spec.path.lastIndexOf('/');
	const name = slashIdx === -1 ? spec.path : spec.path.slice(slashIdx + 1);
	const parentPath = slashIdx === -1 ? '/' : spec.path.slice(0, slashIdx);
	const dotIdx = name.lastIndexOf('.');
	const basename = dotIdx === -1 ? name : name.slice(0, dotIdx);
	const extension = dotIdx === -1 ? '' : name.slice(dotIdx + 1);

	return {
		path: spec.path,
		name,
		basename,
		extension,
		parent: { path: parentPath },
		...(spec.deleted !== undefined ? { deleted: spec.deleted } : {}),
		stat: {
			ctime: spec.ctime ?? 1700000000000,
			mtime: spec.mtime ?? 1700000000000,
			size: spec.size ?? 100,
		},
	};
}

function makeMockApp(options: {
	notes?: MockNoteSpec[];
	typesJson?: string | Error;
	linkMap?: Record<string, string>;
	onGetMarkdownFiles?: () => void;
	onGetFileCache?: (file: { path: string }) => void;
}): App {
	const notes = options.notes ?? [];
	const files = notes.map(makeMockFileEntry);
	const cacheByPath = new Map<string, Partial<CachedMetadata> | null>();
	for (const spec of notes) {
		cacheByPath.set(spec.path, spec.cache ?? null);
	}
	const configDir = 'mock-config';

	return {
		vault: {
			configDir,
			adapter: {
				read: vi.fn(async (path: string) => {
					if (path === `${configDir}/types.json`) {
						if (options.typesJson instanceof Error) {
							throw options.typesJson;
						}
						if (typeof options.typesJson === 'string') {
							return options.typesJson;
						}
					}
					throw new Error(`ENOENT: ${path}`);
				}),
			},
			getMarkdownFiles: () => {
				options.onGetMarkdownFiles?.();
				return files;
			},
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				options.onGetFileCache?.(file);
				return cacheByPath.get(file.path) ?? null;
			},
			getFirstLinkpathDest: (linkpath: string, _sourcePath: string) => {
				const resolved = options.linkMap?.[linkpath];
				return resolved ? { path: resolved } : null;
			},
		},
	} as unknown as App;
}

describe('parseObsidianTypesJson', () => {
	it('parses valid property types and normalizes keys to lowercase', () => {
		const raw = JSON.stringify({
			types: {
				Due_Date: 'date',
				Priority: 'number',
				Done: 'checkbox',
				Summary: 'text',
				Authors: 'multitext',
				Updated: 'datetime',
			},
		});

		expect(parseObsidianTypesJson(raw)).toEqual({
			due_date: 'date',
			priority: 'number',
			done: 'checkbox',
			summary: 'text',
			authors: 'multitext',
			updated: 'datetime',
		});
	});

	it('strips built-in alias/aliases/tag/tags and unknown widget types', () => {
		const raw = JSON.stringify({
			types: {
				aliases: 'aliases',
				alias: 'aliases',
				tags: 'tags',
				tag: 'tags',
				rating: 'number',
				customWidget: 'canvas-color',
				badNumber: 123,
			},
		});

		expect(parseObsidianTypesJson(raw)).toEqual({
			rating: 'number',
		});
	});

	it('deduplicates case-colliding keys deterministically (first-seen wins)', () => {
		const raw = '{"types":{"Status":"text","status":"number","STATUS":"date"}}';
		expect(parseObsidianTypesJson(raw)).toEqual({
			status: 'text',
		});
	});

	it('returns an empty registry on malformed JSON or non-object payloads', () => {
		expect(parseObsidianTypesJson('{bad json')).toEqual({});
		expect(parseObsidianTypesJson('null')).toEqual({});
		expect(parseObsidianTypesJson('[]')).toEqual({});
		expect(parseObsidianTypesJson('{"types": []}')).toEqual({});
	});
});

describe('diagnoseVaultQuery', () => {
	it('evaluates queries across frontmatter, tags, links, and types.json definitions', async () => {
		const app = makeMockApp({
			typesJson: JSON.stringify({
				types: {
					aliases: 'aliases',
					tags: 'tags',
					priority: 'number',
					due: 'date',
					done: 'checkbox',
				},
			}),
			linkMap: {
				Roadmap: 'projects/roadmap.md',
			},
			notes: [
				{
					path: 'tasks/task-1.md',
					cache: {
						frontmatter: {
							priority: 1,
							due: '2026-10-20',
							done: false,
						},
						tags: [{ tag: '#work', position: {} as never }],
						links: [
							{
								link: 'Roadmap#Q4',
								original: '[[Roadmap#Q4]]',
								position: {} as never,
							},
						],
					},
				},
				{
					path: 'tasks/task-2.md',
					cache: {
						frontmatter: {
							priority: 5,
							due: '2026-11-15',
							done: true,
						},
						tags: [{ tag: '#work', position: {} as never }],
					},
				},
			],
		});

		const res = await diagnoseVaultQuery(
			app,
			'#work [priority < 3] [due <= 2026-10-25] [done = false] link:"projects/roadmap.md"',
			{ timeZone: 'UTC' },
		);

		expect(res.executable).toBe(true);
		expect(res.paths).toEqual(['tasks/task-1.md']);
		expect(res.matches).toHaveLength(1);
		expect(res.matches[0]?.links[0]?.resolvedPath).toBe('projects/roadmap.md');
		expect(res.diagnostics).toEqual([]);
		expect(res.propertyDiagnostics).toEqual([]);
	});

	it('falls back gracefully when types.json does not exist in configDir', async () => {
		const app = makeMockApp({
			notes: [
				{
					path: 'inbox/idea.md',
					cache: {
						frontmatter: { category: 'research' },
					},
				},
			],
		});

		const res = await diagnoseVaultQuery(app, '[category: research]');
		expect(res.executable).toBe(true);
		expect(res.paths).toEqual(['inbox/idea.md']);
	});

	it('short-circuits before scanning the vault when query compilation fails', async () => {
		const getMarkdownFilesSpy = vi.fn(() => []);
		const app = makeMockApp({
			typesJson: JSON.stringify({ types: { priority: 'number' } }),
		});
		app.vault.getMarkdownFiles = getMarkdownFilesSpy;

		const res = await diagnoseVaultQuery(app, '[priority = "not-a-number"]');
		expect(res.executable).toBe(false);
		expect(res.paths).toEqual([]);
		expect(res.matches).toEqual([]);
		expect(res.diagnostics.length).toBeGreaterThan(0);
		expect(res.diagnostics[0]?.severity).toBe('error');
		expect(getMarkdownFilesSpy).not.toHaveBeenCalled();
	});

	it('surfaces propertyDiagnostics when a queried property has an invalid value on a note', async () => {
		const app = makeMockApp({
			typesJson: JSON.stringify({ types: { priority: 'number' } }),
			notes: [
				{
					path: 'notes/valid.md',
					cache: { frontmatter: { priority: 2 } },
				},
				{
					path: 'notes/broken.md',
					cache: { frontmatter: { priority: 'urgent' } },
				},
			],
		});

		const res = await diagnoseVaultQuery(app, '[priority > 1]');
		expect(res.executable).toBe(true);
		expect(res.paths).toEqual(['notes/valid.md']);
		expect(res.propertyDiagnostics).toHaveLength(1);
		expect(res.propertyDiagnostics[0]).toMatchObject({
			code: 'DOC_INVALID_PROPERTY_VALUE',
			filePath: 'notes/broken.md',
			propertyKey: 'priority',
			rawValue: 'urgent',
			expectedType: 'number',
		});
	});

	it('supports VaultQueryOptions overrides (propertyTypes, timeZone, referenceTimeMs)', async () => {
		const app = makeMockApp({
			typesJson: JSON.stringify({ types: { due: 'text' } }),
			notes: [
				{
					path: 'journal/today.md',
					cache: { frontmatter: { due: '2026-10-25' } },
				},
			],
		});

		const referenceTimeMs = Date.UTC(2026, 9, 25, 12, 0, 0);
		const res = await diagnoseVaultQuery(app, '[due = @today]', {
			timeZone: 'UTC',
			propertyTypes: { due: 'date' },
			referenceTimeMs,
		});

		expect(res.executable).toBe(true);
		expect(res.paths).toEqual(['journal/today.md']);
	});

	it('returns config diagnostics when an invalid timeZone override is passed', async () => {
		const app = makeMockApp({});
		const res = await diagnoseVaultQuery(app, 'note', {
			timeZone: 'Invalid/Time_Zone_Name',
		});

		expect(res.executable).toBe(false);
		expect(res.paths).toEqual([]);
		expect(res.diagnostics[0]?.code).toBe('ERROR_INVALID_CONFIG');
	});
});

describe('runVaultQuery', () => {
	it('evaluates multiple named queries in a single pass and shares === match references across queries', async () => {
		const getMarkdownFilesSpy = vi.fn();
		const getFileCacheSpy = vi.fn();
		const app = makeMockApp({
			typesJson: JSON.stringify({
				types: {
					aliases: 'aliases',
					tags: 'tags',
					priority: 'number',
					due: 'date',
					done: 'checkbox',
				},
			}),
			linkMap: {
				Roadmap: 'projects/roadmap.md',
			},
			notes: [
				{
					path: 'tasks/task-1.md',
					cache: {
						frontmatter: {
							priority: 1,
							due: '2026-10-20',
							done: false,
						},
						tags: [{ tag: '#work', position: {} as never }],
						links: [
							{
								link: 'Roadmap#Q4',
								original: '[[Roadmap#Q4]]',
								position: {} as never,
							},
						],
					},
				},
				{
					path: 'tasks/task-2.md',
					cache: {
						frontmatter: {
							priority: 5,
							due: '2026-11-15',
							done: true,
						},
						tags: [{ tag: '#work', position: {} as never }],
					},
				},
			],
			onGetMarkdownFiles: getMarkdownFilesSpy,
			onGetFileCache: getFileCacheSpy,
		});

		const referenceTimeMs = Date.UTC(2026, 9, 25, 12, 0, 0);
		const res = await runVaultQuery(
			app,
			{
				urgentRoadmap:
					'#work [priority < 3] [due <= 2026-10-25] [done = false] link:"projects/roadmap.md"',
				allWork: '#work',
			},
			{ timeZone: 'UTC', referenceTimeMs },
		);

		expect(getMarkdownFilesSpy).toHaveBeenCalledTimes(1);
		expect(getFileCacheSpy).toHaveBeenCalledTimes(2);

		expect(res.context).toEqual({
			timeZone: 'UTC',
			referenceTimeMs,
			propertyTypes: {
				priority: 'number',
				due: 'date',
				done: 'checkbox',
			},
			normalizationFingerprint: JSON.stringify({
				tz: 'UTC',
				types: [
					['done', 'checkbox'],
					['due', 'date'],
					['priority', 'number'],
				],
			}),
		});
		expect(Object.isFrozen(res.context)).toBe(true);
		expect(Object.isFrozen(res.context.propertyTypes)).toBe(true);
		expect(res.diagnostics).toEqual({
			executable: true,
			findings: [],
			queries: {
				urgentRoadmap: { executable: true, findings: [] },
				allWork: { executable: true, findings: [] },
			},
		});
		expect(Object.keys(res.matches)).toEqual(['urgentRoadmap', 'allWork']);
		expect(res.matches['urgentRoadmap']).toHaveLength(1);
		expect(res.matches['allWork']).toHaveLength(2);

		const match = res.matches['urgentRoadmap']![0]!;
		expect(match).toBe(res.matches['allWork']![0]);
		expect(match.file.path).toBe('tasks/task-1.md');
		expect(match.links[0]?.resolvedPath).toBe('projects/roadmap.md');
		expect(match.links[0]?.origin).toBe('[[tasks/task-1.md|task-1]]');
		expect(match.tagLocations).toEqual([
			{
				tag: 'work',
				source: 'body',
				origin: '[[tasks/task-1.md|task-1]]',
			},
		]);
		expect(Object.keys(match)).toEqual([
			'file',
			'aliases',
			'tags',
			'tagLocations',
			'headings',
			'links',
			'embeds',
			'blocks',
			'properties',
		]);
		expect('normalizationFingerprint' in match).toBe(false);
		expect('propertyOccurrences' in match).toBe(false);
		expect('propertyKeys' in match).toBe(false);
		expect('diagnostics' in match).toBe(false);
		expect(Object.isFrozen(match)).toBe(false);
		expect(Object.isFrozen(match.file)).toBe(false);
		expect('paths' in res).toBe(false);
		expect('propertyDiagnostics' in res).toBe(false);
	});

	it('executes valid queries and omits failed queries from matches when a batch has partial failures', async () => {
		const app = makeMockApp({
			typesJson: JSON.stringify({ types: { priority: 'number' } }),
			notes: [
				{
					path: 'tasks/task-1.md',
					cache: { frontmatter: { priority: 1 } },
				},
			],
		});

		const res = await runVaultQuery(
			app,
			{
				validQuery: '[priority < 3]',
				brokenQuery: '[priority = "not-a-number"]',
			},
			{ timeZone: 'UTC', referenceTimeMs: 1700000000000 },
		);

		expect(res.diagnostics.executable).toBe(false);
		expect(res.diagnostics.findings).toEqual([]);
		expect(res.diagnostics.queries['validQuery']).toEqual({
			executable: true,
			findings: [],
		});
		expect(res.diagnostics.queries['brokenQuery']?.executable).toBe(false);
		expect(res.diagnostics.queries['brokenQuery']?.findings.length).toBeGreaterThan(0);
		expect(Object.keys(res.matches)).toEqual(['validQuery']);
		expect('brokenQuery' in res.matches).toBe(false);
		expect(res.matches['validQuery']?.map((m) => m.file.path)).toEqual(['tasks/task-1.md']);
	});

	it('skips files marked deleted: true in both runVaultQuery and diagnoseVaultQuery', async () => {
		const app = makeMockApp({
			notes: [
				{
					path: 'notes/active.md',
					cache: { frontmatter: { status: 'active' } },
				},
				{
					path: 'notes/deleted.md',
					deleted: true,
					cache: { frontmatter: { status: 'active' } },
				},
			],
		});

		const runRes = await runVaultQuery(
			app,
			{ active: '[status: active]' },
			{ timeZone: 'UTC' },
		);
		expect(runRes.matches['active']?.map((m) => m.file.path)).toEqual(['notes/active.md']);

		const diagRes = await diagnoseVaultQuery(app, '[status: active]', { timeZone: 'UTC' });
		expect(diagRes.paths).toEqual(['notes/active.md']);
		expect(diagRes.matches.map((d) => d.file.path)).toEqual(['notes/active.md']);
	});

	it('overrides types.json entries case-insensitively via options.propertyTypes', async () => {
		const app = makeMockApp({
			typesJson: JSON.stringify({ types: { due: 'text' } }),
			notes: [
				{
					path: 'journal/today.md',
					cache: { frontmatter: { due: '2026-10-25' } },
				},
			],
		});

		const referenceTimeMs = Date.UTC(2026, 9, 25, 12, 0, 0);
		const res = await runVaultQuery(
			app,
			{ today: '[due = @today]' },
			{
				timeZone: 'UTC',
				propertyTypes: { Due: 'date' },
				referenceTimeMs,
			},
		);

		expect(res.diagnostics.executable).toBe(true);
		expect(res.context.propertyTypes).toEqual({ due: 'date' });
		expect(res.matches['today']?.map((doc) => doc.file.path)).toEqual(['journal/today.md']);
	});

	it('short-circuits before scanning the vault when all queries fail or an empty query map is passed', async () => {
		const getMarkdownFilesSpy = vi.fn(() => []);
		const app = makeMockApp({
			typesJson: JSON.stringify({ types: { priority: 'number' } }),
		});
		app.vault.getMarkdownFiles = getMarkdownFilesSpy;

		const emptyRes = await runVaultQuery(
			app,
			{},
			{
				timeZone: 'UTC',
				referenceTimeMs: 1700000000000,
			},
		);
		expect(emptyRes.diagnostics).toEqual({
			executable: true,
			findings: [],
			queries: {},
		});
		expect(emptyRes.matches).toEqual({});
		expect(getMarkdownFilesSpy).not.toHaveBeenCalled();

		const failedRes = await runVaultQuery(
			app,
			{ bad: '[priority = "not-a-number"]' },
			{
				timeZone: 'UTC',
				referenceTimeMs: 1700000000000,
			},
		);

		expect(failedRes.diagnostics.executable).toBe(false);
		expect(failedRes.diagnostics.findings).toEqual([]);
		expect(failedRes.diagnostics.queries['bad']?.executable).toBe(false);
		expect(failedRes.diagnostics.queries['bad']?.findings[0]?.severity).toBe('error');
		expect(failedRes.matches).toEqual({});
		expect(failedRes.context).toEqual({
			timeZone: 'UTC',
			referenceTimeMs: 1700000000000,
			propertyTypes: { priority: 'number' },
			normalizationFingerprint: JSON.stringify({
				tz: 'UTC',
				types: [['priority', 'number']],
			}),
		});
		expect(getMarkdownFilesSpy).not.toHaveBeenCalled();
	});

	it('returns frozen JSON-safe fallback context when config or referenceTimeMs is invalid', async () => {
		const app = makeMockApp({
			typesJson: JSON.stringify({ types: { priority: 'number' } }),
		});

		const badConfigRes = await runVaultQuery(
			app,
			{ q1: 'note' },
			{
				timeZone: 'Invalid/Time_Zone_Name',
				referenceTimeMs: Number.NaN,
			},
		);

		expect(badConfigRes.diagnostics.executable).toBe(false);
		expect(badConfigRes.diagnostics.findings[0]?.code).toBe('ERROR_INVALID_CONFIG');
		expect(badConfigRes.diagnostics.queries).toEqual({
			q1: { executable: false, findings: [] },
		});
		expect(badConfigRes.matches).toEqual({});
		expect(badConfigRes.context).toEqual({
			timeZone: 'Invalid/Time_Zone_Name',
			referenceTimeMs: null,
			propertyTypes: { priority: 'number' },
			normalizationFingerprint: null,
		});
		expect(Object.isFrozen(badConfigRes.context)).toBe(true);
		expect(Object.isFrozen(badConfigRes.context.propertyTypes)).toBe(true);
		expect(JSON.parse(JSON.stringify(badConfigRes))).toEqual(badConfigRes);
	});
});
