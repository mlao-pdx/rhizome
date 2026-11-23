import type { App, MarkdownPostProcessorContext, TFile as ObsidianTFile } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { BacklinkIndex } from '../../src/adapters/backlink-index';
import { InlineHostResolver } from '../../src/adapters/inline-host-resolver';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import { processRhizomeInlineSpans } from '../../src/adapters/rhizome-inline-postprocessor';
import type RhizomePlugin from '../../src/main';
import type { LoggerPort, LogLevel } from '../../src/ports/logger-port';
import { createMockElement, createMockTextNode, MockElement } from '../support/mock-dom';
import {
	createMockApp,
	MarkdownRenderChild,
	MarkdownRenderer,
	TFile,
} from '../support/mock-obsidian-app';

function makeFile(path: string, mtime: number = 1000): ObsidianTFile {
	const file = new TFile();
	const slash = path.lastIndexOf('/');
	const dot = path.lastIndexOf('.');
	file.path = path;
	file.name = slash === -1 ? path : path.slice(slash + 1);
	file.basename = dot === -1 ? file.name : file.name.slice(0, dot - (slash + 1));
	file.extension = dot === -1 ? '' : path.slice(dot + 1);
	file.parent = slash === -1 ? { path: '' } : { path: path.slice(0, slash) };
	file.stat = { ctime: 1000, mtime, size: 100 };
	return file as unknown as ObsidianTFile;
}

async function flushMicrotasks(rounds: number = 6): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
	}
}

function addCodeEl(parent: MockElement, content: string): MockElement {
	const codeEl = parent.createEl('code');
	codeEl.textContent = content;
	return codeEl;
}

