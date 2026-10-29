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

	it('renders 1-based line snippets enclosing the pertinent span with ‼️...‼️ markers', () => {
		const snippet = formatSourceCaretSnippet('#work [priority = "bad"]', {
			startOffset: 6,
			endOffset: 24,
			startLine: 1,
			startColumn: 7,
		});
		expect(snippet).toBe('1 | #work ‼️[priority = "bad"]‼️');
	});
});

describe('explainQuery', () => {
	it('renders Header Context, Logic Breakdown, Diagnostics, and Concept Reference for an empty query', () => {
		const cfg = makeConfig({ propertyTypes: {} });
		const md = explainQuery('   ', cfg, REF_TIME_MS);

		expect(md).toContain('# Query Explain Plan');
		expect(md).toContain('- **Query**: _(empty query)_');
		expect(md).toContain('- **Status**: *Executable* with 0 errors, 0 warnings, 0 hints.');
		expect(md).toContain('  - `@now`: `2026-10-22T11:30:00-04:00` (`1792683000000` ms UTC)');
		expect(md).toContain(
			'  - `@today`: `[2026-10-22T00:00:00-04:00, 2026-10-23T00:00:00-04:00)`[^1]',
		);
		expect(md).toContain('  - **Timezone**: `America/New_York`[^2]');
		expect(md).toContain('## Logic Breakdown');
		expect(md).toContain(
			'- _(empty query)_\n  Matches every Markdown note in the vault (`MATCH_ALL`).',
		);
		expect(md).toContain('## Diagnostics');
		expect(md).toContain('> [!tip] No issues found');
		expect(md).toContain('## Concept Reference');
		expect(md).toContain('[^1]: **Half-Open Temporal Intervals');
		expect(md).toContain(
			'```mermaid\ngantt\n    title [Half-Open) Interval Comparison Matches',
		);
		expect(md).toContain('[^2]: **Timezone Resolution**');
		expect(md).not.toContain('flowchart TD');
		expect(md).not.toContain('## Reference — Execution Context & Resolution');

		const customHeadingMd = explainQuery(
			'#work [status] [due:]',
			cfg,
			REF_TIME_MS,
			'Active Projects — Explain Plan',
		);
		expect(customHeadingMd.startsWith('# Active Projects — Explain Plan\n')).toBe(true);
		expect(customHeadingMd).toContain('is present on the note (regardless of value).');
		expect(customHeadingMd).toContain('is present on the note with no value (empty or null).');
	});

	it('progressively shrinks query slices, distinguishes implicit vs explicit AND, uses italic emphasis, and emits numbered footnotes', () => {
		const cfg = makeConfig();
		const query =
			'folder:projects AND #work/auth tag:(#urgent !#archived) [priority: >= 2] [status: != "done"] !( [done: = true] OR "draft" )';
		const md = explainQuery(query, cfg, REF_TIME_MS);

		expect(md).toContain(`- **Query**: \`${query}\``);
		expect(md).toContain('- **Status**: *Executable* with 0 errors, 0 warnings, 2 hints.');
		expect(md).toContain(`- \`${query}\``);
		expect(md).toContain('Matches notes where *all* of the following hold (`AND`):');
		// Scope alias + numbered footnote
		expect(md).toContain(
			'- `folder:projects`\n    At least one `path`[^3] (alias for `path:`) contains `projects` (case-insensitive).',
		);
		// Tag shorthand + numbered footnote
		expect(md).toContain(
			'- `#work/auth`\n    At least one `tag`[^4] is `#work/auth` or a nested tag under `#work/auth/...` (case-insensitive).',
		);
		// Compound ValueExprAST with progressive shrinking and implicit AND (reusing [^4] for tag)
		expect(md).toContain('- `tag:(#urgent !#archived)`\n    At least one `tag`[^4] satisfies:');
		expect(md).toContain(
			'  - `(#urgent !#archived)`\n      *All* of the following on that same tag (implicit `AND`):',
		);
		expect(md).toContain(
			'    - `#urgent`\n        Is `#urgent` or a nested tag under `#urgent/...` (case-insensitive).',
		);
		expect(md).toContain('    - `!#archived`\n        Does *not* match (`!` / `NOT`):');
		expect(md).toContain(
			'      - `#archived`\n          Is `#archived` or a nested tag under `#archived/...` (case-insensitive).',
		);
		// Property operators without repeating operator symbols (`>=`, `!=`)
		expect(md).toContain('- `[priority: >= 2]`\n    `priority`[^5] is at least `2`.');
		expect(md).toContain(
			'- `[status: != "done"]`\n    `status`[^6] does not equal `"done"` (case-insensitive). · [^7]',
		);
		expect(md).not.toContain('(`>= 2`)');
		expect(md).not.toContain('(`!=`,');
		// Note-level NOT and OR shrinking
		expect(md).toContain(
			'- `!( [done: = true] OR "draft" )`\n    Excludes notes matching (`!` / `NOT`):',
		);
		expect(md).toContain(
			'  - `( [done: = true] OR "draft" )`\n      Matches notes where *any* of the following hold (`OR`):',
		);
		expect(md).toContain('    - `[done: = true]`\n        `done`[^8] is `true`.');
		expect(md).toContain(
			'    - `"draft"`\n        Note metadata ([^9]) contains `draft` (case-insensitive). · [^10]',
		);

		// Diagnostics section immediately follows Logic Breakdown
		const logicIdx = md.indexOf('## Logic Breakdown');
		const diagIdx = md.indexOf('## Diagnostics');
		const refIdx = md.indexOf('## Concept Reference');
		expect(logicIdx).toBeGreaterThan(-1);
		expect(diagIdx).toBeGreaterThan(logicIdx);
		expect(refIdx).toBeGreaterThan(diagIdx);

		expect(md).toContain('> [!info] Hint 1: `HINT_PROP_NEQ_EXISTENCE`');
		expect(md).toContain('‼️[status: != "done"]‼️');
		expect(md).toContain('> [!info] Hint 2: `HINT_BARE_TEXT_NO_BODY`');
		expect(md).toContain('‼️"draft"‼️');

		// Concept Reference places the Mermaid diagram first, followed by numbered footnote definitions
		const refSection = md.slice(refIdx);
		const mermaidIdx = refSection.indexOf('```mermaid\ngantt');
		const firstFootnoteIdx = refSection.indexOf('[^1]: ');
		expect(mermaidIdx).toBeGreaterThan(-1);
		expect(firstFootnoteIdx).toBeGreaterThan(mermaidIdx);
		for (let i = 1; i <= 10; i++) {
			expect(refSection).toMatch(new RegExp(`^\\[\\^${i}\\]: `, 'm'));
		}
		expect(refSection).toContain('title [Half-Open) Interval Comparison Matches');
		expect(refSection).toContain('[2 <= Criteria < 5)');
	});

	it('resolves temporal windows in the configured timezone and links numbered footnotes', () => {
		const cfg = makeConfig({ timeZone: 'Asia/Tokyo' });
		const md = explainQuery(
			'[due: = @today] [updated: >= 2026-01-01..2026-06-30] [file.modified: < @thisweek]',
			cfg,
			REF_TIME_MS,
		);

		expect(md).toContain('- **Status**: *Executable* with 0 errors, 0 warnings, 0 hints.');
		expect(md).toContain('  - **Timezone**: `Asia/Tokyo`[^2]');
		expect(md).toContain('Matches notes where *all* of the following hold (implicit `AND`):');
		expect(md).toContain('`due`[^3] falls within');
		expect(md).toContain('`updated`[^4] is on or after');
		expect(md).toContain('`file.modified`[^5] is before');
		expect(md).toContain('[^3]: **Configured `date` Property**');
		expect(md).toContain('[^4]: **Configured `datetime` Property**');
		expect(md).toContain('[^5]: **Predetermined Property (`file.modified`)**');
	});

	it('renders regex values as direct links to regex101 with flavor=javascript, regex, and flags preselected', () => {
		const cfg = makeConfig();
		const md = explainQuery(
			'/^roadmap/i path:/^projects\\// [priority:/^10$/] [status:/todo|doing/i]',
			cfg,
			REF_TIME_MS,
		);

		const roadmapUrl = buildRegex101Url('^roadmap', 'i');
		const projectsUrl = buildRegex101Url('^projects\\/', '');
		const prioUrl = buildRegex101Url('^10$', '');
		const statusUrl = buildRegex101Url('todo|doing', 'i');

		expect(md).toContain(`[\`/^roadmap/i\`](${roadmapUrl})[^4]`);
		expect(md).toContain(`[\`/^projects\\//\`](${projectsUrl})[^4]`);
		expect(md).toContain(
			`\`priority\`[^7] has raw text matching [\`/^10$/\`](${prioUrl})[^4].`,
		);
		expect(md).toContain(`\`status\`[^8] matches [\`/todo|doing/i\`](${statusUrl})[^4].`);
		expect(md).toContain('[^4]: **Regular Expression Evaluation**');
	});

	it('preserves the best-effort Logic Breakdown and attaches numbered diagnostic links on semantic errors', () => {
		const cfg = makeConfig();
		const md = explainQuery(
			'bogus:value [priority: = "nan"] [done: > true] [unconfigured_prop: = "ok"]',
			cfg,
			REF_TIME_MS,
		);

		expect(md).toContain('- **Status**: *Not Executable* with 3 errors, 0 warnings, 0 hints.');
		expect(md).toContain('## Logic Breakdown');
		expect(md).toContain('- `bogus:value`\n    ❌ Unknown search scope `bogus:`. · [^3]');
		expect(md).toContain(
			'- `[priority: = "nan"]`\n    ❌ `priority`[^4] ❌ `"nan"` (expected an unquoted number such as `42` or `-3.5`). · [^5]',
		);
		expect(md).toContain(
			'- `[done: > true]`\n    ❌ `done`[^6] ❌ `true` (ordering comparison is not supported on `checkbox` properties). · [^7]',
		);
		expect(md).toContain(
			'- `[unconfigured_prop: = "ok"]`\n    `unconfigured_prop`[^8] equals `"ok"` (case-insensitive).',
		);
		expect(md).toContain('[^8]: **Untyped Property (Default `text`)**');
		expect(md).toContain('> [!danger] Error 1: `ERROR_UNKNOWN_SCOPE`');
		expect(md).toContain('‼️bogus:value‼️');
		expect(md).toContain('> [!danger] Error 2: `ERROR_TYPE_MISMATCH`');
		expect(md).toContain('‼️[priority: = "nan"]‼️');
		expect(md).toContain('> [!danger] Error 3: `ERROR_INVALID_OPERATOR_FOR_TYPE`');
		expect(md).toContain('‼️[done: > true]‼️');
	});

	it('handles syntax errors, invalid EngineConfig, and invalid referenceTimeMs gracefully', () => {
		const badSyntaxMd = explainQuery('tag:(#a OR', makeConfig(), REF_TIME_MS);
		expect(badSyntaxMd).toContain('- **Query**: `tag:(#a OR`');
		expect(badSyntaxMd).toContain('- **Status**: *Not Executable* with 1 error');
		expect(badSyntaxMd).toContain(
			'This query could not be parsed into an execution tree because of a syntax or query-length error.',
		);
		expect(badSyntaxMd).toContain('> [!danger] Error 1: `SYNTAX_ERROR`');

		const badConfigMd = explainQuery(
			'#work [priority: (1 OR 2)] [due: = @today]',
			{
				timeZone: 'Mars/Phobos',
				propertyTypes: { priority: 'number', due: 'date', bad: 'invalid_type' as never },
			},
			Number.NaN,
		);
		expect(badConfigMd).toContain('- **Status**: *Not Executable* with 3 errors');
		expect(badConfigMd).toContain('> [!danger] Error 1: `ERROR_INVALID_CONFIG`');
		expect(badConfigMd).toContain('Mars/Phobos');
		expect(badConfigMd).toContain('Invalid `referenceTimeMs`');
		expect(badConfigMd).toContain(
			'resolved against fallback epoch `0` because `referenceTimeMs` is invalid',
		);
		expect(badConfigMd).toContain('## Logic Breakdown');
	});

	it('safely fences backticks and special characters in inline code and regex links', () => {
		const cfg = makeConfig();
		const md = explainQuery(
			'file:"a|b<c>`d`[e]" tag:"x`y" blocks:"^id`1" ["prop`key": != "val"] [status: (/foo|bar/ OR "x|y")]',
			cfg,
			REF_TIME_MS,
		);

		expect(md).toContain('``#x`y``');
		expect(md).toContain('``^id`1``');
		expect(md).toContain('``prop`key``');
		expect(md).toContain(
			'[`/foo|bar/`](https://regex101.com/?flavor=javascript&regex=foo%7Cbar&flags=)',
		);
	});
});
