/**
 * Pure CommonMark top-level fenced `rhizome` codeblock scanner.
 *
 * @remarks
 * (design, 2026-11-23) Shared between run-once template extraction (`extractTopLevelRhizomeBlocks`)
 * and CodeMirror viewport scanning (`findRhizomeCodeBlocks`) so leading YAML frontmatter,
 * nested 3-backtick/tilde fences inside wider documentation fences, inline backtick code spans,
 * and 4-space indented code blocks behave identically across editor analysis and template execution.
 */

/**
 * Location, line coordinates, and content slice of a top-level fenced `rhizome` codeblock.
 */
export interface TopLevelRhizomeBlock {
	/** 0-based index among top-level `rhizome` blocks in the document. */
	readonly index: number;
	/**
	 * Codeblock body with at most one trailing line break immediately preceding a closing fence
	 * stripped, matching the `source` string Obsidian passes to `registerMarkdownCodeBlockProcessor`.
	 */
	readonly source: string;
	/**
	 * Raw slice `[bodyFrom, bodyTo)` inside the source document (retaining the line break before
	 * the closing fence for exact UTF-16 offset mapping in CodeMirror).
	 */
	readonly rawSlice: string;
	/** Inclusive 0-based UTF-16 offset where the block body starts. */
	readonly bodyFrom: number;
	/** Exclusive 0-based UTF-16 offset where the block body ends. */
	readonly bodyTo: number;
	/** 1-based line number of the opening fence line in the document. */
	readonly fenceStartLine: number;
	/** 1-based line number of the first line inside the codeblock body. */
	readonly bodyStartLine: number;
}

const YAML_OPEN_RE = /^\uFEFF?---[ \t]*$/;
const YAML_CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;
const FENCE_OPEN_CANDIDATE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_CANDIDATE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const RHIZOME_INFO_RE = /^rhizome(?:\s|$)/i;

/**
 * Finds the 0-based closing line index of leading YAML frontmatter (`--- ... ---` or `--- ... ...`),
 * returning `-1` when no closed YAML frontmatter block starts on line 1.
 */
export function findYamlFrontmatterEndLine(
	getLine: (zeroBasedLineIndex: number) => string,
	lineCount: number,
): number {
	if (lineCount < 2 || !YAML_OPEN_RE.test(getLine(0))) {
		return -1;
	}
	for (let i = 1; i < lineCount; i++) {
		if (YAML_CLOSE_RE.test(getLine(i))) {
			return i;
		}
	}
	return -1;
}

/**
 * Mutable line-by-line state for CommonMark top-level code fence scanning.
 */
export interface FenceScanState {
	inFence: boolean;
	fenceChar: string;
	fenceLen: number;
	isRhizomeFence: boolean;
	fenceStartLine: number;
	bodyStartLine: number;
	bodyFrom: number;
}

/**
 * Creates a fresh `FenceScanState` outside any fence.
 */
export function createFenceScanState(): FenceScanState {
	return {
		inFence: false,
		fenceChar: '',
		fenceLen: 0,
		isRhizomeFence: false,
		fenceStartLine: 0,
		bodyStartLine: 0,
		bodyFrom: 0,
	};
}

/**
 * Advances `state` across a single document line (`oneBasedLineNo`), returning the closed
 * `rhizome` block range `{ bodyFrom, bodyTo, fenceStartLine, bodyStartLine }` when `lineText`
 * closes an active `rhizome` fence, or `null` otherwise.
 */
export function stepFenceScanLine(
	state: FenceScanState,
	lineText: string,
	oneBasedLineNo: number,
	lineFrom: number,
	afterLineBreakOffset: number,
): {
	readonly bodyFrom: number;
	readonly bodyTo: number;
	readonly fenceStartLine: number;
	readonly bodyStartLine: number;
} | null {
	if (!state.inFence) {
		const openMatch = FENCE_OPEN_CANDIDATE_RE.exec(lineText);
		if (!openMatch) {
			return null;
		}
		const marker = openMatch[1] ?? '';
		const rest = openMatch[2] ?? '';
		const ch = marker[0] ?? '';
		// CommonMark: backtick fence info strings cannot contain backticks.
		if (ch === '`' && rest.includes('`')) {
			return null;
		}
		state.inFence = true;
		state.fenceChar = ch;
		state.fenceLen = marker.length;
		state.isRhizomeFence = RHIZOME_INFO_RE.test(rest.trim());
		state.fenceStartLine = oneBasedLineNo;
		state.bodyStartLine = oneBasedLineNo + 1;
		state.bodyFrom = afterLineBreakOffset;
		return null;
	}

	const closeMatch = FENCE_CLOSE_CANDIDATE_RE.exec(lineText);
	if (!closeMatch) {
		return null;
	}
	const candidate = closeMatch[1] ?? '';
	if (candidate[0] !== state.fenceChar || candidate.length < state.fenceLen) {
		return null;
	}

	const wasRhizome = state.isRhizomeFence;
	const bodyFrom = state.bodyFrom;
	const bodyTo = Math.max(bodyFrom, lineFrom);
	const fenceStartLine = state.fenceStartLine;
	const bodyStartLine = state.bodyStartLine;

	state.inFence = false;
	state.fenceChar = '';
	state.fenceLen = 0;
	state.isRhizomeFence = false;
	state.fenceStartLine = 0;
	state.bodyStartLine = 0;
	state.bodyFrom = 0;

	if (!wasRhizome) {
		return null;
	}
	return { bodyFrom, bodyTo, fenceStartLine, bodyStartLine };
}