function installDefaultMarkdownRenderer(
	postProcessor?: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void,
): void {
	MarkdownRenderer.render = async (_app, markdown, containerEl, sourcePath) => {
		const root = containerEl as MockElement;
		const trimmed = markdown.trim();
		if (trimmed.startsWith('- ')) {
			const ul = root.createEl('ul');
			for (const line of trimmed.split('\n')) {
				ul.createEl('li', { text: line.replace(/^- /, '') });
			}
		} else if (trimmed.startsWith('#')) {
			const m = /^(#{1,6})\s+(.*)$/.exec(trimmed);
			const lvl = m ? m[1]!.length : 1;
			root.createEl(`h${lvl}`, { text: m ? m[2]! : trimmed });
		} else {
			const p = root.createEl('p');
			const codeMatch = /^`\u25CA\s+([\s\S]+)`$/.exec(trimmed);
			if (codeMatch) {
				addCodeEl(p, `\u25CA ${codeMatch[1]!}`);
			} else {
				p.textContent = markdown;
			}
		}
		if (postProcessor) {
			const nestedCtx = {
				sourcePath,
				addChild: () => {},
				getSectionInfo: () => null,
			} as unknown as MarkdownPostProcessorContext;
			postProcessor(containerEl as HTMLElement, nestedCtx);
		}
	};
}

function buildTestHarness(options: {
	file: ObsidianTFile;
	frontmatter?: Record<string, unknown>;
	headings?: Array<{ heading: string; level: number; position: { start: { line: number } } }>;
}) {
	const fileCache = new Map<string, unknown>([
		[
			options.file.path,
			{
				frontmatter: options.frontmatter ?? {},
				headings: options.headings ?? [],
			},
		],
	]);
	const app = createMockApp({
		files: [options.file],
		fileCache,
	}) as App;

	const logEntries: Array<{
		level: LogLevel;
		message: string;
		meta: Record<string, unknown> | undefined;
	}> = [];
	const logger: LoggerPort = {
		log(level, message, meta) {
			logEntries.push({ level, message, meta });
		},
	};

	const backlinkIndex = new BacklinkIndex(app, () => false);
	const documentCache = new NormalizedDocumentCache(app);
	documentCache.setReady(true);
	const inlineHostResolver = new InlineHostResolver(app, logger, backlinkIndex, documentCache);

	const plugin = {
		app,
		inlineHostResolver,
		waitForVaultReady: () => Promise.resolve(),
	} as unknown as RhizomePlugin;

	return { app, fileCache, documentCache, inlineHostResolver, plugin, logEntries };
}

function makePostProcessorContext(
	sourcePath: string,
	lineStart: number = 0,
): {
	ctx: MarkdownPostProcessorContext;
	registeredChildren: MarkdownRenderChild[];
} {
	const registeredChildren: MarkdownRenderChild[] = [];
	const ctx = {
		sourcePath,
		addChild: (child: MarkdownRenderChild) => {
			registeredChildren.push(child);
		},
		getSectionInfo: () => ({
			text: '',
			lineStart,
			lineEnd: lineStart + 1,
		}),
	} as unknown as MarkdownPostProcessorContext;
	return { ctx, registeredChildren };
}

describe('Reading mode inline Rhizome post-processor', () => {
	beforeEach(() => {
		installDefaultMarkdownRenderer();
	});

	it('exits immediately with zero allocations or subscriptions for ordinary code spans and <pre><code> blocks', async () => {
		const note = makeFile('Notes/Plain.md');
		const { plugin, inlineHostResolver } = buildTestHarness({ file: note });
		const { ctx, registeredChildren } = makePostProcessorContext(note.path);

		const section = createMockElement('div') as unknown as MockElement;
		const p = section.createEl('p');
		addCodeEl(p, 'const x = 1;');
		addCodeEl(p, '◊InternalRhizome');
		const pre = section.createEl('pre');
		addCodeEl(pre, '◊ this.file.basename');

		processRhizomeInlineSpans(section as unknown as HTMLElement, ctx, plugin);
		await flushMicrotasks();

		expect(registeredChildren).toHaveLength(0);
		expect(inlineHostResolver.activePathCount).toBe(0);
		expect(pre.firstElementChild?.tagName).toBe('CODE');
	});

	it('unwraps single <p> inline output, promotes sole-child block output out of <p>, handles blank output, and renders accessible ◊ Error pills', async () => {
		const note = makeFile('Projects/Roadmap.md');
		const { plugin, logEntries } = buildTestHarness({
			file: note,
			frontmatter: {
				status: 'shipped',
				items: ['One', 'Two'],
			},
			headings: [{ heading: 'Parent', level: 2, position: { start: { line: 1 } } }],
		});
		const { ctx } = makePostProcessorContext(note.path, 5);

		const section = createMockElement('div') as unknown as MockElement;

		// 1. Inline span inside mixed paragraph -> unwraps `<p>` into `<span class="rhizome-inline-output">`
		const mixedP = section.createEl('p');
		mixedP.appendChild(createMockTextNode('Status: ') as unknown as MockElement);
		mixedP.createEl('code', { text: '◊ this.properties.status | upcase' });
		mixedP.appendChild(createMockTextNode('!') as unknown as MockElement);

		// 2. Sole-child block output (`| list`) -> promotes `<div class="rhizome-inline-output-block">` replacing `<p>`
		const soleBlockP = section.createEl('p');
		soleBlockP.createEl('code', { text: '◊ this.properties.items | list' });

		// 3. Heading inheritance (`| heading: "demote"` under H2 -> H3)
		const headingP = section.createEl('p');
		addCodeEl(headingP, '◊ "Details" | heading: "demote"');

		// 4. Blank output -> empty `<span class="rhizome-inline-output">`
		const blankP = section.createEl('p');
		blankP.createEl('code', { text: '◊ this.properties.nonexistent' });

		// 5. Invalid expression -> `<span class="rhizome-inline-error">◊ Error</span>` with tooltip + single warning log
		const errP = section.createEl('p');
		errP.createEl('code', { text: '◊ this.properties.status |' });

		processRhizomeInlineSpans(section as unknown as HTMLElement, ctx, plugin);
		await flushMicrotasks(12);

		// Verify 1: mixedP retained `<p>`, replaced `<code>` with inline `<span>`
		expect(mixedP.textContent).toBe('Status: SHIPPED!');
		expect(mixedP.firstElementChild?.tagName).toBe('SPAN');
		expect(mixedP.firstElementChild?.classList.contains('rhizome-inline-output')).toBe(true);

		// Verify 2: soleBlockP was replaced at section level by `<div class="rhizome-inline-output-block">` containing `<ul>`
		const promotedDiv = section.children[1]!;
		expect(promotedDiv.tagName).toBe('DIV');
		expect(promotedDiv.classList.contains('rhizome-inline-output-block')).toBe(true);
		expect(promotedDiv.firstElementChild?.tagName).toBe('UL');

		// Verify 3: heading inherited H2 -> H3
		const promotedHeadingDiv = section.children[2]!;
		expect(promotedHeadingDiv.firstElementChild?.tagName).toBe('H3');
		expect(promotedHeadingDiv.firstElementChild?.textContent).toBe('Details');

		// Verify 4: blank output is an empty inline span
		expect(blankP.firstElementChild?.tagName).toBe('SPAN');
		expect(blankP.firstElementChild?.textContent).toBe('');

		// Verify 5: error pill + tooltip + deduplicated warning log
		const errPill = errP.firstElementChild!;
		expect(errPill.classList.contains('rhizome-inline-error')).toBe(true);
		expect(errPill.textContent).toBe('◊ Error');
		expect(errPill.getAttribute('role')).toBe('status');
		expect(errPill.getAttribute('tabindex')).toBe('0');
		expect(errPill.getAttribute('data-tooltip')).toContain('Fix:');
		expect(logEntries).toHaveLength(1);
		expect(logEntries[0]?.meta?.source).toBe('template.inline');
	});

	it('updates changed slots reactively without replacing unchanged slots, unloads old children, and unsubscribes on section unload', async () => {
		const note = makeFile('Notes/Reactive.md', 100);
		const { fileCache, documentCache, inlineHostResolver, plugin } = buildTestHarness({
			file: note,
			frontmatter: { changing: 'v1', stable: 'constant' },
		});
		const { ctx, registeredChildren } = makePostProcessorContext(note.path, 0);

		const section = createMockElement('div') as unknown as MockElement;
		const p = section.createEl('p');
		p.createEl('code', { text: '◊ this.properties.changing' });
		p.createEl('code', { text: '◊ this.properties.stable' });

		processRhizomeInlineSpans(section as unknown as HTMLElement, ctx, plugin);
		await flushMicrotasks(10);

		expect(inlineHostResolver.activePathCount).toBe(1);
		const firstChangingSpan = p.children[0]!;
		const firstStableSpan = p.children[1]!;
		expect(firstChangingSpan.textContent).toBe('v1');
		expect(firstStableSpan.textContent).toBe('constant');

		const sectionRenderChild = registeredChildren[0]!;
		const initialFirstSlotChild = sectionRenderChild.children[0]!;
		expect(initialFirstSlotChild.unloaded).toBe(false);

		// Mutate `changing` to `v2`, keeping `stable` unchanged
		note.stat.mtime = 200;
		fileCache.set(note.path, { frontmatter: { changing: 'v2', stable: 'constant' } });
		documentCache.delete(note.path);
		inlineHostResolver.notifyMetadataChanged(note.path);
		await flushMicrotasks(10);

		expect(p.children[0]!.textContent).toBe('v2');
		// Old MarkdownRenderChild for slot 0 was unloaded before replacement
		expect(initialFirstSlotChild.unloaded).toBe(true);
		// Unchanged slot 1 kept the exact same DOM node instance
		expect(p.children[1]).toBe(firstStableSpan);

		// Unloading the section MarkdownRenderChild aborts and removes the host subscription
		sectionRenderChild.unload();
		expect(inlineHostResolver.activePathCount).toBe(0);
	});

	it('halts self-referential inline expressions at MAX_INLINE_RENDER_DEPTH (4) without infinite recursion', async () => {
		const note = makeFile('Notes/Cycle.md', 100);
		const { plugin } = buildTestHarness({
			file: note,
			frontmatter: { loop: '`◊ this.properties.loop`' },
		});
		installDefaultMarkdownRenderer((subEl, subCtx) => {
			processRhizomeInlineSpans(subEl, subCtx, plugin);
		});

		const { ctx } = makePostProcessorContext(note.path, 0);
		const section = createMockElement('div') as unknown as MockElement;
		const p = section.createEl('p');
		p.createEl('code', { text: '◊ this.properties.loop' });

		processRhizomeInlineSpans(section as unknown as HTMLElement, ctx, plugin);
		await flushMicrotasks(40);

		// Walk nested `.rhizome-inline-output` wrappers: depth reaches 4 and leaves inner `<code>` literal
		const wrappers = section.querySelectorAll('.rhizome-inline-output');
		expect(wrappers).toHaveLength(4);
		expect(wrappers[3]?.getAttribute('data-rhizome-inline-depth')).toBe('4');
		expect(wrappers[3]?.firstElementChild?.tagName).toBe('CODE');
		expect(wrappers[3]?.firstElementChild?.textContent).toBe('◊ this.properties.loop');
	});

	it('cannot be tricked by forged data-rhizome-inline-depth HTML attributes inside rendered note properties', async () => {
		const note = makeFile('Notes/ForgedDepth.md', 100);
		const { plugin } = buildTestHarness({
			file: note,
			frontmatter: {
				forged: '<span class="rhizome-inline-output" data-rhizome-inline-depth="1">`◊ this.properties.forged`</span>',
			},
		});
		MarkdownRenderer.render = async (_app, markdown, containerEl, sourcePath) => {
			const root = containerEl as MockElement;
			const p = root.createEl('p');
			if (markdown.includes('data-rhizome-inline-depth="1"')) {
				// Simulate DOMPurify preserving `<span class="rhizome-inline-output" data-rhizome-inline-depth="1">`
				const forgedSpan = p.createSpan({
					cls: 'rhizome-inline-output',
					attr: { 'data-rhizome-inline-depth': '1' },
				});
				addCodeEl(forgedSpan, '◊ this.properties.forged');
			} else {
				p.textContent = markdown;
			}
			const nestedCtx = {
				sourcePath,
				addChild: () => {},
				getSectionInfo: () => null,
			} as unknown as MarkdownPostProcessorContext;
			processRhizomeInlineSpans(containerEl as HTMLElement, nestedCtx, plugin);
		};

		const { ctx } = makePostProcessorContext(note.path, 0);
		const section = createMockElement('div') as unknown as MockElement;
		const p = section.createEl('p');
		addCodeEl(p, '◊ this.properties.forged');

		processRhizomeInlineSpans(section as unknown as HTMLElement, ctx, plugin);
		await flushMicrotasks(40);

		// Trusted depth still stops strictly at 4 despite every intermediate node forging depth="1"
		const depth4Wrappers = section.querySelectorAll('[data-rhizome-inline-depth="4"]');
		expect(depth4Wrappers).toHaveLength(1);
		const innerCode = depth4Wrappers[0]?.querySelector('code');
		expect(innerCode?.textContent).toBe('◊ this.properties.forged');
	});
});
