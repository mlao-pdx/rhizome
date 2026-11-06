import { describe, expect, it } from 'vitest';
import {
	compileQuery,
	initEngineConfig,
	levenshteinDistance,
	MAX_QUERY_LENGTH,
	MAX_SAFE_EPOCH_MS,
	MAX_SYNTACTIC_DEPTH,
	normalizeAST,
	substringStringMatch,
	suggestScopeHint,
	type LogicalNode,
	type ResolvedEngineConfig,
	type ScopedFilterNode,
	type SearchAST,
} from '../../src/core/search';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

function createStandardConfig(): ResolvedEngineConfig {
	const res = initEngineConfig({
		timeZone: 'America/New_York',
		propertyTypes: {
			score: 'number',
			priority: 'number',
			meeting: 'datetime',
			due: 'date',
			modified: 'date',
			sprint: 'date',
			status: 'text',
			done: 'checkbox',
		},
	});
	if (!res.ok) throw new Error('Expected valid standard config');
	return res.config;
}

describe('Step 0: referenceTimeMs validation (ERROR_INVALID_CONFIG)', () => {
	it('rejects NaN, ±Infinity, floats, and out-of-range integers with ERROR_INVALID_CONFIG', () => {
		const config = createStandardConfig();
		const invalidTimes = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			123.45,
			MAX_SAFE_EPOCH_MS + 1,
			-MAX_SAFE_EPOCH_MS - 1,
		];

		for (const badTime of invalidTimes) {
			const res = compileQuery('tag:#work', config, badTime);
			expect(res.executable).toBe(false);
			expect(res.ast).toBeNull();
			expect(res.prepared).toBeNull();
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]).toMatchObject({
				code: 'ERROR_INVALID_CONFIG',
				severity: 'error',
				span: null,
			});
		}
	});
});

