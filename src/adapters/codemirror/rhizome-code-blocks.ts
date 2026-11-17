import type { Text } from '@codemirror/state';

/**
 * Location and content slice of a fenced `rhizome` codeblock in a CodeMirror document.
 */
export interface FencedRhizomeBlock {
	readonly bodyFrom: number;
	readonly bodyTo: number;
	readonly source: string;
}

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})\s*(.*)$/;

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
	let inFence = false;
	let fenceChars = '';
	let isRhizomeFence = false;
	let bodyFrom = 0;

	for (let lineNo = 1; lineNo <= totalLines; lineNo++) {
		const line = doc.line(lineNo);
		if (!inFence && line.from > windowTo) {
			break;
		}
		const match = FENCE_OPEN_RE.exec(line.text);
		if (!inFence) {
			if (match) {
				fenceChars = match[1] ?? '';
				const info = (match[2] ?? '').trim();
				inFence = true;
				isRhizomeFence = /^rhizome(?:\s|$)/i.test(info);
				bodyFrom = Math.min(doc.length, line.to + 1);
			}
		} else if (match) {
			const candidateFence = match[1] ?? '';
			const trailing = (match[2] ?? '').trim();
			if (
				candidateFence[0] === fenceChars[0] &&
				candidateFence.length >= fenceChars.length &&
				trailing.length === 0
			) {
				if (isRhizomeFence) {
					const bodyTo = Math.max(bodyFrom, line.from);
					if (bodyTo >= windowFrom && bodyFrom <= windowTo) {
						blocks.push({
							bodyFrom,
							bodyTo,
							source: doc.sliceString(bodyFrom, bodyTo),
						});
					}
				}
				inFence = false;
				fenceChars = '';
				isRhizomeFence = false;
			}
		}
	}

	if (inFence && isRhizomeFence) {
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
