import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	collectReferencedPropertyKeys,
	decodeQuotedString,
	deepFreezeAST,
	initEngineConfig,
	isVirtualFileKey,
	normalizeAST,
	parseQuery,
	SearchLexer,
	VIRTUAL_FILE_KEYS_LIST,
	type SearchAST,
	type SourceSpan,
	type ValueExprAST,
} from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';
import { printableExecutableAstArb } from '../support/search-arbitraries';
import { printAST } from '../support/search-printer';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

function encodeDoubleQuoted(value: string): string {
	let out = '"';
	for (const ch of value) {
		if (ch === '\\') out += '\\\\';
		else if (ch === '"') out += '\\"';
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else out += ch;
	}
	return out + '"';
}

function encodeSingleQuoted(value: string): string {
	let out = "'";
	for (const ch of value) {
		if (ch === '\\') out += '\\\\';
		else if (ch === "'") out += "\\'";
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else out += ch;
	}
	return out + "'";
}

function assertValidSpan(span: SourceSpan, inputLength: number): void {
	expect(Number.isSafeInteger(span.startOffset)).toBe(true);
	expect(Number.isSafeInteger(span.endOffset)).toBe(true);
	expect(Number.isSafeInteger(span.startLine)).toBe(true);
	expect(Number.isSafeInteger(span.startColumn)).toBe(true);
	expect(span.startOffset).toBeGreaterThanOrEqual(0);
	expect(span.endOffset).toBeGreaterThanOrEqual(span.startOffset);
	expect(span.endOffset).toBeLessThanOrEqual(inputLength);
	expect(span.startLine).toBeGreaterThanOrEqual(1);
	expect(span.startColumn).toBeGreaterThanOrEqual(1);
}

function assertAstSpansAndFreeze(ast: SearchAST, inputLength: number, checkFrozen: boolean): void {
	if (checkFrozen) expect(Object.isFrozen(ast)).toBe(true);
	if (ast.type === 'MATCH_ALL') return;
	if (ast.span) {
		if (checkFrozen) expect(Object.isFrozen(ast.span)).toBe(true);
		assertValidSpan(ast.span, inputLength);
	}
	switch (ast.type) {
		case 'TEXT_MATCH':
			if (checkFrozen) expect(Object.isFrozen(ast.matcher)).toBe(true);
			return;
		case 'NOT':
			assertAstSpansAndFreeze(ast.child, inputLength, checkFrozen);
			return;
		case 'SCOPED_FILTER':
			if (checkFrozen) assertValueExprFrozen(ast.expr);
			return;
		case 'PROPERTY_FILTER':
			if (checkFrozen && ast.valueExpr) assertValueExprFrozen(ast.valueExpr);
			return;
		case 'LOGICAL':
			if (checkFrozen) expect(Object.isFrozen(ast.children)).toBe(true);
			for (const child of ast.children)
				assertAstSpansAndFreeze(child, inputLength, checkFrozen);
			return;
	}
}

function assertValueExprFrozen(expr: ValueExprAST): void {
	expect(Object.isFrozen(expr)).toBe(true);
	if (expr.type === 'VALUE_LEAF') {
		expect(Object.isFrozen(expr.matcher)).toBe(true);
	} else if (expr.type === 'VALUE_NOT') {
		assertValueExprFrozen(expr.child);
	} else {
		expect(Object.isFrozen(expr.children)).toBe(true);
		for (const child of expr.children) assertValueExprFrozen(child);
	}
}

function collectExpectedPropertyKeysFromTree(ast: SearchAST, acc = new Set<string>()): Set<string> {
	if (ast.type === 'PROPERTY_FILTER') {
		const key = ast.key.trim().toLowerCase();
		if (!isVirtualFileKey(key)) acc.add(key);
	} else if (ast.type === 'NOT') {
		collectExpectedPropertyKeysFromTree(ast.child, acc);
	} else if (ast.type === 'LOGICAL') {
		for (const child of ast.children) collectExpectedPropertyKeysFromTree(child, acc);
	}
	return acc;
}