describe('Step 1 & 2: SYNTAX_ERROR diagnostics', () => {
	const config = createStandardConfig();

	it('rejects queries exceeding MAX_QUERY_LENGTH (4096) and MAX_SYNTACTIC_DEPTH (32)', () => {
		const overLength = `file:${'a'.repeat(MAX_QUERY_LENGTH - 4)}`;
		const lenRes = compileQuery(overLength, config, PINNED_REF_MS);
		expect(lenRes.executable).toBe(false);
		expect(lenRes.ast).toBeNull();
		expect(lenRes.prepared).toBeNull();
		expect(lenRes.diagnostics[0]?.code).toBe('SYNTAX_ERROR');

		const overDepth = `${'('.repeat(MAX_SYNTACTIC_DEPTH + 1)}#a${')'.repeat(MAX_SYNTACTIC_DEPTH + 1)}`;
		const depthRes = compileQuery(overDepth, config, PINNED_REF_MS);
		expect(depthRes.executable).toBe(false);
		expect(depthRes.ast).toBeNull();
		expect(depthRes.prepared).toBeNull();
		expect(depthRes.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
	});

	it('rejects lexer/parser errors and empty WikiLinkValue / PropertyKey with SYNTAX_ERROR', () => {
		for (const q of [
			'"unterminated',
			'[status =',
			'links:[[]]',
			'links:[[ | alias ]]',
			'[""]',
		]) {
			const res = compileQuery(q, config, PINNED_REF_MS);
			expect(res.executable).toBe(false);
			expect(res.ast).toBeNull();
			expect(res.prepared).toBeNull();
			expect(res.diagnostics.some((d) => d.code === 'SYNTAX_ERROR')).toBe(true);
		}
	});

	it('preserves non-error diagnostics alongside lowering-time SYNTAX_ERRORs and short-circuits invalid PropertyFilterNodes', () => {
		const wikiAndErr = compileQuery(
			'links:[[Notes/A|Alias]] AND links:[[|alias]]',
			config,
			PINNED_REF_MS,
		);
		expect(wikiAndErr.executable).toBe(false);
		expect(wikiAndErr.ast).toBeNull();
		expect(wikiAndErr.prepared).toBeNull();
		expect(wikiAndErr.diagnostics.map((d) => d.code)).toEqual([
			'HINT_WIKILINK_BRACKETS_IN_SCOPE',
			'SYNTAX_ERROR',
		]);

		const propHintAndErr = compileQuery('[status: != done] AND [""]', config, PINNED_REF_MS);
		expect(propHintAndErr.executable).toBe(false);
		expect(propHintAndErr.ast).toBeNull();
		expect(propHintAndErr.prepared).toBeNull();
		expect(propHintAndErr.diagnostics.map((d) => d.code)).toEqual([
			'SYNTAX_ERROR',
			'HINT_PROP_NEQ_EXISTENCE',
		]);

		const emptyKeyNeq = compileQuery('["" : != high]', config, PINNED_REF_MS);
		expect(emptyKeyNeq.executable).toBe(false);
		expect(emptyKeyNeq.ast).toBeNull();
		expect(emptyKeyNeq.prepared).toBeNull();
		expect(emptyKeyNeq.diagnostics.map((d) => d.code)).toEqual(['SYNTAX_ERROR']);
	});

	it('Conformance Test 4: disambiguates path:"/projects/active" vs path:/projects/active vs path:Projects/Active/Archive', () => {
		const quotedRes = compileQuery('path:"/projects/active"', config, PINNED_REF_MS);
		expect(quotedRes.executable).toBe(true);
		expect(quotedRes.diagnostics).toEqual([]);

		const unquotedSlashless = compileQuery(
			'path:Projects/Active/Archive',
			config,
			PINNED_REF_MS,
		);
		expect(unquotedSlashless.executable).toBe(true);
		expect(unquotedSlashless.diagnostics).toEqual([]);

		const accidentalRegex = compileQuery('path:/projects/active', config, PINNED_REF_MS);
		expect(accidentalRegex.executable).toBe(false);
		expect(accidentalRegex.ast).toBeNull();
		expect(accidentalRegex.prepared).toBeNull();
		expect(accidentalRegex.diagnostics).toHaveLength(1);
		expect(accidentalRegex.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
	});

	it('Conformance Test 13: validates native RegExp patterns and flags', () => {
		for (const validQ of [
			'file:/(\\d{1,3}\\.){3}\\d{1,3}/i',
			'file:/^note-(?!draft)/',
			'path:/[\\/]/',
		]) {
			const res = compileQuery(validQ, config, PINNED_REF_MS);
			expect(res.executable).toBe(true);
			expect(res.diagnostics).toEqual([]);
		}

		for (const invalidQ of [
			'path:/[/]/',
			'file:/test/g',
			'file:/test/ii',
			'file:/[unclosed/',
		]) {
			const res = compileQuery(invalidQ, config, PINNED_REF_MS);
			expect(res.executable).toBe(false);
			expect(res.ast).toBeNull();
			expect(res.prepared).toBeNull();
			expect(res.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
		}
	});
});

describe('Step 3: Scope resolution & suggestions (ERROR_UNKNOWN_SCOPE)', () => {
	const config = createStandardConfig();

	it('computes Levenshtein distance and suggests closest scopes or synonyms', () => {
		expect(levenshteinDistance('hedings', 'headings')).toBe(1);
		expect(levenshteinDistance('fiel', 'file')).toBe(2);
		expect(suggestScopeHint('tags', config)).toBe('Did you mean "tag:"?');
		expect(suggestScopeHint('prop', config)).toBe('Use "[prop:]" for property filters.');
		expect(suggestScopeHint('property', config)).toBe('Use "[prop:]" for property filters.');
		expect(suggestScopeHint('properties', config)).toBe('Use "[prop:]" for property filters.');
		expect(suggestScopeHint('hedings', config)).toBe('Did you mean "headings:"?');
		expect(suggestScopeHint('fiel', config)).toBe('Did you mean "file:"?');
		expect(suggestScopeHint('-tag', config)).toBe(
			'Use "!tag:..." or "NOT tag:..." to negate a scope.',
		);
		expect(suggestScopeHint('-unknown', config)).toBe(
			'Use "!" or "NOT" to negate a filter (e.g. "!tag:...").',
		);
		expect(suggestScopeHint('zzzzzz', config)).toBeNull();
	});

	it('emits ERROR_UNKNOWN_SCOPE with linter diagnostics on unknown scopes', () => {
		const typoRes = compileQuery(
			'hedings:"Action Items" AND [status: != done]',
			config,
			PINNED_REF_MS,
		);
		expect(typoRes.executable).toBe(false);
		expect(typoRes.ast).toBeNull();
		expect(typoRes.prepared).toBeNull();
		expect(typoRes.diagnostics.map((d) => d.code)).toEqual([
			'ERROR_UNKNOWN_SCOPE',
			'HINT_PROP_NEQ_EXISTENCE',
		]);
		const scopeErr = typoRes.diagnostics.find((d) => d.code === 'ERROR_UNKNOWN_SCOPE')!;
		expect(scopeErr.issue).toBe('Unknown search scope "hedings:".');
		expect(scopeErr.hint).toBe('Did you mean "headings:"?');
	});

	it('Conformance Test 12b: trims custom scope canonicalName and resolves aliases', () => {
		const customCfgRes = initEngineConfig({
			timeZone: 'America/New_York',
			propertyTypes: {},
			customScopes: [
				{
					canonicalName: ' Tasks ',
					aliases: ['tasks', 'task'],
					extract: () => [],
					matchString: substringStringMatch,
				},
			],
		});
		expect(customCfgRes.ok).toBe(true);
		if (!customCfgRes.ok) return;

		const r1 = compileQuery('task:urgent', customCfgRes.config, PINNED_REF_MS);
		expect(r1.executable).toBe(true);
		expect((r1.ast as ScopedFilterNode).scope).toBe('Tasks');

		const r2 = compileQuery('task:/^urgent/i', customCfgRes.config, PINNED_REF_MS);
		expect(r2.executable).toBe(true);
		expect((r2.ast as ScopedFilterNode).scope).toBe('Tasks');
	});
});

describe('Step 4: Property validation & short-circuit precedence', () => {
	const config = createStandardConfig();

	it('Conformance Test 10: enforces short-circuit precedence across SYNTAX_ERROR, ERROR_INVALID_OPERATOR_FOR_TYPE, and ERROR_TYPE_MISMATCH', () => {
		const r1 = compileQuery('NOT [priority: > high]', config, PINNED_REF_MS);
		expect(r1.executable).toBe(false);
		expect(r1.ast).toBeNull();
		expect(r1.prepared).toBeNull();
		expect(r1.diagnostics).toHaveLength(1);
		expect(r1.diagnostics[0]).toMatchObject({
			code: 'ERROR_TYPE_MISMATCH',
			severity: 'error',
			issue: '"high" is not a valid number for property "priority".',
			hint: null,
			span: {
				startOffset: 17,
				endOffset: 21,
				startLine: 1,
				startColumn: 18,
			},
		});

		const r2 = compileQuery('[priority: = /10/]', config, PINNED_REF_MS);
		expect(r2.executable).toBe(false);
		expect(r2.ast).toBeNull();
		expect(r2.prepared).toBeNull();
		expect(r2.diagnostics).toHaveLength(1);
		expect(r2.diagnostics[0]).toMatchObject({
			code: 'ERROR_INVALID_OPERATOR_FOR_TYPE',
			severity: 'error',
			issue: 'Operator "=" cannot be used with number/regex.',
			hint: null,
		});
		expect(r2.diagnostics[0]?.span).not.toBeNull();

		const r3 = compileQuery('[priority: = /foo(/]', config, PINNED_REF_MS);
		expect(r3.executable).toBe(false);
		expect(r3.ast).toBeNull();
		expect(r3.prepared).toBeNull();
		expect(r3.diagnostics).toHaveLength(1);
		expect(r3.diagnostics[0]?.code).toBe('SYNTAX_ERROR');

		const r4 = compileQuery('[priority: != high]', config, PINNED_REF_MS);
		expect(r4.executable).toBe(false);
		expect(r4.diagnostics).toHaveLength(1);
		expect(r4.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');
	});

	it('validates checkbox operators and literals (ERROR_INVALID_OPERATOR_FOR_TYPE & ERROR_TYPE_MISMATCH)', () => {
		for (const op of ['<', '>', '<=', '>=']) {
			const res = compileQuery(`[done: ${op} true]`, config, PINNED_REF_MS);
			expect(res.executable).toBe(false);
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]?.code).toBe('ERROR_INVALID_OPERATOR_FOR_TYPE');
		}

		const regexColon = compileQuery('[done: /true/]', config, PINNED_REF_MS);
		expect(regexColon.executable).toBe(false);
		expect(regexColon.diagnostics).toHaveLength(1);
		expect(regexColon.diagnostics[0]?.code).toBe('ERROR_INVALID_OPERATOR_FOR_TYPE');

		const quotedBool = compileQuery('[done: = "true"]', config, PINNED_REF_MS);
		expect(quotedBool.executable).toBe(false);
		expect(quotedBool.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const invalidBool = compileQuery('[done: = yes]', config, PINNED_REF_MS);
		expect(invalidBool.executable).toBe(false);
		expect(invalidBool.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const validBool = compileQuery(
			'[done: = true] AND [done: != FALSE] AND [done] AND [done:] AND [done:""]',
			config,
			PINNED_REF_MS,
		);
		expect(validBool.executable).toBe(true);
	});

	it('validates number literals (rejects quoted numbers and non-numbers)', () => {
		const quotedNum = compileQuery('[score: = "42"]', config, PINNED_REF_MS);
		expect(quotedNum.executable).toBe(false);
		expect(quotedNum.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const validSigned = compileQuery(
			'[score: >= -10.5] AND [score:] AND [score:""]',
			config,
			PINNED_REF_MS,
		);
		expect(validSigned.executable).toBe(true);
		expect(validSigned.diagnostics).toEqual([]);
	});

	it('Conformance Test 6: rejects invalid & skipped dates (including NOT [due: = @today+1d] landing on skipped date)', () => {
		const feb31 = compileQuery('[due: = 2026-02-31]', config, PINNED_REF_MS);
		expect(feb31.executable).toBe(false);
		expect(feb31.ast).toBeNull();
		expect(feb31.prepared).toBeNull();
		expect(feb31.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const apiaCfgRes = initEngineConfig({
			timeZone: 'Pacific/Apia',
			propertyTypes: { due: 'date' },
		});
		expect(apiaCfgRes.ok).toBe(true);
		if (!apiaCfgRes.ok) return;
		const apiaRefMs = Date.parse('2011-12-29T12:00:00.000Z');

		const explicitSkipped = compileQuery('[due: = 2011-12-30]', apiaCfgRes.config, apiaRefMs);
		expect(explicitSkipped.executable).toBe(false);
		expect(explicitSkipped.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const relativeSkipped = compileQuery(
			'NOT [due: = @today+1d]',
			apiaCfgRes.config,
			apiaRefMs,
		);
		expect(relativeSkipped.executable).toBe(false);
		expect(relativeSkipped.ast).toBeNull();
		expect(relativeSkipped.prepared).toBeNull();
		expect(relativeSkipped.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');
	});

	it('Conformance Test 14: compiles valid positional date ranges and rejects reversed date ranges with SYNTAX_ERROR and swap hints', () => {
		for (const validQ of [
			'[due: = 2026-10-22..2026]',
			'[due: = @thisyear..@today]',
			'[due: = @today..@thisyear]',
			'[due: = @today-6d..@today]',
			'[due: = @today-7d..@today]',
		]) {
			const res = compileQuery(validQ, config, PINNED_REF_MS);
			expect(res.executable).toBe(true);
			expect(res.diagnostics).toEqual([]);
		}

		const revRel = compileQuery('[due: = @today..@today-7d]', config, PINNED_REF_MS);
		expect(revRel.executable).toBe(false);
		expect(revRel.ast).toBeNull();
		expect(revRel.prepared).toBeNull();
		expect(revRel.diagnostics).toHaveLength(1);
		expect(revRel.diagnostics[0]).toMatchObject({
			code: 'SYNTAX_ERROR',
			severity: 'error',
			issue: "The left endpoint '@today' starts on or after the exclusive end contributed by the right endpoint '@today-7d'.",
			hint: 'Use @today-7d..@today',
		});
		expect(revRel.diagnostics[0]?.span).not.toBeNull();

		const revIso = compileQuery('[due: = 2026-10-15..2026-10-01]', config, PINNED_REF_MS);
		expect(revIso.executable).toBe(false);
		expect(revIso.diagnostics).toHaveLength(1);
		expect(revIso.diagnostics[0]).toMatchObject({
			code: 'SYNTAX_ERROR',
			severity: 'error',
			issue: "The left endpoint '2026-10-15' starts on or after the exclusive end contributed by the right endpoint '2026-10-01'.",
			hint: 'Use 2026-10-01..2026-10-15',
		});
		expect(revIso.diagnostics[0]?.span).not.toBeNull();
	});

	it('validates non-regex leaves in property colon (:) identically to (=) while permitting regex leaves on non-checkbox properties', () => {
		for (const validQ of [
			'[due: @thisyear]',
			'[due: (@today OR @yesterday)]',
			'[due: /^2026/]',
			'[due: (@thisyear OR /^2025/)]',
			'[score: 150]',
			'[score: (10 OR 20)]',
			'[score: /^1\\.5/]',
			'[done: (true OR false)]',
		]) {
			const res = compileQuery(validQ, config, PINNED_REF_MS);
			expect(res.executable).toBe(true);
			expect(res.diagnostics).toEqual([]);
		}

		for (const invalidTypeQ of [
			'[due: invalid-date]',
			'[score: high]',
			'[score: "10"]',
			'[done: maybe]',
			'[done: "true"]',
		]) {
			const res = compileQuery(invalidTypeQ, config, PINNED_REF_MS);
			expect(res.executable).toBe(false);
			expect(res.ast).toBeNull();
			expect(res.prepared).toBeNull();
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');
		}

		const revColon = compileQuery('[due: @today..@today-7d]', config, PINNED_REF_MS);
		expect(revColon.executable).toBe(false);
		expect(revColon.ast).toBeNull();
		expect(revColon.prepared).toBeNull();
		expect(revColon.diagnostics).toHaveLength(1);
		expect(revColon.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
	});
});

describe('System metadata scopes and scope comparisons', () => {
	const config = createStandardConfig();

	it('rejects built-in system metadata keys in property filters with scope fix-it hints', () => {
		const keys: ReadonlyArray<[key: string, scope: 'tag' | 'aliases' | 'cssclasses']> = [
			['tag', 'tag'],
			['tags', 'tag'],
			['alias', 'aliases'],
			['aliases', 'aliases'],
			['cssclass', 'cssclasses'],
			['cssclasses', 'cssclasses'],
		];
		for (const [key, scope] of keys) {
			for (const query of [
				`[${key}: work]`,
				`[${key}: = work]`,
				`[${key}: != work]`,
				`[${key}]`,
			]) {
				const res = compileQuery(query, config, PINNED_REF_MS);
				expect(res.executable).toBe(false);
				expect(res.ast).toBeNull();
				expect(res.diagnostics[0]).toMatchObject({
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: `"${key}" is a built-in note scope, not a property.`,
				});
				expect(res.diagnostics[0]?.hint).toContain(`Use "${scope}:`);
				expect(res.diagnostics[0]?.span).not.toBeNull();
			}
		}
	});

	it('accepts comparison operators on every built-in scope and rejects regex comparisons', () => {
		for (const query of [
			'tag: = work',
			'tag: != work',
			'tag: < work',
			'tag: > work',
			'tag: <= work',
			'tag: >= work',
			'aliases: = Alias',
			'cssclasses: = wide',
			'ext: = md',
			'path: = Notes/A.md',
			'headings: = Overview',
			'blocks: = b1',
			'file: = A.md',
			'file: > 0',
		]) {
			const res = compileQuery(query, config, PINNED_REF_MS);
			expect(res.executable, query).toBe(true);
			expect(
				res.diagnostics.filter((d) => d.severity === 'error'),
				query,
			).toEqual([]);
		}

		for (const query of ['tag: = /work/', 'ext: > /md/']) {
			const res = compileQuery(query, config, PINNED_REF_MS);
			expect(res.executable, query).toBe(false);
			expect(
				res.diagnostics.some((d) => d.code === 'ERROR_INVALID_OPERATOR_FOR_TYPE'),
				query,
			).toBe(true);
		}
	});
});

describe('Step 5: Non-blocking linter diagnostics (Section 4.3)', () => {
	const config = createStandardConfig();

	it('rejects unquoted multi-word scope values with SYNTAX_ERROR and quoting hint', () => {
		const res = compileQuery('headings:Action Items', config, PINNED_REF_MS);
		expect(res.executable).toBe(false);
		expect(res.ast).toBeNull();
		expect(res.prepared).toBeNull();
		expect(res.diagnostics).toEqual([
			{
				code: 'SYNTAX_ERROR',
				severity: 'error',
				issue: '"Items" is not inside "headings:"; bare search terms are not supported.',
				hint: 'Use headings:"Action Items"',
				span: {
					startOffset: 0,
					endOffset: 21,
					startLine: 1,
					startColumn: 1,
				},
			},
		]);
	});

	it('rejects lowercase boolean words with SYNTAX_ERROR and uppercase hint', () => {
		for (const word of ['and', 'or', 'not', 'And']) {
			const res = compileQuery(`#a ${word} #b`, config, PINNED_REF_MS);
			expect(res.executable).toBe(false);
			expect(res.ast).toBeNull();
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]).toMatchObject({
				code: 'SYNTAX_ERROR',
				severity: 'error',
				issue: `Lowercase "${word}" is not a valid logical operator.`,
				hint: `Use uppercase "${word.toUpperCase()}".`,
			});
			expect(res.diagnostics[0]?.span).not.toBeNull();
		}
	});

	it('rejects hyphen-prefixed bare terms and spaced "! term" with SYNTAX_ERROR', () => {
		for (const q of ['-work', '- term']) {
			const res = compileQuery(q, config, PINNED_REF_MS);
			expect(res.executable).toBe(false);
			expect(res.diagnostics[0]).toMatchObject({
				code: 'SYNTAX_ERROR',
				severity: 'error',
				hint: 'Use "!" or "NOT" to negate a filter (e.g. "!tag:..." or "![prop]").',
			});
		}

		const spacedBang = compileQuery('! #work', config, PINNED_REF_MS);
		expect(spacedBang.executable).toBe(false);
		expect(spacedBang.diagnostics.map((d) => d.code)).toEqual(['SYNTAX_ERROR']);
	});

	it('emits WARN_SINGLE_VALUE_CONTRADICTION on contradicting single-valued fields in AND', () => {
		const contradictions: Array<[string, string, string]> = [
			['ext:md AND ext:pdf', 'md', 'pdf'],
			['ext:md AND [file.extension: = pdf]', 'md', 'pdf'],
			['[file.extension: = ".md"] AND [file.extension: = "pdf"]', '.md', 'pdf'],
			['[file.name: = "a.md"] AND [file.name: = "b.md"]', 'a.md', 'b.md'],
			['[file.basename: = alpha] AND [file.basename: = beta]', 'alpha', 'beta'],
			['[file.path: = "a/b.md"] AND [file.path: = "c/d.md"]', 'a/b.md', 'c/d.md'],
			['[file.parent: = "dir1"] AND [file.parent: = "dir2"]', 'dir1', 'dir2'],
		];

		for (const [q, a, b] of contradictions) {
			const res = compileQuery(q, config, PINNED_REF_MS);
			expect(res.executable).toBe(true);
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]).toMatchObject({
				code: 'WARN_SINGLE_VALUE_CONTRADICTION',
				severity: 'warning',
				issue: `A single file cannot match both "${a}" and "${b}" on the same single-valued field.`,
				hint: 'Did you mean "OR"?',
			});
			expect(res.diagnostics[0]?.span).not.toBeNull();
		}

		// Same normalized extension (.md vs md) does not warn
		const sameExt = compileQuery(
			'ext:md AND ext:.md AND [file.extension: = MD]',
			config,
			PINNED_REF_MS,
		);
		expect(sameExt.executable).toBe(true);
		expect(sameExt.diagnostics).toEqual([]);
	});

	it('Conformance Test 9: emits HINT_PROP_NEQ_EXISTENCE with exact interpolated hint on [status: != done]', () => {
		const res = compileQuery('[status: != done]', config, PINNED_REF_MS);
		expect(res.executable).toBe(true);
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0]).toMatchObject({
			code: 'HINT_PROP_NEQ_EXISTENCE',
			severity: 'hint',
			issue: '"[status:!=done]" requires "status" to exist.',
			hint: 'To exclude notes (including notes missing "status"), use "![status:=done]".',
		});
		expect(res.diagnostics[0]?.span).not.toBeNull();
	});

	it('emits HINT_AMBIGUOUS_PRECEDENCE on unparenthesized AND inside OR, and suppresses when parenthesized', () => {
		const unparen = compileQuery('tag:a AND tag:b OR tag:c', config, PINNED_REF_MS);
		expect(unparen.executable).toBe(true);
		expect(unparen.diagnostics).toHaveLength(1);
		expect(unparen.diagnostics[0]).toMatchObject({
			code: 'HINT_AMBIGUOUS_PRECEDENCE',
			severity: 'hint',
			issue: 'Evaluated as "(A AND B) OR C".',
			hint: 'Add parentheses to make precedence explicit.',
		});
		expect(unparen.diagnostics[0]?.span).not.toBeNull();

		const paren = compileQuery('(tag:a AND tag:b) OR tag:c', config, PINNED_REF_MS);
		expect(paren.executable).toBe(true);
		expect(paren.diagnostics).toEqual([]);
	});

	it('Conformance Test 11b: emits HINT_WIKILINK_BRACKETS_IN_SCOPE on links:[[Notes/A|Custom Label]]', () => {
		const res = compileQuery('links:[[Notes/A|Custom Label]]', config, PINNED_REF_MS);
		expect(res.executable).toBe(true);
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0]).toMatchObject({
			code: 'HINT_WIKILINK_BRACKETS_IN_SCOPE',
			severity: 'hint',
			issue: 'Wikilink brackets "[[...]]" are not needed.',
			hint: 'Stripped "[[...]]" automatically.',
		});
		expect(res.diagnostics[0]?.span).not.toBeNull();
	});

	it('rejects bare search terms with SYNTAX_ERROR and suggests scopes or property filters', () => {
		const res = compileQuery('roadmap', config, PINNED_REF_MS);
		expect(res.executable).toBe(false);
		expect(res.ast).toBeNull();
		expect(res.prepared).toBeNull();
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0]).toMatchObject({
			code: 'SYNTAX_ERROR',
			severity: 'error',
			issue: 'Bare search term "roadmap" is not supported.',
			hint: 'Specify a scope (e.g. "file:roadmap", "aliases:roadmap", "#roadmap") or a property filter ("[prop:roadmap]").',
		});
		expect(res.diagnostics[0]?.span).not.toBeNull();
	});

	it('emits HINT_PROPERTY_MATCHES_SCOPE on colon property filters matching scope canonical names or aliases', () => {
		const directRes = compileQuery('[path: Foo]', config, PINNED_REF_MS);
		expect(directRes.executable).toBe(true);
		expect(directRes.diagnostics).toHaveLength(1);
		expect(directRes.diagnostics[0]).toMatchObject({
			code: 'HINT_PROPERTY_MATCHES_SCOPE',
			severity: 'hint',
			issue: 'The property "path" matches the name of scope "path".',
			hint: 'Did you mean "path:Foo" instead?',
		});
		expect(directRes.diagnostics[0]?.span).not.toBeNull();

		const aliasRes = compileQuery('[link: "Note A"]', config, PINNED_REF_MS);
		expect(aliasRes.executable).toBe(true);
		expect(aliasRes.diagnostics).toHaveLength(1);
		expect(aliasRes.diagnostics[0]).toMatchObject({
			code: 'HINT_PROPERTY_MATCHES_SCOPE',
			severity: 'hint',
			issue: 'The property "link" matches an alias of scope "links".',
			hint: 'Did you mean "links:"Note A"" instead?',
		});
		expect(aliasRes.diagnostics[0]?.span).not.toBeNull();

		const backlinkAliasRes = compileQuery('[backlink: Foo]', config, PINNED_REF_MS);
		expect(backlinkAliasRes.executable).toBe(true);
		expect(backlinkAliasRes.diagnostics).toHaveLength(1);
		expect(backlinkAliasRes.diagnostics[0]).toMatchObject({
			code: 'HINT_PROPERTY_MATCHES_SCOPE',
			severity: 'hint',
			issue: 'The property "backlink" matches an alias of scope "backlinks".',
			hint: 'Did you mean "backlinks:Foo" instead?',
		});

		const backlinksScopeRes = compileQuery('backlinks:Foo', config, PINNED_REF_MS);
		expect(backlinksScopeRes.executable).toBe(true);
		expect(backlinksScopeRes.diagnostics).toEqual([]);

		const compoundRes = compileQuery('[heading: (Intro OR Summary)]', config, PINNED_REF_MS);
		expect(compoundRes.executable).toBe(true);
		expect(compoundRes.diagnostics).toHaveLength(1);
		expect(compoundRes.diagnostics[0]).toMatchObject({
			code: 'HINT_PROPERTY_MATCHES_SCOPE',
			severity: 'hint',
			issue: 'The property "heading" matches an alias of scope "headings".',
			hint: 'Did you mean "headings:(Intro OR Summary)" instead?',
		});
		expect(compoundRes.diagnostics[0]?.span).not.toBeNull();

		const nonColonQueries = [
			'[path: < 20]',
			'[path: = Foo]',
			'[path: != Foo]',
			'[path]',
			'[path:]',
			'[path:""]',
			'[owner: Foo]',
		];
		for (const q of nonColonQueries) {
			const res = compileQuery(q, config, PINNED_REF_MS);
			expect(res.diagnostics.some((d) => d.code === 'HINT_PROPERTY_MATCHES_SCOPE')).toBe(
				false,
			);
		}
	});

	it('emits HINT_UNCLOSED_REGEX on unquoted leading-slash strings in scoped and property colon leaf positions', () => {
		for (const bare of ['/foo', '/^draft']) {
			const res = compileQuery(bare, config, PINNED_REF_MS);
			expect(res.executable).toBe(false);
			expect(res.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
		}

		// Scoped filter leaf and compound ValueExprAST
		const scopedSingle = compileQuery('file:/^draft', config, PINNED_REF_MS);
		expect(scopedSingle.executable).toBe(true);
		expect(scopedSingle.diagnostics).toHaveLength(1);
		expect(scopedSingle.diagnostics[0]).toMatchObject({
			code: 'HINT_UNCLOSED_REGEX',
			severity: 'hint',
			issue: 'Unquoted "/^draft" starts with "/" and is searched as literal text.',
			hint: 'Add a closing "/" for a regular expression, or wrap in quotes for literal text.',
		});
		expect(scopedSingle.diagnostics[0]?.span).not.toBeNull();

		const scopedCompound = compileQuery('tag:(/work\nOR !/urgent)', config, PINNED_REF_MS);
		expect(scopedCompound.executable).toBe(true);
		expect(scopedCompound.diagnostics).toHaveLength(2);
		expect(scopedCompound.diagnostics.map((d) => d.issue)).toEqual([
			'Unquoted "/work" starts with "/" and is searched as literal text.',
			'Unquoted "/urgent" starts with "/" and is searched as literal text.',
		]);

		// Property `:` filter leaf and compound ValueExprAST
		const propSingle = compileQuery('[status: /^todo]', config, PINNED_REF_MS);
		expect(propSingle.executable).toBe(true);
		expect(propSingle.diagnostics).toHaveLength(1);
		expect(propSingle.diagnostics[0]).toMatchObject({
			code: 'HINT_UNCLOSED_REGEX',
			severity: 'hint',
			issue: 'Unquoted "/^todo" starts with "/" and is searched as literal text.',
			hint: 'Add a closing "/" for a regular expression, or wrap in quotes for literal text.',
		});
		expect(propSingle.diagnostics[0]?.span).not.toBeNull();

		const propCompound = compileQuery('[status: (/open\nOR /closed)]', config, PINNED_REF_MS);
		expect(propCompound.executable).toBe(true);
		expect(propCompound.diagnostics).toHaveLength(2);
		expect(propCompound.diagnostics.map((d) => d.issue)).toEqual([
			'Unquoted "/open" starts with "/" and is searched as literal text.',
			'Unquoted "/closed" starts with "/" and is searched as literal text.',
		]);

		// Negative cases that must NOT emit HINT_UNCLOSED_REGEX
		const negativeQueries = [
			'file:"/projects/active"',
			'[status: "/todo"]',
			'file:/^draft/',
			'file://',
			'[status: = /todo]',
			'[status: != /todo]',
			'[done: /true]',
			'[score: /100]',
		];
		for (const q of negativeQueries) {
			const res = compileQuery(q, config, PINNED_REF_MS);
			expect(res.diagnostics.some((d) => d.code === 'HINT_UNCLOSED_REGEX')).toBe(false);
		}
	});
});

