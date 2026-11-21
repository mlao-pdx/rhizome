import type { App, CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import {
	explainVaultQuery,
	parseObsidianTypesJson,
	runVaultQuery,
} from '../../src/adapters/vault-query-runner';
import type { BacklinkSnapshot } from '../../src/adapters/backlink-index';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import { resolveThisReference, type NormalizedDocument } from '../../src/core/search';

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
					'#work [priority: < 3] [due: <= 2026-10-25] [done: = false] link:"projects/roadmap.md"',
				allWork: '#work',
			},
			{ timeZone: 'UTC', referenceTimeMs },
		);

		expect(getMarkdownFilesSpy).toHaveBeenCalledTimes(1);
		expect(getFileCacheSpy).toHaveBeenCalledTimes(2);

		expect(Object.keys(res)).toEqual(['urgentRoadmap', 'allWork']);
		expect(res['urgentRoadmap']).toHaveLength(1);
		expect(res['allWork']).toHaveLength(2);

		const match = res['urgentRoadmap']![0]!;
		expect(match).toBe(res['allWork']![0]);
		expect(match.file.path).toBe('tasks/task-1.md');
		expect(match.links[0]?.resolvedPath).toBe('projects/roadmap.md');
		expect(match.links[0]?.origin).toBe('[[tasks/task-1.md|task-1]]');
		expect(match.tagLocations).toEqual([
			{
				tag: 'work',
				source: 'inline',
				origin: '[[tasks/task-1.md|task-1]]',
			},
		]);
		expect(Object.keys(match)).toEqual([
			'file',
			'aliases',
			'aliasLocations',
			'tags',
			'tagLocations',
			'cssclasses',
			'headings',
			'links',
			'embeds',
			'blocks',
			'tasks',
			'properties',
			'propertyLocations',
			'backlinks',
		]);
		expect(match.backlinks).toEqual([]);
		expect('normalizationFingerprint' in match).toBe(false);
		expect('propertyOccurrences' in match).toBe(false);
		expect('propertyKeys' in match).toBe(false);
		expect('diagnostics' in match).toBe(false);
		expect(Object.isFrozen(match)).toBe(true);
		expect(Object.isFrozen(match.file)).toBe(true);
		expect('context' in res).toBe(false);
		expect('diagnostics' in res).toBe(false);
		expect('matches' in res).toBe(false);
		expect('paths' in res).toBe(false);
		expect('propertyDiagnostics' in res).toBe(false);
	});

	it('executes valid queries and omits failed queries from the result when a batch has partial failures', async () => {
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
				validQuery: '[priority: < 3]',
				brokenQuery: '[priority: = "not-a-number"]',
			},
			{ timeZone: 'UTC', referenceTimeMs: 1700000000000 },
		);

		expect(Object.keys(res)).toEqual(['validQuery']);
		expect('brokenQuery' in res).toBe(false);
		expect(res['validQuery']?.map((m) => m.file.path)).toEqual(['tasks/task-1.md']);
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

		const res = await runVaultQuery(app, { research: '[category: research]' });
		expect(res['research']?.map((m) => m.file.path)).toEqual(['inbox/idea.md']);
	});

	it('skips files marked deleted: true', async () => {
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
		expect(runRes['active']?.map((m) => m.file.path)).toEqual(['notes/active.md']);
	});

	it('skips notes carrying ◊InternalRhizome code "001"', async () => {
		const app = makeMockApp({
			notes: [
				{
					path: 'notes/user-note.md',
					cache: { frontmatter: { status: 'active' } },
				},
				{
					path: '◊Rhizome/logs/1700000000000.md',
					cache: {
						frontmatter: {
							status: 'active',
							'◊InternalRhizome': {
								'001': 'Do not index or query.',
							},
						},
					},
				},
				{
					path: 'notes/other-internal-code.md',
					cache: {
						frontmatter: {
							status: 'active',
							'◊InternalRhizome': {
								'024': 'The moon is blue, so do not wash the linens.',
							},
						},
					},
				},
			],
		});

		const runRes = await runVaultQuery(
			app,
			{ active: '[status: active]' },
			{ timeZone: 'UTC' },
		);
		expect(runRes['active']?.map((m) => m.file.path)).toEqual([
			'notes/user-note.md',
			'notes/other-internal-code.md',
		]);
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
			{ today: '[due: = @today]' },
			{
				timeZone: 'UTC',
				propertyTypes: { Due: 'date' },
				referenceTimeMs,
			},
		);

		expect(res['today']?.map((doc) => doc.file.path)).toEqual(['journal/today.md']);
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
		expect(emptyRes).toEqual({});
		expect(getMarkdownFilesSpy).not.toHaveBeenCalled();

		const failedRes = await runVaultQuery(
			app,
			{ bad: '[priority: = "not-a-number"]' },
			{
				timeZone: 'UTC',
				referenceTimeMs: 1700000000000,
			},
		);

		expect(failedRes).toEqual({});
		expect(getMarkdownFilesSpy).not.toHaveBeenCalled();
	});

	it('returns an empty JSON-safe object when config or referenceTimeMs is invalid', async () => {
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

		expect(badConfigRes).toEqual({});
		expect(JSON.parse(JSON.stringify(badConfigRes))).toEqual(badConfigRes);
	});

	it('matches backlinks identically on the cached and direct paths', async () => {
		const target = makeMockFileEntry({ path: 'notes/target.md' });
		const source = makeMockFileEntry({ path: 'sources/Origin.md' });
		const otherSource = makeMockFileEntry({ path: 'sources/other-lib.md' });
		const snapshot = new Map([
			[
				target,
				new Map([
					[source, 2],
					[otherSource, 1],
				]),
			],
		]) as unknown as BacklinkSnapshot;

		const app = makeMockApp({});
		(app.vault as unknown as { getMarkdownFiles: () => unknown[] }).getMarkdownFiles = () => [
			target,
		];
		(app.metadataCache as unknown as { getFileCache: () => unknown }).getFileCache = () => ({
			frontmatter: { status: 'active' },
		});

		const cache = new NormalizedDocumentCache(app);
		const queries = {
			byPath: 'backlinks:"sources/origin"',
			byBase: 'backlinks:ORIGIN',
			byCount: 'backlinks:2',
			viaThis: 'backlinks:@this.backlinks.path',
			viaCount: 'backlinks:@this.backlinks.count',
		};
		const shared = {
			timeZone: 'UTC',
			referenceTimeMs: 1_700_000_000_000,
			backlinks: snapshot,
			sourcePath: 'notes/target.md',
		};

		const cached = await runVaultQuery(app, queries, { ...shared, cache });
		const direct = await runVaultQuery(app, queries, shared);
		const paths = (result: typeof cached) =>
			Object.fromEntries(
				Object.entries(result).map(([key, matches]) => [
					key,
					matches.map((match) => match.file.path),
				]),
			);

		expect(paths(cached)).toEqual(paths(direct));
		expect(cached.byPath?.[0]?.file.path).toBe('notes/target.md');
		expect(cached.byBase?.[0]?.file.path).toBe('notes/target.md');
		expect(cached.byCount).toEqual([]);
		expect(cached.viaThis?.[0]?.file.path).toBe('notes/target.md');
		expect(cached.byPath?.[0]?.backlinks).toEqual([
			{ path: 'sources/Origin.md', count: 2 },
			{ path: 'sources/other-lib.md', count: 1 },
		]);
		expect(cached['◊host']?.[0]?.backlinks).toEqual(direct['◊host']?.[0]?.backlinks);
	});

	it('projects backlinks at most once per document while evaluating', async () => {
		const target = makeMockFileEntry({ path: 'notes/target.md' });
		const source = makeMockFileEntry({ path: 'sources/Origin.md' });
		const otherSource = makeMockFileEntry({ path: 'sources/other-lib.md' });
		const snapshot = new Map([
			[
				target,
				new Map([
					[source, 2],
					[otherSource, 1],
				]),
			],
		]) as unknown as BacklinkSnapshot;
		const isIgnoredFile = vi.fn(() => false);

		const app = makeMockApp({});
		(app.vault as unknown as { getMarkdownFiles: () => unknown[] }).getMarkdownFiles = () => [
			target,
		];
		(app.metadataCache as unknown as { getFileCache: () => unknown }).getFileCache = () => ({});

		const result = await runVaultQuery(
			app,
			{
				byPath: 'backlinks:"sources/origin"',
				byBase: 'backlinks:ORIGIN',
			},
			{
				timeZone: 'UTC',
				referenceTimeMs: 1_700_000_000_000,
				backlinks: snapshot,
				cache: new NormalizedDocumentCache(app),
				isIgnoredFile,
			},
		);

		expect(result.byPath?.[0]?.file.path).toBe('notes/target.md');
		expect(result.byBase?.[0]?.file.path).toBe('notes/target.md');
		expect(isIgnoredFile).toHaveBeenCalledTimes(2);
	});

	describe('diagnostic logging', () => {
		function createLoggerSpy() {
			const calls: Array<{
				level: 'debug' | 'warn' | 'error';
				message: string;
				meta: Record<string, unknown>;
			}> = [];
			return {
				calls,
				logger: {
					log(
						level: 'debug' | 'warn' | 'error',
						message: string,
						meta: { readonly source: string; readonly [key: string]: unknown },
					) {
						calls.push({ level, message, meta });
					},
				},
			};
		}

		it('logs warn on malformed types.json and debug on skipped widget/colliding types', async () => {
			const badTypesSpy = createLoggerSpy();
			const badTypesApp = makeMockApp({
				typesJson: '{ not valid json',
			});
			await runVaultQuery(
				badTypesApp,
				{ q: 'note' },
				{ timeZone: 'UTC' },
				badTypesSpy.logger,
			);
			expect(badTypesSpy.calls).toContainEqual({
				level: 'warn',
				message: 'Failed to parse vault property types from ‼️mock-config/types.json‼️',
				meta: { source: 'query.types', reason: 'invalid_json' },
			});

			const filteredSpy = createLoggerSpy();
			const filteredApp = makeMockApp({
				typesJson: JSON.stringify({
					types: {
						Priority: 'number',
						priority: 'text',
						CustomWidget: 'stars',
						aliases: 'aliases',
					},
				}),
			});
			await runVaultQuery(
				filteredApp,
				{ q: 'note' },
				{ timeZone: 'UTC' },
				filteredSpy.logger,
			);
			expect(filteredSpy.calls).toContainEqual({
				level: 'debug',
				message:
					'Filtered unsupported or colliding property types in ‼️mock-config/types.json‼️',
				meta: {
					source: 'query.types',
					count: 1,
					validCount: 1,
					unsupportedCount: 1,
					collisionCount: 1,
				},
			});
		});

		it('logs error when engine configuration fails', async () => {
			const spy = createLoggerSpy();
			const app = makeMockApp({});
			await runVaultQuery(app, { q: 'note' }, { timeZone: 'Not/A_Real_Zone' }, spy.logger);
			expect(spy.calls).toContainEqual({
				level: 'error',
				message: 'Query engine configuration failed',
				meta: {
					source: 'query.config',
					timeZone: '‼️Not/A_Real_Zone‼️',
					codes: ['ERROR_INVALID_CONFIG'],
					count: 1,
				},
			});
		});

		it('logs warn for compilation errors or lint warnings and debug for clean queries with ‼️...‼️ wrapping', async () => {
			const spy = createLoggerSpy();
			const app = makeMockApp({
				typesJson: JSON.stringify({ types: { priority: 'number' } }),
			});
			await runVaultQuery(
				app,
				{
					cleanQuery: '#project',
					warnQuery: 'ext:md AND ext:pdf AND [priority: != 5]',
					brokenQuery: '[priority: = "nan"]',
				},
				{ timeZone: 'UTC' },
				spy.logger,
			);

			expect(spy.calls).toContainEqual({
				level: 'debug',
				message: 'Compiled query ‼️cleanQuery‼️',
				meta: {
					source: 'query.compile',
					count: 0,
					query: '‼️#project‼️',
					executable: true,
					hintCodes: [],
				},
			});
			expect(spy.calls).toContainEqual({
				level: 'warn',
				message: 'Query compilation diagnostics for ‼️warnQuery‼️',
				meta: {
					source: 'query.compile',
					count: 2,
					query: '‼️ext:md AND ext:pdf AND [priority: != 5]‼️',
					executable: true,
					errorCodes: [],
					warningCodes: ['WARN_SINGLE_VALUE_CONTRADICTION'],
					hintCodes: ['HINT_PROP_NEQ_EXISTENCE'],
				},
			});
			expect(spy.calls).toContainEqual({
				level: 'warn',
				message: 'Query compilation diagnostics for ‼️brokenQuery‼️',
				meta: {
					source: 'query.compile',
					count: 1,
					query: '‼️[priority: = "nan"]‼️',
					executable: false,
					errorCodes: ['ERROR_TYPE_MISMATCH'],
					warningCodes: [],
					hintCodes: [],
				},
			});
		});

		it('aggregates invalid property value warnings only for queried keys and emits one run completion summary', async () => {
			const spy = createLoggerSpy();
			const app = makeMockApp({
				typesJson: JSON.stringify({
					types: {
						priority: 'number',
						unrelated_date: 'date',
					},
				}),
				notes: [
					{
						path: 'notes/bad-priority.md',
						cache: {
							frontmatter: {
								priority: 'urgent',
								unrelated_date: 'not-a-date',
							},
						},
					},
					{
						path: 'notes/uncached.md',
						cache: null,
					},
				],
			});

			await runVaultQuery(
				app,
				{ highPriority: '[priority: > 1]' },
				{ timeZone: 'UTC' },
				spy.logger,
			);

			const propWarn = spy.calls.find(
				(c) => c.message === 'Encountered invalid property values on queried keys',
			);
			expect(propWarn).toEqual({
				level: 'warn',
				message: 'Encountered invalid property values on queried keys',
				meta: {
					source: 'query.run',
					count: 1,
					diagnosticCount: 1,
					affectedNotes: 1,
					codes: ['DOC_INVALID_PROPERTY_VALUE'],
					keys: ['‼️priority‼️'],
					sampleFiles: ['‼️notes/bad-priority.md‼️'],
				},
			});

			const summary = spy.calls.find((c) => c.message === 'Completed vault query run');
			expect(summary?.level).toBe('debug');
			expect(summary?.meta).toMatchObject({
				source: 'query.run',
				count: 2,
				queryCount: 1,
				executableCount: 1,
				notesScanned: 2,
				uncachedNotes: 1,
				docDiagnosticCount: 1,
				matchCounts: { '‼️highPriority‼️': 0 },
			});
			expect(typeof summary?.meta?.['durationMs']).toBe('number');
		});

		it('logs cache counters and query phase timings', async () => {
			const spy = createLoggerSpy();
			const app = makeMockApp({
				notes: [
					{ path: 'notes/a.md', cache: { frontmatter: { status: 'active' } } },
					{ path: 'notes/b.md', cache: { frontmatter: { status: 'active' } } },
				],
			});
			const cache = new NormalizedDocumentCache(app);

			await runVaultQuery(app, { q: 'path:"notes"' }, { timeZone: 'UTC', cache }, spy.logger);

			const summary = spy.calls.find((c) => c.message === 'Completed vault query run');
			expect(summary?.meta).toMatchObject({
				cacheAdd: 2,
				cacheUpdate: 0,
				cacheRemove: 0,
				cacheHits: 0,
				cacheStale: 0,
				uncachedNotes: 0,
			});
			expect(typeof summary?.meta?.['reconcileMs']).toBe('number');
			expect(typeof summary?.meta?.['evaluateMs']).toBe('number');
			expect(typeof summary?.meta?.['projectMs']).toBe('number');
			expect(
				(summary?.meta?.['cacheHits'] as number) +
					(summary?.meta?.['cacheAdd'] as number) +
					(summary?.meta?.['cacheUpdate'] as number),
			).toBe(2);
		});

		it('logs completion summary with executableCount: 0 when all queries fail compilation', async () => {
			const failedSpy = createLoggerSpy();
			const app = makeMockApp({
				typesJson: JSON.stringify({ types: { priority: 'number' } }),
				notes: [
					{
						path: 'notes/bad-priority.md',
						cache: { frontmatter: { priority: 'urgent' } },
					},
				],
			});

			await runVaultQuery(
				app,
				{ broken: '[priority: = "nan"]' },
				{ timeZone: 'UTC' },
				failedSpy.logger,
			);
			const failedSummary = failedSpy.calls.find(
				(c) => c.message === 'Completed vault query run',
			);
			expect(failedSummary?.level).toBe('debug');
			expect(failedSummary?.meta).toMatchObject({
				source: 'query.run',
				count: 0,
				queryCount: 1,
				executableCount: 0,
				notesScanned: 0,
				uncachedNotes: 0,
				docDiagnosticCount: 0,
				matchCounts: {},
			});
			expect(typeof failedSummary?.meta?.['durationMs']).toBe('number');
		});

		it('explainVaultQuery loads types.json and merges overrides without scanning any vault notes', async () => {
			let markdownFilesCalled = false;
			let fileCacheCalled = false;
			const spy = createLoggerSpy();
			const app = makeMockApp({
				typesJson: JSON.stringify({
					types: {
						priority: 'number',
						due: 'date',
					},
				}),
				notes: [
					{
						path: 'notes/a.md',
						cache: { frontmatter: { priority: 1 } },
					},
				],
				onGetMarkdownFiles: () => {
					markdownFilesCalled = true;
				},
				onGetFileCache: () => {
					fileCacheCalled = true;
				},
			});

			const md = await explainVaultQuery(
				app,
				'#work [priority: >= 2] [due: = @today] [custom_override: = true]',
				{
					timeZone: 'America/New_York',
					referenceTimeMs: Date.parse('2026-10-22T15:30:00.000Z'),
					propertyTypes: { custom_override: 'checkbox' },
				},
				spy.logger,
			);

			expect(markdownFilesCalled).toBe(false);
			expect(fileCacheCalled).toBe(false);
			expect(md).toContain('# Query Explain Plan');
			expect(md).toContain('`priority`[^4]');
			expect(md).toContain('`due`[^5]');
			expect(md).toContain('`custom_override`[^6]');
			const explainLog = spy.calls.find((c) => c.message === 'Generated query explanation');
			expect(explainLog?.level).toBe('debug');
			expect(explainLog?.meta?.['source']).toBe('query.explain');
			expect(explainLog?.meta?.['query']).toBe(
				'‼️#work [priority: >= 2] [due: = @today] [custom_override: = true]‼️',
			);
			expect(typeof explainLog?.meta?.['durationMs']).toBe('number');
		});

		it('resolves options.sourcePath in O(1) prior to query compilation, populates results["◊host"], and evaluates @this.* queries against hostDoc', async () => {
			let markdownFilesScanCount = 0;
			const app = makeMockApp({
				typesJson: JSON.stringify({ types: { priority: 'number' } }),
				notes: [
					{
						path: 'Projects/Apollo.md',
						cache: {
							frontmatter: {
								'Review Status': 'active',
								priority: 3,
								tags: ['space'],
							},
						},
					},
					{
						path: 'Notes/Task1.md',
						cache: {
							frontmatter: {
								status: 'active',
								priority: 5,
								tags: ['space/lunar'],
							},
						},
					},
					{
						path: 'Notes/Task2.md',
						cache: {
							frontmatter: {
								status: 'archived',
								priority: 1,
								tags: ['earth'],
							},
						},
					},
				],
				onGetMarkdownFiles: () => {
					markdownFilesScanCount++;
				},
			});

			// 1. With @this.* queries: resolves host note and scans vault once
			const res = await runVaultQuery(
				app,
				{
					matching:
						'tag:@this.tags AND [status: = @this.properties."Review Status"] AND [priority: > @this.properties.priority]',
				},
				{
					timeZone: 'UTC',
					sourcePath: 'Projects/Apollo.md',
				},
			);

			expect(res['◊host']).toHaveLength(1);
			expect(res['◊host']?.[0]?.file.basename).toBe('Apollo');
			expect(res.matching?.map((m) => m.file.path)).toEqual(['Notes/Task1.md']);
			expect(markdownFilesScanCount).toBe(2);

			// 2. With zero queries (e.g. a codeblock only rendering {{ this.file.basename }}): populates ◊host without scanning vault
			markdownFilesScanCount = 0;
			const zeroQueryRes = await runVaultQuery(
				app,
				{},
				{
					timeZone: 'UTC',
					sourcePath: 'Projects/Apollo.md',
				},
			);
			expect(zeroQueryRes['◊host']).toHaveLength(1);
			expect(zeroQueryRes['◊host']?.[0]?.file.basename).toBe('Apollo');
			expect(markdownFilesScanCount).toBe(1);
		});

		it('attaches snapshot backlinks to matches and host docs and filters by source path or basename', async () => {
			const target = makeMockFileEntry({ path: 'notes/target.md' });
			const source = makeMockFileEntry({ path: 'sources/Origin.md' });
			const otherSource = makeMockFileEntry({ path: 'sources/other-lib.md' });
			const snapshot = new Map([
				[
					target,
					new Map([
						[source, 2],
						[otherSource, 1],
					]),
				],
			]) as unknown as BacklinkSnapshot;

			const app = makeMockApp({
				notes: [{ path: 'notes/target.md', cache: {} }],
			});
			(app.vault as unknown as { getMarkdownFiles: () => unknown[] }).getMarkdownFiles =
				() => [target];
			(app.vault as unknown as { getFileByPath: (path: string) => unknown }).getFileByPath = (
				path: string,
			) => (path === target.path ? target : null);
			(app.metadataCache as unknown as { getFileCache: () => unknown }).getFileCache = () =>
				null;

			const res = await runVaultQuery(
				app,
				{
					byPath: 'backlinks:"sources/origin"',
					byBase: 'backlinks:ORIGIN',
					byCount: 'backlinks:2',
					viaThis: 'backlinks:@this.backlinks.path',
				},
				{ timeZone: 'UTC', sourcePath: 'notes/target.md', backlinks: snapshot },
			);

			expect(res.byPath?.[0]?.file.path).toBe('notes/target.md');
			expect(res.byBase?.[0]?.file.path).toBe('notes/target.md');
			expect(res.byCount).toEqual([]);
			expect(res.viaThis?.[0]?.file.path).toBe('notes/target.md');

			expect(res['◊host']?.[0]?.backlinks).toEqual([
				{ path: 'sources/Origin.md', count: 2 },
				{ path: 'sources/other-lib.md', count: 1 },
			]);
			expect(res['◊host']?.[0]?.backlinks).toEqual(res.byPath?.[0]?.backlinks);

			const hostDoc = res['◊host']?.[0] as unknown as NormalizedDocument;
			expect(resolveThisReference(hostDoc, ['backlinks', 'path'])).toEqual({
				resolved: true,
				values: ['sources/Origin.md', 'sources/other-lib.md'],
			});
			expect(resolveThisReference(hostDoc, ['backlinks', 'count'])).toEqual({
				resolved: true,
				values: [2, 1],
			});
			expect(resolveThisReference(hostDoc, ['backlinks'])).toEqual({
				resolved: false,
				values: [],
			});
			expect(
				resolveThisReference({ ...hostDoc, backlinks: [] }, ['backlinks', 'path']),
			).toEqual({ resolved: false, values: [] });

			expect(Object.isFrozen(hostDoc.file)).toBe(true);
			expect(Object.isFrozen(hostDoc.links)).toBe(true);
			expect(Object.isFrozen(hostDoc.backlinks)).toBe(true);
			expect(Object.isFrozen(hostDoc.backlinks?.[0])).toBe(true);
		});

		it('executes multi-query @query.<name> DAG waves in topological order over a single vault normalization pass and omits cyclic/unknown queries', async () => {
			let fileCacheReads = 0;
			const app = makeMockApp({
				typesJson: JSON.stringify({ types: { priority: 'number' } }),
				linkMap: {
					Apollo: 'projects/Apollo.md',
					Q4Goal: 'goals/Q4Goal.md',
				},
				onGetFileCache: () => {
					fileCacheReads++;
				},
				notes: [
					{
						path: 'goals/Q4Goal.md',
						cache: {
							frontmatter: { tags: ['goal'], priority: 10 },
						},
					},
					{
						path: 'projects/Apollo.md',
						cache: {
							frontmatter: { tags: ['project'], up: '[[Q4Goal]]', priority: 5 },
							frontmatterLinks: [{ link: 'Q4Goal', key: 'up' } as never],
						},
					},
					{
						path: 'tasks/LandModule.md',
						cache: {
							frontmatter: { tags: ['task'], up: '[[Apollo]]', priority: 7 },
							frontmatterLinks: [{ link: 'Apollo', key: 'up' } as never],
						},
					},
				],
			});

			const logs: Array<{
				level: string;
				message: string;
				meta?: Record<string, unknown> | undefined;
			}> = [];
			const logger = {
				log: (level: string, message: string, meta?: Record<string, unknown>) => {
					logs.push({ level, message, meta });
				},
			};

			// Intentionally declared in reverse dependency order (Wave 2 -> Wave 1 -> Wave 0) plus cyclic & unknown queries
			const res = await runVaultQuery(
				app,
				{
					goal_tasks:
						'#task AND [up -> @query.goal_projects] AND [priority: > @query.goal_projects.properties.priority]',
					goal_projects: '#project AND [up -> @query.goals]',
					goals: '#goal',
					cyc_a: 'links -> @query.cyc_b',
					cyc_b: 'links -> @query.cyc_a',
					bad_ref: 'links -> @query.nonexistent',
				},
				{ timeZone: 'UTC' },
				logger,
			);

			expect(res.goals?.map((m) => m.file.path)).toEqual(['goals/Q4Goal.md']);
			expect(res.goal_projects?.map((m) => m.file.path)).toEqual(['projects/Apollo.md']);
			expect(res.goal_tasks?.map((m) => m.file.path)).toEqual(['tasks/LandModule.md']);
			expect(res.cyc_a).toBeUndefined();
			expect(res.cyc_b).toBeUndefined();
			expect(res.bad_ref).toBeUndefined();

			// Vault of 3 notes is normalized once across all 3 DAG waves!
			expect(fileCacheReads).toBe(3);
			const summary = logs.find((l) => l.message === 'Completed vault query run');
			expect(summary?.meta?.['notesScanned']).toBe(3);
			expect(
				logs.some((l) => JSON.stringify(l.meta ?? {}).includes('ERROR_CIRCULAR_QUERY_REF')),
			).toBe(true);

			// Lazy backlinks check: non-backlinks graph queries never project backlinks for unmatched notes
			let backlinkGetCalls = 0;
			const spyBacklinks = {
				get: () => {
					backlinkGetCalls++;
					return undefined;
				},
			};
			await runVaultQuery(
				app,
				{ none: '[up ->* { #missing }]' },
				{ timeZone: 'UTC', backlinks: spyBacklinks as never },
			);
			expect(backlinkGetCalls).toBe(0);

			await runVaultQuery(
				app,
				{ descendants: '[up ->* { #goal }]' },
				{ timeZone: 'UTC', backlinks: spyBacklinks as never },
			);
			// Only the 2 matched notes (Apollo, LandModule) project backlinks; unmatched Q4Goal is untouched
			expect(backlinkGetCalls).toBe(2);

			const explainWithoutCutoff = await explainVaultQuery(app, '#goal', { timeZone: 'UTC' });
			expect(explainWithoutCutoff).not.toContain('- **Cutoff**:');

			const explainWithCutoff = await explainVaultQuery(app, '#goal', {
				timeZone: 'UTC',
				cutoff: { value: 250, explicit: true },
			});
			expect(explainWithCutoff).toContain('- **Cutoff**: `250` records\n- **Context**:');
		});
	});
});
