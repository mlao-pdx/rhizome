import type { Text } from '@codemirror/state';
import { extractInlineRhizomeExpression } from '@core/templates';
import {
	type ClassifiedMarkdownLine,
	classifyMarkdownLines,
	splitTableCellRanges,
} from './rhizome-markdown-context';

/**
 * Coordinates and extracted metadata for a single inline `◊ <expr>` code span in a
 * CodeMirror 6 `Text` document.
 */
export interface ScannedInlineSpan {
	readonly spanFrom: number;
	readonly spanTo: number;
	readonly backtickCount: number;
	readonly interiorFrom: number;
	readonly rawInterior: string;
	readonly expr: string;
	readonly unescapeTablePipes: boolean;
	readonly headingLevel: number;
}

const docSpanCache = new WeakMap<Text, readonly ScannedInlineSpan[]>();

function scanMaskedRegionForInlineSpans(
	maskedText: string,
	rawText: string,
	baseDocOffset: number,
	unescapeTablePipes: boolean,
	resolveHeadingAtOffset: (localOffset: number) => number,
	out: ScannedInlineSpan[],
): void {
	const len = maskedText.length;
	let i = 0;

	while (i < len) {
		const ch = maskedText[i]!;
		if (ch === '\\' && i + 1 < len) {
			i += 2;
			continue;
		}
		if (ch !== '`') {
			i++;
			continue;
		}

		let runEnd = i;
		while (runEnd < len && maskedText[runEnd] === '`') {
			runEnd++;
		}
		const backtickCount = runEnd - i;

		let search = runEnd;
		let closeStart = -1;
		while (search < len) {
			if (maskedText[search] !== '`') {
				search++;
				continue;
			}
			let candEnd = search;
			while (candEnd < len && maskedText[candEnd] === '`') {
				candEnd++;
			}
			if (candEnd - search === backtickCount) {
				closeStart = search;
				break;
			}
			search = candEnd;
		}

		if (closeStart === -1) {
			i = runEnd;
			continue;
		}

		const rawInterior = rawText.slice(runEnd, closeStart);
		const extracted = extractInlineRhizomeExpression(rawInterior, { unescapeTablePipes });
		if (extracted !== null) {
			out.push(
				Object.freeze({
					spanFrom: baseDocOffset + i,
					spanTo: baseDocOffset + closeStart + backtickCount,
					backtickCount,
					interiorFrom: baseDocOffset + runEnd,
					rawInterior,
					expr: extracted.expr,
					unescapeTablePipes,
					headingLevel: resolveHeadingAtOffset(i),
				}),
			);
		}
		i = closeStart + backtickCount;
	}
}

/**
 * Scans and memoizes all inline `◊ <expr>` code spans in `doc` (keyed by immutable `Text`
 * identity in a `WeakMap` so selection and lint passes never re-scan unchanged documents).
 */
export function getCachedRhizomeInlineSpans(doc: Text): readonly ScannedInlineSpan[] {
	const cached = docSpanCache.get(doc);
	if (cached !== undefined) {
		return cached;
	}

	const count = doc.lines;
	const rawLines: string[] = new Array<string>(count);
	const lineOffsets: Array<{ readonly from: number; readonly to: number }> = new Array<{
		readonly from: number;
		readonly to: number;
	}>(count);
	for (let i = 0; i < count; i++) {
		const line = doc.line(i + 1);
		rawLines[i] = line.text;
		lineOffsets[i] = { from: line.from, to: line.to };
	}

	const classified: ClassifiedMarkdownLine[] = classifyMarkdownLines(rawLines);
	const spans: ScannedInlineSpan[] = [];

	let idx = 0;
	while (idx < count) {
		const info = classified[idx]!;
		const pos = lineOffsets[idx]!;
		if (info.skipLine || info.isBlankRest) {
			idx++;
			continue;
		}

		if (info.isTableRow) {
			const restRaw = info.rawText.slice(info.quotePrefixLen);
			const restMasked = info.maskedText.slice(info.quotePrefixLen);
			for (const cell of splitTableCellRanges(restRaw)) {
				scanMaskedRegionForInlineSpans(
					restMasked.slice(cell.start, cell.end),
					restRaw.slice(cell.start, cell.end),
					pos.from + info.quotePrefixLen + cell.start,
					true,
					() => info.headingLevelBefore,
					spans,
				);
			}
			idx++;
			continue;
		}

		if (info.isAtxHeading || info.isThematicBreak) {
			scanMaskedRegionForInlineSpans(
				info.maskedText,
				info.rawText,
				pos.from,
				false,
				() => info.headingLevelBefore,
				spans,
			);
			idx++;
			continue;
		}

		const blockStart = idx;
		let blockEnd = idx + 1;
		while (blockEnd < count) {
			const next = classified[blockEnd]!;
			if (
				next.skipLine ||
				next.isBlankRest ||
				next.isTableRow ||
				next.quoteDepth !== info.quoteDepth ||
				next.isAtxHeading ||
				next.isThematicBreak
			) {
				break;
			}
			blockEnd++;
		}

		const regionFrom = lineOffsets[blockStart]!.from;
		const regionTo = lineOffsets[blockEnd - 1]!.to;
		const maskedBlock = classified
			.slice(blockStart, blockEnd)
			.map((l) => l.maskedText)
			.join('\n');
		const rawBlock = doc.sliceString(regionFrom, regionTo);

		scanMaskedRegionForInlineSpans(
			maskedBlock,
			rawBlock,
			regionFrom,
			false,
			(localOffset) => {
				const docPos = regionFrom + localOffset;
				for (let k = blockStart; k < blockEnd; k++) {
					if (docPos <= lineOffsets[k]!.to) {
						return classified[k]!.headingLevelBefore;
					}
				}
				return classified[blockStart]!.headingLevelBefore;
			},
			spans,
		);
		idx = blockEnd;
	}

	const frozen = Object.freeze(spans);
	docSpanCache.set(doc, frozen);
	return frozen;
}

/**
 * Returns all inline `◊ <expr>` code spans in `doc` that intersect `[windowFrom, windowTo]`.
 */
export function findRhizomeInlineSpans(
	doc: Text,
	windowFrom: number = 0,
	windowTo: number = doc.length,
): readonly ScannedInlineSpan[] {
	const all = getCachedRhizomeInlineSpans(doc);
	if (windowFrom <= 0 && windowTo >= doc.length) {
		return all;
	}
	return all.filter((span) => span.spanTo >= windowFrom && span.spanFrom <= windowTo);
}
