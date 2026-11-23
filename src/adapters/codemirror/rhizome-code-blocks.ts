import type { Text } from '@codemirror/state';
import {
	createFenceScanState,
	findYamlFrontmatterEndLine,
	stepFenceScanLine,
} from '@core/templates/template-blocks';

/**
 * Location and content slice of a fenced `rhizome` codeblock in a CodeMirror document.
 */
export interface FencedRhizomeBlock {
	readonly bodyFrom: number;
	readonly bodyTo: number;
	readonly source: string;
}

/**
 * Finds fenced `rhizome` codeblocks within `doc` that intersect `[windowFrom, windowTo]`.
 */
export function findRhizomeCodeBlocks(
	doc: Text,
	windowFrom: number = 0,
	windowTo: number = doc.length,
): FencedRhizomeBlock[] {
	const blocks: FencedRhizomeBlock[] = [];
	const totalLines = doc.lines;
	if (totalLines === 0) {
		return blocks;
	}

	const yamlEndLineZeroBased = findYamlFrontmatterEndLine(
		(idx) => doc.line(idx + 1).text,
		totalLines,
	);
	const startLineNo = yamlEndLineZeroBased + 2;
	const state = createFenceScanState();

	for (let lineNo = startLineNo; lineNo <= totalLines; lineNo++) {
		const line = doc.line(lineNo);
		if (!state.inFence && line.from > windowTo) {
			break;
		}
		const closed = stepFenceScanLine(
			state,
			line.text,
			lineNo,
			line.from,
			Math.min(doc.length, line.to + 1),
		);
		if (closed !== null) {
			if (closed.bodyTo >= windowFrom && closed.bodyFrom <= windowTo) {
				blocks.push({
					bodyFrom: closed.bodyFrom,
					bodyTo: closed.bodyTo,
					source: doc.sliceString(closed.bodyFrom, closed.bodyTo),
				});
			}
		}
	}

	if (state.inFence && state.isRhizomeFence) {
		const bodyFrom = state.bodyFrom;
		const bodyTo = doc.length;
		if (bodyTo >= windowFrom && bodyFrom <= windowTo) {
			blocks.push({
				bodyFrom,
				bodyTo,
				source: doc.sliceString(bodyFrom, bodyTo),
			});
		}
	}

	return blocks;
}
