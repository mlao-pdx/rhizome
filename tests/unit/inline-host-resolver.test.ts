import type { App, TFile as ObsidianTFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { BacklinkIndex } from '../../src/adapters/backlink-index';
import { InlineHostResolver } from '../../src/adapters/inline-host-resolver';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import { INTERNAL_RHIZOME_CODES } from '../../src/core/search';
import type { LoggerPort, LogLevel } from '../../src/ports/logger-port';
import { createMockApp, TFile } from '../support/mock-obsidian-app';

function makeFile(path: string, mtime: number = 1000): ObsidianTFile {
	const file = new TFile();
	const slash = path.lastIndexOf('/');
	const dot = path.lastIndexOf('.');
	file.path = path;
	file.name = slash === -1 ? path : path.slice(slash + 1);
	file.basename = dot === -1 ? file.name : file.name.slice(0, dot - (slash + 1));
	file.extension = dot === -1 ? '' : path.slice(dot + 1);
	file.parent = slash === -1 ? { path: '' } : { path: path.slice(0, slash) };
	file.stat = { ctime: 1000, mtime, size: 120 };
	return file as unknown as ObsidianTFile;
}

function createMemoryLogger(): {
	logger: LoggerPort;
	entries: Array<{ level: LogLevel; message: string; meta: Record<string, unknown> | undefined }>;
} {
	const entries: Array<{
		level: LogLevel;
		message: string;
		meta: Record<string, unknown> | undefined;
	}> = [];
	return {
		entries,
		logger: {
			log(level, message, meta) {
				entries.push({ level, message, meta });
			},
		},
	};
}

describe('InlineHostResolver (O(1) host resolution & per-note subscriptions)', () => {
	it('resolves host notes in O(1) without vault-wide scans after BacklinkIndex build, excludes DO_NOT_INDEX_OR_QUERY, and projects backlinks', () => {
		const alpha = makeFile('Projects/Alpha.md', 100);
		const beta = makeFile('Notes/Beta.md', 100);
		const ignored = makeFile('Logs/Diag.md', 100);

		const fileCache = new Map<string, unknown>([
			[
				alpha.path,
				{
					frontmatter: { status: 'active' },
					headings: [{ heading: 'Overview', level: 2, position: { start: { line: 4 } } }],
				},
			],
			[beta.path, { frontmatter: { status: 'draft' } }],
			[
				ignored.path,
				{
					frontmatter: {
						'◊InternalRhizome': {
							[INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY]: true,
						},
					},
				},
			],
		]);

		const resolvedLinks: Record<string, Record<string, number>> = {
			[beta.path]: { [alpha.path]: 1 },
		};

		const app = createMockApp({
			files: [alpha, beta, ignored],
			fileCache,
			resolvedLinks,
		}) as App;

		const backlinkIndex = new BacklinkIndex(app, () => false);
		const documentCache = new NormalizedDocumentCache(app);
		documentCache.setReady(true);
		const resolver = new InlineHostResolver(app, undefined, backlinkIndex, documentCache);

		// Warm up initial BacklinkIndex build once
		const first = resolver.resolveSync(alpha.path);
		expect(first.hostMatch?.file.basename).toBe('Alpha');
		expect(first.hostMatch?.properties.status).toBe('active');
		expect(first.hostMatch?.backlinks.map((b) => b.path)).toEqual(['Notes/Beta.md']);

		// Subsequent resolveSync calls (simulating editor selection/typing) do ZERO getFiles / getMarkdownFiles calls
		const getFilesSpy = vi.spyOn(app.vault, 'getFiles');
		const getMdSpy = vi.spyOn(app.vault, 'getMarkdownFiles');
		const second = resolver.resolveSync(alpha.path);
		expect(second).toBe(first);
		expect(getFilesSpy).not.toHaveBeenCalled();
		expect(getMdSpy).not.toHaveBeenCalled();

		// Excluded DO_NOT_INDEX_OR_QUERY notes resolve to null
		expect(resolver.resolveSync(ignored.path).hostMatch).toBeNull();
		expect(resolver.resolveSync('').hostMatch).toBeNull();
		expect(resolver.resolveSync('Missing/None.md').hostMatch).toBeNull();
	});

	it('notifies subscribers only when the host revisionHash or heading structure changes, handles renames, and deduplicates sensitive warnings', () => {
		const alpha = makeFile('Projects/Alpha.md', 100);
		const peer = makeFile('Notes/Peer.md', 100);
		const unrelated = makeFile('Notes/Unrelated.md', 100);
		const files: ObsidianTFile[] = [alpha, peer, unrelated];

		const fileCache = new Map<string, unknown>([
			[
				alpha.path,
				{
					frontmatter: { status: 'active' },
					headings: [{ heading: 'Intro', level: 2, position: { start: { line: 2 } } }],
				},
			],
			[peer.path, { frontmatter: {} }],
			[unrelated.path, { frontmatter: { tag: 'x' } }],
		]);
		const resolvedLinks: Record<string, Record<string, number>> = {
			[peer.path]: {},
		};

		const app = createMockApp({ files, fileCache, resolvedLinks }) as App;
		const { logger, entries } = createMemoryLogger();
		const backlinkIndex = new BacklinkIndex(app, () => false);
		const documentCache = new NormalizedDocumentCache(app);
		documentCache.setReady(true);
		const resolver = new InlineHostResolver(app, logger, backlinkIndex, documentCache);

		let changeCount = 0;
		const renamedPaths: string[] = [];
		const abortController = new AbortController();

		resolver.subscribe(
			alpha.path,
			{
				onChange: () => {
					changeCount++;
				},
				onRename: (nextPath) => {
					renamedPaths.push(nextPath);
				},
			},
			abortController.signal,
		);
		expect(resolver.activePathCount).toBe(1);

		// 1. Editing an unrelated note (or Alpha's own headings/frontmatter without link changes)
		// does ZERO full-vault `backlinkIndex.reconcile()` calls!
		const reconcileSpy = vi.spyOn(backlinkIndex, 'reconcile');
		unrelated.stat.mtime = 200;
		fileCache.set(unrelated.path, { frontmatter: { tag: 'y' } });
		resolver.notifyMetadataChanged(unrelated.path);
		expect(changeCount).toBe(0);
		expect(reconcileSpy).not.toHaveBeenCalled();

		// 2. Peer adding an outgoing link to Alpha updates Alpha's backlinks -> reconciles once and fires onChange
		resolvedLinks[peer.path] = { [alpha.path]: 1 };
		resolver.notifyLinksResolved();
		expect(changeCount).toBe(1);
		expect(reconcileSpy).toHaveBeenCalledTimes(1);
		expect(resolver.resolveSync(alpha.path).hostMatch?.backlinks.map((b) => b.path)).toEqual([
			'Notes/Peer.md',
		]);

		// 3. Shifting a heading's line number inside Alpha (no outgoing link change) fires onChange with ZERO backlink reconcile
		reconcileSpy.mockClear();
		alpha.stat.mtime = 300;
		fileCache.set(alpha.path, {
			frontmatter: { status: 'active' },
			headings: [{ heading: 'Intro', level: 2, position: { start: { line: 10 } } }],
		});
		resolver.notifyMetadataChanged(alpha.path);
		expect(changeCount).toBe(2);
		expect(reconcileSpy).not.toHaveBeenCalled();

		// 4. Deduplicated warning logging wraps vault-derived strings in `‼️...‼️`
		resolver.logInlineWarningOnce(alpha.path, 'this.secret | bad', {
			code: 'TEMPLATE_SYNTAX_ERROR',
			issue: 'undefined filter: bad',
		});
		resolver.logInlineWarningOnce(alpha.path, 'this.secret | bad', {
			code: 'TEMPLATE_SYNTAX_ERROR',
			issue: 'undefined filter: bad',
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]?.level).toBe('warn');
		expect(entries[0]?.meta?.source).toBe('template.inline');
		expect(entries[0]?.message).toContain('‼️Projects/Alpha.md‼️');
		expect(entries[0]?.meta?.expression).toBe('‼️this.secret | bad‼️');
		expect(entries[0]?.meta?.issue).toBe('‼️undefined filter: bad‼️');

		// 5. Renaming Alpha -> RenamedAlpha propagates to onRename and re-keys bucket
		const oldPath = alpha.path;
		alpha.path = 'Projects/RenamedAlpha.md';
		alpha.name = 'RenamedAlpha.md';
		alpha.basename = 'RenamedAlpha';
		fileCache.delete(oldPath);
		fileCache.set(alpha.path, { frontmatter: { status: 'active' } });
		documentCache.rename(oldPath, alpha.path);
		resolver.notifyFileRename(oldPath, alpha.path);
		expect(renamedPaths).toEqual(['Projects/RenamedAlpha.md']);
		expect(changeCount).toBe(3);

		// 6. Aborting signal unsubscribes cleanly
		abortController.abort();
		expect(resolver.activePathCount).toBe(0);
	});
});
