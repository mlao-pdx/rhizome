import { describe, expect, it, vi } from 'vitest';
import {
	compileQuery,
	evaluateDoc,
	evaluateVault,
	getExecutionPlan,
	initEngineConfig,
	normalizeObsidianMetadata,
	oracleEvaluateDoc,
	oracleEvaluateVault,
	substringStringMatch,
	type DocumentDiagnostic,
	type EngineConfig,
	type InlinePropertyInput,
	type LogicalNode,
	type NormalizedDocument,
	type ObsidianFileInput,
	type ObsidianMetadataCacheInput,
	type ResolvedEngineConfig,
	type ScopedFilterNode,
	type SearchAST,
} from '../../src/core/search';
import * as astUtils from '../../src/core/search/ast-utils';
import * as literals from '../../src/core/search/literals';
import * as coercion from '../../src/core/search/property-coercion';
import * as temporal from '../../src/core/search/temporal';

const PINNED_REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

function createStandardConfig(overrides: Partial<EngineConfig> = {}): ResolvedEngineConfig {
	const result = initEngineConfig({
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
		...overrides,
	});
	if (!result.ok) throw new Error('Expected valid standard config');
	return result.config;
}

const config = createStandardConfig();

function makeDoc(
	path = 'Notes/A.md',
	cache: ObsidianMetadataCacheInput = {},
	resolvedConfig = config,
	inline: readonly InlinePropertyInput[] = [],
	stat: Partial<ObsidianFileInput['stat']> = {},
): NormalizedDocument {
	const name = path.split('/').at(-1)!;
	const dot = name.lastIndexOf('.');
	return normalizeObsidianMetadata(
		{
			path,
			name,
			basename: name.slice(0, dot),
			extension: name.slice(dot + 1),
			parent: { path: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' },
			stat: { ctime: PINNED_REF_MS, mtime: PINNED_REF_MS, size: 512, ...stat },
		},
		cache,
		resolvedConfig,
		inline,
	);
}

function compile(input: string, resolvedConfig = config, referenceTimeMs = PINNED_REF_MS) {
	const result = compileQuery(input, resolvedConfig, referenceTimeMs);
	expect(result.executable, input).toBe(true);
	if (!result.prepared) throw new Error(`Query did not compile: ${input}`);
	return { ...result, prepared: result.prepared };
}

function assertReports(
	input: string,
	docs: readonly NormalizedDocument[],
	matches: NormalizedDocument[],
	resolvedConfig = config,
	propertyDiagnostics: DocumentDiagnostic[] = [],
) {
	const compiled = compile(input, resolvedConfig);
	const expected = { matches, propertyDiagnostics };
	expect(evaluateVault(docs, compiled.prepared), input).toEqual(expected);
	expect(oracleEvaluateVault(docs, compiled.prepared), input).toEqual(expected);
	return compiled;
}

function assertRejected(input: string, code: string, resolvedConfig = config, ref = PINNED_REF_MS) {
	const result = compileQuery(input, resolvedConfig, ref);
	expect(result).toMatchObject({ executable: false, ast: null, prepared: null });
	expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
	return result;
}

describe('search conformance matrix', () => {
	it('1: matches hierarchical tags and lowers bare tag shorthand', () => {
		const tagged = makeDoc('Work.md', { tags: [{ tag: '#work/urgent' }] });
		const docs = [makeDoc('Other.md'), tagged];
		expect(assertReports('tag:#work/urgent', docs, [tagged]).diagnostics).toEqual([]);
		const compiled = assertReports('#work', docs, [tagged]);
		expect(compiled.diagnostics).toEqual([]);
		expect(compiled.ast).toMatchObject({ scope: 'tag', rawScope: '#' });
	});

	it('2: compares signed decimal numbers', () => {
		const passing = makeDoc('Passing.md', { frontmatter: { score: -5 } });
		const failing = makeDoc('Failing.md', { frontmatter: { score: -20 } });
		assertReports('[score: >= -10.5]', [failing, passing], [passing]);
	});

	it('3: distinguishes document negation, signed strings, and per-filename negation', () => {
		const clean = makeDoc('Notes/final.md');
		const draft = makeDoc('Notes/draft.md');
		const signed = makeDoc('Notes/note-draft.md');
		const aliasDraft = makeDoc('Notes/published.md', { frontmatter: { aliases: ['draft'] } });
		const extensionDraft = makeDoc('Notes/final.draft');
		const docs = [draft, signed, aliasDraft, extensionDraft, clean];
		assertReports('!draft', docs, [clean]);
		assertReports('file:-draft', docs, [signed]);
		assertReports('file:!draft', docs, [aliasDraft, extensionDraft, clean]);
		assertReports('file:(!draft)', docs, [aliasDraft, extensionDraft, clean]);
	});

	it('4: distinguishes quoted and slashless paths from accidental regex syntax', () => {
		const project = makeDoc('Root/Projects/Active/Archive/A.md');
		const docs = [makeDoc('Other.md'), project];
		assertReports('path:"/projects/active"', docs, [project]);
		assertReports('path:Projects/Active/Archive', docs, [project]);
		assertRejected('path:/projects/active', 'SYNTAX_ERROR');
	});

	it('5: compares explicit timezone offsets as absolute timestamps', () => {
		const meeting = makeDoc('Meeting.md', {
			frontmatter: { meeting: '2026-10-22T12:00:00.000Z' },
		});
		const other = makeDoc('Other.md', { frontmatter: { meeting: '2026-10-22T14:00:00.000Z' } });
		assertReports('[meeting: = 2026-10-22T14:00:00+02:00]', [other, meeting], [meeting]);
	});

	it('6: gates invalid and skipped dates even under negation', () => {
		assertRejected('[due: = 2026-02-31]', 'ERROR_TYPE_MISMATCH');
		const apia = createStandardConfig({ timeZone: 'Pacific/Apia' });
		const ref = Date.parse('2011-12-29T12:00:00.000Z');
		assertRejected('[due: = 2011-12-30]', 'ERROR_TYPE_MISMATCH', apia, ref);
		assertRejected('NOT [due: = @today+1d]', 'ERROR_TYPE_MISMATCH', apia, ref);
	});

	it('7: includes every hour and both boundaries of the 25-hour DST fall-back day', () => {
		const start = Date.parse('2026-11-01T04:00:00.000Z');
		const end = Date.parse('2026-11-02T05:00:00.000Z');
		const inside = [
			...Array.from({ length: 25 }, (_, hour) => start + hour * 3_600_000),
			end - 1,
		].map((ms, index) =>
			makeDoc(`Inside-${index}.md`, {
				frontmatter: { modified: new Date(ms).toISOString() },
			}),
		);
		const outside = [start - 1, end].map((ms, index) =>
			makeDoc(`Outside-${index}.md`, {
				frontmatter: { modified: new Date(ms).toISOString() },
			}),
		);
		assertReports('[modified: = 2026-11-01]', [outside[0]!, ...inside, outside[1]!], inside);
	});

	it('8: applies scoped conjunction to a single heading', () => {
		const split = makeDoc('Split.md', {
			headings: [
				{ heading: 'Intro', level: 1 },
				{ heading: 'Summary', level: 2 },
			],
		});
		const combined = makeDoc('Combined.md', {
			headings: [{ heading: 'Intro and Summary', level: 1 }],
		});
		assertReports('headings:(Intro AND Summary)', [split, combined], [combined]);
	});

	it('9: inequality requires existence unlike document-level negation', () => {
		const missing = makeDoc('Missing.md');
		const done = makeDoc('Done.md', { frontmatter: { status: 'done' } });
		const active = makeDoc('Active.md', { frontmatter: { status: 'active' } });
		const docs = [missing, done, active];
		const compiled = assertReports('[status: != done]', docs, [active]);
		expect(compiled.diagnostics).toMatchObject([
			{
				code: 'HINT_PROP_NEQ_EXISTENCE',
				hint: 'To exclude notes (including notes missing "status"), use "![status:=done]".',
			},
		]);
		assertReports('![status: = done]', docs, [missing, active]);
	});

	it('10: respects syntax, operator, and type error precedence', () => {
		assertRejected('NOT [priority: > high]', 'ERROR_TYPE_MISMATCH');
		assertRejected('[priority: = /10/]', 'ERROR_INVALID_OPERATOR_FOR_TYPE');
		assertRejected('[priority: = /foo(/]', 'SYNTAX_ERROR');
	});

	it('11: resolves self-links and strips wikilink aliases before evaluation', () => {
		const doc = makeDoc('Notes/A.md', { links: [{ link: '#Overview' }] });
		expect(doc.links[0]).toMatchObject({
			rawTarget: 'Notes/A.md',
			resolvedPath: 'Notes/A.md',
			subpath: '#Overview',
		});
		const compiled = assertReports('links:[[Notes/A|Custom Label]]', [doc], [doc]);
		expect((compiled.ast as ScopedFilterNode).expr).toMatchObject({
			matcher: { value: 'Notes/A', quoted: true },
		});
		expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'HINT_WIKILINK_BRACKETS_IN_SCOPE',
		]);
	});

	it('12: preserves hybrid key order, promotes occurrences, and evaluates trimmed custom scopes', () => {
		const matchString = vi.fn(substringStringMatch);
		const custom = createStandardConfig({
			customScopes: [
				{
					canonicalName: ' Tasks ',
					aliases: ['tasks', 'task'],
					extract: (doc) => doc.aliases,
					matchString,
				},
			],
		});
		const doc = makeDoc('Tasks.md', { frontmatter: { foo: ['fm1', 'fm2'] } }, custom, [
			{ key: '10', value: 'ten', line: 5 },
			{ key: '2', value: 'two', line: 6 },
			{ key: 'foo', value: 'inline1', line: 7 },
			{ key: 'foo', value: ['inline2', 'inline3'], line: 8 },
		]);
		expect(doc.propertyKeys).toEqual(['foo', '10', '2']);
		expect(doc.properties['foo']).toEqual(['fm1', 'fm2', 'inline1', 'inline2', 'inline3']);
		assertReports('[foo: inline3] AND ["10": = ten] AND ["2": = two]', [doc], [doc], custom);
		const urgent = makeDoc(
			'Urgent.md',
			{ frontmatter: { aliases: ['Urgent review'] } },
			custom,
		);
		for (const query of ['task:urgent', 'task:/^urgent/i', 'task:"Urgent review"']) {
			matchString.mockClear();
			const compiled = assertReports(query, [doc, urgent], [urgent], custom);
			expect(compiled.ast).toMatchObject({ scope: 'Tasks' });
			if (query === 'task:/^urgent/i') expect(matchString).not.toHaveBeenCalled();
			else expect(matchString).toHaveBeenCalled();
		}
		expect(matchString).toHaveBeenCalledWith('Urgent review', 'Urgent review', true);
		expect(custom.getScope('task')).toMatchObject({
			canonicalName: 'Tasks',
			aliases: ['tasks', 'task'],
		});
	});

	it('13: executes native regex features and rejects invalid patterns and flags', () => {
		const ip = makeDoc('Notes/host-192.168.1.2.md');
		const final = makeDoc('note-final.md');
		const draft = makeDoc('note-draft.md');
		const docs = [draft, ip, final];
		assertReports('file:/(\\d{1,3}\\.){3}\\d{1,3}/i', docs, [ip]);
		assertReports('file:/^note-(?!draft)/', docs, [final]);
		assertReports('path:/[\\/]/', docs, [ip]);
		for (const query of ['path:/[/]/', 'file:/test/g', 'file:/test/ii', 'file:/[unclosed/']) {
			assertRejected(query, 'SYNTAX_ERROR');
		}
	});

	it.each([
		['@now', '2026-10-22T15:30:00.000Z', '2026-10-22T15:30:00.001Z'],
		['@today', '2026-10-22T04:00:00Z', '2026-10-23T04:00:00Z'],
		['@yesterday', '2026-10-21T04:00:00Z', '2026-10-22T04:00:00Z'],
		['@tomorrow', '2026-10-23T04:00:00Z', '2026-10-24T04:00:00Z'],
		['@lastday', '2026-10-21T04:00:00Z', '2026-10-22T04:00:00Z'],
		['@thisday', '2026-10-22T04:00:00Z', '2026-10-23T04:00:00Z'],
		['@nextday', '2026-10-23T04:00:00Z', '2026-10-24T04:00:00Z'],
		['@today-6d..@today', '2026-10-16T04:00:00Z', '2026-10-23T04:00:00Z'],
		['@today-7d..@today', '2026-10-15T04:00:00Z', '2026-10-23T04:00:00Z'],
		['@lastweek', '2026-10-12T04:00:00Z', '2026-10-19T04:00:00Z'],
		['@thisweek', '2026-10-19T04:00:00Z', '2026-10-26T04:00:00Z'],
		['@nextweek', '2026-10-26T04:00:00Z', '2026-11-02T05:00:00Z'],
		['@lastmonth', '2026-09-01T04:00:00Z', '2026-10-01T04:00:00Z'],
		['@thismonth', '2026-10-01T04:00:00Z', '2026-11-01T04:00:00Z'],
		['@nextmonth', '2026-11-01T04:00:00Z', '2026-12-01T05:00:00Z'],
		['@lastquarter', '2026-07-01T04:00:00Z', '2026-10-01T04:00:00Z'],
		['@thisquarter', '2026-10-01T04:00:00Z', '2027-01-01T05:00:00Z'],
		['@nextquarter', '2027-01-01T05:00:00Z', '2027-04-01T04:00:00Z'],
		['@lastyear', '2025-01-01T05:00:00Z', '2026-01-01T05:00:00Z'],
		['@thisyear', '2026-01-01T05:00:00Z', '2027-01-01T05:00:00Z'],
		['@nextyear', '2027-01-01T05:00:00Z', '2028-01-01T05:00:00Z'],
		['2026-10-22..2026', '2026-10-22T04:00:00Z', '2027-01-01T05:00:00Z'],
		['@thisyear..@today', '2026-01-01T05:00:00Z', '2026-10-23T04:00:00Z'],
		['@today..@thisyear', '2026-10-22T04:00:00Z', '2027-01-01T05:00:00Z'],
	])('14: evaluates %s with exact local calendar boundaries', (literal, start, end) => {
		const bounds = [
			Date.parse(start) - 1,
			Date.parse(start),
			Date.parse(end) - 1,
			Date.parse(end),
		];
		const docs = bounds.map((ms, index) =>
			makeDoc(`Bound-${index}.md`, { frontmatter: { due: new Date(ms).toISOString() } }),
		);
		assertReports(`[due: = ${literal}]`, docs, [docs[1]!, docs[2]!]);
	});

	it('14: rejects reversed positional ranges with exact swap hints', () => {
		for (const [literal, hint] of [
			['@today..@today-7d', 'Use @today-7d..@today'],
			['2026-10-15..2026-10-01', 'Use 2026-10-01..2026-10-15'],
		]) {
			const rejected = assertRejected(`[due: = ${literal}]`, 'SYNTAX_ERROR');
			expect(rejected.diagnostics[0]?.hint).toBe(hint);
		}
	});

	it('15: filters stored diagnostics and isolates virtual file property shadowing', () => {
		const doc = makeDoc(
			'Projects/Sprint-12.md',
			{ frontmatter: { 'file.size': 'large' } },
			config,
			[
				{ key: 'Sprint', value: '2026-10-01..2026-01-01', line: 14 },
				{ key: 'due', value: '2026-01-01..@today', line: 15 },
			],
			{ size: 2048 },
		);
		expect(doc.propertyOccurrences[0]?.typedValues).toEqual([{ kind: 'text', value: 'large' }]);
		assertReports('[file.size: > 1024]', [doc], [doc]);
		const sprint: DocumentDiagnostic = {
			code: 'DOC_REVERSED_DATE_RANGE',
			filePath: 'Projects/Sprint-12.md',
			fileBasename: 'Sprint-12',
			propertyKey: 'sprint',
			rawKey: 'Sprint',
			rawValue: '2026-10-01..2026-01-01',
			expectedType: 'date',
			source: 'inline',
			line: 14,
			occurrenceIndex: 1,
			valueIndex: 0,
			issue: 'The left endpoint starts on or after the exclusive end contributed by the right endpoint in "2026-10-01..2026-01-01".',
			hint: 'Use 2026-01-01..2026-10-01',
		};
		const due: DocumentDiagnostic = {
			code: 'DOC_INVALID_PROPERTY_VALUE',
			filePath: 'Projects/Sprint-12.md',
			fileBasename: 'Sprint-12',
			propertyKey: 'due',
			rawKey: 'due',
			rawValue: '2026-01-01..@today',
			expectedType: 'date',
			source: 'inline',
			line: 15,
			occurrenceIndex: 2,
			valueIndex: 0,
			issue: 'Value "2026-01-01..@today" is not a valid date.',
			hint: 'Relative @date anchors are only allowed in search queries, not in stored note properties.',
		};
		assertReports('[sprint: = @thisquarter]', [doc], [], config, [sprint]);
		assertReports('[due: = @today]', [doc], [], config, [due]);
	});

	it('16a: fingerprints are stable across registry key order', () => {
		const first = createStandardConfig({
			timeZone: 'UTC',
			propertyTypes: { a: 'number', b: 'date' },
		});
		const second = createStandardConfig({
			timeZone: 'UTC',
			propertyTypes: { b: 'date', a: 'number' },
		});
		expect(first.normalizationFingerprint).toBe(second.normalizationFingerprint);
		const doc = makeDoc('A.md', { frontmatter: { a: 10 } }, first);
		assertReports('[a: = 10]', [doc], [doc], second);
	});

	it('16b: both vault and document entrypoints reject incompatible normalization', () => {
		const utc = createStandardConfig({ timeZone: 'UTC' });
		const { prepared } = compile('', utc);
		const doc = makeDoc();
		const expected = `Document "${doc.file.path}" normalizationFingerprint mismatch: expected ${utc.normalizationFingerprint}, got ${doc.normalizationFingerprint}`;
		for (const evaluate of [evaluateVault, oracleEvaluateVault]) {
			expect(() => evaluate([doc], prepared)).toThrow(new Error(expected));
			expect(() => evaluate([makeDoc('Good.md', {}, utc), doc], prepared)).toThrow(
				new Error(expected),
			);
		}
		for (const evaluate of [evaluateDoc, oracleEvaluateDoc]) {
			expect(() => evaluate(doc, prepared)).toThrow(
				new Error(`Document "${doc.file.path}" normalizationFingerprint mismatch.`),
			);
		}
	});

	it('16c: compiled AST nodes, child arrays, matchers, and prepared queries are immutable', () => {
		const compiled = compile('tag:work AND [score: >= 10]');
		const ast = compiled.ast as LogicalNode;
		expect(compiled.prepared.ast).toBe(ast);
		expect(() => (ast.children as SearchAST[]).push({ type: 'MATCH_ALL' })).toThrow(TypeError);
		expect(() =>
			Object.assign((ast.children[0] as ScopedFilterNode).expr, { type: 'VALUE_NOT' }),
		).toThrow(TypeError);
		const expr = (ast.children[0] as ScopedFilterNode).expr;
		if (expr.type !== 'VALUE_LEAF') throw new Error('Expected a leaf');
		expect(() => Object.assign(expr.matcher, { value: 'changed' })).toThrow(TypeError);
		expect(() => Object.assign(compiled.prepared, { referenceTimeMs: 0 })).toThrow(TypeError);
	});

	it('16d: temporal snapshots survive wall-clock changes in repeated evaluations', () => {
		const today = makeDoc('Today.md', { frontmatter: { due: '2026-10-22' } });
		const tomorrow = makeDoc('Tomorrow.md', { frontmatter: { due: '2026-10-23' } });
		const { prepared } = compile('[due: = @today]');
		try {
			vi.useFakeTimers();
			for (const now of [
				'2026-10-22T15:30:00Z',
				'2026-10-23T16:00:00Z',
				'2030-01-01T00:00:00Z',
			]) {
				vi.setSystemTime(new Date(now));
				for (const evaluate of [evaluateVault, oracleEvaluateVault]) {
					expect(evaluate([tomorrow, today], prepared)).toEqual({
						matches: [today],
						propertyDiagnostics: [],
					});
				}
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('16d: lazily compiles every regex and typed literal once per prepared query', () => {
		const custom = createStandardConfig({
			customScopes: [
				{
					canonicalName: 'Tasks',
					aliases: ['task'],
					extract: (doc) => doc.aliases,
					matchString: substringStringMatch,
				},
			],
		});
		const getScope = vi.fn(custom.getScope);
		const instrumented = Object.freeze({ ...custom, getScope });
		const query =
			'file:/a/i AND task:/^urgent/i AND [status: /open/i] AND /a/i AND [due: = @today] AND [score: > 1] AND [done: = true]';
		const { prepared } = compile(query, instrumented);
		const doc = makeDoc(
			'A.md',
			{
				frontmatter: {
					aliases: ['Urgent'],
					status: 'open',
					due: '2026-10-22',
					score: 2,
					done: true,
				},
			},
			instrumented,
		);
		getScope.mockClear();
		const regex = vi.spyOn(literals, 'validateRegexLiteral');
		const date = vi.spyOn(temporal, 'parseTemporalExpr');
		const type = vi.spyOn(coercion, 'resolveQueryPropertyType');
		const keys = vi.spyOn(astUtils, 'collectReferencedPropertyKeys');
		try {
			expect(regex).not.toHaveBeenCalled();
			expect(date).not.toHaveBeenCalled();
			expect(evaluateVault([doc, doc], prepared).matches).toEqual([doc, doc]);
			const plan = getExecutionPlan(prepared);
			expect(regex).toHaveBeenCalledTimes(4);
			expect(date).toHaveBeenCalledTimes(1);
			expect(type).toHaveBeenCalledTimes(4);
			expect(keys).toHaveBeenCalledTimes(1);
			expect(getScope).toHaveBeenCalledTimes(2);
			expect(evaluateDoc(doc, prepared)).toBe(true);
			expect(evaluateVault([doc], prepared).matches).toEqual([doc]);
			expect(getExecutionPlan(prepared)).toBe(plan);
			expect(regex).toHaveBeenCalledTimes(4);
			expect(date).toHaveBeenCalledTimes(1);
			expect(type).toHaveBeenCalledTimes(4);
			expect(keys).toHaveBeenCalledTimes(1);
			expect(getScope).toHaveBeenCalledTimes(2);
		} finally {
			vi.restoreAllMocks();
		}
		const other = compile(query, instrumented).prepared;
		expect(getExecutionPlan(other)).not.toBe(getExecutionPlan(prepared));
	});

	it('16d: prepares every branch even for an empty vault and reuses that plan', () => {
		const { prepared } = compile('[score] OR file:/^unused/i OR [due: = @tomorrow]');
		const doc = makeDoc('A.md', { frontmatter: { score: 1 } });
		const regex = vi.spyOn(literals, 'validateRegexLiteral');
		const date = vi.spyOn(temporal, 'parseTemporalExpr');
		try {
			expect(evaluateVault([], prepared)).toEqual({ matches: [], propertyDiagnostics: [] });
			expect(regex).toHaveBeenCalledTimes(1);
			expect(date).toHaveBeenCalledTimes(1);
			expect(evaluateVault([doc], prepared).matches).toEqual([doc]);
			expect(regex).toHaveBeenCalledTimes(1);
			expect(date).toHaveBeenCalledTimes(1);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('16e: reports duplicate malformed list values with distinct indices', () => {
		const doc = makeDoc('Malformed.md', { frontmatter: { sprint: ['invalid', 'invalid'] } });
		expect(doc.diagnostics).toHaveLength(2);
		expect(
			doc.diagnostics.map(({ occurrenceIndex, valueIndex }) => [occurrenceIndex, valueIndex]),
		).toEqual([
			[0, 0],
			[0, 1],
		]);
		assertReports('[sprint: = @thisquarter]', [doc], [], config, doc.diagnostics);
	});
});
