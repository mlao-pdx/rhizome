import { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { App, Editor, EditorPosition, TFile as ObsidianTFile } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import { BacklinkIndex } from '../../src/adapters/backlink-index';
import {
	createRhizomeEditorExtension,
	findRhizomeInlineSpans,
	getInlineLivePreviewDecorations,
	setCompositionFrozenEffect,
} from '../../src/adapters/codemirror/rhizome-editor-extension';
import { InlineRhizomeWidget } from '../../src/adapters/codemirror/rhizome-inline-widget';
import { buildRhizomeLintDiagnostics } from '../../src/adapters/codemirror/rhizome-lint';
import { InlineHostResolver } from '../../src/adapters/inline-host-resolver';
import { NormalizedDocumentCache } from '../../src/adapters/normalized-document-cache';
import {
	insertInlineExpressionAtSelection,
	RhizomeInlineSuggest,
} from '../../src/adapters/rhizome-inline-suggest';
import { initEngineConfig } from '../../src/core/search';
import { analyzeRhizomeCodeBlock } from '../../src/core/templates';
import { createMockElement, MockElement } from '../support/mock-dom';
import {
	createMockApp,
	editorInfoField,
	editorLivePreviewField,
	MarkdownRenderer,
	setMockLivePreviewEffect,
	TFile,
} from '../support/mock-obsidian-app';

function makeFile(path: string): ObsidianTFile {
	const file = new TFile();
	const slash = path.lastIndexOf('/');
	const dot = path.lastIndexOf('.');
	file.path = path;
	file.name = slash === -1 ? path : path.slice(slash + 1);
	file.basename = dot === -1 ? file.name : file.name.slice(0, dot - (slash + 1));
	file.extension = dot === -1 ? '' : path.slice(dot + 1);
	file.parent = slash === -1 ? { path: '' } : { path: path.slice(0, slash) };
	file.stat = { ctime: 1000, mtime: 1000, size: 120 };
	return file as unknown as ObsidianTFile;
}

function createMockEditor(
	initialText: string,
	selectionFrom?: EditorPosition,
	selectionTo?: EditorPosition,
) {
	let lines = initialText.split('\n');
	let cursor: EditorPosition = selectionTo ?? selectionFrom ?? { line: 0, ch: lines[0]!.length };
	let selFrom: EditorPosition = selectionFrom ?? cursor;
	let selTo: EditorPosition = selectionTo ?? cursor;

	const posToOffset = (pos: EditorPosition): number => {
		let offset = 0;
		for (let i = 0; i < pos.line; i++) {
			offset += (lines[i]?.length ?? 0) + 1;
		}
		return offset + pos.ch;
	};

	const replaceOffsets = (fromOff: number, toOff: number, replacement: string): void => {
		const full = lines.join('\n');
		const updated = full.slice(0, fromOff) + replacement + full.slice(toOff);
		lines = updated.split('\n');
	};

	const editor = {
		getValue: () => lines.join('\n'),
		lineCount: () => lines.length,
		getLine: (n: number) => lines[n] ?? '',
		getCursor: (which?: 'from' | 'to') => {
			if (which === 'from') return selFrom;
			if (which === 'to') return selTo;
			return cursor;
		},
		setCursor: (pos: EditorPosition) => {
			cursor = { ...pos };
			selFrom = { ...pos };
			selTo = { ...pos };
		},
		getSelection: () => {
			const a = posToOffset(selFrom);
			const b = posToOffset(selTo);
			return lines.join('\n').slice(a, b);
		},
		replaceSelection: (replacement: string) => {
			replaceOffsets(posToOffset(selFrom), posToOffset(selTo), replacement);
		},
		replaceRange: (replacement: string, from: EditorPosition, to?: EditorPosition) => {
			replaceOffsets(posToOffset(from), posToOffset(to ?? from), replacement);
		},
	};

	return {
		editor: editor as unknown as Editor,
		getText: () => lines.join('\n'),
		getCursor: () => cursor,
	};
}

function collectReplacedWidgets(state: EditorState): Array<{
	from: number;
	to: number;
	widget: InlineRhizomeWidget;
}> {
	const decos = getInlineLivePreviewDecorations(state);
	const out: Array<{ from: number; to: number; widget: InlineRhizomeWidget }> = [];
	decos.between(0, state.doc.length, (from, to, value) => {
		const spec = value.spec as { widget?: unknown };
		if (spec.widget instanceof InlineRhizomeWidget) {
			out.push({ from, to, widget: spec.widget });
		}
	});
	return out;
}

describe('CodeMirror 6 inline scanner, linter, Live Preview widget/field & authoring helpers', () => {
	beforeEach(() => {
		MarkdownRenderer.render = async (_app, markdown, containerEl) => {
			const root = containerEl as MockElement;
			if (markdown.trim().startsWith('- ')) {
				const ul = root.createEl('ul');
				ul.createEl('li', { text: markdown.trim().slice(2) });
			} else {
				const p = root.createEl('p');
				p.textContent = markdown;
			}
		};
	});

	it('scans CommonMark single/multi-backtick spans, ATX/Setext heading levels, and GFM table cells while skipping non-code constructs', () => {
		const docText = [
			'---',
			'note: "`◊ ignored.frontmatter`"',
			'---',
			'Intro `◊ this.file.basename` and `` ◊ "tick ` inside" `` and `◊literal`.',
			'',
			'## Section Two',
			'Under H2: `◊ "Sub" | heading` and $x + `◊ math` + y$ and <!-- `◊ comment` --> and %% `◊ obs` %%.',
			'',
			'%%',
			'# Commented Heading Must Not Change Level',
			'',
			'Second paragraph inside multi-paragraph comment: `◊ ignored.across.blank.line`',
			'%%',
			'',
			'<!--',
			'HTML comment across blank line:',
			'',
			'`◊ ignored.html.blank.line`',
			'-->',
			'',
			'$$',
			'x = 1',
			'',
			'`◊ ignored.math.blank.line`',
			'$$',
			'',
			'Still H2 after commented H1: `◊ "StillH2" | heading`.',
			'',
			'Setext Title',
			'===',
			'Under Setext H1: `◊ "Child" | heading`.',
			'',
			'| Col A | Col B |',
			'| --- | --- |',
			'| `◊ this.tags \\| join: ", "` | `◊ unclosed | cell` |',
			'',
			'> [!info] Callout Table',
			'> | Callout A | Callout B |',
			'> | --- | --- |',
			'> | `◊ this.tags \\| first` | `◊ split | cell` |',
			'',
			'```rhizome',
			'`◊ ignored.in.fence`',
			'```',
		].join('\n');

		const spans = findRhizomeInlineSpans(Text.of(docText.split('\n')));
		expect(
			spans.map((s) => ({
				expr: s.expr,
				heading: s.headingLevel,
				table: s.unescapeTablePipes,
			})),
		).toEqual([
			{ expr: 'this.file.basename', heading: 0, table: false },
			{ expr: '"tick ` inside"', heading: 0, table: false },
			{ expr: '"Sub" | heading', heading: 2, table: false },
			{ expr: '"StillH2" | heading', heading: 2, table: false },
			{ expr: '"Child" | heading', heading: 1, table: false },
			{ expr: 'this.tags | join: ", "', heading: 1, table: true },
			{ expr: 'this.tags | first', heading: 1, table: true },
		]);
	});

	it('surfaces inline syntax errors and INLINE_QUERY_SCOPE_UNAVAILABLE warnings in CodeMirror lint diagnostics with exact table offsets', () => {
		const cfgRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
		if (!cfgRes.ok) throw new Error('Expected config');

		const docText = [
			'Valid `◊ this.file.basename`.',
			'Warn `◊ query.tasks.size | default: 0`.',
			'',
			'| Col |',
			'| --- |',
			'| `◊ this.tags \\|` |',
		].join('\n');
		const doc = Text.of(docText.split('\n'));

		const diags = buildRhizomeLintDiagnostics(doc, (src) =>
			analyzeRhizomeCodeBlock(src, cfgRes.config, Date.parse('2026-11-22T00:00:00Z')),
		);

		expect(diags).toHaveLength(2);
		expect(diags[0]?.severity).toBe('warning');
		expect(doc.sliceString(diags[0]!.from, diags[0]!.to)).toBe('query.tasks.size');

		expect(diags[1]?.severity).toBe('error');
		expect(doc.sliceString(diags[1]!.from, diags[1]!.to)).toBe('\\|');
	});

	it('manages Live Preview replacement, cursor reveal, Source mode toggle, IME freeze, blank/error/block widgets, and click-to-reveal', async () => {
		const note = makeFile('Projects/Demo.md');
		const app = createMockApp({
			files: [note],
			fileCache: new Map([[note.path, { frontmatter: { status: 'ready', items: ['One'] } }]]),
		}) as App;
		const backlinkIndex = new BacklinkIndex(app, () => false);
		const documentCache = new NormalizedDocumentCache(app);
		documentCache.setReady(true);
		const resolver = new InlineHostResolver(app, undefined, backlinkIndex, documentCache);

		const content =
			'Lead `◊ this.properties.status` mid `◊ this.properties.empty` tail `◊ this.bad |` block `◊ this.properties.items | list`.';
		const ext = createRhizomeEditorExtension(
			app,
			undefined,
			backlinkIndex,
			documentCache,
			resolver,
		);

		// Start in Source mode (`editorLivePreviewField = false`), cursor at 0
		let state = EditorState.create({
			doc: content,
			selection: { anchor: 0 },
			extensions: [
				editorLivePreviewField.init(() => false),
				editorInfoField.init(() => ({ file: note })),
				ext,
			],
		});
		expect(collectReplacedWidgets(state)).toHaveLength(0);

		// Switch to Live Preview (`editorLivePreviewField = true`): all 4 untouched spans are replaced
		state = state.update({ effects: setMockLivePreviewEffect.of(true) }).state;
		const initialWidgets = collectReplacedWidgets(state);
		expect(initialWidgets).toHaveLength(4);
		expect(initialWidgets[0]?.widget.result).toEqual({ ok: true, markdown: 'ready' });
		expect(initialWidgets[1]?.widget.result).toEqual({ ok: true, markdown: '' });
		expect(initialWidgets[2]?.widget.result.ok).toBe(false);

		// Move cursor inside the first span -> synchronously reveals raw source for span 0 only
		const firstFrom = initialWidgets[0]!.from;
		state = state.update({ selection: { anchor: firstFrom + 2 } }).state;
		const afterReveal = collectReplacedWidgets(state);
		expect(afterReveal).toHaveLength(3);
		expect(afterReveal.some((w) => w.from === firstFrom)).toBe(false);

		// Move cursor back to 0 -> re-replaces all 4 spans
		state = state.update({ selection: { anchor: 0 } }).state;
		expect(collectReplacedWidgets(state)).toHaveLength(4);

		// Moving cursor between two prose offsets (0 -> 2) preserves exact DecorationSet identity with ZERO resolveSync calls
		const decosBeforeProseMove = getInlineLivePreviewDecorations(state);
		const resolveSyncSpy = vi.spyOn(resolver, 'resolveSync');
		state = state.update({ selection: { anchor: 2 } }).state;
		expect(getInlineLivePreviewDecorations(state)).toBe(decosBeforeProseMove);
		expect(resolveSyncSpy).not.toHaveBeenCalled();
		resolveSyncSpy.mockRestore();

		// IME composition freeze maps existing decorations across doc edits without rebuilding
		state = state.update({ effects: setCompositionFrozenEffect.of(true) }).state;
		state = state.update({ changes: { from: 0, to: 0, insert: 'XX ' } }).state;
		const frozenWidgets = collectReplacedWidgets(state);
		expect(frozenWidgets).toHaveLength(4);
		expect(frozenWidgets[0]?.from).toBe(firstFrom + 3);
		state = state.update({ effects: setCompositionFrozenEffect.of(false) }).state;
		expect(collectReplacedWidgets(state)).toHaveLength(4);

		// Verify DOM rendering, click-to-reveal (including shifted posAtDOM), link passthrough, and destroy()
		let dispatchedAnchor: number | null = null;
		let measureRequested = false;
		const fakeView = {
			state,
			posAtDOM: () => frozenWidgets[0]!.from,
			dispatch: (spec: { selection?: { anchor: number } }) => {
				if (spec.selection) {
					dispatchedAnchor = spec.selection.anchor;
				}
			},
			focus: () => {},
			requestMeasure: () => {
				measureRequested = true;
			},
		} as unknown as EditorView;

		// 1. Blank badge (`◊`) + tooltip
		const emptyDom = frozenWidgets[1]!.widget.toDOM(fakeView) as unknown as MockElement;
		expect(emptyDom.classList.contains('rhizome-inline-empty')).toBe(true);
		expect(emptyDom.textContent).toBe('◊');
		expect(emptyDom.getAttribute('data-tooltip')).toBe('`◊ this.properties.empty`');

		// 2. Error pill (`◊ Error`) + tooltip
		const errDom = frozenWidgets[2]!.widget.toDOM(fakeView) as unknown as MockElement;
		expect(errDom.classList.contains('rhizome-inline-error')).toBe(true);
		expect(errDom.textContent).toBe('◊ Error');

		// 3. Block output widget toggles `.rhizome-inline-output-block` and calls `requestMeasure()`
		const blockDom = frozenWidgets[3]!.widget.toDOM(fakeView) as unknown as MockElement;
		await Promise.resolve();
		await Promise.resolve();
		expect(blockDom.classList.contains('rhizome-inline-output-block')).toBe(true);
		expect(measureRequested).toBe(true);

		// 4. Click-to-reveal places caret inside span (`from + 1 + 2`), while clicking `<a>` is ignored
		const valDom = frozenWidgets[0]!.widget.toDOM(fakeView) as unknown as MockElement;
		await Promise.resolve();
		const linkChild = createMockElement('a', { cls: 'internal-link' });
		valDom.appendChild(linkChild as unknown as MockElement);
		valDom.dispatchEvent('mousedown', { target: linkChild, button: 0 });
		expect(dispatchedAnchor).toBeNull();

		valDom.dispatchEvent('mousedown', { target: valDom, button: 0 });
		expect(dispatchedAnchor).toBe(frozenWidgets[0]!.from + 3);

		frozenWidgets[0]!.widget.destroy(valDom as unknown as HTMLElement);
		frozenWidgets[3]!.widget.destroy(blockDom as unknown as HTMLElement);
	});

	it('triggers `lo / `loz EditorSuggest only in valid prose contexts, consumes auto-paired backticks, and wraps command selections', () => {
		const app = createMockApp() as App;
		const suggest = new RhizomeInlineSuggest(app);

		// Valid prose triggers (`lo and `loz)
		const prose = createMockEditor('Hello `lo');
		const trig1 = suggest.onTrigger({ line: 0, ch: 9 }, prose.editor, null);
		expect(trig1).toEqual({
			start: { line: 0, ch: 6 },
			end: { line: 0, ch: 9 },
			query: 'lo',
		});

		// With Obsidian auto-paired closing backtick (`lo|`) -> produces `` `◊ |` `` (no duplicate backtick!)
		const dummyFile = makeFile('Notes/Suggest.md');
		const autoPaired = createMockEditor('Hello `loz` world');
		const trig2 = suggest.onTrigger({ line: 0, ch: 10 }, autoPaired.editor, dummyFile);
		expect(trig2).not.toBeNull();
		suggest.context = {
			editor: autoPaired.editor,
			file: dummyFile,
			...trig2!,
		};
		const items = suggest.getSuggestions(suggest.context);
		expect(items).toHaveLength(1);
		suggest.selectSuggestion(items[0]!, {} as KeyboardEvent);
		expect(autoPaired.getText()).toBe('Hello `◊ ` world');
		expect(autoPaired.getCursor()).toEqual({ line: 0, ch: 9 });

		// Without auto-paired closing backtick -> also produces `` `◊ |` ``
		const unpaired = createMockEditor('Hello `lo');
		const trig3 = suggest.onTrigger({ line: 0, ch: 9 }, unpaired.editor, dummyFile);
		suggest.context = {
			editor: unpaired.editor,
			file: dummyFile,
			...trig3!,
		};
		suggest.selectSuggestion(items[0]!, {} as KeyboardEvent);
		expect(unpaired.getText()).toBe('Hello `◊ `');
		expect(unpaired.getCursor()).toEqual({ line: 0, ch: 9 });

		// Blocked contexts: frontmatter, fenced code, inline math, display math, comments, escaped `\`lo`, existing code span
		const blockedCases: Array<{ doc: string; line: number; ch: number }> = [
			{ doc: '---\nk: `lo\n---\nBody', line: 1, ch: 6 },
			{ doc: '```ts\n`lo\n```', line: 1, ch: 3 },
			{ doc: 'Math $x + `lo$ end', line: 0, ch: 13 },
			{ doc: '$$\n`lo\n$$', line: 1, ch: 3 },
			{ doc: '$$\na = 1\n\n`lo\n$$', line: 3, ch: 3 },
			{ doc: '%% hidden `lo %%', line: 0, ch: 13 },
			{ doc: '%%\npara 1\n\npara 2 `lo\n%%', line: 3, ch: 10 },
			{ doc: '<!-- hidden `lo -->', line: 0, ch: 15 },
			{ doc: '<!--\npara 1\n\npara 2 `lo\n-->', line: 3, ch: 10 },
			{ doc: 'Escaped \\`lo', line: 0, ch: 12 },
			{ doc: 'Inside `open code `lo', line: 0, ch: 21 },
		];
		for (const c of blockedCases) {
			const ed = createMockEditor(c.doc);
			expect(
				suggest.onTrigger({ line: c.line, ch: c.ch }, ed.editor, null),
				`Expected null trigger for: ${c.doc}`,
			).toBeNull();
		}

		// Command `insertInlineExpressionAtSelection`: empty selection, auto-paired `` `|` ``, plain selection, and backtick selection
		const emptyEd = createMockEditor('Value: ', { line: 0, ch: 7 }, { line: 0, ch: 7 });
		insertInlineExpressionAtSelection(emptyEd.editor);
		expect(emptyEd.getText()).toBe('Value: `◊ `');
		expect(emptyEd.getCursor()).toEqual({ line: 0, ch: 10 });

		const autoPairedCmdEd = createMockEditor(
			'Value: `` end',
			{ line: 0, ch: 8 },
			{ line: 0, ch: 8 },
		);
		insertInlineExpressionAtSelection(autoPairedCmdEd.editor);
		expect(autoPairedCmdEd.getText()).toBe('Value: `◊ ` end');
		expect(autoPairedCmdEd.getCursor()).toEqual({ line: 0, ch: 10 });

		const plainSel = createMockEditor(
			'See this.file.basename!',
			{ line: 0, ch: 4 },
			{ line: 0, ch: 22 },
		);
		insertInlineExpressionAtSelection(plainSel.editor);
		expect(plainSel.getText()).toBe('See `◊ this.file.basename`!');

		const backtickSel = createMockEditor(
			'"has ` tick"',
			{ line: 0, ch: 0 },
			{ line: 0, ch: 12 },
		);
		insertInlineExpressionAtSelection(backtickSel.editor);
		expect(backtickSel.getText()).toBe('`` ◊ "has ` tick" ``');
	});
});
