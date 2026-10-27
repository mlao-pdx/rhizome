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
	'[priority > 1]',
	'[priority = "bad"]',
	'[due = @today]',
	'[status: active]',
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

describe('Vault Query Runner Property Invariants', () => {
	it('Invariant 1: Differential Equivalence between runVaultQuery and diagnoseVaultQuery', async () => {
		await assertProperty(
			'adapters/vault-query-runner__differential-equivalence',
			fc.asyncProperty(
				fc.array(mockNoteSpecArb, { maxLength: 5 }),
				typesJsonPayloadArb,
				queryFuzzArb,
				optionsFuzzArb,
				async (notes, typesJson, queryInput, rawOptions) => {
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
					const { app: appDiag, getFileCacheSpy: diagCacheSpy } = makeSpyMockApp({
						notes,
						typesJson,
					});

					const [runRes, diagRes] = await Promise.all([
						runVaultQuery(appRun, queryInput, options),
						diagnoseVaultQuery(appDiag, queryInput, options),
					]);

					expect(runRes.diagnostics.executable).toBe(diagRes.executable);
					expect(runRes.diagnostics.findings).toEqual(diagRes.diagnostics);
					expect(runRes.matches).toEqual(diagRes.matches.map(toVaultQueryMatch));
					expect(diagRes.paths).toEqual(runRes.matches.map((doc) => doc.file.path));
					expect('paths' in runRes).toBe(false);
					expect('propertyDiagnostics' in runRes).toBe(false);

					for (const m of runRes.matches) {
						expect(Object.keys(m)).toEqual([
							'file',
							'aliases',
							'tags',
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

					// Deleted files are never normalized or returned in matches
					for (const call of [...runCacheSpy.mock.calls, ...diagCacheSpy.mock.calls]) {
						const arg = call[0] as { deleted?: boolean };
						expect(arg.deleted).toBe(false);
					}
				},
			),
		);
	});

	it('Invariant 2: Compile Gate, Non-Blocking Lints, and Lazy Vault Short-Circuit', async () => {
		await assertProperty(
			'adapters/vault-query-runner__compile-gate-and-lazy-vault-short-circuit',
			fc.asyncProperty(
				fc.array(mockNoteSpecArb, { minLength: 1, maxLength: 4 }),
				typesJsonPayloadArb,
				queryFuzzArb,
				optionsFuzzArb,
				async (notes, typesJson, queryInput, rawOptions) => {
					const options: VaultQueryOptions = {
						...rawOptions,
						referenceTimeMs:
							rawOptions?.referenceTimeMs !== undefined
								? rawOptions.referenceTimeMs
								: PINNED_REF_MS,
					};
					const {
						app: appRun,
						getMarkdownFilesSpy: runFilesSpy,
						getFileCacheSpy: runCacheSpy,
					} = makeSpyMockApp({ notes, typesJson });
					const {
						app: appDiag,
						getMarkdownFilesSpy: diagFilesSpy,
						getFileCacheSpy: diagCacheSpy,
					} = makeSpyMockApp({ notes, typesJson });

					const [runRes, diagRes] = await Promise.all([
						runVaultQuery(appRun, queryInput, options),
						diagnoseVaultQuery(appDiag, queryInput, options),
					]);

					const hasError = runRes.diagnostics.findings.some(
						(d) => d.severity === 'error',
					);
					expect(runRes.diagnostics.executable).toBe(!hasError);

					if (!runRes.diagnostics.executable) {
						expect(runRes.matches).toEqual([]);
						expect(diagRes.paths).toEqual([]);
						expect(diagRes.matches).toEqual([]);
						expect(diagRes.propertyDiagnostics).toEqual([]);
						expect(runFilesSpy).not.toHaveBeenCalled();
						expect(runCacheSpy).not.toHaveBeenCalled();
						expect(diagFilesSpy).not.toHaveBeenCalled();
						expect(diagCacheSpy).not.toHaveBeenCalled();
					} else {
						expect(runFilesSpy).toHaveBeenCalledTimes(1);
						expect(diagFilesSpy).toHaveBeenCalledTimes(1);
					}
				},
			),
		);
	});

	it('Invariant 3: Total Function (Never-Throw) & Strict LiquidJS POJO / JSON Round-Trip', async () => {
		await assertProperty(
			'adapters/vault-query-runner__never-throw-and-json-pojo-roundtrip',
			fc.asyncProperty(
				fc.array(mockNoteSpecArb, { maxLength: 4 }),
				typesJsonPayloadArb,
				queryFuzzArb,
				optionsFuzzArb,
				async (notes, typesJson, queryInput, options) => {
					const { app: appRun } = makeSpyMockApp({ notes, typesJson });
					const { app: appDiag } = makeSpyMockApp({ notes, typesJson });

					const [runRes, diagRes] = await Promise.all([
						runVaultQuery(appRun, queryInput, options),
						diagnoseVaultQuery(appDiag, queryInput, options),
					]);

					expect(Object.isFrozen(runRes.context)).toBe(true);
					expect(Object.isFrozen(runRes.context.propertyTypes)).toBe(true);

					if (runRes.context.referenceTimeMs !== null) {
						expect(Number.isSafeInteger(runRes.context.referenceTimeMs)).toBe(true);
						expect(Math.abs(runRes.context.referenceTimeMs)).toBeLessThanOrEqual(
							MAX_SAFE_EPOCH_MS,
						);
					}

					expect(JSON.parse(JSON.stringify(runRes))).toEqual(runRes);
					expect(JSON.parse(JSON.stringify(diagRes))).toEqual(diagRes);
				},
			),
		);
	});

	it('Invariant 4: Context, Case-Insensitive Override Precedence & Normalization Fingerprint Alignment', async () => {
		const validKeyArb = fc.constantFrom('due', 'priority', 'status', 'done', 'score');
		const validPropTypeArb = fc.constantFrom(...VALID_PROPERTY_TYPES);

		await assertProperty(
			'adapters/vault-query-runner__context-override-precedence-and-fingerprint',
			fc.asyncProperty(
				fc.array(mockNoteSpecArb, { minLength: 1, maxLength: 4 }),
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
						},
					});
					const { app: appRun } = makeSpyMockApp({ notes, typesJson });
					const { app: appDiag } = makeSpyMockApp({ notes, typesJson });

					const [res, diagRes] = await Promise.all([
						runVaultQuery(appRun, '', {
							timeZone: rawTz,
							referenceTimeMs: PINNED_REF_MS,
							propertyTypes: {
								[variantKey]: overrideType,
							},
						}),
						diagnoseVaultQuery(appDiag, '', {
							timeZone: rawTz,
							referenceTimeMs: PINNED_REF_MS,
							propertyTypes: {
								[variantKey]: overrideType,
							},
						}),
					]);

					expect(res.diagnostics.executable).toBe(true);
					expect(res.context.timeZone).toBe(rawTz.trim());
					expect(res.context.referenceTimeMs).toBe(PINNED_REF_MS);
					expect(res.context.propertyTypes[baseKey]).toBe(overrideType);

					const sortedTypePairs = Object.keys(res.context.propertyTypes)
						.sort()
						.map((k) => [k, res.context.propertyTypes[k]!]);
					const expectedFingerprint = JSON.stringify({
						tz: res.context.timeZone,
						types: sortedTypePairs,
					});

					for (const m of res.matches) {
						expect('normalizationFingerprint' in m).toBe(false);
					}
					for (const doc of diagRes.matches) {
						expect(doc.normalizationFingerprint).toBe(expectedFingerprint);
					}

					// Conflicting case-colliding keys within options.propertyTypes itself must fail config validation
					if (vaultType !== overrideType) {
						const conflictRes = await runVaultQuery(appRun, '', {
							timeZone: 'UTC',
							referenceTimeMs: PINNED_REF_MS,
							propertyTypes: {
								[baseKey]: vaultType,
								[baseKey.toUpperCase()]: overrideType,
							},
						});
						expect(conflictRes.diagnostics.executable).toBe(false);
						expect(
							conflictRes.diagnostics.findings.some(
								(d) => d.code === 'ERROR_INVALID_CONFIG',
							),
						).toBe(true);
					}
				},
			),
		);
	});

	it('Invariant 5: parseObsidianTypesJson Total Sanitization & Idempotence', async () => {
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
