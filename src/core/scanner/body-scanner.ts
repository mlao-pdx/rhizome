import { XxHash64Accumulator } from '../hash/xxhash64';
import type { InlinePropertyInput, ObsidianPosInput } from '../search/metadata-normalizer';
import { extractDataviewInlinePropertiesFromLine } from './dataview-inline-extractor';
import { maskInlineCodeAndMath } from './line-masker';
import { extractTaskFromLine, TASK_LINE_RE, type ExtractedTaskInput } from './task-extractor';

export interface ObsidianSectionCacheInput {
	readonly type: string;
	readonly position: ObsidianPosInput;
}

export interface ObsidianListItemCacheInput {
	readonly task?: string | undefined;
	readonly parent: number;
	readonly position: ObsidianPosInput;
}

export interface ObsidianBodyScannerCacheInput {
	readonly sections?: readonly ObsidianSectionCacheInput[] | undefined;
	readonly listItems?: readonly ObsidianListItemCacheInput[] | undefined;
}

export interface BodyScanResult {
	readonly inlineProperties: InlinePropertyInput[];
	readonly tasks: ExtractedTaskInput[];
}

const SKIPPED_SECTION_TYPES: ReadonlySet<string> = new Set([
	'yaml',
	'code',
	'math',
	'thematicBreak',
	'html',
]);

