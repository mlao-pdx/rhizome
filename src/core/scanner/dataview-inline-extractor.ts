import type { InlinePropertyInput, ObsidianPosInput } from '../search/metadata-normalizer';

export interface DataviewInlineFieldSpan {
	readonly key: string;
	readonly value: string | null;
	readonly startCol: number;
	readonly endCol: number;
}

const FORBIDDEN_KEY_CHARS = new Set(['[', ']', '(', ')', ':', '\r', '\n']);

function findOpeningBracket(maskedLine: string, sepIdx: number, minCol: number): number {
	for (let i = sepIdx - 1; i >= minCol; i--) {
		const ch = maskedLine[i]!;
		if (ch === '[' || ch === '(') {
			return i;
		}
		if (FORBIDDEN_KEY_CHARS.has(ch)) {
			return -1;
		}
	}
	return -1;
}

function findClosingBracket(
	maskedLine: string,
	startIdx: number,
	openChar: '[' | '(',
	closeChar: ']' | ')',
): number {
	let nesting = 1;
	const len = maskedLine.length;
	for (let i = startIdx; i < len; i++) {
		const ch = maskedLine[i]!;
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === openChar) {
			nesting++;
		} else if (ch === closeChar) {
			nesting--;
			if (nesting === 0) {
				return i;
			}
		}
	}
	return -1;
}

/**
 * Extracts all wrapped Dataview inline fields (`[key:: value]` and `(key:: value)`)
 * from `line`, guided by `maskedLine` (where inline code and math spans are space-masked).
 */
export function extractDataviewWrappedSpans(
	line: string,
	maskedLine: string,
): DataviewInlineFieldSpan[] {
	if (!maskedLine.includes('::')) {
		return [];
	}

	const spans: DataviewInlineFieldSpan[] = [];
	let searchFrom = 0;
	let minOpenCol = 0;

	while (searchFrom < maskedLine.length) {
		const sepIdx = maskedLine.indexOf('::', searchFrom);
		if (sepIdx === -1) {
			break;
		}

		const openIdx = findOpeningBracket(maskedLine, sepIdx, minOpenCol);
		if (openIdx === -1) {
			searchFrom = sepIdx + 2;
			continue;
		}

		const openChar = maskedLine[openIdx] as '[' | '(';
		const closeChar = openChar === '[' ? ']' : ')';
		const closeIdx = findClosingBracket(maskedLine, sepIdx + 2, openChar, closeChar);
		if (closeIdx === -1) {
			searchFrom = sepIdx + 2;
			continue;
		}

		// Guard against treating a [[WikiLink::Title]] as an inline property
		if (
			openChar === '[' &&
			openIdx > 0 &&
			maskedLine[openIdx - 1] === '[' &&
			closeIdx + 1 < maskedLine.length &&
			maskedLine[closeIdx + 1] === ']'
		) {
			searchFrom = closeIdx + 2;
			minOpenCol = closeIdx + 2;
			continue;
		}

		const rawKeySlice = line.slice(openIdx + 1, sepIdx);
		const maskedKeySlice = maskedLine.slice(openIdx + 1, sepIdx);
		const trimmedKey = rawKeySlice.trim();
		// Reject empty keys or keys whose non-whitespace content was entirely inside an inline code/math mask
		if (trimmedKey.length === 0 || maskedKeySlice.trim().length === 0) {
			searchFrom = sepIdx + 2;
			minOpenCol = sepIdx + 2;
			continue;
		}

		const rawValueSlice = line.slice(sepIdx + 2, closeIdx).trim();
		const value = rawValueSlice.length === 0 ? null : rawValueSlice;

		spans.push({
			key: trimmedKey,
			value,
			startCol: openIdx,
			endCol: closeIdx + 1,
		});

		searchFrom = closeIdx + 1;
		minOpenCol = closeIdx + 1;
	}

	return spans;
}

/**
 * Extracts note-level Dataview inline properties (`[key:: value]` and `(key:: value)`)
 * from a single non-task line with `source: 'dataview'` and 0-based `ObsidianPosInput`.
 */
export function extractDataviewInlinePropertiesFromLine(
	line: string,
	maskedLine: string,
	lineNumberOneBased: number,
	lineStartOffset: number,
): InlinePropertyInput[] {
	const spans = extractDataviewWrappedSpans(line, maskedLine);
	if (spans.length === 0) {
		return [];
	}

	const zeroBasedLine = lineNumberOneBased - 1;
	const out: InlinePropertyInput[] = [];
	for (const span of spans) {
		const position: ObsidianPosInput = {
			start: {
				line: zeroBasedLine,
				col: span.startCol,
				offset: lineStartOffset + span.startCol,
			},
			end: {
				line: zeroBasedLine,
				col: span.endCol,
				offset: lineStartOffset + span.endCol,
			},
		};
		out.push({
			key: span.key,
			value: span.value,
			source: 'dataview',
			line: lineNumberOneBased,
			position,
		});
	}
	return out;
}
