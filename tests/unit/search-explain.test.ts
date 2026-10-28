import { describe, expect, it } from 'vitest';
import {
	buildRegex101Url,
	explainQuery,
	formatDateIntervalWindow,
	formatSourceCaretSnippet,
	initEngineConfig,
	resolvePropertyTypeWithOrigin,
	type EngineConfig,
	type ResolvedEngineConfig,
} from '../../src/core/search';

const REF_TIME_MS = Date.parse('2026-10-22T15:30:00.000Z');

function makeConfig(overrides?: Partial<EngineConfig>): ResolvedEngineConfig {
	const res = initEngineConfig({
		timeZone: 'America/New_York',
		propertyTypes: {
			priority: 'number',
			due: 'date',
			updated: 'datetime',
			done: 'checkbox',
			status: 'text',
			reviewers: 'multitext',
			topics: 'tags',
		},
		...overrides,
	});
	if (!res.ok) throw new Error('Expected valid config');
	return res.config;
}

describe('explain-helpers', () => {
	it('resolves property type and origin across virtual, built-in, configured, and default fallback keys', () => {
		const cfg = makeConfig();
		expect(resolvePropertyTypeWithOrigin('file.modified', cfg.propertyTypes)).toEqual({
			type: 'datetime',
			origin: 'virtual',
			originLabel: 'virtual (file.*)',
		});
		expect(resolvePropertyTypeWithOrigin('file.size', cfg.propertyTypes)).toEqual({
			type: 'number',
			origin: 'virtual',
			originLabel: 'virtual (file.*)',
		});
		expect(resolvePropertyTypeWithOrigin('file.basename', cfg.propertyTypes)).toEqual({
			type: 'text',
			origin: 'virtual',
			originLabel: 'virtual (file.*)',
		});
		expect(resolvePropertyTypeWithOrigin('tags', cfg.propertyTypes)).toEqual({
			type: 'tags',
			origin: 'built-in',
			originLabel: 'built-in',
		});
		expect(resolvePropertyTypeWithOrigin('aliases', cfg.propertyTypes)).toEqual({
			type: 'multitext',
			origin: 'built-in',
			originLabel: 'built-in',
		});
		expect(resolvePropertyTypeWithOrigin('priority', cfg.propertyTypes)).toEqual({
			type: 'number',
			origin: 'configured',
			originLabel: 'configured',
		});
		expect(resolvePropertyTypeWithOrigin('unregistered_key', cfg.propertyTypes)).toEqual({
			type: 'text',
			origin: 'default',
			originLabel: "default fallback ('text')",
		});
	});

	it('constructs URL-encoded regex101 links without making network calls', () => {
		const url = buildRegex101Url('^todo\\s+#(urgent|high)$', 'im');
		expect(url).toBe(
			'https://regex101.com/?flavor=javascript&regex=%5Etodo%5Cs%2B%23(urgent%7Chigh)%24&flags=im',
		);
	});

	it('formats DateInterval windows and operator inequalities accurately', () => {
		const interval = {
			start: Date.parse('2026-10-22T04:00:00.000Z'),
			end: Date.parse('2026-10-23T04:00:00.000Z'),
			grain: 'day' as const,
			raw: '@today',
		};
		const eqWin = formatDateIntervalWindow(interval, '=', 'America/New_York');
		expect(eqWin.grain).toBe('day');
		expect(eqWin.utcWindow).toBe('[2026-10-22T04:00:00Z, 2026-10-23T04:00:00Z)');
		expect(eqWin.localWindow).toContain('2026-10-22T00:00:00-04:00');
		expect(eqWin.inequality).toBe('D.start >= Q.start && D.end <= Q.end');

		expect(formatDateIntervalWindow(interval, '!=', 'UTC').inequality).toBe(
			'D.start < Q.start || D.end > Q.end',
		);
		expect(formatDateIntervalWindow(interval, '<', 'UTC').inequality).toBe('D.end <= Q.start');
		expect(formatDateIntervalWindow(interval, '<=', 'UTC').inequality).toBe('D.end <= Q.end');
		expect(formatDateIntervalWindow(interval, '<=', 'UTC').plainEnglish).toContain(
			'ends at or before `2026-10-23 04:00` (`UTC`) (end of `@today`)',
		);
		expect(formatDateIntervalWindow(interval, '>', 'UTC').inequality).toBe('D.start >= Q.end');
		expect(formatDateIntervalWindow(interval, '>', 'UTC').plainEnglish).toContain(
			'is on or after `2026-10-23 04:00` (`UTC`) (end of `@today`)',
		);
		expect(formatDateIntervalWindow(interval, '>=', 'UTC').inequality).toBe(
			'D.start >= Q.start',
		);
	});

	it('renders 1-based line and caret underline snippets for SourceSpan', () => {
		const snippet = formatSourceCaretSnippet('#work [priority = "bad"]', {
			startOffset: 6,
			endOffset: 24,
			startLine: 1,
			startColumn: 7,
		});
		expect(snippet).toBe('1 | #work [priority = "bad"]\n          ^^^^^^^^^^^^^^^^^^');
	});
});

