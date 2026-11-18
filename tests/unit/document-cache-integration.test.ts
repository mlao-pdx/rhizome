import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { ActiveQueryRoster } from '../../src/adapters/active-query-roster';
import { BacklinkIndex } from '../../src/adapters/backlink-index';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import {
	resolveHostDocument,
	runVaultQuery,
	type VaultQueryResult,
} from '../../src/adapters/vault-query-runner';
import type { LoggerPort } from '../../src/ports/logger-port';
import { makeConfig } from '../support/cache-fixtures';
import { createCacheVault, noteModel } from '../support/cache-vault';

function prepared() {
	return createCacheVault({
		notes: [
			noteModel({ id: 0, tags: ['#work'] }),
			noteModel({ id: 1, links: ['n0'], status: 'active' }),
			noteModel({ id: 2, links: ['n1'], status: 'archived' }),
		],
	});
}

describe('document cache integration', () => {
	it('projects backlinks onto a new object without mutating the cached document', async () => {
		const vault = prepared();
		const cache = new NormalizedDocumentCache(vault.app);
		const index = new BacklinkIndex(vault.app, () => false);

		const result = await runVaultQuery(
			vault.app,
			{ active: '[status: active]' },
			{
				timeZone: 'UTC',
				referenceTimeMs: 1_700_000_000_000,
				cache,
				backlinkIndex: index,
			},
		);
		const match = result['active']?.find((candidate) => candidate.file.path === 'notes/n1.md');
		expect(match).toBeDefined();
		expect(match?.backlinks.map((backlink) => backlink.path)).toContain('notes/n2.md');
		expect(cache.get('notes/n1.md')?.backlinks).toBeUndefined();
		expect(Object.isFrozen(match)).toBe(true);
	});

	it('a backlink-only change does not re-normalize the cached target', async () => {
		const vault = prepared();
		const cache = new NormalizedDocumentCache(vault.app);
		const config = makeConfig();
		cache.reconcile(vault.files, config, vault.resolveLinkPath);
		const before = cache.get('notes/n0.md');
		const beforeDigest = cache.digest();

		vault.setState({
			notes: vault.state.notes.map((note) =>
				note.id === 2 ? { ...note, links: ['n0'] } : { ...note },
			),
		});
		const stats = cache.reconcile(vault.files, config, vault.resolveLinkPath).stats;

		expect(cache.get('notes/n0.md')).toBe(before);
		expect(cache.get('notes/n2.md')).not.toBeUndefined();
		expect(cache.digest()).not.toBe(beforeDigest);
		expect(stats.update).toBeGreaterThan(0); // n2's own links changed
	});

	it('warm passes keep the cache digest stable and project the same values', async () => {
		const vault = prepared();
		const cache = new NormalizedDocumentCache(vault.app);
		const index = new BacklinkIndex(vault.app, () => false);
		const options = {
			timeZone: 'UTC',
			referenceTimeMs: 1_700_000_000_000,
			cache,
			backlinkIndex: index,
		};

		const first = await runVaultQuery(
			vault.app,
			{ work: '#work', all: 'path:"notes"' },
			options,
		);
		const digest = cache.digest();
		const second = await runVaultQuery(
			vault.app,
			{ work: '#work', all: 'path:"notes"' },
			options,
		);

		expect(cache.digest()).toBe(digest);
		expect(second).toEqual(first);
		// Unchanged notes reuse the exact same frozen VaultQueryMatch object reference across passes
		expect(second['work']?.[0]).toBe(first['work']?.[0]);
		expect(second['all']?.[0]).toBe(first['all']?.[0]);
		expect(second['all']?.[1]).toBe(first['all']?.[1]);
		expect(second['all']?.[2]).toBe(first['all']?.[2]);
	});

	it('includes pre-pass reconciliation time in query.run reconcileMs and durationMs during reactive nudge', async () => {
		const vault = prepared();
		const calls: Array<{ source: string; [key: string]: unknown }> = [];
		const logger: LoggerPort = {
			log(_level, _message, meta) {
				calls.push(meta);
			},
		};
		const cache = new NormalizedDocumentCache(vault.app, logger);
		const index = new BacklinkIndex(vault.app, () => false, logger);
		const roster = new ActiveQueryRoster(vault.app, logger, index, cache);
		const queries = { all: 'path:"notes"' };
		const options = { timeZone: 'UTC', referenceTimeMs: 1_700_000_000_000 };
		const initial = await runVaultQuery(vault.app, queries, {
			...options,
			cache,
			backlinkIndex: index,
		});
		roster.register(queries, options, initial, () => {});
		calls.length = 0;

		const origReconcile = cache.reconcile.bind(cache);
		vi.spyOn(cache, 'reconcile').mockImplementation((files, cfg, resolver) => {
			const res = origReconcile(files, cfg, resolver);
			const end = Date.now() + 12;
			while (Date.now() < end) {
				// busy-wait to create measurable pre-pass reconciliation time
			}
			return res;
		});

		vault.setState({
			notes: vault.state.notes.map((note) =>
				note.id === 0 ? { ...note, mtime: note.mtime + 1 } : { ...note },
			),
		});
		await roster.nudge(1_700_000_000_000, { onlyIfChanged: true });

		const runLog = calls.find((c) => c.source === 'query.run');
		expect(runLog).toBeDefined();
		expect(runLog?.['reconcileMs'] as number).toBeGreaterThanOrEqual(10);
		expect(runLog?.['durationMs'] as number).toBeGreaterThanOrEqual(
			runLog?.['reconcileMs'] as number,
		);
		roster.clear();
	});

	it('skips a normalization failure per file instead of failing the pass', async () => {
		const vault = prepared();
		const bad = vault.files.find((file) => file.path === 'notes/n2.md')!;
		bad.stat = { ctime: Number.NaN, mtime: Number.NaN, size: Number.NaN };
		const logger = { log: vi.fn() };

		const result = await runVaultQuery(
			vault.app,
			{ all: 'path:"notes"' },
			{ timeZone: 'UTC', referenceTimeMs: 1_700_000_000_000 },
			logger,
		);

		expect(result['all']?.map((match) => match.file.path)).toEqual([
			'notes/n0.md',
			'notes/n1.md',
		]);
		expect(logger.log).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('notes/n2.md'),
			expect.anything(),
		);
	});

	it('does not build a cold cache before the vault is resolved', async () => {
		const vault = prepared();
		const cache = new NormalizedDocumentCache(vault.app);
		const config = makeConfig();
		cache.setReady(false);

		cache.reconcile(vault.files, config, vault.resolveLinkPath);
		expect(cache.size).toBe(0);

		cache.setReady(true);
		cache.reconcile(vault.files, config, vault.resolveLinkPath);
		expect(cache.size).toBe(3);
	});

	it('reconciles backlink index once per nudge and skips query evaluation when onlyIfChanged sees no changes', async () => {
		const vault = prepared();
		const calls: Array<{ source: string; [key: string]: unknown }> = [];
		const logger: LoggerPort = {
			log(_level, _message, meta) {
				calls.push(meta);
			},
		};
		const cache = new NormalizedDocumentCache(vault.app, logger);
		const index = new BacklinkIndex(vault.app, () => false);
		const roster = new ActiveQueryRoster(vault.app, logger, index, cache);
		const queries = { all: 'path:"notes"' };
		const options = { timeZone: 'UTC', referenceTimeMs: 1_700_000_000_000 };
		const initial = await runVaultQuery(vault.app, queries, {
			...options,
			cache,
			backlinkIndex: index,
		});
		roster.register(queries, options, initial, () => {});
		calls.length = 0;

		const reconcileSpy = vi.spyOn(index, 'reconcile');
		const before = cache.get('notes/n0.md');
		await roster.nudge(1_700_000_000_000, { onlyIfChanged: true });

		expect(reconcileSpy).toHaveBeenCalledTimes(1);
		expect(cache.get('notes/n0.md')).toBe(before);
		const cacheLog = calls.filter((call) => call.source === 'query.cache').at(-1);
		expect(cacheLog).toMatchObject({ add: 0, update: 0, remove: 0, changed: false });
		// Because neither cache nor backlinks changed, onlyIfChanged skips running the query scan
		expect(calls.filter((call) => call.source === 'query.run')).toHaveLength(0);
		roster.clear();
	});

	it('freezes the oracle host document before projection', () => {
		const vault = prepared();
		const index = new BacklinkIndex(vault.app, () => false);
		const doc = resolveHostDocument(
			vault.app,
			'notes/n0.md',
			makeConfig(),
			vault.resolveLinkPath,
			undefined,
			index.snapshot(),
			() => false,
		);

		expect(doc).not.toBeNull();
		expect(Object.isFrozen(doc)).toBe(true);
		expect(Object.isFrozen(doc?.file)).toBe(true);
		expect(Object.isFrozen(doc?.links)).toBe(true);
		expect(Object.isFrozen(doc?.backlinks)).toBe(true);
		expect(Object.isFrozen(doc?.backlinks?.[0])).toBe(true);
	});

	it('updates only the edited hub note, not the notes that link to it', async () => {
		const vault = createCacheVault({
			notes: [
				noteModel({ id: 0, tags: ['#hub'] }),
				noteModel({ id: 1, links: ['n0'] }),
				noteModel({ id: 2, links: ['n0'] }),
				noteModel({ id: 3, links: ['n0'] }),
			],
		});
		const calls: Array<{ source: string; [key: string]: unknown }> = [];
		const logger = {
			log(
				_level: string,
				_message: string,
				meta: { source: string; [key: string]: unknown },
			) {
				calls.push(meta);
			},
		};
		const cache = new NormalizedDocumentCache(vault.app, logger);
		const index = new BacklinkIndex(vault.app, () => false);
		const options = { timeZone: 'UTC', referenceTimeMs: 1_700_000_000_000 };

		await runVaultQuery(
			vault.app,
			{ all: 'path:"notes"' },
			{
				...options,
				cache,
				backlinkIndex: index,
			},
		);

		const reconcileSpy = vi.spyOn(index, 'reconcile');
		vault.setState({
			notes: vault.state.notes.map((note) =>
				note.id === 0
					? { ...note, status: 'archived', mtime: note.mtime + 1 }
					: { ...note },
			),
		});

		await runVaultQuery(
			vault.app,
			{ all: 'path:"notes"' },
			{
				...options,
				cache,
				backlinkIndex: index,
			},
		);

		expect(reconcileSpy).toHaveBeenCalledTimes(1);
		const cacheLog = calls.filter((call) => call.source === 'query.cache').at(-1);
		expect(cacheLog).toMatchObject({ add: 0, update: 1, remove: 0 });
	});

	it('reports unchanged entries as hits rather than rewrites', async () => {
		const vault = prepared();
		const calls: Array<{ source: string; [key: string]: unknown }> = [];
		const logger = {
			log(
				_level: string,
				_message: string,
				meta: { source: string; [key: string]: unknown },
			) {
				calls.push(meta);
			},
		};
		const cache = new NormalizedDocumentCache(vault.app, logger);
		const index = new BacklinkIndex(vault.app, () => false);
		const options = {
			timeZone: 'UTC',
			referenceTimeMs: 1_700_000_000_000,
			cache,
			backlinkIndex: index,
		};

		await runVaultQuery(vault.app, { all: 'path:"notes"' }, options);
		const first = calls.filter((call) => call.source === 'query.cache').at(-1);
		expect(first).toMatchObject({
			add: 3,
			update: 0,
			remove: 0,
			hits: 0,
			stale: 0,
			uncached: 0,
		});

		await runVaultQuery(vault.app, { all: 'path:"notes"' }, options);
		const second = calls.filter((call) => call.source === 'query.cache').at(-1);
		expect(second).toMatchObject({ add: 0, update: 0, remove: 0, hits: 3, stale: 0 });
		expect(
			(second?.['hits'] as number) +
				(second?.['add'] as number) +
				(second?.['update'] as number),
		).toBe(3);
	});

	it('reactive nudge matches a cold rebuild for backlink queries', async () => {
		const vault = prepared();
		const cache = new NormalizedDocumentCache(vault.app);
		const index = new BacklinkIndex(vault.app, () => false);
		const roster = new ActiveQueryRoster(vault.app, undefined, index, cache);
		const queries = { inbound: 'backlinks:"n2"', all: 'path:"notes"' };
		const options = { timeZone: 'UTC', referenceTimeMs: 1_700_000_000_000 };
		const initial = await runVaultQuery(vault.app, queries, {
			...options,
			cache,
			backlinkIndex: index,
		});
		const updates: VaultQueryResult[] = [];
		roster.register(queries, options, initial, (next) => {
			updates.push(next);
		});

		vault.setState({
			notes: vault.state.notes.map((note) =>
				note.id === 2
					? { ...note, links: ['n1', 'n0'], mtime: note.mtime + 1 }
					: { ...note },
			),
		});
		await roster.nudge(1_700_000_000_000, { onlyIfChanged: true });

		const coldIndex = new BacklinkIndex(vault.app, () => false);
		const cold = await runVaultQuery(vault.app, queries, {
			...options,
			backlinks: coldIndex.snapshot(),
		});
		const pluginQuery = await runVaultQuery(vault.app, queries, {
			...options,
			cache,
			backlinkIndex: index,
		});
		const paths = (result: VaultQueryResult) =>
			Object.fromEntries(
				Object.entries(result).map(([key, matches]) => [
					key,
					matches.map((match) => match.file.path),
				]),
			);

		expect(updates).toHaveLength(1);
		expect(updates[0]).toEqual(pluginQuery);
		expect(paths(updates[0]!)).toEqual(paths(cold));
		expect(updates[0]?.['inbound']?.map((match) => match.file.path)).toContain('notes/n0.md');
		roster.clear();
	});
});
