import { describe, expect, it } from 'vitest';
import {
	compileQuery,
	evaluateVault,
	initEngineConfig,
	normalizeObsidianMetadata,
	oracleEvaluateVault,
	type NormalizedDocument,
} from '../../src/core/search';

const REF_MS = Date.parse('2026-10-22T15:30:00.000Z');

interface GraphNoteFixture {
	readonly path: string;
	readonly tags?: readonly string[];
	readonly frontmatter?: Record<string, unknown>;
	readonly upLinks?: readonly string[];
	readonly relatedLinks?: readonly string[];
	readonly proseLinks?: readonly string[];
	readonly embeds?: readonly string[];
	readonly inlineProps?: ReadonlyArray<{ key: string; value: unknown }>;
}

function buildGraphVault(fixtures: readonly GraphNoteFixture[]) {
	const cfgRes = initEngineConfig({
		timeZone: 'UTC',
		propertyTypes: {
			priority: 'number',
			due: 'date',
			done: 'checkbox',
		},
	});
	if (!cfgRes.ok) throw new Error('Expected valid config');
	const config = cfgRes.config;

	const pathByBasename = new Map<string, string>();
	const allPaths = new Set<string>();
	for (const f of fixtures) {
		allPaths.add(f.path);
		const slash = f.path.lastIndexOf('/');
		const name = slash === -1 ? f.path : f.path.slice(slash + 1);
		const base = name.replace(/\.md$/i, '');
		pathByBasename.set(base, f.path);
		pathByBasename.set(f.path, f.path);
	}

	const resolveLinkPath = (rawTarget: string): string | null =>
		pathByBasename.get(rawTarget) ?? (allPaths.has(rawTarget) ? rawTarget : null);

	const docs: NormalizedDocument[] = fixtures.map((f) => {
		const slash = f.path.lastIndexOf('/');
		const name = slash === -1 ? f.path : f.path.slice(slash + 1);
		const basename = name.replace(/\.md$/i, '');
		const parentPath = slash === -1 ? '/' : f.path.slice(0, slash);

		const fm: Record<string, unknown> = { ...(f.frontmatter ?? {}) };
		const fmLinks: Array<{ link: string; key: string }> = [];
		if (f.upLinks && f.upLinks.length > 0) {
			fm.up = f.upLinks.map((t) => `[[${t}]]`);
			f.upLinks.forEach((t, idx) => fmLinks.push({ link: t, key: `up.${idx}` }));
		}
		if (f.relatedLinks && f.relatedLinks.length > 0) {
			fm.related = f.relatedLinks.map((t) => `[[${t}]]`);
			f.relatedLinks.forEach((t, idx) => fmLinks.push({ link: t, key: `related.${idx}` }));
		}
		if (f.tags && f.tags.length > 0) {
			fm.tags = [...f.tags];
		}

		return normalizeObsidianMetadata(
			{
				path: f.path,
				name,
				basename,
				extension: 'md',
				parent: { path: parentPath },
				stat: { ctime: REF_MS, mtime: REF_MS, size: 100 },
			},
			{
				frontmatter: fm,
				frontmatterLinks: fmLinks,
				links: (f.proseLinks ?? []).map((t) => ({ link: t })),
				embeds: (f.embeds ?? []).map((t) => ({ link: t })),
			},
			config,
			(f.inlineProps ?? []).map((p) => ({
				key: p.key,
				value: p.value,
				line: 1,
				position: null,
			})),
			resolveLinkPath,
		);
	});

	return { config, docs };
}

