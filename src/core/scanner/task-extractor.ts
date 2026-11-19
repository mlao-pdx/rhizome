import type { ObsidianPosInput } from '../search/metadata-normalizer';
import { FORBIDDEN_KEYS, mergeKeyValue } from '../search/property-coercion';
import type { TaskPriority, TaskSignifierFormat, TaskStatusType } from '../search/types';
import { extractDataviewWrappedSpans } from './dataview-inline-extractor';
import {
	createEmptySignifierState,
	mapTaskStatusSymbol,
	parseDataviewSignifier,
	PRIORITY_NUMBERS,
	tryPeelEmojiSignifier,
} from './task-signifiers';

export { mapTaskStatusSymbol };

export interface ExtractedTaskInput {
	readonly line: number;
	readonly status: string;
	readonly statusType: TaskStatusType;
	readonly completed: boolean;
	readonly done: boolean;
	readonly text: string;
	readonly cleanText: string;
	readonly priority: TaskPriority;
	readonly priorityNumber: number;
	readonly created: string | null;
	readonly start: string | null;
	readonly scheduled: string | null;
	readonly due: string | null;
	readonly completion: string | null;
	readonly cancelled: string | null;
	readonly repeat: string | null;
	readonly onCompletion: string | null;
	readonly id: string | null;
	readonly dependsOn: string[];
	readonly tags: string[];
	readonly blockId: string | null;
	readonly parentLine: number | null;
	readonly format: TaskSignifierFormat;
	readonly properties: Record<string, unknown>;
	readonly position?: ObsidianPosInput | null | undefined;
}

export const TASK_LINE_RE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/u;

