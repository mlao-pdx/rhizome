import * as fc from 'fast-check';
import type { App, CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import {
	diagnoseVaultQuery,
	parseObsidianTypesJson,
	runVaultQuery,
	toVaultQueryMatch,
	type VaultQueryOptions,
} from '../../src/adapters/vault-query-runner';
import {
	FORBIDDEN_KEYS,
	initEngineConfig,
	isValidPropertyType,
	MAX_SAFE_EPOCH_MS,
	type ObsidianPropertyType,
	type PropertyTypeRegistry,
} from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';
import { printableExecutableAstArb } from '../support/search-arbitraries';
import { printAST } from '../support/search-printer';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');
const BUILTIN_PROPERTY_KEYS = new Set(['alias', 'aliases', 'tag', 'tags']);
const VALID_PROPERTY_TYPES: readonly ObsidianPropertyType[] = [
	'text',
	'multitext',
	'number',
	'checkbox',
	'date',
	'datetime',
	'tags',
];

interface MockNoteSpec {
	path: string;
	ctime: number;
	mtime: number;
	size: number;
	deleted: boolean;
	cache: Partial<CachedMetadata> | null;
}

interface SpyAppResult {
	app: App;
	getMarkdownFilesSpy: ReturnType<typeof vi.fn>;
	getFileCacheSpy: ReturnType<typeof vi.fn>;
}

function makeSpyMockApp(options: {
	notes: MockNoteSpec[];
	typesJson: string | Error;
}): SpyAppResult {
	const files = options.notes.map((spec) => {
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
			deleted: spec.deleted,
			stat: {
				ctime: spec.ctime,
				mtime: spec.mtime,
				size: spec.size,
			},
		};
	});

	const cacheByPath = new Map<string, Partial<CachedMetadata> | null>();
	for (const spec of options.notes) {
		cacheByPath.set(spec.path, spec.cache);
	}

	const configDir = 'mock-config';
	const getMarkdownFilesSpy = vi.fn(() => files);
	const getFileCacheSpy = vi.fn((file: { path: string }) => cacheByPath.get(file.path) ?? null);

	const app = {
		vault: {
			configDir,
			adapter: {
				read: vi.fn(async (path: string) => {
					if (path === `${configDir}/types.json`) {
						if (options.typesJson instanceof Error) {
							throw options.typesJson;
						}
						return options.typesJson;
					}
					throw new Error(`ENOENT: ${path}`);
				}),
			},
			getMarkdownFiles: getMarkdownFilesSpy,
		},
		metadataCache: {
			getFileCache: getFileCacheSpy,
			getFirstLinkpathDest: () => null,
		},
	} as unknown as App;

	return { app, getMarkdownFilesSpy, getFileCacheSpy };
}

const resolvedTestConfig = (() => {
	const res = initEngineConfig({
		timeZone: 'America/New_York',
		propertyTypes: {
			score: 'number',
			priority: 'number',
			meeting: 'datetime',
			due: 'date',
			modified: 'date',
			sprint: 'date',
			status: 'text',
			done: 'checkbox',
		},
	});
	if (!res.ok) throw new Error('Expected valid test config');
	return res.config;
})();

const executableQueryStringArb = printableExecutableAstArb(resolvedTestConfig, PINNED_REF_MS).map(
	(ast) => printAST(ast),
);

const tokenFragmentArb = fc.constantFrom(
	'AND',
	'OR',
	'NOT',
	'-',
	'(',
	')',
	'[',
	']',
	':',
	'=',
	'!=',
	'<',
	'>',
	'<=',
	'>=',
	'"hello"',
	'/abc/i',
	'/unclosed(/',
	'#work',
	'file:note',
	'[priority: > 1]',
	'[priority: = "bad"]',
	'[due: = @today]',
	'[status: active]',
	'[status:]',
	'and',
	'or',
	'bareword',
);

const queryFuzzArb = fc.oneof(
	executableQueryStringArb,
	fc.string({ maxLength: 120 }),
	fc.array(tokenFragmentArb, { minLength: 1, maxLength: 12 }).map((parts) => parts.join(' ')),
);

