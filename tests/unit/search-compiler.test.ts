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
		const overLength = 'a'.repeat(MAX_QUERY_LENGTH + 1);
		const lenRes = compileQuery(overLength, config, PINNED_REF_MS);
		expect(lenRes.executable).toBe(false);
		expect(lenRes.ast).toBeNull();
		expect(lenRes.prepared).toBeNull();
		expect(lenRes.diagnostics[0]?.code).toBe('SYNTAX_ERROR');

		const overDepth = `${'('.repeat(MAX_SYNTACTIC_DEPTH + 1)}a${')'.repeat(MAX_SYNTACTIC_DEPTH + 1)}`;
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

		const bareTextAndErr = compileQuery('roadmap AND [""]', config, PINNED_REF_MS);
		expect(bareTextAndErr.executable).toBe(false);
		expect(bareTextAndErr.ast).toBeNull();
		expect(bareTextAndErr.prepared).toBeNull();
		expect(bareTextAndErr.diagnostics.map((d) => d.code)).toEqual([
			'SYNTAX_ERROR',
			'HINT_BARE_TEXT_NO_BODY',
		]);

		const emptyKeyNeq = compileQuery('["" != high]', config, PINNED_REF_MS);
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
		expect(suggestScopeHint('zzzzzz', config)).toBeNull();
	});

	it('emits ERROR_UNKNOWN_SCOPE with lowering and linter diagnostics on unknown scopes', () => {
		const typoRes = compileQuery('hedings:Action Items', config, PINNED_REF_MS);
		expect(typoRes.executable).toBe(false);
		expect(typoRes.ast).toBeNull();
		expect(typoRes.prepared).toBeNull();
		expect(typoRes.diagnostics.map((d) => d.code)).toEqual([
			'WARN_UNQUOTED_MULTIWORD_SCOPE',
			'ERROR_UNKNOWN_SCOPE',
			'HINT_BARE_TEXT_NO_BODY',
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
		const r1 = compileQuery('NOT [priority > high]', config, PINNED_REF_MS);
		expect(r1.executable).toBe(false);
		expect(r1.ast).toBeNull();
		expect(r1.prepared).toBeNull();
		expect(r1.diagnostics).toHaveLength(1);
		expect(r1.diagnostics[0]).toMatchObject({
			code: 'ERROR_TYPE_MISMATCH',
			severity: 'error',
			issue: '"high" is not a valid number for property "priority".',
			hint: null,
		});
		expect(r1.diagnostics[0]?.span).not.toBeNull();

		const r2 = compileQuery('[priority = /10/]', config, PINNED_REF_MS);
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

		const r3 = compileQuery('[priority = /foo(/]', config, PINNED_REF_MS);
		expect(r3.executable).toBe(false);
		expect(r3.ast).toBeNull();
		expect(r3.prepared).toBeNull();
		expect(r3.diagnostics).toHaveLength(1);
		expect(r3.diagnostics[0]?.code).toBe('SYNTAX_ERROR');

		const r4 = compileQuery('[priority != high]', config, PINNED_REF_MS);
		expect(r4.executable).toBe(false);
		expect(r4.diagnostics).toHaveLength(1);
		expect(r4.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');
	});

	it('validates checkbox operators and literals (ERROR_INVALID_OPERATOR_FOR_TYPE & ERROR_TYPE_MISMATCH)', () => {
		for (const op of ['<', '>', '<=', '>=']) {
			const res = compileQuery(`[done ${op} true]`, config, PINNED_REF_MS);
			expect(res.executable).toBe(false);
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]?.code).toBe('ERROR_INVALID_OPERATOR_FOR_TYPE');
		}

		const regexColon = compileQuery('[done: /true/]', config, PINNED_REF_MS);
		expect(regexColon.executable).toBe(false);
		expect(regexColon.diagnostics).toHaveLength(1);
		expect(regexColon.diagnostics[0]?.code).toBe('ERROR_INVALID_OPERATOR_FOR_TYPE');

		const quotedBool = compileQuery('[done = "true"]', config, PINNED_REF_MS);
		expect(quotedBool.executable).toBe(false);
		expect(quotedBool.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const invalidBool = compileQuery('[done = yes]', config, PINNED_REF_MS);
		expect(invalidBool.executable).toBe(false);
		expect(invalidBool.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const validBool = compileQuery('[done = true] AND [done != FALSE]', config, PINNED_REF_MS);
		expect(validBool.executable).toBe(true);
	});

	it('validates number literals (rejects quoted numbers and non-numbers)', () => {
		const quotedNum = compileQuery('[score = "42"]', config, PINNED_REF_MS);
		expect(quotedNum.executable).toBe(false);
		expect(quotedNum.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const validSigned = compileQuery('[score >= -10.5]', config, PINNED_REF_MS);
		expect(validSigned.executable).toBe(true);
		expect(validSigned.diagnostics).toEqual([]);
	});

	it('Conformance Test 6: rejects invalid & skipped dates (including NOT [due = @today+1d] landing on skipped date)', () => {
		const feb31 = compileQuery('[due = 2026-02-31]', config, PINNED_REF_MS);
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

		const explicitSkipped = compileQuery('[due = 2011-12-30]', apiaCfgRes.config, apiaRefMs);
		expect(explicitSkipped.executable).toBe(false);
		expect(explicitSkipped.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');

		const relativeSkipped = compileQuery('NOT [due = @today+1d]', apiaCfgRes.config, apiaRefMs);
		expect(relativeSkipped.executable).toBe(false);
		expect(relativeSkipped.ast).toBeNull();
		expect(relativeSkipped.prepared).toBeNull();
		expect(relativeSkipped.diagnostics[0]?.code).toBe('ERROR_TYPE_MISMATCH');
	});

	it('Conformance Test 14: compiles valid positional date ranges and rejects reversed date ranges with SYNTAX_ERROR and swap hints', () => {
		for (const validQ of [
			'[due = 2026-10-22..2026]',
			'[due = @thisyear..@today]',
			'[due = @today..@thisyear]',
			'[due = @today-6d..@today]',
			'[due = @today-7d..@today]',
		]) {
			const res = compileQuery(validQ, config, PINNED_REF_MS);
			expect(res.executable).toBe(true);
			expect(res.diagnostics).toEqual([]);
		}

		const revRel = compileQuery('[due = @today..@today-7d]', config, PINNED_REF_MS);
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

		const revIso = compileQuery('[due = 2026-10-15..2026-10-01]', config, PINNED_REF_MS);
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
			'[tags: #work]',
			'[tags: work]',
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

describe('Step 5: Non-blocking linter diagnostics (Section 4.3)', () => {
	const config = createStandardConfig();

	it('emits WARN_UNQUOTED_MULTIWORD_SCOPE when unquoted scope is followed by bare text on the same line', () => {
		const res = compileQuery('headings:Action Items', config, PINNED_REF_MS);
		expect(res.executable).toBe(true);
		const warn = res.diagnostics.find((d) => d.code === 'WARN_UNQUOTED_MULTIWORD_SCOPE');
		expect(warn).toMatchObject({
			code: 'WARN_UNQUOTED_MULTIWORD_SCOPE',
			severity: 'warning',
			issue: '"Items" is searched as a separate term, not inside "headings:".',
			hint: 'Use headings:"Action Items"',
		});
		expect(warn?.span).not.toBeNull();
	});

	it('emits WARN_LOWERCASE_BOOLEAN on unquoted lowercase boolean words and suppresses HINT_BARE_TEXT_NO_BODY on that node', () => {
		for (const word of ['and', 'or', 'not', 'And']) {
			const res = compileQuery(word, config, PINNED_REF_MS);
			expect(res.executable).toBe(true);
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0]).toMatchObject({
				code: 'WARN_LOWERCASE_BOOLEAN',
				severity: 'warning',
				issue: `Lowercase "${word}" is searched as literal text.`,
				hint: `Use uppercase "${word.toUpperCase()}".`,
			});
			expect(res.diagnostics[0]?.span).not.toBeNull();
		}

		const quotedRes = compileQuery('"and"', config, PINNED_REF_MS);
		expect(quotedRes.executable).toBe(true);
		expect(quotedRes.diagnostics.map((d) => d.code)).toEqual(['HINT_BARE_TEXT_NO_BODY']);
	});

	it('emits WARN_DANGEROUS_SPACED_HYPHEN only when bare "-" precedes another sibling in AND', () => {
		const leadingRes = compileQuery('- term', config, PINNED_REF_MS);
		expect(leadingRes.executable).toBe(true);
		expect(leadingRes.diagnostics.map((d) => d.code)).toEqual([
			'WARN_DANGEROUS_SPACED_HYPHEN',
			'HINT_BARE_TEXT_NO_BODY',
		]);
		expect(leadingRes.diagnostics[0]).toMatchObject({
			code: 'WARN_DANGEROUS_SPACED_HYPHEN',
			severity: 'warning',
			issue: 'A space after "-" prevents negation.',
			hint: 'Use "-term" or "NOT term".',
		});

		const trailingRes = compileQuery('term -', config, PINNED_REF_MS);
		expect(trailingRes.executable).toBe(true);
		expect(trailingRes.diagnostics.some((d) => d.code === 'WARN_DANGEROUS_SPACED_HYPHEN')).toBe(
			false,
		);
	});

	it('emits WARN_SINGLE_VALUE_CONTRADICTION on contradicting single-valued fields in AND', () => {
		const contradictions: Array<[string, string, string]> = [
			['ext:md AND ext:pdf', 'md', 'pdf'],
			['ext:md AND [file.extension = pdf]', 'md', 'pdf'],
			['[file.extension = ".md"] AND [file.extension = "pdf"]', '.md', 'pdf'],
			['[file.name = "a.md"] AND [file.name = "b.md"]', 'a.md', 'b.md'],
			['[file.basename = alpha] AND [file.basename = beta]', 'alpha', 'beta'],
			['[file.path = "a/b.md"] AND [file.path = "c/d.md"]', 'a/b.md', 'c/d.md'],
			['[file.parent = "dir1"] AND [file.parent = "dir2"]', 'dir1', 'dir2'],
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
			'ext:md AND ext:.md AND [file.extension = MD]',
			config,
			PINNED_REF_MS,
		);
		expect(sameExt.executable).toBe(true);
		expect(sameExt.diagnostics).toEqual([]);
	});

	it('Conformance Test 9: emits HINT_PROP_NEQ_EXISTENCE with exact interpolated hint on [status != done]', () => {
		const res = compileQuery('[status != done]', config, PINNED_REF_MS);
		expect(res.executable).toBe(true);
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0]).toMatchObject({
			code: 'HINT_PROP_NEQ_EXISTENCE',
			severity: 'hint',
			issue: '"[status != done]" requires "status" to exist.',
			hint: 'To exclude notes (including notes missing "status"), use "-[status = done]".',
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

	it('emits HINT_BARE_TEXT_NO_BODY on bare document-level TextMatchNode', () => {
		const res = compileQuery('roadmap', config, PINNED_REF_MS);
		expect(res.executable).toBe(true);
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0]).toMatchObject({
			code: 'HINT_BARE_TEXT_NO_BODY',
			severity: 'hint',
			issue: 'Bare terms only search filenames, paths, aliases, and tags (note body is not indexed).',
			hint: null,
		});
		expect(res.diagnostics[0]?.span).not.toBeNull();
	});
});

describe('Step 6: PreparedQuery & AST deep freeze (Conformance Test 16c)', () => {
	const config = createStandardConfig();

	it('Conformance Test 16c: deeply freezes compiled.ast and compiled.prepared so mutation throws TypeError', () => {
		const compiled = compileQuery('tag:work AND [score >= 10]', config, PINNED_REF_MS);
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
});
