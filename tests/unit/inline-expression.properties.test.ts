import { Text } from '@codemirror/state';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findRhizomeInlineSpans } from '../../src/adapters/codemirror/rhizome-inline-spans';
import {
	analyzeInlineRhizomeSpan,
	evaluateInlineRhizomeExpression,
	extractInlineRhizomeExpression,
	renderRhizomeTemplate,
} from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

const PINNED_REF_MS = Date.parse('2026-11-22T04:46:08.000Z');

describe('Inline Rhizome Expression Property Invariants', () => {
	it('1. Differential Parity: `◊ <expr>` produces identical ok status and markdown as `{{ <expr> }}` across host documents, runtime contexts, and FilteredValue expressions', async () => {
		const hostMatchArb = fc.option(
			fc.record({
				file: fc.record({
					path: fc.constantFrom('Notes/Alpha.md', 'Daily/2026-11-22.md', 'Root.md'),
					name: fc.constantFrom('Alpha.md', '2026-11-22.md', 'Root.md'),
					basename: fc.constantFrom('Alpha', '2026-11-22', 'Root'),
					folder: fc.constantFrom('Notes', 'Daily', ''),
				}),
				tags: fc.array(fc.constantFrom('#work', '#active', '#idea'), { maxLength: 4 }),
				aliases: fc.array(fc.constantFrom('Alias A', 'Alias B'), { maxLength: 2 }),
				properties: fc.record({
					status: fc.constantFrom('open', 'done', 'draft', null),
					score: fc.integer({ min: -50, max: 200 }),
					featured: fc.boolean(),
				}),
			}),
			{ nil: null },
		);

		const runtimeCtxArb = fc.record({
			sourcePath: fc.constantFrom('Notes/Alpha.md', 'Daily/2026-11-22.md', ''),
			referenceTimeMs: fc.constant(PINNED_REF_MS),
			timeZone: fc.constantFrom('UTC', 'America/New_York'),
			vault: fc.constantFrom('TestVault', 'Obsidian'),
			language: fc.constantFrom('en', 'fr'),
			headingLevel: fc.integer({ min: 0, max: 6 }),
		});

		const baseExprArb = fc.constantFrom(
			'this.file.basename',
			'this.file.folder',
			'this.tags',
			'this.tags.size',
			'this.aliases',
			'this.properties.status',
			'this.properties.score',
			'this.properties.featured',
			'today',
			'vault',
			'language',
			'"hello world"',
			'42',
			'(1..4)',
			'(this.properties.score | default: 0)',
		);

		const filterStepArb = fc.constantFrom(
			'default: "fallback"',
			'upcase',
			'downcase',
			'size',
			'join: ", "',
			'sentence',
			'heading',
			'append: "!"',
		);

		const exprArb = fc
			.tuple(baseExprArb, fc.array(filterStepArb, { minLength: 0, maxLength: 3 }))
			.map(([base, filters]) =>
				filters.length === 0 ? base : `${base} | ${filters.join(' | ')}`,
			);

		await assertProperty(
			'templates/inline__differential-parity-with-liquid-output',
			fc.asyncProperty(hostMatchArb, runtimeCtxArb, exprArb, async (hostMatch, ctx, expr) => {
				const effectiveHost = ctx.sourcePath.length > 0 ? hostMatch : null;
				const inlineRes = evaluateInlineRhizomeExpression(expr, effectiveHost, ctx);
				const blockRes = await renderRhizomeTemplate(`{{ ${expr} }}`, {
					runQueries: async () => ({}),
					resolveHost: () => effectiveHost,
					runtimeContext: ctx,
				});

				expect(inlineRes.ok).toBe(blockRes.ok);
				if (inlineRes.ok && blockRes.ok) {
					expect(inlineRes.markdown).toBe(blockRes.markdown);
				}
			}),
		);
	});

	it('2. Signet Activation & Literal Non-Interference: non-signet or whitespace-only code-span interiors return null and zero analyzer spans', async () => {
		const nonActivatingInteriorArb = fc.oneof(
			fc.string({ maxLength: 80 }).filter((s) => !s.includes('\u25CA')),
			fc.constantFrom(
				'\u25CA',
				'\u25CAhost',
				'\u25CAInternalRhizome',
				'\u25CA ',
				'\u25CA   \t\n ',
				'  \u25CA this.title  ',
				'prefix \u25CA this.title',
			),
			fc
				.string({ minLength: 1, maxLength: 30 })
				.filter((s) => !/^[\s\u00A0]/.test(s))
				.map((suffix) => `\u25CA${suffix}`),
		);

		await assertProperty(
			'templates/inline__signet-activation-literal-non-interference',
			fc.property(nonActivatingInteriorArb, fc.boolean(), (rawInterior, unescapePipes) => {
				expect(
					extractInlineRhizomeExpression(rawInterior, {
						unescapeTablePipes: unescapePipes,
					}),
				).toBeNull();
				const analysis = analyzeInlineRhizomeSpan(rawInterior, {
					unescapeTablePipes: unescapePipes,
				});
				expect(analysis.tokens).toHaveLength(0);
				expect(analysis.diagnostics).toHaveLength(0);
			}),
		);
	});

	it('3. Analyzer Span Monotonicity & Bounds: analyzeInlineRhizomeSpan never throws and emits sorted, bounded spans', async () => {
		const fragmentArb = fc.constantFrom(
			'\u25CA ',
			' \u25CA ',
			'this.file.basename',
			'query.tasks.size',
			'\\| default: "x"',
			'| upcase',
			'"quoted"',
			"'unclosed",
			'{{ bad }}',
			'{% tag %}',
			'42',
			'and',
			'today+7d',
			'|',
			'\r\n',
		);

		const interiorArb = fc.oneof(
			fc.string({ maxLength: 100 }),
			fc.array(fragmentArb, { minLength: 1, maxLength: 10 }).map((parts) => parts.join(' ')),
		);

		await assertProperty(
			'templates/inline__analyzer-span-monotonicity-and-bounds',
			fc.property(interiorArb, fc.boolean(), (rawInterior, unescapePipes) => {
				const analysis = analyzeInlineRhizomeSpan(rawInterior, {
					unescapeTablePipes: unescapePipes,
				});

				let prevTokenEnd = 0;
				for (const tok of analysis.tokens) {
					expect(tok.startOffset).toBeGreaterThanOrEqual(0);
					expect(tok.endOffset).toBeGreaterThan(tok.startOffset);
					expect(tok.endOffset).toBeLessThanOrEqual(rawInterior.length);
					expect(tok.startOffset).toBeGreaterThanOrEqual(prevTokenEnd);
					prevTokenEnd = tok.endOffset;
				}

				let prevDiagStart = 0;
				let prevDiagEnd = 0;
				for (const diag of analysis.diagnostics) {
					expect(diag.startOffset).toBeGreaterThanOrEqual(0);
					expect(diag.endOffset).toBeGreaterThan(diag.startOffset);
					expect(diag.endOffset).toBeLessThanOrEqual(rawInterior.length);
					expect(
						diag.startOffset > prevDiagStart ||
							(diag.startOffset === prevDiagStart && diag.endOffset >= prevDiagEnd),
					).toBe(true);
					prevDiagStart = diag.startOffset;
					prevDiagEnd = diag.endOffset;
				}
			}),
		);
	});

	it('4. Scanner Non-Code Exclusion: inline `◊ ...` inside frontmatter, fences, math, or comments emits zero ScannedInlineSpan entries', async () => {
		const safeBodyArb = fc
			.stringMatching(/^[a-zA-Z0-9_.|+:" ]{1,30}$/)
			.filter((s) => s.trim().length > 0);

		const wrapperKindArb = fc.constantFrom(
			'frontmatter',
			'backtick-fence',
			'tilde-fence',
			'indented-code',
			'display-math',
			'inline-math',
			'obsidian-comment',
			'html-comment',
		);

		await assertProperty(
			'templates/inline__scanner-non-code-exclusion',
			fc.property(wrapperKindArb, safeBodyArb, (kind, exprBody) => {
				const spanLiteral = `\`\u25CA ${exprBody}\``;
				let markdown: string;
				switch (kind) {
					case 'frontmatter':
						markdown = `---\nnote: '${spanLiteral}'\n---\nPlain body.`;
						break;
					case 'backtick-fence':
						markdown = `\`\`\`markdown\n${spanLiteral}\n\`\`\``;
						break;
					case 'tilde-fence':
						markdown = `~~~rhizome\n${spanLiteral}\n~~~`;
						break;
					case 'indented-code':
						markdown = `Paragraph above.\n\n    ${spanLiteral}\n`;
						break;
					case 'display-math':
						markdown = `$$\nx = 1\n\n${spanLiteral}\n$$`;
						break;
					case 'inline-math':
						markdown = `Value is $x + ${spanLiteral} + y$ inline.`;
						break;
					case 'obsidian-comment':
						markdown = `Before %%\npara 1\n\n${spanLiteral}\n%% after.`;
						break;
					case 'html-comment':
						markdown = `Before <!--\npara 1\n\n${spanLiteral}\n--> after.`;
						break;
				}
				const doc = Text.of(markdown.split('\n'));
				expect(findRhizomeInlineSpans(doc)).toHaveLength(0);
			}),
		);
	});
});