describe('explainQuery', () => {
	it('renders all 3 Diátaxis sections and MATCH_ALL flowchart for an empty query', () => {
		const cfg = makeConfig({ propertyTypes: {} });
		const md = explainQuery('   ', cfg, REF_TIME_MS);

		expect(md).toContain('# Query Explain Plan');
		expect(md).toContain('## Explanation — How This Query Matches Notes');
		expect(md).toContain('**Status**: **Executable** — 0 errors, 0 warnings, 0 hints.');
		expect(md).toContain('Match All Notes (`MATCH_ALL`)');
		expect(md).toContain('```mermaid\nflowchart TD');
		expect(md).toContain('Match every note in vault');
		expect(md).toContain('## Reference — Execution Context & Resolution');
		expect(md).toContain('_No scoped or property filters in this query._');
		expect(md).toContain('_None configured');
		expect(md).toContain('## Troubleshooting & Diagnostics');
		expect(md).toContain('> [!tip] No issues found');
	});

	it('explains boolean precedence, scope aliases, compound ValueExprAST, and property operators', () => {
		const cfg = makeConfig();
		const query =
			'folder:projects #work/auth tag:(#urgent OR -#archived) [priority >= 2] [status != "done"] -( [done = true] OR "draft" )';
		const md = explainQuery(query, cfg, REF_TIME_MS);

		expect(md).toContain('**Status**: **Executable**');
		// Scope alias resolution
		expect(md).toContain('(`folder:` is an alias for `path:`)');
		expect(md).toContain('**Tag filter** `#work/auth`');
		// Compound ValueExprAST explanation
		expect(md).toContain('The note has **at least one tag** where that single tag matches:');
		expect(md).toContain('**Either / any (`OR`)**');
		expect(md).toContain('**Not (`-`)**: Does **not** match:');
		// Plain-English != phrasing & existence tip
		expect(md).toContain('whose value does not equal `"done"` (case-insensitive)');
		expect(md).toContain(
			'*Tip: `[status != ...]` only matches notes that have a `status` property. To also include notes without `status`, use `-[status = ...]`.*',
		);
		expect(md).toContain('case-insensitive inequality (`!=`, does not equal `"done"`)');
		// Hint callout for != existence
		expect(md).toContain('HINT: `HINT_PROP_NEQ_EXISTENCE`');
	});

	it('resolves temporal windows in the configured timezone for relative and ISO range expressions', () => {
		const cfg = makeConfig({ timeZone: 'Asia/Tokyo' });
		const md = explainQuery(
			'[due = @today] [updated >= 2026-01-01..2026-06-30] [file.modified < @thisweek]',
			cfg,
			REF_TIME_MS,
		);

		expect(md).toContain('**Status**: **Executable**');
		expect(md).toContain('Asia/Tokyo');
		expect(md).toContain('`day` window');
		expect(md).toContain('`range` window');
		expect(md).toContain('`week` window');
		expect(md).toContain('virtual (file.*)');
		expect(md).toContain('D.start >= Q.start && D.end <= Q.end');
		expect(md).toContain('D.start >= Q.start');
		expect(md).toContain('D.end <= Q.start');
	});

	it('renders the Regular Expressions reference table with regex101 links and raw-string notes', () => {
		const cfg = makeConfig();
		const md = explainQuery(
			'/^roadmap/i path:/^projects\\// [priority:/^10$/] [status:/todo|doing/i]',
			cfg,
			REF_TIME_MS,
		);

		expect(md).toContain('### Regular Expressions');
		expect(md).toContain('https://regex101.com/?flavor=javascript&regex=');
		expect(md).toContain('regular expression match; rhs: `/^projects\\//`');
		expect(md).toContain(
			'Property `priority` (`number`) — tested against raw authored string `entry.raw`',
		);
		expect(md).toContain(
			'Property `status` (`text`) — tested against normalized string `entry.value`',
		);
	});

	it('preserves the best-effort AST explanation, Mermaid chart, and Reference tables on semantic errors', () => {
		const cfg = makeConfig();
		const md = explainQuery(
			'bogus:value [priority = "nan"] [done > true] [unconfigured_prop = "ok"]',
			cfg,
			REF_TIME_MS,
		);

		expect(md).toContain('**Status**: **Not Executable** (3 errors)');
		// AST & Mermaid still rendered
		expect(md).toContain('### Plain-English Logic Breakdown');
		expect(md).toContain('### Logic Flowchart');
		expect(md).toContain('```mermaid');
		expect(md).toContain('❌ **Unknown Scope Filter** `bogus:value`');
		expect(md).toContain(
			'❌ `true` — ordering operator `>` cannot be used on `checkbox` properties',
		);
		expect(md).toContain('`unconfigured_prop`');
		expect(md).toContain("default fallback ('text')");
		// Diagnostics section
		expect(md).toContain('> [!danger] ERROR: `ERROR_UNKNOWN_SCOPE`');
		expect(md).toContain('> [!danger] ERROR: `ERROR_TYPE_MISMATCH`');
		expect(md).toContain('> [!danger] ERROR: `ERROR_INVALID_OPERATOR_FOR_TYPE`');
	});

	it('handles syntax errors, invalid EngineConfig, and invalid referenceTimeMs gracefully', () => {
		const badSyntaxMd = explainQuery('tag:(#a OR', makeConfig(), REF_TIME_MS);
		expect(badSyntaxMd).toContain('**Status**: **Not Executable**');
		expect(badSyntaxMd).toContain(
			'This query could not be parsed into an execution tree because of a syntax or query-length error.',
		);
		expect(badSyntaxMd).not.toContain('```mermaid');
		expect(badSyntaxMd).toContain('> [!danger] ERROR: `SYNTAX_ERROR`');

		const badConfigMd = explainQuery(
			'#work [priority: (1 OR 2)] [due = @today]',
			{
				timeZone: 'Mars/Phobos',
				propertyTypes: { priority: 'number', due: 'date', bad: 'invalid_type' as never },
			},
			Number.NaN,
		);
		expect(badConfigMd).toContain('**Status**: **Not Executable**');
		expect(badConfigMd).toContain('> [!danger] ERROR: `ERROR_INVALID_CONFIG`');
		expect(badConfigMd).toContain('Mars/Phobos');
		expect(badConfigMd).toContain('Invalid reference timestamp');
		expect(badConfigMd).toContain(
			'resolved against fallback epoch `0` because `referenceTimeMs` is invalid',
		);
		// Best-effort AST still rendered with fallback UTC config
		expect(badConfigMd).toContain('### Plain-English Logic Breakdown');
		expect(badConfigMd).toContain('```mermaid');
	});

	it('escapes pipes, quotes, backticks, and angle brackets in Mermaid labels and Markdown tables while keeping parentheses and brackets readable', () => {
		const cfg = makeConfig();
		const md = explainQuery(
			'file:"a|b<c>`d`[e]" tag:"x`y" blocks:"^id`1" ["prop`key" != "val"] [status: (/foo|bar/ OR "x|y")]',
			cfg,
			REF_TIME_MS,
		);

		expect(md).toContain('&quot;');
		expect(md).toContain('&lt;');
		expect(md).toContain('&gt;');
		expect(md).toContain('&#96;');
		expect(md).toContain('\\|');
		expect(md).toContain('``#x`y``');
		expect(md).toContain('``^id`1``');
		expect(md).toContain('``prop`key``');
		expect(md).not.toContain('&#40;');
		expect(md).not.toContain('&#91;');
	});
});
