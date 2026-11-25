import type {
	App,
	MarkdownPostProcessorContext,
	PluginManifest,
	TFile as ObsidianTFile,
} from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { CodeBlockRenderCache } from '../../src/adapters/codeblock-render-cache';
import { computeCodeBlockSentinelHash } from '../../src/adapters/render-sentinel-store';
import { processRhizomeCodeBlock } from '../../src/adapters/rhizome-codeblock';
import RhizomePlugin from '../../src/main';
import { MockElement } from '../support/mock-dom';
import {
	createMockApp,
	createMockManifest,
	MarkdownRenderer,
	TFile,
} from '../support/mock-obsidian-app';

function makeFile(path: string): ObsidianTFile {
	const slash = path.lastIndexOf('/');
	const name = slash === -1 ? path : path.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const f = new TFile();
	f.path = path;
	f.name = name;
	f.basename = dot === -1 ? name : name.slice(0, dot);
	f.extension = dot === -1 ? '' : name.slice(dot + 1);
	f.parent = { path: slash === -1 ? '' : path.slice(0, slash) };
	f.stat = {
		ctime: Date.UTC(2026, 10, 20, 10, 0, 0),
		mtime: Date.UTC(2026, 10, 21, 12, 0, 0),
		size: 120,
	};
	return f as unknown as ObsidianTFile;
}

async function createWorkbenchHarness(typesJson?: Record<string, string>) {
	const files: ObsidianTFile[] = [];
	const fileCaches = new Map<string, Record<string, unknown>>();
	const contents = new Map<string, string>();

	const rawApp = createMockApp({
		files,
		markdownFiles: files,
		fileCache: fileCaches,
	}) as App & {
		vault: {
			cachedRead: (f: ObsidianTFile) => Promise<string>;
			adapter: {
				exists: (p: string) => Promise<boolean>;
				read: (p: string) => Promise<string>;
			};
			trigger: (event: string, ...args: unknown[]) => void;
		};
		metadataCache: {
			trigger: (event: string, ...args: unknown[]) => void;
		};
	};

	rawApp.vault.cachedRead = async (f: ObsidianTFile) => contents.get(f.path) ?? '';
	rawApp.vault.adapter.exists = async (p: string) =>
		p.endsWith('types.json') ? Boolean(typesJson) : contents.has(p);
	rawApp.vault.adapter.read = async (p: string) =>
		p.endsWith('types.json') && typesJson
			? JSON.stringify({ types: typesJson })
			: (contents.get(p) ?? '');

	const putNote = (path: string, body: string, cache: Record<string, unknown> = {}) => {
		let file = files.find((f) => f.path === path);
		if (!file) {
			file = makeFile(path);
			files.push(file);
		}
		contents.set(path, body);
		fileCaches.set(path, cache);
		return file;
	};

	const plugin = new RhizomePlugin(rawApp, createMockManifest() as PluginManifest);
	await plugin.onload();
	return { app: rawApp, plugin, files, fileCaches, contents, putNote };
}

