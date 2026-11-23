/**
 * Shared document-level Markdown block, table, heading, comment, and math context classifier
 * used by both `findRhizomeInlineSpans` and `RhizomeInlineSuggest` so prose/non-prose boundaries
 * never drift between scanning, highlighting, linting, Live Preview, and autocomplete.
 */

const FENCE_LINE_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING_RE = /^[ ]{0,3}(#{1,6})(?:[ \t]+|$)/;
const SETEXT_UNDERLINE_RE = /^[ ]{0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK_RE = /^[ ]{0,3}(?:-\s*){3,}$|^[ ]{0,3}(?:_\s*){3,}$|^[ ]{0,3}(?:\*\s*){3,}$/;
const LIST_STARTER_RE = /^[ ]{0,3}(?:[-+*][ \t]|\d{1,9}[.)][ \t])/;
const BLOCKQUOTE_PREFIX_RE = /^(?:[ ]{0,3}>[ \t]?)+/;
const TABLE_DELIMITER_ROW_RE =
	/^[ ]{0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$|^[ ]{0,3}\|[ \t]*:?-+:?[ \t]*\|[ \t]*$/;

type MultiLineExclusionMode = 'none' | 'html-comment' | 'obsidian-comment' | 'display-math';

/**
 * Per-line structural and masked-prose metadata produced by `classifyMarkdownLines`.
 */
export interface ClassifiedMarkdownLine {
	readonly lineIndex: number;
	readonly rawText: string;
	/** Length of any leading blockquote `> ` prefix on this line (`0` outside blockquotes/callouts). */
	readonly quotePrefixLen: number;
	/** Number of `>` markers in the leading blockquote prefix (`0` outside blockquotes/callouts). */
	readonly quoteDepth: number;
	/**
	 * Same length as `rawText`, with characters inside YAML frontmatter, fenced/indented code,
	 * `<!--...-->`, `%%...%%`, `$$...$$`, `$...$`, and leading `>` prefixes replaced by `' '`.
	 */
	readonly maskedText: string;
	readonly skipLine: boolean;
	readonly isBlankRest: boolean;
	readonly isTableRow: boolean;
	readonly isAtxHeading: boolean;
	readonly isThematicBreak: boolean;
	readonly headingLevelBefore: number;
}

function stripLeadingBlockquote(rawLine: string): {
	readonly prefixLen: number;
	readonly quoteDepth: number;
	readonly rest: string;
} {
	const match = BLOCKQUOTE_PREFIX_RE.exec(rawLine);
	if (!match) {
		return { prefixLen: 0, quoteDepth: 0, rest: rawLine };
	}
	const prefix = match[0];
	let depth = 0;
	for (let i = 0; i < prefix.length; i++) {
		if (prefix[i] === '>') {
			depth++;
		}
	}
	return {
		prefixLen: prefix.length,
		quoteDepth: depth,
		rest: rawLine.slice(prefix.length),
	};
}

function findFrontmatterEndLine(rawLines: readonly string[]): number {
	if (rawLines.length < 2 || !/^---[ \t]*$/.test(rawLines[0]!)) {
		return 0;
	}
	for (let i = 1; i < rawLines.length; i++) {
		if (/^(?:---|\.\.\.)[ \t]*$/.test(rawLines[i]!)) {
			return i + 1;
		}
	}
	return 0;
}

/**
 * Splits `restText` (after any leading blockquote prefix) into GFM table cell `[start, end)`
 * slices on unescaped `|` delimiters.
 */
export function splitTableCellRanges(
	restText: string,
): Array<{ readonly start: number; readonly end: number }> {
	const cells: Array<{ readonly start: number; readonly end: number }> = [];
	let cellStart = 0;
	for (let i = 0; i < restText.length; i++) {
		const ch = restText[i]!;
		if (ch === '\\' && i + 1 < restText.length) {
			i++;
			continue;
		}
		if (ch === '|') {
			if (i > cellStart) {
				cells.push({ start: cellStart, end: i });
			}
			cellStart = i + 1;
		}
	}
	if (cellStart < restText.length) {
		cells.push({ start: cellStart, end: restText.length });
	}
	return cells;
}

function maskMultiLineConstructsInSlice(
	chars: string[],
	sliceStart: number,
	sliceEnd: number,
	initialMode: MultiLineExclusionMode,
): MultiLineExclusionMode {
	let mode = initialMode;
	let i = sliceStart;

	while (i < sliceEnd) {
		if (mode === 'html-comment') {
			if (
				i + 2 < sliceEnd &&
				chars[i] === '-' &&
				chars[i + 1] === '-' &&
				chars[i + 2] === '>'
			) {
				chars[i] = ' ';
				chars[i + 1] = ' ';
				chars[i + 2] = ' ';
				i += 3;
				mode = 'none';
				continue;
			}
			if (chars[i] !== '\n' && chars[i] !== '\r') {
				chars[i] = ' ';
			}
			i++;
			continue;
		}

		if (mode === 'obsidian-comment') {
			if (i + 1 < sliceEnd && chars[i] === '%' && chars[i + 1] === '%') {
				chars[i] = ' ';
				chars[i + 1] = ' ';
				i += 2;
				mode = 'none';
				continue;
			}
			if (chars[i] !== '\n' && chars[i] !== '\r') {
				chars[i] = ' ';
			}
			i++;
			continue;
		}

		if (mode === 'display-math') {
			if (chars[i] === '\\' && i + 1 < sliceEnd) {
				if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
				if (chars[i + 1] !== '\n' && chars[i + 1] !== '\r') chars[i + 1] = ' ';
				i += 2;
				continue;
			}
			if (i + 1 < sliceEnd && chars[i] === '$' && chars[i + 1] === '$') {
				chars[i] = ' ';
				chars[i + 1] = ' ';
				i += 2;
				mode = 'none';
				continue;
			}
			if (chars[i] !== '\n' && chars[i] !== '\r') {
				chars[i] = ' ';
			}
			i++;
			continue;
		}

		const ch = chars[i]!;
		if (ch === '\\' && i + 1 < sliceEnd) {
			i += 2;
			continue;
		}

		// Protect closed inline backtick code spans within this slice so `%%` / `$` inside code
		// spans do not open comment or math modes.
		if (ch === '`') {
			let runEnd = i;
			while (runEnd < sliceEnd && chars[runEnd] === '`') {
				runEnd++;
			}
			const tickLen = runEnd - i;
			let search = runEnd;
			let closeEnd = -1;
			while (search < sliceEnd) {
				if (chars[search] !== '`') {
					search++;
					continue;
				}
				let candEnd = search;
				while (candEnd < sliceEnd && chars[candEnd] === '`') {
					candEnd++;
				}
				if (candEnd - search === tickLen) {
					closeEnd = candEnd;
					break;
				}
				search = candEnd;
			}
			if (closeEnd !== -1) {
				i = closeEnd;
				continue;
			}
			i = runEnd;
			continue;
		}

		if (
			ch === '<' &&
			i + 3 < sliceEnd &&
			chars[i + 1] === '!' &&
			chars[i + 2] === '-' &&
			chars[i + 3] === '-'
		) {
			chars[i] = ' ';
			chars[i + 1] = ' ';
			chars[i + 2] = ' ';
			chars[i + 3] = ' ';
			i += 4;
			mode = 'html-comment';
			continue;
		}

		if (ch === '%' && i + 1 < sliceEnd && chars[i + 1] === '%') {
			chars[i] = ' ';
			chars[i + 1] = ' ';
			i += 2;
			mode = 'obsidian-comment';
			continue;
		}

		if (ch === '$') {
			if (i + 1 < sliceEnd && chars[i + 1] === '$') {
				chars[i] = ' ';
				chars[i + 1] = ' ';
				i += 2;
				mode = 'display-math';
				continue;
			}
			const afterOpen = chars[i + 1] ?? '';
			if (afterOpen.length > 0 && !/[\s$]/.test(afterOpen)) {
				let m = i + 1;
				let closeIdx = -1;
				while (m < sliceEnd && chars[m] !== '\n' && chars[m] !== '\r') {
					if (chars[m] === '\\' && m + 1 < sliceEnd) {
						m += 2;
						continue;
					}
					if (
						chars[m] === '$' &&
						!/\s/.test(chars[m - 1] ?? ' ') &&
						!/\d/.test(chars[m + 1] ?? '')
					) {
						closeIdx = m;
						break;
					}
					m++;
				}
				if (closeIdx !== -1) {
					for (let k = i; k <= closeIdx; k++) {
						chars[k] = ' ';
					}
					i = closeIdx + 1;
					continue;
				}
			}
		}

		i++;
	}

	return mode;
}

/**
 * Classifies all `rawLines` in a single stateful document pass:
 * - masks YAML frontmatter, fenced/indented code blocks, multi-paragraph `<!--...-->` / `%%...%%` /
 *   `$$...$$` blocks, and inline `$...$` math into spaces while preserving exact line offsets;
 * - detects GFM tables (including inside blockquotes and Obsidian callouts `> | ... |`);
 * - computes preceding ATX and Setext heading levels (`0..6`) ignoring commented-out headings.
 */
export function classifyMarkdownLines(rawLines: readonly string[]): ClassifiedMarkdownLine[] {
	const count = rawLines.length;
	const fmEnd = findFrontmatterEndLine(rawLines);

	interface MutableLine {
		readonly lineIndex: number;
		readonly rawText: string;
		readonly quotePrefixLen: number;
		readonly quoteDepth: number;
		readonly rest: string;
		maskedText: string;
		skipLine: boolean;
		isBlankRest: boolean;
		isTableRow: boolean;
		isAtxHeading: boolean;
		isThematicBreak: boolean;
		headingLevelBefore: number;
	}

	const lines: MutableLine[] = new Array<MutableLine>(count);
	for (let i = 0; i < count; i++) {
		const rawText = rawLines[i]!;
		const { prefixLen, quoteDepth, rest } = stripLeadingBlockquote(rawText);
		lines[i] = {
			lineIndex: i,
			rawText,
			quotePrefixLen: prefixLen,
			quoteDepth,
			rest,
			maskedText: ' '.repeat(rawText.length),
			skipLine: i < fmEnd,
			isBlankRest: rest.trim().length === 0,
			isTableRow: false,
			isAtxHeading: false,
			isThematicBreak: false,
			headingLevelBefore: 0,
		};
	}

	let inFence = false;
	let fenceChar = '';
	let fenceLen = 0;
	let fenceQuoteDepth = 0;
	let inParagraph = false;
	let inList = false;
	let prevQuoteDepth = 0;

	for (let i = fmEnd; i < count; i++) {
		const info = lines[i]!;
		if (info.quoteDepth !== prevQuoteDepth) {
			if (inFence && info.quoteDepth < fenceQuoteDepth) {
				inFence = false;
			}
			inParagraph = false;
			inList = false;
			prevQuoteDepth = info.quoteDepth;
		}

		if (inFence) {
			info.skipLine = true;
			const closeMatch = FENCE_LINE_RE.exec(info.rest);
			if (closeMatch) {
				const marker = closeMatch[1]!;
				const trailing = (closeMatch[2] ?? '').trim();
				if (marker[0] === fenceChar && marker.length >= fenceLen && trailing.length === 0) {
					inFence = false;
				}
			}
			continue;
		}

		const openMatch = FENCE_LINE_RE.exec(info.rest);
		if (openMatch) {
			const marker = openMatch[1]!;
			const infoStr = openMatch[2] ?? '';
			if (marker[0] === '~' || !infoStr.includes('`')) {
				inFence = true;
				fenceChar = marker[0]!;
				fenceLen = marker.length;
				fenceQuoteDepth = info.quoteDepth;
				info.skipLine = true;
				inParagraph = false;
				continue;
			}
		}

		if (info.isBlankRest) {
			inParagraph = false;
			inList = false;
			continue;
		}

		if (!inParagraph && !inList && /^(?: {4}|\t)/.test(info.rest)) {
			info.skipLine = true;
			continue;
		}

		if (LIST_STARTER_RE.test(info.rest)) {
			inList = true;
			inParagraph = true;
			continue;
		}

		if (ATX_HEADING_RE.test(info.rest) || THEMATIC_BREAK_RE.test(info.rest)) {
			inParagraph = false;
			inList = false;
			continue;
		}

		inParagraph = true;
	}

	// Detect GFM tables (supporting matching `quoteDepth` for blockquotes and callouts)
	for (let i = fmEnd + 1; i < count; i++) {
		const delimInfo = lines[i]!;
		const headerInfo = lines[i - 1]!;
		if (
			delimInfo.skipLine ||
			headerInfo.skipLine ||
			headerInfo.isBlankRest ||
			headerInfo.isTableRow ||
			delimInfo.quoteDepth !== headerInfo.quoteDepth ||
			!headerInfo.rest.includes('|') ||
			ATX_HEADING_RE.test(headerInfo.rest) ||
			!TABLE_DELIMITER_ROW_RE.test(delimInfo.rest)
		) {
			continue;
		}
		headerInfo.isTableRow = true;
		delimInfo.isTableRow = true;
		delimInfo.skipLine = true;
		let r = i + 1;
		while (r < count) {
			const rowInfo = lines[r]!;
			if (
				rowInfo.skipLine ||
				rowInfo.isBlankRest ||
				rowInfo.quoteDepth !== headerInfo.quoteDepth ||
				ATX_HEADING_RE.test(rowInfo.rest) ||
				THEMATIC_BREAK_RE.test(rowInfo.rest) ||
				LIST_STARTER_RE.test(rowInfo.rest) ||
				!rowInfo.rest.includes('|')
			) {
				break;
			}
			rowInfo.isTableRow = true;
			r++;
		}
		i = r - 1;
	}

	// Stateful multi-line masking across paragraphs, blank lines, headings, and table cells
	let exclusionMode: MultiLineExclusionMode = 'none';
	let idx = fmEnd;
	while (idx < count) {
		const info = lines[idx]!;
		if (info.skipLine) {
			idx++;
			continue;
		}

		if (info.isBlankRest) {
			// Blank lines carry `exclusionMode` forward without resetting it!
			idx++;
			continue;
		}

		if (info.isTableRow) {
			const lineChars = Array.from(info.rawText);
			for (let p = 0; p < info.quotePrefixLen; p++) {
				lineChars[p] = ' ';
			}
			for (const cell of splitTableCellRanges(info.rest)) {
				const absStart = info.quotePrefixLen + cell.start;
				const absEnd = info.quotePrefixLen + cell.end;
				exclusionMode = maskMultiLineConstructsInSlice(
					lineChars,
					absStart,
					absEnd,
					exclusionMode,
				);
			}
			info.maskedText = lineChars.join('');
			idx++;
			continue;
		}

		const rawHeadingOrBreak =
			ATX_HEADING_RE.test(info.rest) || THEMATIC_BREAK_RE.test(info.rest);
		if (rawHeadingOrBreak) {
			const lineChars = Array.from(info.rawText);
			for (let p = 0; p < info.quotePrefixLen; p++) {
				lineChars[p] = ' ';
			}
			exclusionMode = maskMultiLineConstructsInSlice(
				lineChars,
				info.quotePrefixLen,
				lineChars.length,
				exclusionMode,
			);
			info.maskedText = lineChars.join('');
			const maskedRest = info.maskedText.slice(info.quotePrefixLen);
			info.isAtxHeading = ATX_HEADING_RE.test(maskedRest);
			info.isThematicBreak = THEMATIC_BREAK_RE.test(maskedRest);
			idx++;
			continue;
		}

		// Contiguous paragraph/list block at the same blockquote depth
		const blockStart = idx;
		let blockEnd = idx + 1;
		while (blockEnd < count) {
			const next = lines[blockEnd]!;
			if (
				next.skipLine ||
				next.isBlankRest ||
				next.isTableRow ||
				next.quoteDepth !== info.quoteDepth ||
				ATX_HEADING_RE.test(next.rest) ||
				THEMATIC_BREAK_RE.test(next.rest)
			) {
				break;
			}
			blockEnd++;
		}

		const joinedParts: string[] = [];
		for (let k = blockStart; k < blockEnd; k++) {
			const l = lines[k]!;
			joinedParts.push(' '.repeat(l.quotePrefixLen) + l.rest);
		}
		const blockChars = Array.from(joinedParts.join('\n'));
		exclusionMode = maskMultiLineConstructsInSlice(
			blockChars,
			0,
			blockChars.length,
			exclusionMode,
		);
		const maskedBlockLines = blockChars.join('').split('\n');
		for (let k = blockStart; k < blockEnd; k++) {
			lines[k]!.maskedText = maskedBlockLines[k - blockStart]!;
		}
		idx = blockEnd;
	}

	// Compute heading levels (`0..6`) from masked lines so `# Heading` inside `%%...%%` or
	// `<!--...-->` never alters `headingLevelBefore`.
	let headingLevel = 0;
	for (let i = fmEnd; i < count; i++) {
		const info = lines[i]!;
		info.headingLevelBefore = headingLevel;
		if (info.skipLine || info.isBlankRest || info.isTableRow || info.quoteDepth > 0) {
			continue;
		}
		const maskedRest = info.maskedText.slice(info.quotePrefixLen);
		const atx = ATX_HEADING_RE.exec(maskedRest);
		if (atx) {
			headingLevel = atx[1]!.length;
			continue;
		}
		const nextInfo = i + 1 < count ? lines[i + 1] : undefined;
		if (
			nextInfo &&
			!nextInfo.skipLine &&
			!nextInfo.isTableRow &&
			nextInfo.quoteDepth === 0 &&
			maskedRest.trim().length > 0 &&
			!LIST_STARTER_RE.test(maskedRest) &&
			SETEXT_UNDERLINE_RE.test(nextInfo.maskedText.slice(nextInfo.quotePrefixLen))
		) {
			nextInfo.headingLevelBefore = headingLevel;
			headingLevel = nextInfo.maskedText.trimStart().startsWith('=') ? 1 : 2;
			i++;
		}
	}

	return lines;
}
