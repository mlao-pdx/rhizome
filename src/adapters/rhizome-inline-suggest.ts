import {
	type App,
	type Editor,
	type EditorPosition,
	EditorSuggest,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	type TFile,
} from 'obsidian';
import { classifyMarkdownLines, splitTableCellRanges } from './codemirror/rhizome-markdown-context';

/**
 * Suggestion item surfaced by `RhizomeInlineSuggest` when typing a backtick + `lo` / `loz` trigger.
 */
export interface InlineSuggestItem {
	readonly label: string;
	readonly description: string;
}

const INLINE_SUGGESTION_ITEM: InlineSuggestItem = Object.freeze({
	label: '◊ … — Inline expression',
	description: 'Insert `◊ ` inline expression',
});

const TRIGGER_SUFFIX_RE = /`loz?$/;

function countTotalLines(editor: Editor): number {
	if (typeof editor.lineCount === 'function') {
		return editor.lineCount();
	}
	return editor.getValue().split('\n').length;
}

function readLineSafe(editor: Editor, line: number): string {
	return editor.getLine(line) ?? '';
}

function hasUnclosedBacktickBeforeOffset(maskedPrefix: string): boolean {
	const len = maskedPrefix.length;
	let i = 0;
	while (i < len) {
		const ch = maskedPrefix[i]!;
		if (ch === '\\' && i + 1 < len) {
			i += 2;
			continue;
		}
		if (ch !== '`') {
			i++;
			continue;
		}
		let runEnd = i;
		while (runEnd < len && maskedPrefix[runEnd] === '`') {
			runEnd++;
		}
		const tickLen = runEnd - i;
		let search = runEnd;
		let closeEnd = -1;
		while (search < len) {
			if (maskedPrefix[search] !== '`') {
				search++;
				continue;
			}
			let candEnd = search;
			while (candEnd < len && maskedPrefix[candEnd] === '`') {
				candEnd++;
			}
			if (candEnd - search === tickLen) {
				closeEnd = candEnd;
				break;
			}
			search = candEnd;
		}
		if (closeEnd === -1) {
			return true;
		}
		i = closeEnd;
	}
	return false;
}

/**
 * Checks whether a trigger match starting at `(cursorLine, matchStartCh)` is in ordinary Markdown
 * prose (outside YAML frontmatter, fenced/indented code blocks, multi-paragraph HTML/Obsidian
 * comments, math spans/blocks, and pre-existing inline code spans) using the shared
 * `classifyMarkdownLines` masker.
 */
export function isEligibleInlineSuggestPosition(
	editor: Editor,
	cursorLine: number,
	matchStartCh: number,
): boolean {
	const fullLine = readLineSafe(editor, cursorLine);
	if (matchStartCh < 0 || matchStartCh >= fullLine.length || fullLine[matchStartCh] !== '`') {
		return false;
	}
	if (matchStartCh > 0 && fullLine[matchStartCh - 1] === '`') {
		return false;
	}

	let backslashes = 0;
	for (let b = matchStartCh - 1; b >= 0 && fullLine[b] === '\\'; b--) {
		backslashes++;
	}
	if (backslashes % 2 === 1) {
		return false;
	}

	const totalLines = countTotalLines(editor);
	if (cursorLine < 0 || cursorLine >= totalLines) {
		return false;
	}

	// Include lines through `cursorLine` plus a bounded lookahead for closing `---` frontmatter
	// (only needed when line 0 is `---`).
	const line0 = readLineSafe(editor, 0);
	const hasPotentialFrontmatter = totalLines >= 2 && /^---[ \t]*$/.test(line0);
	const scanLimit = hasPotentialFrontmatter
		? Math.min(totalLines, Math.max(cursorLine + 1, 200))
		: cursorLine + 1;

	const rawLines: string[] = new Array<string>(scanLimit);
	for (let i = 0; i < scanLimit; i++) {
		rawLines[i] = readLineSafe(editor, i);
	}

	const classified = classifyMarkdownLines(rawLines);
	const target = classified[cursorLine];
	if (!target || target.skipLine || matchStartCh < target.quotePrefixLen) {
		return false;
	}

	// If `maskedText[matchStartCh]` was replaced by `' '`, the trigger sits inside frontmatter,
	// fenced/indented code, `<!--...-->`, `%%...%%`, `$$...$$`, or `$...$`.
	if (target.maskedText[matchStartCh] !== '`') {
		return false;
	}

	if (target.isTableRow) {
		const restRaw = target.rawText.slice(target.quotePrefixLen);
		const restMasked = target.maskedText.slice(target.quotePrefixLen);
		const relCh = matchStartCh - target.quotePrefixLen;
		for (const cell of splitTableCellRanges(restRaw)) {
			if (relCh >= cell.start && relCh < cell.end) {
				return !hasUnclosedBacktickBeforeOffset(restMasked.slice(cell.start, relCh));
			}
		}
		return false;
	}

	if (target.isAtxHeading || target.isThematicBreak) {
		return !hasUnclosedBacktickBeforeOffset(target.maskedText.slice(0, matchStartCh));
	}

	let blockStart = cursorLine;
	while (blockStart > 0) {
		const prev = classified[blockStart - 1]!;
		if (
			prev.skipLine ||
			prev.isBlankRest ||
			prev.isTableRow ||
			prev.quoteDepth !== target.quoteDepth ||
			prev.isAtxHeading ||
			prev.isThematicBreak
		) {
			break;
		}
		blockStart--;
	}

	const prefixParts: string[] = [];
	for (let k = blockStart; k < cursorLine; k++) {
		prefixParts.push(classified[k]!.maskedText);
	}
	prefixParts.push(target.maskedText.slice(0, matchStartCh));
	return !hasUnclosedBacktickBeforeOffset(prefixParts.join('\n'));
}