const FENCE_OPEN_RE = /^[\s\t>]*(`{3,}|~{3,})/;
const MATH_BLOCK_DELIM_RE = /^[\s\t>]*\$\$(?!.*?\$\$)/;
const LIST_ITEM_INDENT_RE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +/;

function computeIndentWidth(prefix: string): number {
	let width = 0;
	for (let i = 0; i < prefix.length; i++) {
		const ch = prefix[i]!;
		if (ch === '\t') {
			width += 4;
		} else if (ch === ' ') {
			width += 1;
		}
	}
	return width;
}

function buildSkippedLinesMask(
	lineCount: number,
	sections: readonly ObsidianSectionCacheInput[] | undefined,
): Uint8Array | null {
	if (!sections || sections.length === 0) {
		return null;
	}
	const skipped = new Uint8Array(lineCount);
	for (const sec of sections) {
		if (!SKIPPED_SECTION_TYPES.has(sec.type)) {
			continue;
		}
		const startLine = Math.max(0, sec.position.start.line);
		const endLine = Math.min(lineCount - 1, sec.position.end.line);
		for (let l = startLine; l <= endLine; l++) {
			skipped[l] = 1;
		}
	}
	return skipped;
}

/**
 * Scans a Markdown note body in a single pass for note-level Dataview inline
 * properties (`[key:: value]` and `(key:: value)`) and `obsidian-tasks` / Dataview tasks.
 *
 * @remarks
 * Skips YAML frontmatter, fenced code blocks, math blocks, HTML sections, and thematic
 * breaks, and masks inline code spans and inline math spans on each candidate line while
 * keeping `%%...%%` and `<!--...-->` comments visible.
 */
export function scanNoteBody(
	text: string,
	cache?: ObsidianBodyScannerCacheInput | null,
): BodyScanResult {
	if (text.length === 0) {
		return { inlineProperties: [], tasks: [] };
	}

	const lines: string[] = [];
	const lineOffsets: number[] = [];
	let lineStart = 0;
	const textLen = text.length;

	for (let i = 0; i < textLen; i++) {
		const code = text.charCodeAt(i);
		if (code === 10 /* \n */) {
			const end = i > lineStart && text.charCodeAt(i - 1) === 13 /* \r */ ? i - 1 : i;
			lines.push(text.slice(lineStart, end));
			lineOffsets.push(lineStart);
			lineStart = i + 1;
		} else if (code === 13 /* \r */ && (i + 1 >= textLen || text.charCodeAt(i + 1) !== 10)) {
			lines.push(text.slice(lineStart, i));
			lineOffsets.push(lineStart);
			lineStart = i + 1;
		}
	}
	if (lineStart <= textLen) {
		lines.push(text.slice(lineStart));
		lineOffsets.push(lineStart);
	}

	const lineCount = lines.length;
	const skippedLines = buildSkippedLinesMask(lineCount, cache?.sections);

	const listItemsByLine = new Map<number, ObsidianListItemCacheInput>();
	if (cache?.listItems) {
		for (const item of cache.listItems) {
			listItemsByLine.set(item.position.start.line, item);
		}
	}

	// Fallback frontmatter range detection when cache?.sections is absent
	let yamlEndLine = -1;
	if (!skippedLines && lineCount > 1 && lines[0]!.trim() === '---') {
		for (let l = 1; l < lineCount; l++) {
			const trimmed = lines[l]!.trim();
			if (trimmed === '---' || trimmed === '...') {
				yamlEndLine = l;
				break;
			}
		}
	}

	const inlineProperties: InlinePropertyInput[] = [];
	const tasks: ExtractedTaskInput[] = [];
	const indentStack: Array<{ indent: number; lineOneBased: number }> = [];

	let activeFenceChar: string | null = null;
	let activeFenceLen = 0;
	let inMathBlock = false;

	for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
		if (lineIdx <= yamlEndLine || (skippedLines && skippedLines[lineIdx] === 1)) {
			indentStack.length = 0;
			continue;
		}

		const line = lines[lineIdx]!;

		// Track fenced code blocks (including inside callouts/blockquotes)
		const fenceMatch = FENCE_OPEN_RE.exec(line);
		if (fenceMatch && fenceMatch[1]) {
			const marker = fenceMatch[1];
			const ch = marker[0]!;
			if (activeFenceChar === null) {
				activeFenceChar = ch;
				activeFenceLen = marker.length;
				continue;
			} else if (activeFenceChar === ch && marker.length >= activeFenceLen) {
				const rest = line.slice(fenceMatch[0].length).trim();
				if (rest.length === 0) {
					activeFenceChar = null;
					activeFenceLen = 0;
					continue;
				}
			}
		}
		if (activeFenceChar !== null) {
			continue;
		}

		// Track multi-line $$ math blocks
		if (MATH_BLOCK_DELIM_RE.test(line)) {
			inMathBlock = !inMathBlock;
			continue;
		}
		if (inMathBlock) {
			continue;
		}

		const lineNumberOneBased = lineIdx + 1;
		const lineStartOffset = lineOffsets[lineIdx]!;

		// Update fallback list-item indentation stack for parentLine resolution
		const listMatch = LIST_ITEM_INDENT_RE.exec(line);
		let inferredParentLine: number | null = null;
		if (listMatch) {
			const indent = computeIndentWidth(listMatch[1]!);
			while (
				indentStack.length > 0 &&
				indentStack[indentStack.length - 1]!.indent >= indent
			) {
				indentStack.pop();
			}
			inferredParentLine =
				indentStack.length > 0 ? indentStack[indentStack.length - 1]!.lineOneBased : null;
			indentStack.push({ indent, lineOneBased: lineNumberOneBased });
		} else if (line.trim().length === 0) {
			indentStack.length = 0;
		}

		const cachedListItem = listItemsByLine.get(lineIdx);
		const isCandidateTask =
			(cachedListItem !== undefined && cachedListItem.task !== undefined) ||
			(listMatch !== null && TASK_LINE_RE.test(line));
		const hasDataviewSep = line.includes('::');

		if (!isCandidateTask && !hasDataviewSep) {
			continue;
		}

		const maskedLine = maskInlineCodeAndMath(line);

		if (isCandidateTask) {
			const parentLine =
				cachedListItem !== undefined
					? cachedListItem.parent >= 0
						? cachedListItem.parent + 1
						: null
					: inferredParentLine;
			const task = extractTaskFromLine(
				line,
				maskedLine,
				lineNumberOneBased,
				lineStartOffset,
				parentLine,
			);
			if (task !== null) {
				tasks.push(task);
				continue;
			}
		}

		if (hasDataviewSep) {
			const props = extractDataviewInlinePropertiesFromLine(
				line,
				maskedLine,
				lineNumberOneBased,
				lineStartOffset,
			);
			for (const p of props) {
				inlineProperties.push(p);
			}
		}
	}

	return { inlineProperties, tasks };
}

/**
 * Computes a deterministic 64-bit xxHash hex digest over a `BodyScanResult`.
 */
export function digestBodyScanResult(result: BodyScanResult): string {
	const acc = new XxHash64Accumulator();
	acc.updateTag(0x51, 0);
	acc.updateValue([result.inlineProperties, result.tasks]);
	return acc.digest().hex;
}
