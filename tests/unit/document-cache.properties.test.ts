import type { TFile } from 'obsidian';
import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { assertProperty } from '../support/assertProperty';
import {
	createCacheVault,
	noteModel,
	type NoteModel,
	type VaultState,
} from '../support/cache-vault';
import { expectDeepFrozen as assertFrozen, makeConfig } from '../support/cache-fixtures';
import { BacklinkIndex } from '../../src/adapters/backlink-index';
import { BodyScanCache } from '../../src/adapters/body-scan-cache';
import { BodyScanIdbStore } from '../../src/adapters/body-scan-idb';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import { runVaultQuery } from '../../src/adapters/vault-query-runner';
import { digestNormalizedDocument } from '../../src/core/cache/doc-digest';
import {
	getInternalFileEpochMs,
	hasInternalRhizomeFlag,
	INTERNAL_RHIZOME_CODES,
	normalizeObsidianMetadata,
} from '../../src/core/search';

const CONFIG = makeConfig();

const LINK_TARGETS = ['n0', 'n1', 'n2', 'n3', 'n4', 'missing'];
const STATUSES = ['active', 'archived', 'todo'];
const TAGS = ['#work', '#home', '#project'];

const linksArb = fc.array(fc.constantFrom(...LINK_TARGETS), { maxLength: 3 });

const optionalNoteArb = fc.option(
	fc.record({
		ignored: fc.boolean(),
		deleted: fc.boolean(),
		status: fc.constantFrom(...STATUSES),
		tags: fc.array(fc.constantFrom(...TAGS), { maxLength: 2 }),
		links: linksArb,
		mtime: fc.constantFrom(1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002),
		size: fc.constantFrom(100, 101),
		cacheVersion: fc.constantFrom(0, 1),
		canvas: fc.boolean(),
	}),
	{ nil: null },
);

const stateArb: fc.Arbitrary<VaultState> = fc
	.tuple(...[0, 1, 2, 3, 4].map(() => optionalNoteArb))
	.map((entries) => {
		const notes: NoteModel[] = [];
		entries.forEach((entry, id) => {
			if (entry === null) return;
			if (entry.canvas) {
				notes.push(
					noteModel({
						id,
						basename: `b${id}`,
						path: `boards/b${id}.canvas`,
						extension: 'canvas',
						deleted: entry.deleted,
						links: entry.links,
					}),
				);
				return;
			}
			notes.push(
				noteModel({
					id,
					ignored: entry.ignored,
					deleted: entry.deleted,
					status: entry.status,
					tags: entry.tags,
					links: entry.links,
					mtime: entry.mtime,
					size: entry.size,
					cacheVersion: entry.cacheVersion,
				}),
			);
		});
		return { notes };
	});

function liveNotes(state: VaultState): NoteModel[] {
	return state.notes.filter((note) => !note.deleted);
}

function coldDigests(
	state: VaultState,
	vault: ReturnType<typeof createCacheVault>,
): Map<string, string> {
	const result = new Map<string, string>();
	for (const note of liveNotes(state)) {
		if (note.extension !== 'md' || note.ignored) continue;
		const file = vault.files.find((candidate) => candidate.path === note.path);
		const cache = vault.cacheFor(note.path);
		if (!file || !cache) continue;
		if (
			hasInternalRhizomeFlag(cache.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY)
		) {
			continue;
		}
		const doc = normalizeObsidianMetadata(file, cache, CONFIG, [], vault.resolveLinkPath);
		result.set(note.path, digestNormalizedDocument(doc));
	}
	return result;
}

function cacheDigests(cache: NormalizedDocumentCache): Map<string, string> {
	const result = new Map<string, string>();
	for (const [path, doc] of cache.entries()) {
		result.set(path, digestNormalizedDocument(doc));
	}
	return result;
}