const mockNoteSpecArb: fc.Arbitrary<MockNoteSpec> = fc.record({
	path: fc.constantFrom('notes/alpha.md', 'notes/beta.md', 'tasks/todo.md', 'archive/old.md'),
	ctime: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
	mtime: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
	size: fc.integer({ min: 0, max: 50_000 }),
	deleted: fc.boolean(),
	cache: fc.oneof(
		fc.constant(null),
		fc.record({
			frontmatter: fc.dictionary(
				fc.constantFrom('priority', 'score', 'due', 'status', 'done', 'extra'),
				fc.oneof(
					fc.integer({ min: -10, max: 100 }),
					fc.boolean(),
					fc.constantFrom('active', 'done', '2026-10-22', 'invalid-val'),
				),
			),
			tags: fc.array(
				fc
					.constantFrom('#work', '#project', '#urgent')
					.map((tag) => ({ tag, position: {} as never })),
				{ maxLength: 3 },
			),
		}),
	),
});

const typesJsonPayloadArb: fc.Arbitrary<string | Error> = fc.oneof(
	fc.constant(new Error('ENOENT')),
	fc.string({ maxLength: 80 }),
	fc
		.dictionary(
			fc.constantFrom(
				'priority',
				'Priority',
				'due',
				'DUE',
				'score',
				'status',
				'done',
				'aliases',
				'tags',
				'customWidget',
			),
			fc.constantFrom(...VALID_PROPERTY_TYPES, 'aliases', 'canvas-color', 'unknown-widget'),
		)
		.map((types) => JSON.stringify({ types })),
);

const optionsFuzzArb: fc.Arbitrary<VaultQueryOptions | undefined> = fc.option(
	fc.record(
		{
			timeZone: fc.option(
				fc.constantFrom(
					'UTC',
					'America/New_York',
					'Europe/Berlin',
					'  UTC  ',
					'',
					'Invalid/Zone_Name',
				),
				{ nil: undefined },
			),
			referenceTimeMs: fc.option(
				fc.oneof(
					fc.constant(PINNED_REF_MS),
					fc.integer({ min: -MAX_SAFE_EPOCH_MS, max: MAX_SAFE_EPOCH_MS }),
					fc.constantFrom(
						Number.NaN,
						Number.POSITIVE_INFINITY,
						Number.NEGATIVE_INFINITY,
						123.45,
						MAX_SAFE_EPOCH_MS + 1,
						-MAX_SAFE_EPOCH_MS - 1,
					),
				),
				{ nil: undefined },
			),
			propertyTypes: fc.option(
				fc.dictionary(
					fc.constantFrom(
						'priority',
						'Priority',
						'due',
						'Due',
						'status',
						'done',
						'score',
						'__proto__',
						'constructor',
					),
					fc.constantFrom(
						...VALID_PROPERTY_TYPES,
						'invalid-type' as ObsidianPropertyType,
					),
				) as fc.Arbitrary<PropertyTypeRegistry>,
				{ nil: undefined },
			),
		},
		{ requiredKeys: [] },
	),
	{ nil: undefined },
);

const queryNameArb = fc.constantFrom(
	'inbox',
	'urgent',
	'work',
	'roadmap',
	'archive',
	'__proto__',
	'constructor',
	'prototype',
);

const queryMapFuzzArb: fc.Arbitrary<Record<string, string>> = fc.dictionary(
	queryNameArb,
	queryFuzzArb,
	{ maxKeys: 5 },
);

const uniqueNotesArb = fc.uniqueArray(mockNoteSpecArb, {
	selector: (n) => n.path,
	maxLength: 4,
});

