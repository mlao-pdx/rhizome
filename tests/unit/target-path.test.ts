import { describe, expect, it } from 'vitest';
import {
	normalizeAndValidateTargetPath,
	renderRhizomeTemplate,
	resolveInitialNewNoteTargetPath,
	TargetPathClaimRegistry,
} from '../../src/core/templates';

describe('normalizeAndValidateTargetPath & TargetPathClaimRegistry', () => {
	it('strips leading slashes at vault root vs subfolders, collapses repeated slashes, and appends .md', () => {
		expect(normalizeAndValidateTargetPath('/untitled')).toEqual({
			ok: true,
			path: 'untitled.md',
		});
		expect(normalizeAndValidateTargetPath('Projects//2026/Kickoff')).toEqual({
			ok: true,
			path: 'Projects/2026/Kickoff.md',
		});
		expect(normalizeAndValidateTargetPath('  /Areas/Health/Log.MD  ')).toEqual({
			ok: true,
			path: 'Areas/Health/Log.md',
		});
	});

	it('rejects traversal, dot-directories, configDir, ◊Rhizome/logs, empty names, control chars, and OS-illegal filename chars', () => {
		const badInputs = [
			'',
			'   ',
			'/',
			'Projects/',
			'.md',
			'../escape',
			'Projects/../escape.md',
			'.hidden/note.md',
			'Projects/.secret.md',
			'Projects/trailingdot./note.md',
			'Projects/note..md',
			'◊Rhizome/logs/2026-11-23.md',
			'◊rhizome/logs/nested/entry',
			'Notes/Back\\Slash',
			'Notes/Colon:Title',
			'Notes/Star*Title',
			'Notes/Question?Title',
			'Notes/Quote"Title',
			'Notes/Angle<Title>',
			'Notes/Pipe|Title',
			'Notes/Line\nBreak',
			'Notes/Null\x00Byte',
		];

		for (const input of badInputs) {
			const res = normalizeAndValidateTargetPath(input);
			expect(res.ok, `Expected '${input}' to be rejected`).toBe(false);
			if (!res.ok) {
				expect(res.diagnostic.code).toBe('INVALID_TARGET_PATH');
			}
		}

		// Custom configDir rejection
		const customCfg = normalizeAndValidateTargetPath('CustomConfig/themes/x.md', {
			configDir: 'CustomConfig',
		});
		expect(customCfg.ok).toBe(false);
	});

	it('resolves collisions case-insensitively against vault paths and inter-block claims while replacing intra-block claims cleanly', () => {
		const registry = new TargetPathClaimRegistry([
			'Projects/Kickoff.md',
			'Projects/Kickoff 1.md',
			'untitled.md',
		]);

		// Initial seed for block 0 collides with vault's 'untitled.md' -> 'untitled 1.md'
		const seed0 = resolveInitialNewNoteTargetPath('', 0, registry);
		expect(seed0).toBe('untitled 1.md');

		// Block 0 calls {% targetPath "Projects/kickoff" %}: case-insensitively collides with Kickoff.md & Kickoff 1.md -> Kickoff 2.md
		const claim0First = registry.claim(0, 'Projects/kickoff.md');
		expect(claim0First).toBe('Projects/kickoff 2.md');

		// Calling claim again on Block 0 with the exact same path is idempotent (does NOT self-collide to Kickoff 3.md!)
		expect(registry.claim(0, 'Projects/kickoff 2.md')).toBe('Projects/kickoff 2.md');

		// Block 0 released 'untitled 1.md' when it switched to 'Projects/kickoff 2.md', so Block 1 gets 'untitled 1.md'!
		const seed1 = resolveInitialNewNoteTargetPath('', 1, registry);
		expect(seed1).toBe('untitled 1.md');

		// Block 1 now requests 'Projects/Kickoff.md': collides with vault (Kickoff, Kickoff 1) AND Block 0 (kickoff 2) -> Kickoff 3.md
		expect(registry.claim(1, 'Projects/Kickoff.md')).toBe('Projects/Kickoff 3.md');
	});

	it('parses {% targetPath %} expressions + optional active/closed tab modes and updates virtual this in newNote mode', async () => {
		const registry = new TargetPathClaimRegistry(['Projects/Sprint 1.md']);
		const source = [
			'Initial: {{ targetPath }} | {{ this.file.path }}',
			'{% assign n = 1 %}',
			'{% targetPath "Projects/Sprint " | append: n active %}',
			'After: {{ targetPath }} | {{ this.file.name }} | {{ this.file.basename }} | {{ this.file.parent }} | {{ this.file.ext }}',
		].join('\n');

		const res = await renderRhizomeTemplate(source, {
			runQueries: async () => ({}),
			runtimeContext: {
				trigger: 'newNote',
				referenceTimeMs: Date.UTC(2026, 10, 23, 19, 3, 0),
				timeZone: 'UTC',
				claimRegistry: registry,
				blockIndex: 0,
			},
		});

		expect(res.ok).toBe(true);
		expect(res.targetPath).toBe('Projects/Sprint 1 1.md');
		expect(res.tabMode).toBe('active');
		expect(res.markdown).toContain('Initial: untitled.md | untitled.md');
		expect(res.markdown).toContain(
			'After: Projects/Sprint 1 1.md | Sprint 1 1.md | Sprint 1 1 | Projects | md',
		);
	});

	it('supports filter arguments named active/closed vs trailing mode keywords and rejects invalid mode tokens', async () => {
		const resWithDefaultVar = await renderRhizomeTemplate(
			'{% assign active = "Inbox/Fallback" %}{% targetPath missing_var | default: active closed %}{{ targetPath }}',
			{
				runQueries: async () => ({}),
				runtimeContext: { trigger: 'newNote', timeZone: 'UTC' },
			},
		);
		expect(resWithDefaultVar.ok).toBe(true);
		expect(resWithDefaultVar.targetPath).toBe('Inbox/Fallback.md');
		expect(resWithDefaultVar.tabMode).toBe('closed');

		const badMode = await renderRhizomeTemplate('{% targetPath "Inbox/Note" sideways %}', {
			runQueries: async () => ({}),
			runtimeContext: { trigger: 'newNote', timeZone: 'UTC' },
		});
		expect(badMode.ok).toBe(false);
		expect(badMode.diagnostics[0]?.code).toBe('INVALID_TARGET_PATH_ARGS');

		const badPathRuntime = await renderRhizomeTemplate('{% targetPath "../escape" %}', {
			runQueries: async () => ({}),
			runtimeContext: { trigger: 'newNote', timeZone: 'UTC' },
		});
		expect(badPathRuntime.ok).toBe(false);
		expect(badPathRuntime.diagnostics[0]?.code).toBe('INVALID_TARGET_PATH');
	});

	it('loads only target parent folders via lazy lookup and preserves basePath on commit-time reverifyClaim when external files appear mid-preflight', () => {
		const queriedParents: string[] = [];
		const folderChildren = new Map<string, string[]>([
			['projects', ['Projects/Alpha.md']],
			['archive', ['Archive/Huge1.md', 'Archive/Huge2.md']],
		]);

		const registry = new TargetPathClaimRegistry((parentDir) => {
			queriedParents.push(parentDir);
			return folderChildren.get(parentDir.toLowerCase()) ?? [];
		});

		// Preflight: Block 0 and Block 1 both target 'Projects/Alpha.md'
		expect(registry.claim(0, 'Projects/Alpha.md')).toBe('Projects/Alpha 1.md');
		expect(registry.claim(1, 'Projects/Alpha.md')).toBe('Projects/Alpha 2.md');
		expect(queriedParents).toEqual(['Projects']);

		// Simulate an external sync adding 'Projects/Alpha 1.md' mid-preflight before commit
		folderChildren.set('projects', ['Projects/Alpha.md', 'Projects/Alpha 1.md']);
		registry.resetLoadedDirectories();

		// Block 0 re-claims from its original unsuffixed basePath ('Projects/Alpha.md'), skipping
		// both external 'Projects/Alpha 1.md' AND Block 1's held 'Projects/Alpha 2.md' -> 'Projects/Alpha 3.md'!
		expect(registry.reverifyClaim(0, 'Projects/Alpha 1.md')).toBe('Projects/Alpha 3.md');
		expect(registry.reverifyClaim(1, 'Projects/Alpha 2.md')).toBe('Projects/Alpha 2.md');
	});
});