/**
 * `EditorSuggest` expanding backtick + `lo` / `loz` triggers into a `◊ ` inline code span
 * (consuming an auto-paired closing backtick when present so no duplicate backtick is left behind).
 */
export class RhizomeInlineSuggest extends EditorSuggest<InlineSuggestItem> {
	constructor(app: App) {
		super(app);
	}

	override onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		// Fast O(1) suffix check on the current line BEFORE reading surrounding lines!
		const linePrefix = readLineSafe(editor, cursor.line).slice(0, cursor.ch);
		const match = TRIGGER_SUFFIX_RE.exec(linePrefix);
		if (!match) {
			return null;
		}
		const matchStartCh = cursor.ch - match[0].length;
		if (!isEligibleInlineSuggestPosition(editor, cursor.line, matchStartCh)) {
			return null;
		}
		return {
			start: { line: cursor.line, ch: matchStartCh },
			end: { line: cursor.line, ch: cursor.ch },
			query: match[0].slice(1),
		};
	}

	override getSuggestions(_context: EditorSuggestContext): InlineSuggestItem[] {
		return [INLINE_SUGGESTION_ITEM];
	}

	override renderSuggestion(item: InlineSuggestItem, el: HTMLElement): void {
		if (typeof el.createDiv === 'function') {
			el.createDiv({ text: item.label });
		} else {
			el.textContent = item.label;
		}
	}

	override selectSuggestion(_item: InlineSuggestItem, _evt: MouseEvent | KeyboardEvent): void {
		const ctx = this.context;
		if (!ctx) {
			return;
		}
		const { editor, start, end } = ctx;
		const afterEnd = readLineSafe(editor, end.line).slice(end.ch);
		const hasAutoPairedBacktick = afterEnd.startsWith('`') && !afterEnd.startsWith('``');
		const replaceTo: EditorPosition = hasAutoPairedBacktick
			? { line: end.line, ch: end.ch + 1 }
			: end;

		editor.replaceRange('`◊ `', start, replaceTo);
		editor.setCursor({ line: start.line, ch: start.ch + 3 });
		this.close();
	}
}

function longestBacktickRun(text: string): number {
	let maxRun = 0;
	let cur = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '`') {
			cur++;
			if (cur > maxRun) {
				maxRun = cur;
			}
		} else {
			cur = 0;
		}
	}
	return maxRun;
}

/**
 * Command handler for `insert-inline-expression`: inserts an empty `◊ ` code span when the
 * selection is empty (consuming adjacent auto-paired backticks when present), or wraps a
 * non-empty selection as `◊ selection` (upgrading to N+1 backticks when needed).
 */
export function insertInlineExpressionAtSelection(editor: Editor): void {
	const selected = editor.getSelection();
	if (selected.length === 0) {
		const cursor = editor.getCursor();
		const line = readLineSafe(editor, cursor.line);
		const before = cursor.ch > 0 ? line[cursor.ch - 1] : '';
		const before2 = cursor.ch > 1 ? line[cursor.ch - 2] : '';
		const after = line[cursor.ch] ?? '';
		const after2 = line[cursor.ch + 1] ?? '';

		const hasSingleOpeningBefore = before === '`' && before2 !== '`' && before2 !== '\\';
		const hasSingleClosingAfter =
			after === '`' &&
			after2 !== '`' &&
			(hasSingleOpeningBefore || !line.slice(cursor.ch + 1).includes('`'));

		const fromCh = hasSingleOpeningBefore ? cursor.ch - 1 : cursor.ch;
		const toCh = hasSingleClosingAfter ? cursor.ch + 1 : cursor.ch;

		editor.replaceRange(
			'`◊ `',
			{ line: cursor.line, ch: fromCh },
			{ line: cursor.line, ch: toCh },
		);
		editor.setCursor({ line: cursor.line, ch: fromCh + 3 });
		return;
	}

	const fromPos = editor.getCursor('from');
	const maxRun = longestBacktickRun(selected);
	const wrapped =
		maxRun === 0
			? `\`◊ ${selected}\``
			: `${'`'.repeat(maxRun + 1)} ◊ ${selected} ${'`'.repeat(maxRun + 1)}`;

	editor.replaceSelection(wrapped);
	const wrappedLines = wrapped.split('\n');
	const endPos: EditorPosition =
		wrappedLines.length === 1
			? { line: fromPos.line, ch: fromPos.ch + wrapped.length }
			: {
					line: fromPos.line + wrappedLines.length - 1,
					ch: wrappedLines[wrappedLines.length - 1]!.length,
				};
	editor.setCursor(endPos);
}