describe('Vault Query Runner Property Invariants', () => {
	it('Invariant 1: Multi-Query Differential Equivalence & Failed-Query Omission', async () => {
		await assertProperty(
			'adapters/vault-query-runner__multi-query-differential-equivalence',
			fc.asyncProperty(
				uniqueNotesArb,
				typesJsonPayloadArb,
				queryMapFuzzArb,
				optionsFuzzArb,
				async (notes, typesJson, queryMap, rawOptions) => {
					const options: VaultQueryOptions = {
						...rawOptions,
						referenceTimeMs:
							rawOptions?.referenceTimeMs !== undefined
								? rawOptions.referenceTimeMs
								: PINNED_REF_MS,
					};
					const { app: appRun, getFileCacheSpy: runCacheSpy } = makeSpyMockApp({
						notes,
						typesJson,
					});

					const runRes = await runVaultQuery(appRun, queryMap, options);

					const expectedKeys = Object.keys(queryMap).filter(
						(k) =>
							!FORBIDDEN_KEYS.has(k) && !FORBIDDEN_KEYS.has(k.trim().toLowerCase()),
					);
					for (const key of Object.keys(runRes)) {
						expect(expectedKeys).toContain(key);
					}

					for (const k of expectedKeys) {
						const { app: appDiag, getFileCacheSpy: diagCacheSpy } = makeSpyMockApp({
							notes,
							typesJson,
						});
						const diagRes = await diagnoseVaultQuery(appDiag, queryMap[k], options);

						if (diagRes.executable) {
							expect(Object.prototype.hasOwnProperty.call(runRes, k)).toBe(true);
							const bucket = runRes[k]!;
							expect(bucket).toEqual(diagRes.matches.map(toVaultQueryMatch));
							expect(diagRes.paths).toEqual(bucket.map((m) => m.file.path));

							for (const m of bucket) {
								expect(Object.keys(m)).toEqual([
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
								expect('normalizationFingerprint' in m).toBe(false);
								expect('propertyOccurrences' in m).toBe(false);
								expect('propertyKeys' in m).toBe(false);
								expect('diagnostics' in m).toBe(false);
								expect(Object.isFrozen(m)).toBe(false);
								expect(Object.isFrozen(m.file)).toBe(false);
							}
						} else {
							expect(Object.prototype.hasOwnProperty.call(runRes, k)).toBe(false);
						}

						for (const call of diagCacheSpy.mock.calls) {
							const arg = call[0] as { deleted?: boolean };
							expect(arg.deleted).toBe(false);
						}
					}

					for (const call of runCacheSpy.mock.calls) {
						const arg = call[0] as { deleted?: boolean };
						expect(arg.deleted).toBe(false);
					}
				},
			),
		);
	});

	it('Invariant 2: Cross-Query In-Memory Reference Identity (===) & Single Normalization Pass', async () => {
		const multiExecutableQueryMapArb = fc.dictionary(
			fc.constantFrom('q1', 'q2', 'q3', 'q4'),
			fc.oneof(executableQueryStringArb, fc.constant(''), fc.constant('#work')),
			{ minKeys: 1, maxKeys: 4 },
		);

		await assertProperty(
			'adapters/vault-query-runner__cross-query-reference-identity-and-single-pass',
			fc.asyncProperty(
				uniqueNotesArb,
				multiExecutableQueryMapArb,
				async (notes, queryMap) => {
					const typesJson = JSON.stringify({
						types: {
							score: 'number',
							priority: 'number',
							meeting: 'datetime',
							due: 'date',
							modified: 'date',
							sprint: 'date',
							status: 'text',
							done: 'checkbox',
						},
					});
					const { app, getMarkdownFilesSpy, getFileCacheSpy } = makeSpyMockApp({
						notes,
						typesJson,
					});

					const runRes = await runVaultQuery(app, queryMap, {
						timeZone: 'America/New_York',
						referenceTimeMs: PINNED_REF_MS,
					});

					const executableBuckets = Object.values(runRes);
					expect(executableBuckets.length).toBeGreaterThanOrEqual(1);

					const nonDeletedCount = notes.filter((n) => !n.deleted).length;
					expect(getMarkdownFilesSpy).toHaveBeenCalledTimes(1);
					expect(getFileCacheSpy).toHaveBeenCalledTimes(nonDeletedCount);

					const canonicalByPath = new Map<string, unknown>();
					for (const bucket of executableBuckets) {
						for (const match of bucket) {
							const existing = canonicalByPath.get(match.file.path);
							if (existing !== undefined) {
								expect(match).toBe(existing);
							} else {
								canonicalByPath.set(match.file.path, match);
							}
						}
					}
				},
			),
		);
	});

	it('Invariant 3: Partial Execution Gate vs. Lazy Vault Short-Circuit', async () => {
		await assertProperty(
			'adapters/vault-query-runner__partial-execution-and-lazy-vault-short-circuit',
			fc.asyncProperty(
				fc.uniqueArray(mockNoteSpecArb, {
					selector: (n) => n.path,
					minLength: 1,
					maxLength: 4,
				}),
				typesJsonPayloadArb,
				queryMapFuzzArb,
				optionsFuzzArb,
				async (notes, typesJson, queryMap, rawOptions) => {
					const options: VaultQueryOptions = {
						...rawOptions,
						referenceTimeMs:
							rawOptions?.referenceTimeMs !== undefined
								? rawOptions.referenceTimeMs
								: PINNED_REF_MS,
					};
					const { app, getMarkdownFilesSpy, getFileCacheSpy } = makeSpyMockApp({
						notes,
						typesJson,
					});

					const runRes = await runVaultQuery(app, queryMap, options);

					const executableCount = Object.keys(runRes).length;
					const nonDeletedCount = notes.filter((n) => !n.deleted).length;
					if (executableCount === 0) {
						expect(getMarkdownFilesSpy).not.toHaveBeenCalled();
						expect(getFileCacheSpy).not.toHaveBeenCalled();
					} else {
						expect(getMarkdownFilesSpy).toHaveBeenCalledTimes(1);
						expect(getFileCacheSpy).toHaveBeenCalledTimes(nonDeletedCount);
					}
				},
			),
		);

		await assertProperty(
			'adapters/vault-query-runner__mixed-valid-invalid-batch-partial-execution',
			fc.asyncProperty(
				fc.uniqueArray(mockNoteSpecArb, {
					selector: (n) => n.path,
					minLength: 1,
					maxLength: 4,
				}),
				executableQueryStringArb,
				fc.constantFrom('/unclosed(/', '[priority: = "not-a-number"]', 'AND'),
				async (notes, validQuery, invalidQuery) => {
					const typesJson = JSON.stringify({
						types: {
							score: 'number',
							priority: 'number',
							meeting: 'datetime',
							due: 'date',
							modified: 'date',
							sprint: 'date',
							status: 'text',
							done: 'checkbox',
						},
					});
					const { app, getMarkdownFilesSpy, getFileCacheSpy } = makeSpyMockApp({
						notes,
						typesJson,
					});

					const runRes = await runVaultQuery(
						app,
						{
							validKey: validQuery,
							invalidKey: invalidQuery,
						},
						{
							timeZone: 'America/New_York',
							referenceTimeMs: PINNED_REF_MS,
						},
					);

					expect(Object.keys(runRes)).toEqual(['validKey']);
					expect(Object.prototype.hasOwnProperty.call(runRes, 'invalidKey')).toBe(false);
					expect(getMarkdownFilesSpy).toHaveBeenCalledTimes(1);
					expect(getFileCacheSpy).toHaveBeenCalledTimes(
						notes.filter((n) => !n.deleted).length,
					);
				},
			),
		);
	});

	it('Invariant 4: Shared Config, Fingerprint & Zero Temporal Tear Across Sibling Queries', async () => {
		const validKeyArb = fc.constantFrom('priority', 'status', 'done', 'score');
		const validPropTypeArb = fc.constantFrom(...VALID_PROPERTY_TYPES);
		const dueDateNoteArb: fc.Arbitrary<MockNoteSpec> = fc.record({
			path: fc.constantFrom(
				'notes/alpha.md',
				'notes/beta.md',
				'tasks/todo.md',
				'archive/old.md',
			),
			ctime: fc.constant(1_700_000_000_000),
			mtime: fc.constant(1_700_000_000_000),
			size: fc.constant(120),
			deleted: fc.boolean(),
			cache: fc.record({
				frontmatter: fc.record({
					due: fc.constantFrom(
						'2026-10-20',
						'2026-10-21',
						'2026-10-22',
						'2026-10-23',
						'2026-10-25',
						'not-a-date',
					),
				}),
			}),
		});

		await assertProperty(
			'adapters/vault-query-runner__shared-context-fingerprint-and-zero-temporal-tear',
			fc.asyncProperty(
				fc.uniqueArray(dueDateNoteArb, {
					selector: (n) => n.path,
					minLength: 1,
					maxLength: 4,
				}),
				validKeyArb,
				validPropTypeArb,
				validPropTypeArb,
				fc.constantFrom('UTC', 'America/New_York', '  Europe/London  '),
				async (notes, baseKey, vaultType, overrideType, rawTz) => {
					const variantKey =
						baseKey.charAt(0).toUpperCase() + baseKey.slice(1).toLowerCase();
					const typesJson = JSON.stringify({
						types: {
							[baseKey]: vaultType,
							due: 'date',
						},
					});
					const { app: appRun } = makeSpyMockApp({ notes, typesJson });
					const { app: appDiag } = makeSpyMockApp({ notes, typesJson });

					const [res, diagRes] = await Promise.all([
						runVaultQuery(
							appRun,
							{
								all: '',
								lt: '[due: < @today]',
								eq: '[due: = @today]',
								gt: '[due: > @today]',
								hasDue: '[due: <= @today] OR [due: > @today]',
							},
							{
								timeZone: rawTz,
								referenceTimeMs: PINNED_REF_MS,
								propertyTypes: {
									[variantKey]: overrideType,
									due: 'date',
								},
							},
						),
						diagnoseVaultQuery(appDiag, '', {
							timeZone: rawTz,
							referenceTimeMs: PINNED_REF_MS,
							propertyTypes: {
								[variantKey]: overrideType,
								due: 'date',
							},
						}),
					]);

					const effectiveTypes: Record<string, string> = {
						[baseKey]: overrideType,
						due: 'date',
					};
					const sortedTypePairs = Object.keys(effectiveTypes)
						.sort()
						.map((k) => [k, effectiveTypes[k]!]);
					const expectedFingerprint = JSON.stringify({
						tz: rawTz.trim(),
						types: sortedTypePairs,
					});

					for (const doc of diagRes.matches) {
						expect(doc.normalizationFingerprint).toBe(expectedFingerprint);
					}

					// Zero temporal tear: lt, eq, gt strictly partition all notes with a valid single due date (`hasDue`)
					const ltPaths = res['lt']!.map((m) => m.file.path);
					const eqPaths = res['eq']!.map((m) => m.file.path);
					const gtPaths = res['gt']!.map((m) => m.file.path);
					const hasDuePaths = res['hasDue']!.map((m) => m.file.path);

					const combined = [...ltPaths, ...eqPaths, ...gtPaths];
					expect(new Set(combined).size).toBe(combined.length);
					expect([...combined].sort()).toEqual([...hasDuePaths].sort());

					// Conflicting case-colliding keys within options.propertyTypes itself must fail config validation
					if (vaultType !== overrideType) {
						const conflictRes = await runVaultQuery(
							appRun,
							{ all: '' },
							{
								timeZone: 'UTC',
								referenceTimeMs: PINNED_REF_MS,
								propertyTypes: {
									[baseKey]: vaultType,
									[baseKey.toUpperCase()]: overrideType,
								},
							},
						);
						expect(conflictRes).toEqual({});
					}
				},
			),
		);
	});

	it('Invariant 5: Total Function (Never-Throw), Strict LiquidJS POJO / JSON Round-Trip & parseObsidianTypesJson Sanitization', async () => {
		await assertProperty(
			'adapters/vault-query-runner__never-throw-and-json-pojo-roundtrip',
			fc.asyncProperty(
				uniqueNotesArb,
				typesJsonPayloadArb,
				queryMapFuzzArb,
				queryFuzzArb,
				optionsFuzzArb,
				async (notes, typesJson, queryMap, singleQuery, options) => {
					const { app: appRun } = makeSpyMockApp({ notes, typesJson });
					const { app: appDiag } = makeSpyMockApp({ notes, typesJson });

					const [runRes, diagRes] = await Promise.all([
						runVaultQuery(appRun, queryMap, options),
						diagnoseVaultQuery(appDiag, singleQuery, options),
					]);

					for (const forbidden of FORBIDDEN_KEYS) {
						expect(Object.prototype.hasOwnProperty.call(runRes, forbidden)).toBe(false);
					}

					expect(JSON.parse(JSON.stringify(runRes))).toEqual(runRes);
					expect(JSON.parse(JSON.stringify(diagRes))).toEqual(diagRes);
				},
			),
		);

		const rawInputArb = fc.oneof(
			fc.string({ maxLength: 200 }),
			fc.json(),
			fc
				.dictionary(
					fc.oneof(
						fc.string({ maxLength: 30 }),
						fc.constantFrom(
							'alias',
							'aliases',
							'tag',
							'tags',
							'__proto__',
							'constructor',
							'prototype',
							'  Due_Date  ',
							'due_date',
						),
					),
					fc.oneof(
						fc.constantFrom(...VALID_PROPERTY_TYPES),
						fc.string({ maxLength: 20 }),
						fc.integer(),
						fc.boolean(),
						fc.constant(null),
					),
				)
				.map((dict) => JSON.stringify({ types: dict })),
		);

		await assertProperty(
			'adapters/vault-query-runner__parse-obsidian-types-json-sanitization-and-idempotence',
			fc.property(rawInputArb, (rawJson) => {
				const parsed = parseObsidianTypesJson(rawJson);
				expect(Object.getPrototypeOf(parsed)).toBeNull();

				for (const [k, v] of Object.entries(parsed)) {
					expect(k.length).toBeGreaterThan(0);
					expect(k).toBe(k.trim().toLowerCase());
					expect(FORBIDDEN_KEYS.has(k)).toBe(false);
					expect(BUILTIN_PROPERTY_KEYS.has(k)).toBe(false);
					expect(isValidPropertyType(v)).toBe(true);
				}

				const reserialized = JSON.stringify({ types: parsed });
				const reparsed = parseObsidianTypesJson(reserialized);
				expect(reparsed).toEqual(parsed);
			}),
		);
	});
});