const BLOCK_ID_SUFFIX_RE = / +\^([a-zA-Z0-9-]+)$/;
const TRAILING_TAG_RE = /(?:^|\s)(#[^ !@#$%^&*(),.?":{}|<>[\]\\]+)$/;
const INLINE_TAG_GLOBAL_RE = /(?:^|[\s\t])#([^ !@#$%^&*(),.?":{}|<>[\]\\]+)/g;

/**
 * Parses a single Markdown line as an `obsidian-tasks` / Dataview compatible task item,
 * or returns `null` if the line is not a task list item.
 */
export function extractTaskFromLine(
	line: string,
	maskedLine: string,
	lineNumberOneBased: number,
	lineStartOffset: number,
	parentLine: number | null,
): ExtractedTaskInput | null {
	const headerMatch = TASK_LINE_RE.exec(maskedLine);
	if (!headerMatch) {
		return null;
	}

	const bodyLen = headerMatch[4]!.length;
	const bodyStartCol = line.length - bodyLen;
	const statusChar = headerMatch[3]!;
	const statusType = mapTaskStatusSymbol(statusChar);

	let rawBody = line.slice(bodyStartCol).replace(/[ \t]+$/, '');
	let maskedBody = maskedLine.slice(bodyStartCol, bodyStartCol + rawBody.length);

	// 1. Strip trailing ^block-id before signifier peeling
	let blockId: string | null = null;
	const blockMatch = BLOCK_ID_SUFFIX_RE.exec(maskedBody);
	if (blockMatch && blockMatch[1]) {
		blockId = blockMatch[1];
		rawBody = rawBody.slice(0, blockMatch.index).replace(/[ \t]+$/, '');
		maskedBody = maskedBody.slice(0, rawBody.length);
	}

	const state = createEmptySignifierState();

	// 2. Right-to-left signifier peeling loop (preserving interleaved trailing #tags and custom [key:: val])
	const trailingPreservedRaw: string[] = [];
	const trailingPreservedMasked: string[] = [];
	let runs = 0;
	let matched = false;

	do {
		matched = false;
		runs++;

		// 2a. Try emoji signifiers at end of line
		const emojiRes = tryPeelEmojiSignifier(rawBody, maskedBody, state);
		if (emojiRes) {
			rawBody = emojiRes.nextRaw;
			maskedBody = emojiRes.nextMasked;
			matched = true;
			continue;
		}

		// 2b. Try wrapped [key:: val] or (key:: val) at end of line (with optional trailing comma)
		const commaStrippedMasked = maskedBody.replace(/ *,$/, '');
		const spans = extractDataviewWrappedSpans(
			rawBody.slice(0, commaStrippedMasked.length),
			commaStrippedMasked,
		);
		const lastSpan = spans.length > 0 ? spans[spans.length - 1]! : undefined;
		if (
			lastSpan &&
			lastSpan.endCol === commaStrippedMasked.length &&
			(lastSpan.startCol === 0 ||
				maskedBody[lastSpan.startCol - 1] === ' ' ||
				maskedBody[lastSpan.startCol - 1] === '\t')
		) {
			const lowerKey = lastSpan.key.toLowerCase();
			const dvSig = parseDataviewSignifier(lowerKey, lastSpan.value);
			if (dvSig.matched) {
				dvSig.apply(state);
				state.hasDataview = true;
			} else {
				trailingPreservedRaw.unshift(
					rawBody.slice(lastSpan.startCol, commaStrippedMasked.length),
				);
				trailingPreservedMasked.unshift(
					maskedBody.slice(lastSpan.startCol, commaStrippedMasked.length),
				);
			}
			rawBody = rawBody.slice(0, lastSpan.startCol).replace(/[ \t]+$/, '');
			maskedBody = maskedBody.slice(0, rawBody.length);
			matched = true;
			continue;
		}

		// 2c. Pop trailing #tag so signifiers to its left can be peeled, then re-append later
		const tagMatch = TRAILING_TAG_RE.exec(maskedBody);
		if (tagMatch && tagMatch[1]) {
			const tagTokenLen = tagMatch[1].length;
			const tagStart = rawBody.length - tagTokenLen;
			trailingPreservedRaw.unshift(rawBody.slice(tagStart));
			trailingPreservedMasked.unshift(maskedBody.slice(tagStart));
			rawBody = rawBody.slice(0, tagMatch.index).replace(/[ \t]+$/, '');
			maskedBody = maskedBody.slice(0, rawBody.length);
			matched = true;
		}
	} while (matched && runs <= 20);

	if (trailingPreservedRaw.length > 0) {
		const suffixRaw = trailingPreservedRaw.join(' ');
		const suffixMasked = trailingPreservedMasked.join(' ');
		rawBody = rawBody.length > 0 ? `${rawBody} ${suffixRaw}` : suffixRaw;
		maskedBody = maskedBody.length > 0 ? `${maskedBody} ${suffixMasked}` : suffixMasked;
	}

	// 3. Extract custom task properties and strip mid-line Dataview signifiers if present
	const properties = Object.create(null) as Record<string, unknown>;
	const promotedKeys = new Set<string>();
	const remainingSpans = extractDataviewWrappedSpans(rawBody, maskedBody);
	const midLineSignifierSpans: Array<{ startCol: number; endCol: number }> = [];

	for (const span of remainingSpans) {
		const lowerKey = span.key.toLowerCase();
		const dvSig = parseDataviewSignifier(lowerKey, span.value);
		if (dvSig.matched) {
			dvSig.apply(state);
			state.hasDataview = true;
			midLineSignifierSpans.push({ startCol: span.startCol, endCol: span.endCol });
			continue;
		}
		if (!FORBIDDEN_KEYS.has(span.key) && !FORBIDDEN_KEYS.has(lowerKey)) {
			mergeKeyValue(properties, promotedKeys, span.key, span.value);
		}
	}

	if (midLineSignifierSpans.length > 0) {
		let nextRaw = '';
		let nextMasked = '';
		let cursor = 0;
		for (const sp of midLineSignifierSpans) {
			nextRaw += rawBody.slice(cursor, sp.startCol);
			nextMasked += maskedBody.slice(cursor, sp.startCol);
			cursor = sp.endCol;
		}
		nextRaw += rawBody.slice(cursor);
		nextMasked += maskedBody.slice(cursor);
		rawBody = nextRaw.replace(/[ \t]{2,}/g, ' ').trim();
		maskedBody = nextMasked.replace(/[ \t]{2,}/g, ' ').trim();
	}

	// 4. Collect all inline #tags on the task line (outside code/math)
	const tagSet = new Set<string>();
	INLINE_TAG_GLOBAL_RE.lastIndex = 0;
	let tagExec: RegExpExecArray | null;
	while ((tagExec = INLINE_TAG_GLOBAL_RE.exec(maskedBody)) !== null) {
		const capturedLen = tagExec[1]!.length;
		const tagBodyStart = tagExec.index + tagExec[0].length - capturedLen;
		const rawTagName = rawBody.slice(tagBodyStart, tagBodyStart + capturedLen);
		if (rawTagName.length > 0) {
			tagSet.add(rawTagName);
		}
	}

	// 5. Build cleanText by excising custom [key:: val] / (key:: val) spans and inline #tags
	const customSpans =
		midLineSignifierSpans.length > 0
			? extractDataviewWrappedSpans(rawBody, maskedBody)
			: remainingSpans;
	const cleanChars = rawBody.split('');
	for (const sp of customSpans) {
		for (let i = sp.startCol; i < sp.endCol; i++) {
			cleanChars[i] = ' ';
		}
	}
	INLINE_TAG_GLOBAL_RE.lastIndex = 0;
	while ((tagExec = INLINE_TAG_GLOBAL_RE.exec(maskedBody)) !== null) {
		const hashIdx = tagExec.index + tagExec[0].indexOf('#');
		const endIdx = tagExec.index + tagExec[0].length;
		for (let i = hashIdx; i < endIdx; i++) {
			cleanChars[i] = ' ';
		}
	}

	const text = rawBody.trim();
	const cleanText = cleanChars
		.join('')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
	const priority: TaskPriority = state.priority ?? 'normal';
	const format: TaskSignifierFormat =
		state.hasEmoji && state.hasDataview
			? 'mixed'
			: state.hasEmoji
				? 'emoji'
				: state.hasDataview
					? 'dataview'
					: 'none';

	const zeroBasedLine = lineNumberOneBased - 1;
	const position: ObsidianPosInput = {
		start: { line: zeroBasedLine, col: 0, offset: lineStartOffset },
		end: { line: zeroBasedLine, col: line.length, offset: lineStartOffset + line.length },
	};

	return {
		line: lineNumberOneBased,
		status: statusChar,
		statusType,
		completed: statusType === 'DONE',
		done: statusType === 'DONE' || statusType === 'CANCELLED' || statusType === 'NON_TASK',
		text,
		cleanText,
		priority,
		priorityNumber: PRIORITY_NUMBERS[priority],
		created: state.created,
		start: state.start,
		scheduled: state.scheduled,
		due: state.due,
		completion: state.completion,
		cancelled: state.cancelled,
		repeat: state.repeat,
		onCompletion: state.onCompletion,
		id: state.id,
		dependsOn: state.dependsOn ?? [],
		tags: Array.from(tagSet),
		blockId,
		parentLine,
		format,
		properties,
		position,
	};
}
