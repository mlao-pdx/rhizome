import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { findRhizomeCodeBlocks } from '../../src/adapters/codemirror/rhizome-code-blocks';
import { buildRhizomeLintDiagnostics } from '../../src/adapters/codemirror/rhizome-lint';
import { initEngineConfig } from '../../src/core/search';
import {
	analyzeRhizomeCodeBlock,
	type CodeBlockAnalysis,
	type CodeBlockDiagnosticSpan,
} from '../../src/core/templates';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

const cfgRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
if (!cfgRes.ok) throw new Error('Expected valid config');
const config = cfgRes.config;

function analysisWith(diagnostics: CodeBlockDiagnosticSpan[]): CodeBlockAnalysis {
	return { tokens: [], queries: [], diagnostics };
}

function diagnosticSpan(
	startOffset: number,
	endOffset: number,
	issue = 'test issue',
): CodeBlockDiagnosticSpan {
	return {
		startOffset,
		endOffset,
		code: 'ERROR_UNKNOWN_SCOPE',
		severity: 'error',
		issue,
		hint: null,
		span: { startOffset, endOffset, startLine: 1, startColumn: 1 },
	};
}

describe('buildRhizomeLintDiagnostics', () => {
	it('positions a real invalid-query diagnostic at its absolute document offset', () => {
		const docText = [
			'# Heading',
			'',
			'```rhizome',
			'{% query tasks %}',
			'unknown_scope:val [score: = "not-a-number"]',
			'{% endquery %}',
			'```',
		].join('\n');
		const doc = Text.of(docText.split('\n'));
		const [block] = findRhizomeCodeBlocks(doc);
		expect(block).toBeDefined();

		const analysis = analyzeRhizomeCodeBlock(block!.source, config, PINNED_REF_MS);
		const unknownScope = analysis.diagnostics.find((d) => d.code === 'ERROR_UNKNOWN_SCOPE');
		expect(unknownScope).toBeDefined();
		expect(docText.slice(block!.bodyFrom + unknownScope!.startOffset)).toMatch(
			/^unknown_scope/,
		);

		const diagnostics = buildRhizomeLintDiagnostics(doc, () => analysis);
		const lintDiag = diagnostics.find(
			(d) => d.from === block!.bodyFrom + unknownScope!.startOffset,
		);
		expect(lintDiag).toBeDefined();
		expect(lintDiag!.to).toBe(block!.bodyFrom + unknownScope!.endOffset);
		expect(lintDiag!.severity).toBe(unknownScope!.severity);
		expect(lintDiag!.message).toBe(unknownScope!.issue);
		expect(lintDiag!.source).toBe('rhizome');
	});

	it('ignores non-rhizome fences', () => {
		const docText = ['```js', 'console.log(1);', '```'].join('\n');
		const doc = Text.of(docText.split('\n'));

		const diagnostics = buildRhizomeLintDiagnostics(doc, () =>
			analysisWith([diagnosticSpan(0, 5)]),
		);

		expect(diagnostics).toEqual([]);
	});

	it('clamps an overlong diagnostic to the end of the document', () => {
		const docText = ['```rhizome', 'x'].join('\n');
		const doc = Text.of(docText.split('\n'));
		const [block] = findRhizomeCodeBlocks(doc);
		expect(block).toBeDefined();

		const diagnostics = buildRhizomeLintDiagnostics(doc, () =>
			analysisWith([diagnosticSpan(0, 999)]),
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.from).toBe(block!.bodyFrom);
		expect(diagnostics[0]!.to).toBe(doc.length);
	});

	it('widens a zero-width span to one character', () => {
		const docText = ['```rhizome', 'abc', '```'].join('\n');
		const doc = Text.of(docText.split('\n'));
		const [block] = findRhizomeCodeBlocks(doc);
		expect(block).toBeDefined();

		const diagnostics = buildRhizomeLintDiagnostics(doc, () =>
			analysisWith([diagnosticSpan(1, 1)]),
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.from).toBe(block!.bodyFrom + 1);
		expect(diagnostics[0]!.to).toBe(block!.bodyFrom + 2);
	});

	it('skips a zero-width span that sits at the end of the document', () => {
		const docText = ['```rhizome', 'abc'].join('\n');
		const doc = Text.of(docText.split('\n'));

		const diagnostics = buildRhizomeLintDiagnostics(doc, () =>
			analysisWith([diagnosticSpan(3, 3)]),
		);

		expect(diagnostics).toEqual([]);
	});
});