describe('rhizome-sample Authoring & Diagnostics Workbench', () => {
	it('namespaces sentinel hashes and CodeBlockRenderCache entries by fence flavor', () => {
		const hProd = computeCodeBlockSentinelHash('Dash.md', '{{ "hi" }}', new Map(), 'rhizome');
		const hSample = computeCodeBlockSentinelHash(
			'Dash.md',
			'{{ "hi" }}',
			new Map(),
			'rhizome-sample',
		);
		expect(hProd).not.toBe(hSample);

		const cache = new CodeBlockRenderCache();
		const fakeResult = Object.freeze({
			ok: true,
			markdown: 'PROD',
			queries: Object.freeze([]),
			diagnostics: Object.freeze([]),
		});
		const fakeSampleResult = Object.freeze({
			ok: true,
			markdown: 'SAMPLE',
			queries: Object.freeze([]),
			diagnostics: Object.freeze([]),
		});
		cache.setRender('Dash.md', 'src', 0, {}, 0, 1, 'hash1', {}, fakeResult, 'rhizome');
		cache.setRender(
			'Dash.md',
			'src',
			0,
			{},
			0,
			1,
			'hash1',
			{},
			fakeSampleResult,
			'rhizome-sample',
			{ explainMarkdown: 'EXPLAIN' },
		);

		expect(cache.getRemountHit('Dash.md', 'src', 0, {}, 0, 1, 'rhizome')?.result.markdown).toBe(
			'PROD',
		);
		expect(
			cache.getRemountHit('Dash.md', 'src', 0, {}, 0, 1, 'rhizome-sample')?.result.markdown,
		).toBe('SAMPLE');

		cache.deleteForSourcePath('Dash.md');
		expect(cache.getRemountHit('Dash.md', 'src', 0, {}, 0, 1, 'rhizome')).toBeUndefined();
		expect(
			cache.getRemountHit('Dash.md', 'src', 0, {}, 0, 1, 'rhizome-sample'),
		).toBeUndefined();
	});

	it('renders Sample Preview + Explain Stack, stops Live Preview propagation on non-link interactions inside Explain Stack while allowing link clicks, and updates coercion warnings live on onUnchangedPayload', async () => {
		const h = await createWorkbenchHarness({ priority: 'number' });
		h.putNote('Notes/GoodTask.md', 'body', {
			tags: [{ tag: '#task', position: {} }],
			frontmatter: { priority: 5 },
		});
		const unmatchedNote = h.putNote('Notes/Unmatched.md', 'body', {
			frontmatter: { priority: 2 },
		});

		const renderedCalls: Array<{ markdown: string; el: HTMLElement }> = [];
		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, md, targetEl) => {
				renderedCalls.push({ markdown: md, el: targetEl as HTMLElement });
				(targetEl as MockElement).textContent = md;
			});

		try {
			const container = new MockElement('div');
			const postCtx = {
				sourcePath: 'Dashboards/Overview.md',
				addChild: () => {},
				getSectionInfo: () => null,
			} as unknown as MarkdownPostProcessorContext;

			const source = [
				'{% query tasks %}#task [priority: >= 3]{% endquery %}',
				'{% for t in query.tasks %}- {{ t.file.basename }}{% endfor %}',
			].join('\n');

			await processRhizomeCodeBlock(
				source,
				container as unknown as HTMLElement,
				postCtx,
				h.plugin,
				'rhizome-sample',
			);

			const previewEl = container.querySelector('.rhizome-sample-preview-body');
			const explainEl = container.querySelector('.rhizome-sample-explain-stack');
			expect(previewEl).not.toBeNull();
			expect(explainEl).not.toBeNull();
			expect(previewEl?.textContent).toContain('- GoodTask');
			expect(explainEl?.textContent).toContain('> [!check]- Query `tasks` — all 1 record');
			expect(explainEl?.textContent).toContain('> [!check]- Template Explain Plan');
			expect(explainEl?.textContent).not.toContain('Vault Property Coercion');

			// Verify Live Preview event guard on .rhizome-sample-explain-stack vs internal-link navigation
			const calloutTitle = explainEl!.createDiv({ cls: 'callout-title' });
			expect(
				explainEl!.dispatchEvent('mousedown', { target: calloutTitle }).propagationStopped,
			).toBe(true);
			expect(
				explainEl!.dispatchEvent('pointerdown', { target: calloutTitle })
					.propagationStopped,
			).toBe(true);
			expect(
				explainEl!.dispatchEvent('click', { target: calloutTitle }).propagationStopped,
			).toBe(true);

			const internalLink = explainEl!.createEl('a', { cls: 'internal-link' });
			// mousedown is stopped so Live Preview never collapses widget; click is NOT stopped so Obsidian navigates!
			expect(
				explainEl!.dispatchEvent('mousedown', { target: internalLink }).propagationStopped,
			).toBe(true);
			expect(
				explainEl!.dispatchEvent('click', { target: internalLink }).propagationStopped,
			).toBe(false);

			// Introduce a property coercion error on `Notes/Unmatched.md` (still does NOT match `#task`,
			// so ActiveQueryRoster payloadHash is unchanged and fires `onUnchangedPayload`!)
			h.fileCaches.set('Notes/Unmatched.md', {
				frontmatter: { priority: 'not-a-number' },
			});
			h.app.metadataCache.trigger('changed', unmatchedNote, '', {
				frontmatter: { priority: 'not-a-number' },
			});
			await h.plugin.activeQueryRoster.nudge(Date.now());

			await vi.waitFor(() => {
				expect(explainEl?.textContent).toContain('Vault Property Coercion');
			});
			expect(explainEl?.textContent).toContain('[[Notes/Unmatched.md]]');
		} finally {
			renderSpy.mockRestore();
		}
	});

	it('renders simulated newNote preview inside templatesFolder with targetPath pills, Simulated Frontmatter (YAML), and zero disk mutations', async () => {
		const h = await createWorkbenchHarness();
		h.putNote('Notes/Seed.md', 'body', {
			tags: [{ tag: '#roadmap', position: {} }],
		});

		const blockSource = [
			'{% targetPath "Areas/Plans/Q4 Review" active %}',
			'{% frontmatter "\'roadmap\' as tags" %}',
			'{% query related %}tag:@this.tags{% endquery %}',
			'{{ "Top Title" | heading }}',
			'Found: {{ query.related[0].file.basename }}',
		].join('\n');
		h.putNote(
			'◊Rhizome/templates/ReviewTpl.md',
			`## Enclosing Template Doc Heading\n\`\`\`rhizome-sample\n${blockSource}\n\`\`\``,
			{
				headings: [
					{
						heading: 'Enclosing Template Doc Heading',
						level: 2,
						position: { start: { line: 0 } },
					},
				],
			},
		);

		const renderSpy = vi
			.spyOn(MarkdownRenderer, 'render')
			.mockImplementation(async (_app, md, targetEl) => {
				(targetEl as MockElement).textContent = md;
			});

		try {
			const container = new MockElement('div');
			const postCtx = {
				sourcePath: '◊Rhizome/templates/ReviewTpl.md',
				addChild: () => {},
				getSectionInfo: () => ({ lineStart: 2, lineEnd: 9, text: '' }),
			} as unknown as MarkdownPostProcessorContext;

			await processRhizomeCodeBlock(
				blockSource,
				container as unknown as HTMLElement,
				postCtx,
				h.plugin,
				'rhizome-sample',
			);

			const targetBar = container.querySelector('.rhizome-sample-target-bar');
			expect(targetBar?.textContent).toContain('Target: Areas/Plans/Q4 Review.md');
			expect(targetBar?.textContent).toContain('Tab: active');

			const previewBody = container.querySelector('.rhizome-sample-preview-body');
			expect(previewBody?.textContent).toContain('> [!info]- Simulated Frontmatter (YAML)');
			expect(previewBody?.textContent).toContain('roadmap');
			// Fix #3 check: simulated newNote always starts at headingLevel 0 (`# Top Title`, NOT `### Top Title`)
			expect(previewBody?.textContent).toContain('# Top Title');
			expect(previewBody?.textContent).not.toContain('### Top Title');
			expect(previewBody?.textContent).toContain('Found: Seed');

			const explainStack = container.querySelector('.rhizome-sample-explain-stack');
			expect(explainStack?.textContent).toContain(
				'Initial heading level: `H0` (document root)',
			);
			expect(explainStack?.textContent).toContain('Virtual `@this` Snapshot');
			expect(explainStack?.textContent).toContain('Areas/Plans/Q4 Review.md');
			expect(h.contents.has('Areas/Plans/Q4 Review.md')).toBe(false);
		} finally {
			renderSpy.mockRestore();
		}
	});
});
