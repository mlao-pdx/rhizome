import { describe, expect, it } from 'vitest';
import {
	analyzeQueryExplain,
	buildRegex101Url,
	createNormalizedFileInfo,
	describeScopeSemantics,
	formatDateIntervalWindow,
	formatSourceCaretSnippet,
	initEngineConfig,
	resolvePropertyTypeWithOrigin,
	type EngineConfig,
	type ResolvedEngineConfig,
} from '../../src/core/search';
import {
	buildConceptsReferenceCallout,
	buildQueryExplainCallouts,
	escapeExplainProse,
	prefixCalloutBodyLines,
	wrapCodeFenceLines,
} from '../../src/core/templates';

const REF_TIME_MS = Date.parse('2026-10-22T15:30:00.000Z');
const SPAN = Object.freeze({ startOffset: 0, endOffset: 1, startLine: 1, startColumn: 1 });

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
		},
		...overrides,
	});
	if (!res.ok) throw new Error('Expected valid config');
	return res.config;
}

describe('explain-helpers', () => {
	it('resolves property type and origin across virtual, configured, and default fallback keys', () => {
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

	it('describes the backlinks scope semantics', () => {
		const semantics = describeScopeSemantics('backlinks');
		expect(semantics.friendlyTitle).toBe('Backlink filter');
		expect(semantics.targetsDescription).toContain('backlinks[].path');
		expect(semantics.matchRuleDescription).toBe('case-insensitive substring match');
		expect(semantics.formatPlainStringMatch('Source')).toBe(
			'contains `Source` (case-insensitive)',
		);
	});
});

describe('analyzeQueryExplain & buildQueryExplainCallouts', () => {
	it('produces footnote-free MATCH_ALL bullets and omits Concepts Reference when 0 concepts are triggered', () => {
		const cfg = makeConfig({ propertyTypes: {} });
		const res = analyzeQueryExplain('   ', cfg, REF_TIME_MS);

		expect(res.executable).toBe(true);
		expect(res.nowLocalIso).toBe('2026-10-22T11:30:00-04:00');
		expect(res.todayLocalWindow).toBe('[2026-10-22T00:00:00-04:00, 2026-10-23T00:00:00-04:00)');
		expect(res.astBullets.join('\n')).toContain(
			'- _(empty query)_\n  Matches every Markdown note in the vault (`MATCH_ALL`).',
		);
		expect(res.concepts.size).toBe(0);
		expect(buildConceptsReferenceCallout(res.concepts, REF_TIME_MS, cfg.timeZone)).toBe('');

		const existsEmpty = analyzeQueryExplain('#work [status] [due:]', cfg, REF_TIME_MS);
		const joined = existsEmpty.astBullets.join('\n');
		expect(joined).toContain('is present on the note (regardless of value).');
		expect(joined).toContain('is present on the note with no value (empty or null).');
		expect(joined).not.toContain('[^');
	});

	it('progressively shrinks query slices, distinguishes implicit vs explicit AND, and embeds inline property type badges without footnotes', () => {
		const cfg = makeConfig();
		const query =
			'folder:projects AND #work/auth tag:(#urgent !#archived) [priority: >= 2] [status: != "done"] !( [done: = true] OR file:"draft" )';
		const res = analyzeQueryExplain(query, cfg, REF_TIME_MS);
		const md = res.astBullets.join('\n');

		expect(res.executable).toBe(true);
		expect(res.hintCount).toBe(1);
		expect(md).toContain('Matches notes where *all* of the following hold (`AND`):');
		expect(md).toContain(
			'- `folder:projects`\n    At least one `path` (alias for `path:`) contains `projects` (case-insensitive).',
		);
		expect(md).toContain(
			'- `#work/auth`\n    At least one `tag` is `#work/auth` or a nested tag under `#work/auth/...` (case-insensitive).',
		);
		expect(md).toContain(
			'  - `(#urgent !#archived)`\n      *All* of the following on that same tag (implicit `AND`):',
		);
		expect(md).toContain(
			'- `[priority: >= 2]`\n    `priority` *(`number` in `types.json`)* is at least `2`.',
		);
		expect(md).toContain(
			'- `[status: != "done"]`\n    `status` *(`text` in `types.json`)* does not equal `"done"` (case-insensitive). · ℹ️ `HINT_PROP_NEQ_EXISTENCE`',
		);
		expect(md).toContain(
			'- `!( [done: = true] OR file:"draft" )`\n    Excludes notes matching (`!` / `NOT`):',
		);
		expect(md).not.toContain('[^');
	});

	it('resolves temporal windows in the configured timezone, triggers temporal-intervals concept once, and links regexes to regex101', () => {
		const cfg = makeConfig({ timeZone: 'Asia/Tokyo' });
		const temporalRes = analyzeQueryExplain(
			'[due: = @today] [updated: >= 2026-01-01..2026-06-30] [file.modified: < @thisweek]',
			cfg,
			REF_TIME_MS,
		);
		expect(temporalRes.executable).toBe(true);
		expect(temporalRes.concepts.has('temporal-intervals')).toBe(true);
		const conceptsCallout = buildConceptsReferenceCallout(
			temporalRes.concepts,
			REF_TIME_MS,
			cfg.timeZone,
		);
		expect(conceptsCallout).toContain('> [!abstract]- Concepts Reference');
		expect(conceptsCallout).toContain('title [Half-Open) Interval Comparison Matches');

		const regexRes = analyzeQueryExplain(
			'file:/^roadmap/i path:/^projects\\// [priority:/^10$/] [status:/todo|doing/i]',
			makeConfig(),
			REF_TIME_MS,
		);
		const regexMd = regexRes.astBullets.join('\n');
		expect(regexMd).toContain(
			`[
			\`/^roadmap/i\`
		]`
				.replace(/\s+/g, '')
				.replace('][', ']('),
		);
		expect(regexMd).toContain(buildRegex101Url('^roadmap', 'i'));
		expect(regexMd).toContain(buildRegex101Url('^10$', ''));
	});

	it('handles semantic errors, syntax errors, invalid EngineConfig, system scope hints, and @this / @query graph filters', () => {
		const cfg = makeConfig();
		const semErr = analyzeQueryExplain(
			'bogus:value [priority: = "nan"] [done: > true] [unconfigured_prop: = "ok"]',
			cfg,
			REF_TIME_MS,
		);
		expect(semErr.executable).toBe(false);
		expect(semErr.errorCount).toBe(3);
		expect(semErr.astBullets.join('\n')).toContain('*(untyped → `text`)*');

		const synErr = analyzeQueryExplain('tag:(#a OR', cfg, REF_TIME_MS);
		expect(synErr.executable).toBe(false);
		expect(synErr.ast).toBeNull();
		expect(synErr.diagnostics[0]?.code).toBe('SYNTAX_ERROR');

		const badCfg = analyzeQueryExplain(
			'#work [due: = @today]',
			{ timeZone: 'Mars/Phobos', propertyTypes: { due: 'date' } },
			Number.NaN,
		);
		expect(badCfg.executable).toBe(false);
		expect(badCfg.astBullets.join('\n')).toContain('resolved against fallback epoch `0`');

		for (const [key, scope] of [
			['tags', 'tag'],
			['aliases', 'aliases'],
			['cssclasses', 'cssclasses'],
		] as const) {
			const sys = analyzeQueryExplain(`[${key}: work]`, cfg, REF_TIME_MS);
			expect(sys.astBullets.join('\n')).toContain(`(use \`${scope}:\` instead)`);
		}

		const hostDoc = {
			normalizationFingerprint: cfg.normalizationFingerprint,
			file: createNormalizedFileInfo({
				path: 'Projects/Host.md',
				name: 'Host.md',
				basename: 'Host',
				extension: 'md',
				parent: 'Projects',
				created: '2026-10-20T09:00',
				modified: '2026-10-22T15:30',
				size: 512,
			}),
			aliases: [],
			aliasLocations: [],
			tags: ['alpha', 'beta'],
			tagLocations: [],
			cssclasses: [],
			headings: [],
			links: [],
			embeds: [],
			blocks: [],
			tasks: [],
			propertyOccurrences: [],
			propertyKeys: ['priority'],
			properties: Object.assign(Object.create(null) as Record<string, unknown>, {
				priority: [
					{
						key: 'priority',
						raw: '3',
						value: 3,
						type: 'number',
						source: 'frontmatter',
						line: 1,
					},
				],
			}),
			propertyLocations: [],
			diagnostics: [],
		};
		const hostRes = analyzeQueryExplain(
			'tag:@this.tags AND [status: = @this.properties.missing]',
			cfg,
			REF_TIME_MS,
			{ hostDoc },
		);
		expect(hostRes.warningCount).toBe(1);
		expect(hostRes.astBullets.join('\n')).toContain('(from `@this.tags`)');

		const graphRes = analyzeQueryExplain(
			'links ->* { #project AND [priority: >= @query.baselines.properties.priority] } AND [up <-0..3 @query.goals] AND [parent -> @this]',
			cfg,
			REF_TIME_MS,
			{ hostDoc: null, knownQueryNames: new Set(['baselines', 'goals']) },
		);
		expect(graphRes.concepts.has('graph-traversal')).toBe(true);
		expect(graphRes.concepts.has('cross-query-waves')).toBe(true);
		expect(graphRes.queryDependencies).toEqual(['baselines', 'goals']);
	});

	it('orders Query Explain Callouts with errors first, static waves second, and lazy queries third, and flags template-folder exclusions & coercion warnings', () => {
		const cfg = makeConfig();
		const queries = [
			{
				name: 'wave2',
				query: 'links -> @query.wave1',
				cutoff: 5_000,
				explicitCutoff: false,
				headerSpan: SPAN,
				bodySpan: SPAN,
				fullSpan: SPAN,
				file: null,
			},
			{
				name: 'lazy_items',
				query: 'tag:@this.tags',
				cutoff: 5_000,
				explicitCutoff: false,
				headerSpan: SPAN,
				bodySpan: SPAN,
				fullSpan: SPAN,
				file: null,
			},
			{
				name: 'broken',
				query: '[unclosed',
				cutoff: 5_000,
				explicitCutoff: false,
				headerSpan: SPAN,
				bodySpan: SPAN,
				fullSpan: SPAN,
				file: null,
			},
			{
				name: 'downstream_of_broken',
				query: 'links -> @query.broken',
				cutoff: 5_000,
				explicitCutoff: false,
				headerSpan: SPAN,
				bodySpan: SPAN,
				fullSpan: SPAN,
				file: null,
			},
			{
				name: 'wave1',
				query: 'path:"◊Rhizome/templates" [priority: >= 1]',
				cutoff: 100,
				explicitCutoff: true,
				headerSpan: SPAN,
				bodySpan: SPAN,
				fullSpan: SPAN,
				file: '◊Rhizome/partials/q.md',
			},
		];

		const res = buildQueryExplainCallouts({
			queries,
			resolvedConfig: cfg,
			referenceTimeMs: REF_TIME_MS,
			isNewNoteMode: true,
			metricsByName: new Map([
				[
					'wave1',
					{
						matchedCount: 250,
						sampledCount: 100,
						baseStrideCount: 100,
						referentialTopUpCount: 0,
						downsampled: false,
						effectiveCutoff: 100,
						cutoffBound: true,
						exceedsProductionCutoff: true,
					},
				],
				[
					'wave2',
					{
						matchedCount: 5,
						sampledCount: 5,
						baseStrideCount: 5,
						referentialTopUpCount: 0,
						downsampled: false,
						effectiveCutoff: 5_000,
						cutoffBound: false,
						exceedsProductionCutoff: false,
					},
				],
			]),
			coercionDocuments: [
				{
					file: { path: 'Notes/BadPrio.md' },
					diagnostics: [
						{
							code: 'DOC_INVALID_PROPERTY_VALUE',
							filePath: 'Notes/BadPrio.md',
							fileBasename: 'BadPrio',
							propertyKey: 'priority',
							rawKey: 'priority',
							expectedType: 'number',
							rawValue: 'high',
							source: 'frontmatter',
							line: null,
							occurrenceIndex: 0,
							valueIndex: 0,
							issue: 'Expected number',
							hint: null,
						},
					],
				},
			],
		});

		expect(res.callouts).toHaveLength(5);
		expect(res.callouts[0]).toContain('> [!danger]+ Query `broken` — 1 error (Not executable)');
		// Transitively blocked query receives explicit upstream blocker diagnostic (never 0 diagnostics)
		expect(res.callouts[1]).toContain(
			'> [!danger]+ Query `downstream_of_broken` — 1 error (Not executable)',
		);
		expect(res.callouts[1]).toContain("upstream dependency '@query.broken'");
		expect(res.callouts[2]).toContain('> [!warning]- Query `wave1`');
		expect(res.callouts[2]).toContain('Pass 1.5 · Wave 1');
		expect(res.callouts[2]).toContain('Template-Folder Index Exclusion');
		expect(res.callouts[2]).toContain('Vault Property Coercion');
		expect(res.callouts[2]).toContain('[[Notes/BadPrio.md]]');
		expect(res.callouts[3]).toContain('> [!check]- Query `wave2` — all 5 records');
		expect(res.callouts[3]).toContain('Pass 1.5 · Wave 2');
		expect(res.callouts[4]).toContain(
			'> [!info]- Query `lazy_items` — Skipped (branch not entered in sample)',
		);

		// Verify newline-safe callout prefixing, image/link escaping, and dynamic fence width
		expect(prefixCalloutBodyLines(['line1\n![evil](https://x.test)'])).toEqual([
			'> line1',
			'> ![evil](https://x.test)',
		]);
		expect(escapeExplainProse('Bad ![img](https://evil.example) and [lnk](https://x)')).toBe(
			'Bad \\![img]\\(https://evil.example) and [lnk]\\(https://x)',
		);
		expect(wrapCodeFenceLines('1 | ```triple```', 'text', '  ')[0]).toBe('  ````text');
	});
});