function sortedEntries(map: Map<string, string>): Array<[string, string]> {
	return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function snapshotPaths(index: BacklinkIndex): Map<string, Map<string, number>> {
	const result = new Map<string, Map<string, number>>();
	for (const [target, sources] of index.snapshot()) {
		const inner = new Map<string, number>();
		for (const [source, count] of sources) {
			inner.set(source.path, count);
		}
		result.set(target.path, inner);
	}
	return result;
}

function sortedSnapshot(
	map: Map<string, Map<string, number>>,
): Array<[string, Array<[string, number]>]> {
	return [...map.entries()]
		.map(([target, sources]): [string, Array<[string, number]>] => [
			target,
			[...sources.entries()].sort(([a], [b]) => a.localeCompare(b)),
		])
		.sort(([a], [b]) => a.localeCompare(b));
}

type Mutation =
	| { readonly kind: 'status'; readonly id: number; readonly status: string }
	| { readonly kind: 'links'; readonly id: number; readonly links: readonly string[] }
	| { readonly kind: 'rename'; readonly id: number; readonly suffix: string }
	| { readonly kind: 'ignore'; readonly id: number; readonly value: boolean }
	| { readonly kind: 'delete'; readonly id: number; readonly value: boolean }
	| { readonly kind: 'touch'; readonly id: number; readonly mtime: number }
	| { readonly kind: 'cache'; readonly id: number; readonly version: number };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
	fc.record({
		kind: fc.constant('status' as const),
		id: fc.integer({ min: 0, max: 4 }),
		status: fc.constantFrom(...STATUSES),
	}),
	fc.record({
		kind: fc.constant('links' as const),
		id: fc.integer({ min: 0, max: 4 }),
		links: linksArb,
	}),
	fc.record({
		kind: fc.constant('rename' as const),
		id: fc.integer({ min: 0, max: 4 }),
		suffix: fc.stringMatching(/^[a-z]{1,5}$/),
	}),
	fc.record({
		kind: fc.constant('ignore' as const),
		id: fc.integer({ min: 0, max: 4 }),
		value: fc.boolean(),
	}),
	fc.record({
		kind: fc.constant('delete' as const),
		id: fc.integer({ min: 0, max: 4 }),
		value: fc.boolean(),
	}),
	fc.record({
		kind: fc.constant('touch' as const),
		id: fc.integer({ min: 0, max: 4 }),
		mtime: fc.constantFrom(1_700_000_000_000, 1_700_000_000_003),
	}),
	fc.record({
		kind: fc.constant('cache' as const),
		id: fc.integer({ min: 0, max: 4 }),
		version: fc.integer({ min: 0, max: 3 }),
	}),
);

function applyMutation(state: VaultState, mutation: Mutation): VaultState {
	return {
		notes: state.notes.map((note) => {
			if (note.id !== mutation.id) return { ...note };
			switch (mutation.kind) {
				case 'status':
					return { ...note, status: mutation.status };
				case 'links':
					return { ...note, links: mutation.links };
				case 'rename':
					return {
						...note,
						basename: `${note.basename}-${mutation.suffix}`,
						path:
							note.extension === 'md'
								? `notes/${note.basename}-${mutation.suffix}.md`
								: `boards/${note.basename}-${mutation.suffix}.canvas`,
					};
				case 'ignore':
					return { ...note, ignored: mutation.value };
				case 'delete':
					return { ...note, deleted: mutation.value };
				case 'touch':
					return { ...note, mtime: mutation.mtime };
				case 'cache':
					return { ...note, cacheVersion: mutation.version };
			}
		}),
	};
}

function mdFiles(vault: ReturnType<typeof createCacheVault>): TFile[] {
	return vault.files.filter((file) => file.path.toLowerCase().endsWith('.md'));
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
	if (value === null || typeof value !== 'object') return;
	const container = value;
	if (seen.has(container)) return;
	seen.add(container);
	expect(Object.isFrozen(container)).toBe(true);
	if (Array.isArray(value)) {
		for (const item of value) expectDeepFrozen(item, seen);
		return;
	}
	for (const key of Object.keys(value)) {
		expectDeepFrozen((value as Record<string, unknown>)[key], seen);
	}
}