function runBothEvaluators(
	docs: readonly NormalizedDocument[],
	query: string,
	config: ReturnType<typeof buildGraphVault>['config'],
	hostDoc?: NormalizedDocument | null,
	priorQueryDocs?: ReadonlyMap<string, readonly NormalizedDocument[]>,
): string[] {
	const compiled = compileQuery(
		query,
		config,
		REF_MS,
		hostDoc,
		priorQueryDocs ? new Set(priorQueryDocs.keys()) : undefined,
	);
	if (!compiled.executable || !compiled.prepared) {
		throw new Error(
			`Expected executable query "${query}", got diagnostics: ${JSON.stringify(compiled.diagnostics)}`,
		);
	}
	const actual = evaluateVault(docs, compiled.prepared, priorQueryDocs).matches.map(
		(d) => d.file.path,
	);
	const expected = oracleEvaluateVault(docs, compiled.prepared, priorQueryDocs).matches.map(
		(d) => d.file.path,
	);
	expect(actual).toEqual(expected);
	return actual;
}

describe('Phase 3 graph evaluation engine & cross-query @query.* resolution', () => {
	it('evaluates outgoing and incoming property-attributed links across 1-hop, bounded M..N, unbounded *, and reflexive 0..* quantifiers', () => {
		const { config, docs } = buildGraphVault([
			{ path: 'Goals/Vision.md', tags: ['vision'] },
			{ path: 'Goals/Q4.md', tags: ['goal'], upLinks: ['Vision'] },
			{
				path: 'Projects/Atlas.md',
				tags: ['project'],
				upLinks: ['Q4'],
				relatedLinks: ['Vision'],
			},
			{
				path: 'Tasks/BuildIndex.md',
				tags: ['task'],
				inlineProps: [{ key: 'up', value: '[[Atlas]]' }],
				proseLinks: ['Vision'],
			},
			{ path: 'Tasks/WriteDocs.md', tags: ['task'], upLinks: ['BuildIndex'] },
		]);

		const q4Doc = docs.find((d) => d.file.path === 'Goals/Q4.md')!;

		// 1-hop outgoing `up` from candidate to `#goal`: only Atlas has `up -> Q4`
		// (BuildIndex has prose link to Vision, NOT `up` link to Q4)
		expect(runBothEvaluators(docs, '[up -> { #goal }]', config)).toEqual(['Projects/Atlas.md']);

		// Case-insensitive property attribution (`UP`) across 1..2 hops to `#vision`:
		// Q4 (1 hop) and Atlas (2 hops via Q4; relatedLinks to Vision is ignored because property is `related`, not `up`!)
		expect(runBothEvaluators(docs, '[UP ->1..2 { #vision }]', config)).toEqual([
			'Goals/Q4.md',
			'Projects/Atlas.md',
		]);

		// Exact 3 hops `[up ->3..3 { #vision }]`: BuildIndex -> Atlas -> Q4 -> Vision
		expect(runBothEvaluators(docs, '[up ->3..3 { #vision }]', config)).toEqual([
			'Tasks/BuildIndex.md',
		]);

		// Unbounded incoming descendants of `@this` (Q4): `[up ->* @this]` matches Atlas, BuildIndex, WriteDocs
		expect(runBothEvaluators(docs, '[up ->* @this]', config, q4Doc)).toEqual([
			'Projects/Atlas.md',
			'Tasks/BuildIndex.md',
			'Tasks/WriteDocs.md',
		]);

		// Reflexive `0..*` includes Q4 itself!
		expect(runBothEvaluators(docs, '[up ->0..* @this]', config, q4Doc)).toEqual([
			'Goals/Q4.md',
			'Projects/Atlas.md',
			'Tasks/BuildIndex.md',
			'Tasks/WriteDocs.md',
		]);

		// Incoming `<-` from descendants (`[up <-* { file:WriteDocs }]` = ancestors of WriteDocs):
		expect(runBothEvaluators(docs, '[up <-* { file:WriteDocs }]', config)).toEqual([
			'Goals/Vision.md',
			'Goals/Q4.md',
			'Projects/Atlas.md',
			'Tasks/BuildIndex.md',
		]);
	});

	it('terminates safely on cyclic graphs, self-links, and chord shortcuts while preserving exact simple-path M..N semantics', () => {
		const { config, docs } = buildGraphVault([
			// Mutual 2-cycle A <-> B plus self-TOC link `#Overview` on A, and C -> A
			{ path: 'CycleA.md', tags: ['target'], proseLinks: ['CycleB', '#Overview'] },
			{ path: 'CycleB.md', proseLinks: ['CycleA'] },
			{ path: 'EntryC.md', proseLinks: ['CycleA'] },
			// Chord graph: Start -> Mid1 -> Mid2 -> End, plus direct shortcut Start -> End (1 hop)
			{ path: 'Start.md', proseLinks: ['Mid1', 'End'] },
			{ path: 'Mid1.md', proseLinks: ['Mid2'] },
			{ path: 'Mid2.md', proseLinks: ['End'] },
			{ path: 'End.md', tags: ['endpoint'] },
		]);

		// CycleA has `#Overview` (self-link) and CycleA -> CycleB -> CycleA (non-simple cycle):
		// Neither makes CycleA match 1..* to `#target` (`CycleA` only matches under `0..*`)!
		expect(runBothEvaluators(docs, 'links ->* { #target }', config)).toEqual([
			'CycleB.md',
			'EntryC.md',
		]);
		expect(runBothEvaluators(docs, 'links ->0..* { #target }', config)).toEqual([
			'CycleA.md',
			'CycleB.md',
			'EntryC.md',
		]);

		// Start has a 1-hop shortcut to End AND a 3-hop simple path Start -> Mid1 -> Mid2 -> End:
		// Exact `3..3` MUST still match `Start.md`!
		expect(runBothEvaluators(docs, 'links ->3..3 { #endpoint }', config)).toEqual(['Start.md']);
	});

	it('evaluates embeds, backlinks, 1-hop colon shorthand, @query.<name> node sets, and @query.<name>.<field> scalar projections', () => {
		const { config, docs } = buildGraphVault([
			{
				path: 'Projects/Apollo.md',
				tags: ['project'],
				frontmatter: { priority: 2, due: '2026-11-01', focus: 'lunar' },
				embeds: ['SpecDoc'],
			},
			{
				path: 'Docs/SpecDoc.md',
				tags: ['spec'],
				frontmatter: { priority: 5 },
			},
			{
				path: 'Tasks/Task1.md',
				tags: ['task'],
				frontmatter: { priority: 3, due: '2026-11-10', category: 'lunar' },
				proseLinks: ['Apollo'],
			},
			{
				path: 'Tasks/Task2.md',
				tags: ['task'],
				frontmatter: { priority: 1, due: '2026-10-01', category: 'mars' },
			},
		]);

		// Colon 1-hop shorthand on `embeds` and `backlinks`
		expect(runBothEvaluators(docs, 'embeds: { #spec }', config)).toEqual([
			'Projects/Apollo.md',
		]);
		expect(runBothEvaluators(docs, 'backlinks: { #task }', config)).toEqual([
			'Projects/Apollo.md',
		]);

		// Wave 0 -> Wave 1 `@query.<name>` node set + scalar projections
		const apolloOnly = docs.filter((d) => d.file.path === 'Projects/Apollo.md');
		const prior = new Map<string, readonly NormalizedDocument[]>([
			['active_projects', apolloOnly],
			['empty_query', []],
		]);

		expect(
			runBothEvaluators(docs, 'links: @query.active_projects', config, undefined, prior),
		).toEqual(['Tasks/Task1.md']);

		expect(
			runBothEvaluators(
				docs,
				'#task AND [priority: > @query.active_projects.properties.priority] AND [due: >= @query.active_projects.properties.due] AND [category: @query.active_projects.properties.focus]',
				config,
				undefined,
				prior,
			),
		).toEqual(['Tasks/Task1.md']);

		// Empty `@query.empty_query` evaluates to false cleanly (negated evaluates to true!)
		expect(
			runBothEvaluators(
				docs,
				'[priority: >= @query.empty_query.properties.priority]',
				config,
				undefined,
				prior,
			),
		).toEqual([]);
		expect(
			runBothEvaluators(
				docs,
				'#task AND NOT links -> @query.empty_query',
				config,
				undefined,
				prior,
			),
		).toEqual(['Tasks/Task1.md', 'Tasks/Task2.md']);
	});
});
