import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { BacklinkIndex } from '../../src/adapters/backlink-index';
import { DirtySet } from '../../src/adapters/dirty-set';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import { runVaultQuery } from '../../src/adapters/vault-query-runner';
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
		const dirty = new DirtySet();
		const index = new BacklinkIndex(vault.app, () => false);
		const options = {
			timeZone: 'UTC',
			referenceTimeMs: 1_700_000_000_000,
			cache,
			backlinkIndex: index,
			dirtySet: dirty,
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
});