describe('normalized document cache properties', () => {
	it('I1 warm cache documents and cold rebuild agree', async () => {
		await assertProperty(
			'cache/i1__warm-equals-cold',
			fc.asyncProperty(stateArb, async (state) => {
				const vault = createCacheVault(state);
				const cache = new NormalizedDocumentCache(vault.app);
				const files = liveNotes(state)
					.filter((note) => note.extension === 'md')
					.map((note) => vault.files.find((file) => file.path === note.path)!)
					.filter((file): file is TFile => file !== undefined);
				cache.reconcile(files, CONFIG, vault.resolveLinkPath);

				expect(sortedEntries(cacheDigests(cache))).toEqual(
					sortedEntries(coldDigests(state, vault)),
				);

				const queries = {
					work: '#work',
					active: '[status: active]',
					path: 'path:"notes"',
					link: 'link:"n0"',
					inbound: 'backlinks:"n0"',
					inboundAny: 'backlinks:"notes"',
				};
				const snapshot = new BacklinkIndex(vault.app, () => false).snapshot();
				const warm = await runVaultQuery(vault.app, queries, {
					timeZone: 'UTC',
					referenceTimeMs: 1_700_000_000_000,
					cache,
					backlinks: snapshot,
				});
				const cold = await runVaultQuery(vault.app, queries, {
					timeZone: 'UTC',
					referenceTimeMs: 1_700_000_000_000,
					backlinks: snapshot,
				});
				const paths = (result: typeof warm) =>
					Object.fromEntries(
						Object.entries(result).map(([key, matches]) => [
							key,
							matches.map((match) => match.file.path),
						]),
					);
				expect(paths(warm)).toEqual(paths(cold));
				expect(warm['inbound']).toEqual(cold['inbound']);
				expect(warm['inboundAny']).toEqual(cold['inboundAny']);
			}),
		);
	});

	it('I2 a dropped event still converges on the next reconcile', async () => {
		await assertProperty(
			'cache/i2__dropped-event-converges',
			fc.asyncProperty(
				stateArb,
				fc.array(linksArb, { minLength: 1, maxLength: 1 }),
				async (state, replacementLinks) => {
					const vault = createCacheVault(state);
					const cache = new NormalizedDocumentCache(vault.app);
					const mdFiles = () =>
						liveNotes(vault.state)
							.filter((note) => note.extension === 'md')
							.map((note) => vault.files.find((file) => file.path === note.path)!)
							.filter((file): file is TFile => file !== undefined);
					cache.reconcile(mdFiles(), CONFIG, vault.resolveLinkPath);

					const nextNotes = vault.state.notes.map((note) =>
						note.extension === 'md' && !note.deleted
							? { ...note, links: replacementLinks[0]!, mtime: note.mtime + 1 }
							: { ...note },
					);
					vault.setState({ notes: nextNotes });

					// No dirty paths are supplied: reconciliation must discover the change itself.
					cache.reconcile(mdFiles(), CONFIG, vault.resolveLinkPath);
					expect(sortedEntries(cacheDigests(cache))).toEqual(
						sortedEntries(coldDigests(vault.state, vault)),
					);
				},
			),
		);
	});

	it('I3 a no-op reconcile writes nothing and preserves the digest', async () => {
		await assertProperty(
			'cache/i3__noop-reconcile',
			fc.property(stateArb, (state) => {
				const vault = createCacheVault(state);
				const cache = new NormalizedDocumentCache(vault.app);
				const files = liveNotes(state)
					.filter((note) => note.extension === 'md')
					.map((note) => vault.files.find((file) => file.path === note.path)!)
					.filter((file): file is TFile => file !== undefined);
				cache.reconcile(files, CONFIG, vault.resolveLinkPath);
				const digest = cache.digest();
				const stats = cache.reconcile(files, CONFIG, vault.resolveLinkPath).stats;

				expect(stats.add).toBe(0);
				expect(stats.update).toBe(0);
				expect(stats.remove).toBe(0);
				expect(cache.digest()).toBe(digest);
			}),
		);
	});

	it('I5 a rename re-normalizes under the new path', async () => {
		await assertProperty(
			'cache/i5__rename-converges',
			fc.property(
				stateArb,
				fc.integer({ min: 0, max: 4 }),
				fc.stringMatching(/^[a-z]{1,6}$/),
				(state, id, suffix) => {
					const vault = createCacheVault(state);
					const target = vault.state.notes.find(
						(note) =>
							note.id === id &&
							note.extension === 'md' &&
							!note.deleted &&
							!note.ignored,
					);
					if (!target) return;
					const cache = new NormalizedDocumentCache(vault.app);
					cache.reconcile(vault.files, CONFIG, vault.resolveLinkPath);

					const renamed = `notes/${target.basename}-${suffix}.md`;
					vault.setState({
						notes: vault.state.notes.map((note) =>
							note.id === id
								? { ...note, path: renamed, basename: `${note.basename}-${suffix}` }
								: { ...note },
						),
					});
					cache.reconcile(vault.files, CONFIG, vault.resolveLinkPath);

					expect(cache.get(target.path)).toBeUndefined();
					expect(cache.get(renamed)?.file.path).toBe(renamed);
					expect(sortedEntries(cacheDigests(cache))).toEqual(
						sortedEntries(coldDigests(vault.state, vault)),
					);
				},
			),
		);
	});

	it('I6 incremental backlink deltas equal a full rebuild', async () => {
		await assertProperty(
			'cache/i6__backlink-delta-equals-rebuild',
			fc.property(
				stateArb,
				fc.array(
					fc.record({
						id: fc.integer({ min: 0, max: 4 }),
						links: linksArb,
						ignored: fc.boolean(),
					}),
					{ maxLength: 2 },
				),
				(state, mutations) => {
					const vault = createCacheVault(state);
					const before = new BacklinkIndex(vault.app, (file) =>
						hasInternalRhizomeFlag(
							vault.cacheFor(file.path)?.frontmatter,
							INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
						),
					);
					before.snapshot();

					const nextNotes = state.notes.map((note) => {
						const mutation = mutations.find((candidate) => candidate.id === note.id);
						return mutation
							? { ...note, links: mutation.links, ignored: mutation.ignored }
							: { ...note };
					});
					const afterState: VaultState = { notes: nextNotes };

					vault.setState(afterState);
					before.reconcile();

					const freshVault = createCacheVault(afterState);
					const after = new BacklinkIndex(freshVault.app, (file) =>
						hasInternalRhizomeFlag(
							freshVault.cacheFor(file.path)?.frontmatter,
							INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
						),
					);
					after.snapshot();

					expect(sortedSnapshot(snapshotPaths(before))).toEqual(
						sortedSnapshot(snapshotPaths(after)),
					);
				},
			),
		);
	});

	it('I9 ignore-flag transitions remove and restore matches and backlinks', async () => {
		await assertProperty(
			'cache/i9__ignore-toggle-roundtrip',
			fc.asyncProperty(stateArb, fc.integer({ min: 0, max: 4 }), async (state, id) => {
				const target = state.notes.find(
					(note) => note.id === id && note.extension === 'md' && !note.deleted,
				);
				if (!target) return;
				const vault = createCacheVault({
					notes: state.notes.map((note) =>
						note.id === id ? { ...note, ignored: false } : { ...note },
					),
				});
				const cache = new NormalizedDocumentCache(vault.app);
				const index = new BacklinkIndex(vault.app, (file) =>
					hasInternalRhizomeFlag(
						vault.cacheFor(file.path)?.frontmatter,
						INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
					),
				);
				const queries = { target: 'path:"n' + id + '"' };
				const run = () =>
					runVaultQuery(vault.app, queries, {
						timeZone: 'UTC',
						referenceTimeMs: 1_700_000_000_000,
						cache,
						backlinkIndex: index,
					});

				const baseline = await run();
				expect(baseline['target']?.map((match) => match.file.path)).toContain(target.path);

				vault.setState({
					notes: vault.state.notes.map((note) =>
						note.id === id ? { ...note, ignored: true } : { ...note },
					),
				});
				const ignored = await run();
				expect(ignored['target']).toEqual([]);
				expect(cache.get(target.path)).toBeUndefined();

				vault.setState({
					notes: vault.state.notes.map((note) =>
						note.id === id ? { ...note, ignored: false } : { ...note },
					),
				});
				const restored = await run();
				expect(restored['target']?.map((match) => match.file.path)).toContain(target.path);
			}),
		);
	});

	it('I1 a random operation sequence keeps warm and cold equivalent at every step', async () => {
		await assertProperty(
			'cache/i1__sequence-warm-equals-cold',
			fc.asyncProperty(
				stateArb,
				fc.array(mutationArb, { maxLength: 3 }),
				async (state, mutations) => {
					const vault = createCacheVault(state);
					const cache = new NormalizedDocumentCache(vault.app);
					const queries = { work: '#work', active: '[status: active]' };

					for (const mutation of mutations) {
						vault.setState(applyMutation(vault.state, mutation));

						const warm = await runVaultQuery(vault.app, queries, {
							timeZone: 'UTC',
							referenceTimeMs: 1_700_000_000_000,
							cache,
						});
						const cold = await runVaultQuery(vault.app, queries, {
							timeZone: 'UTC',
							referenceTimeMs: 1_700_000_000_000,
						});
						const paths = (result: typeof warm) =>
							Object.fromEntries(
								Object.entries(result).map(([key, matches]) => [
									key,
									matches.map((match) => match.file.path),
								]),
							);
						expect(paths(warm)).toEqual(paths(cold));
						expect(sortedEntries(cacheDigests(cache))).toEqual(
							sortedEntries(coldDigests(vault.state, vault)),
						);
					}
				},
			),
		);
	});

	it('I3 earlier payloads are unchanged by later operations', async () => {
		await assertProperty(
			'cache/i3__payload-immutable',
			fc.property(stateArb, mutationArb, (state, mutation) => {
				const vault = createCacheVault(state);
				const cache = new NormalizedDocumentCache(vault.app);
				cache.reconcile(mdFiles(vault), CONFIG, vault.resolveLinkPath);
				const before = [...cache.entries()].map(
					([path, doc]) => [path, doc, JSON.stringify(doc)] as const,
				);

				vault.setState(applyMutation(vault.state, mutation));
				cache.reconcile(mdFiles(vault), CONFIG, vault.resolveLinkPath);

				for (const [, doc, json] of before) {
					expect(JSON.stringify(doc)).toBe(json);
				}
			}),
		);
	});

	it('I4 cached documents and projected matches are deeply frozen', async () => {
		await assertProperty(
			'cache/i4__all-frozen',
			fc.asyncProperty(stateArb, mutationArb, async (state, mutation) => {
				const vault = createCacheVault(state);
				const cache = new NormalizedDocumentCache(vault.app);
				vault.setState(applyMutation(vault.state, mutation));
				const result = await runVaultQuery(
					vault.app,
					{ work: '#work', all: 'path:"notes"' },
					{
						timeZone: 'UTC',
						referenceTimeMs: 1_700_000_000_000,
						cache,
					},
				);
				for (const [, doc] of cache.entries()) {
					expectDeepFrozen(doc);
				}
				for (const matches of Object.values(result)) {
					for (const match of matches) {
						expectDeepFrozen(match);
					}
				}

				const index = new BacklinkIndex(vault.app, () => false);
				const cold = await runVaultQuery(
					vault.app,
					{ work: '#work', all: 'path:"notes"', inbound: 'backlinks:"notes"' },
					{
						timeZone: 'UTC',
						referenceTimeMs: 1_700_000_000_000,
						backlinks: index.snapshot(),
					},
				);
				for (const matches of Object.values(cold)) {
					for (const match of matches) {
						expectDeepFrozen(match);
					}
				}
			}),
		);
	});

	it('I8 ignored notes are never visible in the cache, results, or backlinks', async () => {
		await assertProperty(
			'cache/i8__ignored-never-visible',
			fc.asyncProperty(stateArb, async (state) => {
				const vault = createCacheVault(state);
				const cache = new NormalizedDocumentCache(vault.app);
				const index = new BacklinkIndex(vault.app, (file) =>
					hasInternalRhizomeFlag(
						vault.cacheFor(file.path)?.frontmatter,
						INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
					),
				);
				const ignoredPaths = state.notes
					.filter((note) => note.ignored && !note.deleted)
					.map((note) => note.path);
				const result = await runVaultQuery(
					vault.app,
					{ all: 'path:"notes"', work: '#work' },
					{
						timeZone: 'UTC',
						referenceTimeMs: 1_700_000_000_000,
						cache,
						backlinkIndex: index,
					},
				);
				for (const path of ignoredPaths) {
					expect(cache.get(path)).toBeUndefined();
				}
				for (const matches of Object.values(result)) {
					for (const match of matches) {
						expect(ignoredPaths).not.toContain(match.file.path);
					}
				}
				const snapshot = snapshotPaths(index);
				for (const [target, sources] of snapshot) {
					expect(ignoredPaths).not.toContain(target);
					for (const source of sources.keys()) {
						expect(ignoredPaths).not.toContain(source);
					}
				}
			}),
		);
	});

	it('I9 rename sequences leave no stale paths', async () => {
		await assertProperty(
			'cache/i9__no-stale-paths',
			fc.asyncProperty(
				stateArb,
				fc.array(
					fc.record({
						id: fc.integer({ min: 0, max: 4 }),
						suffix: fc.stringMatching(/^[a-z]{1,5}$/),
					}),
					{ maxLength: 3 },
				),
				async (state, renames) => {
					const vault = createCacheVault(state);
					const cache = new NormalizedDocumentCache(vault.app);
					const renamedOldPaths: string[] = [];
					for (const rename of renames) {
						const target = vault.state.notes.find(
							(note) =>
								note.id === rename.id && note.extension === 'md' && !note.deleted,
						);
						if (!target) continue;
						renamedOldPaths.push(target.path);
						vault.setState(
							applyMutation(vault.state, {
								kind: 'rename',
								id: rename.id,
								suffix: rename.suffix,
							}),
						);
					}
					const result = await runVaultQuery(
						vault.app,
						{ all: 'path:"notes"' },
						{
							timeZone: 'UTC',
							referenceTimeMs: 1_700_000_000_000,
							cache,
						},
					);
					const expected = new Set(
						vault.state.notes
							.filter(
								(note) => note.extension === 'md' && !note.deleted && !note.ignored,
							)
							.map((note) => note.path),
					);
					expect(new Set(cache.keys())).toEqual(expected);
					for (const path of renamedOldPaths) {
						expect(cache.get(path)).toBeUndefined();
					}
					for (const match of result['all'] ?? []) {
						expect(expected.has(match.file.path)).toBe(true);
					}
				},
			),
		);
	});

	it('I10 same stat with new metadata identity refreshes the entry', async () => {
		await assertProperty(
			'cache/i10__mtime-lag-refresh',
			fc.asyncProperty(stateArb, async (state) => {
				const vault = createCacheVault(state);
				const cache = new NormalizedDocumentCache(vault.app);
				cache.reconcile(mdFiles(vault), CONFIG, vault.resolveLinkPath);
				const signatureBefore = cache.digest();

				const next = {
					notes: vault.state.notes.map((note) => ({
						...note,
						cacheVersion: note.cacheVersion + 1,
					})),
				};
				vault.setState(next);
				const stats = cache.reconcile(mdFiles(vault), CONFIG, vault.resolveLinkPath).stats;
				if (
					next.notes.some(
						(note) => note.extension === 'md' && !note.ignored && !note.deleted,
					)
				) {
					expect(stats.update).toBeGreaterThan(0);
				}
				expect(sortedEntries(cacheDigests(cache))).toEqual(
					sortedEntries(coldDigests(next, vault)),
				);
				if (stats.update === 0) {
					expect(cache.digest()).toBe(signatureBefore);
				}
			}),
		);
	});

	it('I11 in-place TFile move and link rebinding match cold normalization across sync and async reconcile', async () => {
		await assertProperty(
			'cache/i11__in-place-move-and-relink-equals-cold',
			fc.asyncProperty(
				stateArb,
				fc.subarray([0, 1, 2, 3, 4], { minLength: 1, maxLength: 5 }),
				fc.constantFrom('Archive', 'Projects/2026', ''),
				async (state, movedIds, targetFolder) => {
					const vault = createCacheVault(state);
					const bodyCache = new BodyScanCache(
						vault.app,
						undefined,
						new BodyScanIdbStore('prop-move', null),
						() => 1_700_000_100_000,
					);
					for (const file of mdFiles(vault)) {
						bodyCache.ingestFromText(
							file,
							'[inline_owner:: alice]\n- [ ] Task item 📅 2026-11-20',
						);
					}

					const syncCache = new NormalizedDocumentCache(vault.app, undefined, bodyCache);
					const asyncCache = new NormalizedDocumentCache(vault.app, undefined, bodyCache);
					const typedConfig = makeConfig({ priority: 'number' });

					syncCache.reconcile(mdFiles(vault), typedConfig, vault.resolveLinkPath);
					await asyncCache.reconcileAsync(
						mdFiles(vault),
						typedConfig,
						vault.resolveLinkPath,
						{
							sliceBudgetMs: 0,
						},
					);

					// Mutate selected live TFiles IN PLACE (same TFile & CachedMetadata object identity!)
					const movedSet = new Set(movedIds);
					const liveAllFiles = vault.files.filter(
						(f) => !(f as { deleted?: boolean }).deleted,
					);
					const cacheMap = new Map<string, ReturnType<typeof vault.cacheFor>>();
					for (const f of liveAllFiles) {
						cacheMap.set(f.path, vault.cacheFor(f.path));
					}

					for (const f of liveAllFiles) {
						const idMatch = /^notes\/n(\d+)/.exec(f.path);
						if (!idMatch) continue;
						const id = Number(idMatch[1]);
						if (!movedSet.has(id) || !f.path.endsWith('.md')) continue;
						const oldPath = f.path;
						const cachedMeta = cacheMap.get(oldPath) ?? null;
						const newBasename = `${f.basename}-moved`;
						const newName = `${newBasename}.md`;
						const newPath = targetFolder ? `${targetFolder}/${newName}` : newName;
						if (newPath === oldPath) continue;

						cacheMap.delete(oldPath);
						(f as { path: string }).path = newPath;
						(f as { name: string }).name = newName;
						(f as { basename: string }).basename = newBasename;
						(f as { parent: { path: string } }).parent = { path: targetFolder };
						cacheMap.set(newPath, cachedMeta);
						bodyCache.rename(oldPath, newPath);
						syncCache.rename(oldPath, newPath);
						asyncCache.rename(oldPath, newPath);
					}

					// Wire live metadataCache & link resolution against mutated in-place TFiles
					(
						vault.app.metadataCache as unknown as {
							getFileCache: (file: TFile) => unknown;
						}
					).getFileCache = (file: TFile) => cacheMap.get(file.path) ?? null;

					const liveResolver = (raw: string): string | null => {
						const hit = liveAllFiles.find(
							(f) =>
								f.path === raw ||
								f.basename === raw ||
								f.basename === `${raw}-moved`,
						);
						return hit ? hit.path : null;
					};
					const nextResolvedLinks: Record<string, Record<string, number>> = {};
					for (const f of liveAllFiles) {
						const meta = cacheMap.get(f.path);
						const out: Record<string, number> = {};
						for (const l of meta?.links ?? []) {
							const dest = liveResolver(l.link);
							if (dest) out[dest] = (out[dest] ?? 0) + 1;
						}
						nextResolvedLinks[f.path] = out;
					}
					(
						vault.app.metadataCache as unknown as {
							resolvedLinks: Record<string, Record<string, number>>;
						}
					).resolvedLinks = nextResolvedLinks;

					const currentMdFiles = liveAllFiles.filter((f) =>
						f.path.toLowerCase().endsWith('.md'),
					);
					syncCache.reconcile(currentMdFiles, typedConfig, liveResolver);
					await asyncCache.reconcileAsync(currentMdFiles, typedConfig, liveResolver, {
						sliceBudgetMs: 0,
					});

					expect(asyncCache.digest()).toBe(syncCache.digest());

					for (const f of currentMdFiles) {
						const meta = cacheMap.get(f.path) ?? null;
						if (
							hasInternalRhizomeFlag(
								meta?.frontmatter,
								INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
							)
						) {
							expect(syncCache.get(f.path)).toBeUndefined();
							continue;
						}
						const syncDoc = syncCache.get(f.path)!;
						const asyncDoc = asyncCache.get(f.path)!;
						expect(syncDoc).toBeDefined();
						expect(asyncDoc).toBeDefined();
						assertFrozen(syncDoc);
						assertFrozen(asyncDoc);
						expect(getInternalFileEpochMs(syncDoc.file)).toEqual({
							ctime: f.stat.ctime,
							mtime: f.stat.mtime,
						});

						const coldDoc = normalizeObsidianMetadata(
							f,
							meta,
							typedConfig,
							bodyCache.getInlineProperties(f.path),
							liveResolver,
							bodyCache.getTasks(f.path),
						);
						expect(digestNormalizedDocument(syncDoc)).toBe(
							digestNormalizedDocument(coldDoc),
						);
						expect(digestNormalizedDocument(asyncDoc)).toBe(
							digestNormalizedDocument(coldDoc),
						);
					}
				},
			),
		);
	});
});
