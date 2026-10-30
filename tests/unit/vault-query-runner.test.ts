import type { App, CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import {
	explainVaultQuery,
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
					warnQuery: 'alpha and beta',
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
					count: 3,
					query: '‼️alpha and beta‼️',
					executable: true,
					errorCodes: [],
					warningCodes: ['WARN_LOWERCASE_BOOLEAN'],
					hintCodes: ['HINT_BARE_TEXT_NO_BODY'],
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
	});
});