interface ScannedLineSpan {
	readonly text: string;
	readonly from: number;
	readonly afterBreak: number;
}

function splitDocumentLines(text: string): ScannedLineSpan[] {
	const lines: ScannedLineSpan[] = [];
	const len = text.length;
	let lineStart = 0;

	for (let i = 0; i < len; i++) {
		const code = text.charCodeAt(i);
		if (code === 10 /* \n */) {
			const lineEnd = i > lineStart && text.charCodeAt(i - 1) === 13 /* \r */ ? i - 1 : i;
			lines.push({
				text: text.slice(lineStart, lineEnd),
				from: lineStart,
				afterBreak: i + 1,
			});
			lineStart = i + 1;
		} else if (code === 13 /* \r */ && (i + 1 >= len || text.charCodeAt(i + 1) !== 10)) {
			lines.push({
				text: text.slice(lineStart, i),
				from: lineStart,
				afterBreak: i + 1,
			});
			lineStart = i + 1;
		}
	}

	if (lineStart <= len) {
		lines.push({
			text: text.slice(lineStart),
			from: lineStart,
			afterBreak: len,
		});
	}

	return lines;
}

function stripClosingFenceNewline(rawSlice: string): string {
	if (rawSlice.endsWith('\r\n')) {
		return rawSlice.slice(0, -2);
	}
	if (rawSlice.endsWith('\n') || rawSlice.endsWith('\r')) {
		return rawSlice.slice(0, -1);
	}
	return rawSlice;
}

/**
 * Extracts all top-level fenced `rhizome` codeblocks from `markdownText` in document order,
 * skipping leading YAML frontmatter and ignoring nested fences inside wider outer fences.
 */
export function extractTopLevelRhizomeBlocks(markdownText: string): TopLevelRhizomeBlock[] {
	if (markdownText.length === 0) {
		return [];
	}

	const lines = splitDocumentLines(markdownText);
	const lineCount = lines.length;
	const yamlEndLine = findYamlFrontmatterEndLine((idx) => lines[idx]?.text ?? '', lineCount);
	const state = createFenceScanState();
	const blocks: TopLevelRhizomeBlock[] = [];

	for (let idx = yamlEndLine + 1; idx < lineCount; idx++) {
		const line = lines[idx]!;
		const closed = stepFenceScanLine(state, line.text, idx + 1, line.from, line.afterBreak);
		if (closed !== null) {
			const rawSlice = markdownText.slice(closed.bodyFrom, closed.bodyTo);
			blocks.push({
				index: blocks.length,
				source: stripClosingFenceNewline(rawSlice),
				rawSlice,
				bodyFrom: closed.bodyFrom,
				bodyTo: closed.bodyTo,
				fenceStartLine: closed.fenceStartLine,
				bodyStartLine: closed.bodyStartLine,
			});
		}
	}

	if (state.inFence && state.isRhizomeFence) {
		const bodyFrom = state.bodyFrom;
		const bodyTo = markdownText.length;
		const rawSlice = markdownText.slice(bodyFrom, bodyTo);
		blocks.push({
			index: blocks.length,
			source: rawSlice,
			rawSlice,
			bodyFrom,
			bodyTo,
			fenceStartLine: state.fenceStartLine,
			bodyStartLine: state.bodyStartLine,
		});
	}

	return blocks;
}

/**
 * Counts top-level fenced `rhizome` codeblocks in `markdownText`.
 */
export function countTopLevelRhizomeBlocks(markdownText: string): number {
	return extractTopLevelRhizomeBlocks(markdownText).length;
}