describe('Step 6: PreparedQuery & AST deep freeze (Conformance Test 16c)', () => {
	const config = createStandardConfig();

	it('Conformance Test 16c: deeply freezes compiled.ast and compiled.prepared so mutation throws TypeError', () => {
		const compiled = compileQuery('tag:work AND [score: >= 10]', config, PINNED_REF_MS);
		expect(compiled.executable).toBe(true);
		expect(compiled.ast).not.toBeNull();
		expect(compiled.prepared).not.toBeNull();
		expect(compiled.prepared?.ast).toBe(compiled.ast);
		expect(compiled.prepared?.resolvedConfig).toBe(config);
		expect(compiled.prepared?.referenceTimeMs).toBe(PINNED_REF_MS);
		expect(Object.isFrozen(compiled.prepared)).toBe(true);
		expect(Object.isFrozen(compiled.ast)).toBe(true);

		const logical = compiled.ast as LogicalNode;
		expect(() => {
			(logical.children as SearchAST[]).push({ type: 'MATCH_ALL' });
		}).toThrow(TypeError);

		expect(() => {
			(compiled.prepared as { referenceTimeMs: number }).referenceTimeMs = 0;
		}).toThrow(TypeError);

		expect(normalizeAST(compiled.ast!)).toEqual(normalizeAST(compiled.prepared!.ast));
	});

	it('emits non-blocking WARN_MISSING_THIS_VALUE and WARN_THIS_TYPE_MISMATCH when hostDoc is supplied while keeping executable: true', () => {
		const hostDoc = {
			normalizationFingerprint: config.normalizationFingerprint,
			file: {
				path: 'Projects/Apollo.md',
				name: 'Apollo.md',
				basename: 'Apollo',
				extension: 'md',
				parent: 'Projects',
				created: '2026-10-20T09:00',
				modified: '2026-10-22T15:30',
				size: 512,
			},
			aliases: [],
			aliasLocations: [],
			tags: ['space'],
			tagLocations: [],
			cssclasses: [],
			headings: [],
			links: [],
			embeds: [],
			blocks: [],
			propertyOccurrences: [],
			propertyKeys: ['bad_score'],
			properties: Object.assign(Object.create(null) as Record<string, unknown>, {
				bad_score: 'not-a-number',
			}),
			propertyLocations: [],
			diagnostics: [],
		};

		const missingRes = compileQuery(
			'tag:@this.properties.nonexistent AND [score: = @this.properties.missing_num]',
			config,
			PINNED_REF_MS,
			hostDoc,
		);
		expect(missingRes.executable).toBe(true);
		expect(missingRes.prepared).not.toBeNull();
		expect(missingRes.prepared?.hostDoc).toBe(hostDoc);
		expect(missingRes.diagnostics.map((d) => d.code)).toEqual([
			'WARN_MISSING_THIS_VALUE',
			'WARN_MISSING_THIS_VALUE',
		]);

		const mismatchRes = compileQuery(
			'[score: > @this.properties.bad_score]',
			config,
			PINNED_REF_MS,
			hostDoc,
		);
		expect(mismatchRes.executable).toBe(true);
		expect(mismatchRes.prepared).not.toBeNull();
		expect(mismatchRes.diagnostics.map((d) => d.code)).toEqual(['WARN_THIS_TYPE_MISMATCH']);
	});
});