describe('Phase 4 parser, AST normalizer, literal decoder & fuzz invariants', () => {
	const cfgRes = initEngineConfig({
		timeZone: 'America/New_York',
		propertyTypes: {
			score: 'number',
			priority: 'number',
			meeting: 'datetime',
			due: 'date',
			done: 'checkbox',
			status: 'text',
		},
	});
	if (!cfgRes.ok) throw new Error('Expected valid config');
	const resolvedConfig = cfgRes.config;
	const printableAstArb = printableExecutableAstArb(resolvedConfig, PINNED_REF_MS);

	it('Invariant 5: printable executable AST round-trip (normalizeAST(parseQuery(printAST(ast)).ast) === normalizeAST(ast)) and normalizeAST idempotence', async () => {
		await assertProperty(
			'search/parser__printable-ast-roundtrip-and-normalize-idempotence',
			fc.property(printableAstArb, (ast) => {
				const norm1 = normalizeAST(ast);
				const norm2 = normalizeAST(norm1);
				expect(norm2).toEqual(norm1);
				const printed = printAST(ast);
				const parsed = parseQuery(printed);
				expect(
					parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
				).toEqual([]);
				expect(parsed.ast).not.toBeNull();
				expect(normalizeAST(parsed.ast!)).toEqual(norm1);
			}),
		);
	});

	it('Invariant 1b & 4.2.7: deepFreezeAST freezes all reachable nodes/arrays/matchers/spans and collectReferencedPropertyKeys collects exact non-virtual keys', async () => {
		await assertProperty(
			'search/ast-utils__deep-freeze-and-referenced-property-keys',
			fc.property(printableAstArb, (ast) => {
				const printed = printAST(ast);
				const parsed = parseQuery(printed);
				expect(parsed.ast).not.toBeNull();
				const frozen = deepFreezeAST(parsed.ast!);
				assertAstSpansAndFreeze(frozen, printed.length, true);
				const actualKeys = collectReferencedPropertyKeys(frozen);
				expect(actualKeys).toEqual(collectExpectedPropertyKeysFromTree(frozen));
				for (const virtualKey of VIRTUAL_FILE_KEYS_LIST) {
					expect(actualKeys.has(virtualKey)).toBe(false);
				}
			}),
		);
	});

	it('Section 3.4 Rule 2: decodeQuotedString round-trips arbitrary strings in both double and single quotes and preserves unknown escapes', async () => {
		const nonSpecialEscapeCharArb = fc
			.string({ minLength: 1, maxLength: 1 })
			.filter((ch) => !['"', "'", '\\', 'n', 'r', 't', '\r', '\n'].includes(ch));
		await assertProperty(
			'search/literals__quoted-string-escape-roundtrip',
			fc.property(fc.string({ maxLength: 64 }), nonSpecialEscapeCharArb, (rawStr, unkCh) => {
				const dbl = encodeDoubleQuoted(rawStr);
				const sgl = encodeSingleQuoted(rawStr);
				const dblLex = SearchLexer.tokenize(dbl);
				expect(dblLex.errors).toEqual([]);
				expect(dblLex.tokens).toHaveLength(1);
				expect(decodeQuotedString(dblLex.tokens[0]!.image)).toBe(rawStr);
				const sglLex = SearchLexer.tokenize(sgl);
				expect(sglLex.errors).toEqual([]);
				expect(sglLex.tokens).toHaveLength(1);
				expect(decodeQuotedString(sglLex.tokens[0]!.image)).toBe(rawStr);
				expect(decodeQuotedString(`"\\${unkCh}"`)).toBe(`\\${unkCh}`);
			}),
		);
	});

	it('Invariant 2b & Fuzz Totality: parseQuery never throws on arbitrary or adversarial strings, gates ast === null on error diagnostics, and emits valid JSON-safe SourceSpans', async () => {
		const tokenFragmentArb = fc.constantFrom(
			'(',
			')',
			'[',
			']',
			':',
			'=',
			'!=',
			'>=',
			'<=',
			'>',
			'<',
			'AND',
			'OR',
			'NOT',
			'-',
			'-draft',
			'- 5',
			'#tag/sub',
			'headings:',
			'links:[[Note|Alias]]',
			'links:[[]]',
			'links:[[|Alias]]',
			'["" = 1]',
			'[score >= -10.5]',
			'[score = - 5]',
			'/regex/im',
			'/bad/flags',
			'"quoted"',
			'"unclosed',
			'2026-10-22..2026',
			'@today-7d..@today',
			' ',
			'\n',
		);
		const adversarialQueryArb = fc.oneof(
			fc.string({ maxLength: 120 }),
			fc
				.array(tokenFragmentArb, { minLength: 1, maxLength: 20 })
				.map((parts) => parts.join('')),
			fc
				.integer({ min: 1, max: 40 })
				.map((depth) => `${'('.repeat(depth)}a${')'.repeat(depth)}`),
			fc.integer({ min: 1, max: 40 }).map((depth) => `${'-'.repeat(depth)}a`),
			fc.integer({ min: 4090, max: 4105 }).map((len) => 'x'.repeat(len)),
		);
		await assertProperty(
			'search/parser__fuzz-totality-error-gating-and-span-integrity',
			fc.property(adversarialQueryArb, (input) => {
				const res = parseQuery(input);
				const hasError = res.diagnostics.some(
					(diagnostic) => diagnostic.severity === 'error',
				);
				if (hasError) {
					expect(res.ast).toBeNull();
				} else {
					expect(res.ast).not.toBeNull();
					assertAstSpansAndFreeze(res.ast!, input.length, false);
				}
				for (const diagnostic of res.diagnostics) {
					for (const value of Object.values(diagnostic))
						expect(value).not.toBeUndefined();
					expect(diagnostic.span).not.toBeNull();
					if (diagnostic.span) assertValidSpan(diagnostic.span, input.length);
				}
				expect(JSON.parse(JSON.stringify(res))).toEqual(res);
			}),
		);
	});
});
