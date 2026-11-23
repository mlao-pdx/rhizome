import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { findRhizomeCodeBlocks } from '../../src/adapters/codemirror/rhizome-code-blocks';
import { countTopLevelRhizomeBlocks, extractTopLevelRhizomeBlocks } from '../../src/core/templates';

describe('extractTopLevelRhizomeBlocks & findRhizomeCodeBlocks', () => {
	it('skips leading YAML frontmatter (including fenced strings inside frontmatter) and reports accurate 1-based lines', () => {
		const doc = [
			'---',
			'title: Weekly Review',
			'description: |',
			'  ```rhizome',
			'  ignored inside yaml',
			'  ```',
			'---',
			'# Documentation Header',
			'',
			'```rhizome',
			'Hello {{ "world" }}',
			'```',
		].join('\n');

		const blocks = extractTopLevelRhizomeBlocks(doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			index: 0,
			source: 'Hello {{ "world" }}',
			rawSlice: 'Hello {{ "world" }}\n',
			fenceStartLine: 10,
			bodyStartLine: 11,
		});
		expect(countTopLevelRhizomeBlocks(doc)).toBe(1);

		const cmBlocks = findRhizomeCodeBlocks(Text.of(doc.split('\n')));
		expect(cmBlocks).toHaveLength(1);
		expect(cmBlocks[0]?.source).toBe('Hello {{ "world" }}\n');
	});

	it('treats an unclosed leading --- as a thematic break rather than skipping the document', () => {
		const doc = ['---', '', '```rhizome', 'Body line', '```'].join('\n');
		const blocks = extractTopLevelRhizomeBlocks(doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.source).toBe('Body line');
		expect(blocks[0]?.fenceStartLine).toBe(3);
	});

	it('ignores nested 3-backtick and tilde rhizome blocks inside wider 4-backtick or tilde documentation fences', () => {
		const doc = [
			'# Template Docs',
			'',
			'````markdown',
			'Example block:',
			'```rhizome',
			'{{ ignored_nested_backticks }}',
			'```',
			'````',
			'',
			'~~~~text',
			'~~~rhizome',
			'{{ ignored_nested_tildes }}',
			'~~~',
			'~~~~',
			'',
			'~~~rhizome',
			'First real block',
			'~~~',
			'',
			'    ```rhizome',
			'    indented 4-space code block ignored',
			'    ```',
			'',
			'```rhizome``` inline triple-backtick code span ignored',
			'',
			'```rhizome extra-info',
			'Second real block',
			'',
			'```',
		].join('\n');

		const blocks = extractTopLevelRhizomeBlocks(doc);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({
			index: 0,
			source: 'First real block',
			fenceStartLine: 16,
			bodyStartLine: 17,
		});
		// Deliberate blank line before closing fence is preserved while only the fence-closing newline is stripped
		expect(blocks[1]).toMatchObject({
			index: 1,
			source: 'Second real block\n',
			fenceStartLine: 26,
			bodyStartLine: 27,
		});
	});

	it('captures unclosed top-level rhizome fences extending to EOF per CommonMark', () => {
		const doc = ['Intro', '```rhizome', 'Line A', 'Line B'].join('\n');
		const blocks = extractTopLevelRhizomeBlocks(doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			index: 0,
			source: 'Line A\nLine B',
			fenceStartLine: 2,
			bodyStartLine: 3,
		});
	});

	it('handles CRLF line endings and empty rhizome blocks cleanly', () => {
		const doc = ['```rhizome', '```', '', '```rhizome', 'CRLF body', '```'].join('\r\n');
		const blocks = extractTopLevelRhizomeBlocks(doc);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.source).toBe('');
		expect(blocks[1]?.source).toBe('CRLF body');
	});
});
