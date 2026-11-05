import { describe, expect, it } from 'vitest';
import {
	compileQuery,
	evaluateDoc,
	evaluateVault,
	initEngineConfig,
	normalizeObsidianMetadata,
	oracleEvaluateDoc,
	oracleEvaluateVault,
	type InlinePropertyInput,
	type NormalizedDocument,
	type ObsidianMetadataCacheInput,
	type PreparedQuery,
	type ResolvedEngineConfig,
} from '../../src/core/search';

const REF_MS = Date.UTC(2026, 9, 22, 15, 0, 0);

function makeConfig(): ResolvedEngineConfig {
	const res = initEngineConfig({
		timeZone: 'UTC',
		propertyTypes: {
			num: 'number',
			flag: 'checkbox',
			day: 'date',
			stamp: 'datetime',
			label: 'text',
			multi: 'multitext',
		},
	});
	if (!res.ok) throw new Error('Invalid test config');
	return res.config;
}

function makeDoc(
	config: ResolvedEngineConfig,
	path: string,
	cache: ObsidianMetadataCacheInput | null = null,
	inlineFields: readonly InlinePropertyInput[] = [],
): NormalizedDocument {
	const slash = path.lastIndexOf('/');
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf('.');
	const basename = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot + 1) : 'md';
	const parentPath = slash >= 0 ? path.slice(0, slash) : '/';
	return normalizeObsidianMetadata(
		{
			path,
			name,
			basename,
			extension,
			parent: { path: parentPath },
			stat: {
				ctime: Date.UTC(2026, 2, 1, 0, 0, 0),
				mtime: Date.UTC(2026, 5, 15, 0, 0, 0),
				size: 4096,
			},
		},
		cache,
		config,
		inlineFields,
	);
}

function prepare(query: string, config: ResolvedEngineConfig): PreparedQuery {
	const compiled = compileQuery(query, config, REF_MS);
	if (!compiled.executable || !compiled.prepared) throw new Error(`Invalid query: ${query}`);
	return compiled.prepared;
}

function assertEval(
	docs: readonly NormalizedDocument[],
	query: string,
	config: ResolvedEngineConfig,
	expectedPaths: readonly string[],
) {
	const beforeJson = JSON.stringify(docs);
	const prepared = prepare(query, config);
	const prodReport = evaluateVault(docs, prepared);
	const oracleReport = oracleEvaluateVault(docs, prepared);

	expect(prodReport.matches.map((d) => d.file.path)).toEqual(expectedPaths);
	expect(oracleReport.matches.map((d) => d.file.path)).toEqual(expectedPaths);
	expect(prodReport.propertyDiagnostics).toEqual(oracleReport.propertyDiagnostics);
	expect(docs.filter((d) => evaluateDoc(d, prepared)).map((d) => d.file.path)).toEqual(
		expectedPaths,
	);
	expect(docs.filter((d) => oracleEvaluateDoc(d, prepared)).map((d) => d.file.path)).toEqual(
		expectedPaths,
	);
	expect(JSON.stringify(docs)).toBe(beforeJson);
	return prodReport;
}

describe('Phase 6 supplemental evaluator unit tests', () => {
	it('evaluates all six comparison operators for number, text, date, and datetime, plus checkbox = and !=', () => {
		const config = makeConfig();
		const fm1 = {
			num: 10,
			label: 'Bravo',
			day: '2026-10-15',
			stamp: '2026-10-15T10:00:00Z',
			flag: true,
		};
		const fm2 = {
			num: 20,
			label: 'charlie',
			day: '2026-10-20',
			stamp: '2026-10-20T10:00:00Z',
			flag: false,
		};
		const docs = [
			makeDoc(config, 'a.md', { frontmatter: fm1 }),
			makeDoc(config, 'b.md', { frontmatter: fm2 }),
		];
		const aQueries =
			'[num:=10];[num:<20];[num:<=10];[label:=bravo];[label:<charlie];[label:<=BRAVO];[day:=2026-10-15];[day:<2026-10-20];[day:<=2026-10-15];[stamp:=2026-10-15];[stamp:<2026-10-20T10:00:00Z];[stamp:<=2026-10-15T10:00:00Z];[flag:=true];[flag:!=false]'.split(
				';',
			);
		const bQueries =
			'[num:!=10];[num:>10];[num:>=20];[label:!=bravo];[label:>bravo];[label:>=CHARLIE];[day:!=2026-10-15];[day:>2026-10-15];[day:>=2026-10-20];[stamp:!=2026-10-15];[stamp:>2026-10-15T10:00:00Z];[stamp:>=2026-10-20T10:00:00Z];[flag:!=true];[flag:=false]'.split(
				';',
			);
		for (const q of aQueries) assertEval(docs, q, config, ['a.md']);
		for (const q of bQueries) assertEval(docs, q, config, ['b.md']);
	});

	it('evaluates the 5 property states: ![prop] (absent), [prop] (present regardless of value), [prop:] / [prop:""] (present with no value), [prop] ![prop:] (present with any value, valid or malformed), and [prop:value]', () => {
		const config = makeConfig();
		const docs = [
			makeDoc(config, 'missing.md'),
			makeDoc(config, 'null.md', { frontmatter: { num: null } }),
			makeDoc(config, 'empty-str.md', { frontmatter: { num: '' } }),
			makeDoc(config, 'empty-list.md', { frontmatter: { num: [] } }),
			makeDoc(config, 'null-and-empty-list.md', { frontmatter: { num: [null, ''] } }),
			makeDoc(config, 'multi-occ-empty.md', { frontmatter: { num: null } }, [
				{ key: 'num', value: '', line: 5 },
			]),
			makeDoc(config, 'multi-occ-one-filled.md', { frontmatter: { num: null } }, [
				{ key: 'num', value: 10, line: 5 },
			]),
			makeDoc(config, 'invalid.md', { frontmatter: { num: 'not-a-number' } }),
			makeDoc(config, 'valid.md', { frontmatter: { num: [null, 'bad', 42] } }),
		];

		// 1. Property not present: ![num]
		assertEval(docs, '![num]', config, ['missing.md']);

		// 2. Property present, regardless of value: [num]
		assertEval(docs, '[num]', config, [
			'null.md',
			'empty-str.md',
			'empty-list.md',
			'null-and-empty-list.md',
			'multi-occ-empty.md',
			'multi-occ-one-filled.md',
			'invalid.md',
			'valid.md',
		]);

		// 3. Property present, no value: [num:] and [num:""] and [num:''] and [num: ("")]
		for (const q of ['[num:]', '[num:""]', "[num:'']", '[num: ("")]']) {
			assertEval(docs, q, config, [
				'null.md',
				'empty-str.md',
				'empty-list.md',
				'null-and-empty-list.md',
				'multi-occ-empty.md',
			]);
		}

		// 4. Property present, any value (including malformed — judge, don't sentence): [num] ![num:]
		assertEval(docs, '[num] ![num:]', config, [
			'multi-occ-one-filled.md',
			'invalid.md',
			'valid.md',
		]);

		// 5. Property present, specific value: [num:42]
		assertEval(docs, '[num:42]', config, ['valid.md']);

		// Also verify [label:null] searches for literal string "null" while [label:] matches empty
		const labelDocs = [
			makeDoc(config, 'l-empty.md', { frontmatter: { label: null } }),
			makeDoc(config, 'l-literal-null.md', { frontmatter: { label: 'null' } }),
		];
		assertEval(labelDocs, '[label:]', config, ['l-empty.md']);
		assertEval(labelDocs, '[label:null]', config, ['l-literal-null.md']);
	});

	it('evaluates property colon as typed equality on number, date, and checkbox, regex on raw/normalized representations, and per-entry logical grouping', () => {
		const config = makeConfig();
		const fm1 = {
			num: ' 1.5e2 ',
			day: '2026-10-22',
			flag: ' TRUE ',
			multi: ['alpha one', 'beta two'],
			tags: ['#work/urgent', 'project'],
		};
		const fm2 = {
			num: 150,
			day: '2025-01-01',
			flag: false,
			multi: ['alpha two', 'gamma three'],
			tags: ['work', '#archive'],
		};
		const docs = [
			makeDoc(config, 'raw1.md', { frontmatter: fm1 }),
			makeDoc(config, 'raw2.md', { frontmatter: fm2 }),
		];
		for (const q of '[num: /1\\.5e2/];[day: 2026-10];[day: @today];[day: (@today OR @yesterday)];[day: /^2026-10/];[flag: true];[multi: (alpha AND !two)];[multi: (/^alpha/ AND !/two$/)];tag:#work/urgent;tag:work/urgent;tag:=#project;tag:=project'.split(
			';',
		)) {
			assertEval(docs, q, config, ['raw1.md']);
		}
		for (const q of '[num: 150];[num: 1.5e2];[num: (150 OR 200)];tag:#work;tag:work;tag:/^work/'.split(
			';',
		)) {
			assertEval(docs, q, config, ['raw1.md', 'raw2.md']);
		}
		assertEval(docs, 'tag:=#work', config, ['raw2.md']);
		assertEval(docs, 'tag:=work', config, ['raw2.md']);
		assertEval(docs, '[flag: false]', config, ['raw2.md']);
		assertEval(docs, '[multi: (alpha AND beta)]', config, []);
		assertEval(docs, '[multi: (beta OR gamma)]', config, ['raw1.md', 'raw2.md']);
	});

	it('keeps empty scopes false under inner NOT while outer NOT negates the empty scope result', () => {
		const config = makeConfig();
		const docs = [makeDoc(config, 'empty.md')];
		for (const q of 'headings:(NOT intro);links:(!target);embeds:(!diagram);blocks:(!blk);aliases:(!aka);tag:(!work)'.split(
			';',
		)) {
			assertEval(docs, q, config, []);
		}
		assertEval(docs, '!headings:intro', config, ['empty.md']);
	});

	it('resolves all virtual file.* keys exclusively from doc.file despite conflicting shadow properties, while retired keys act as ordinary user properties', () => {
		const config = makeConfig();
		const shadowFm = {
			'file.modified': '1999-01-01',
			'file.created': '1999-01-01',
			'file.size': 1,
			'file.extension': 'txt',
			'file.name': 'Fake.txt',
			'file.basename': 'Fake',
			'file.path': 'Wrong/Fake.txt',
			'file.parent': 'Wrong',
			'file.mtime': 'legacy-mtime',
			'file.ctime': 'legacy-ctime',
			'file.ext': 'legacy-ext',
		};
		const docs = [makeDoc(config, 'Archive/2026/Report.md', { frontmatter: shadowFm })];
		for (const q of '[file.modified: = 2026-06-15];[file.created: = 2026-03-01];[file.modified: /^2026-06-15T/];[file.created: /^2026-03-01T/];[file.size: = 4096];[file.extension: = md];[file.name: = Report.md];[file.basename: = Report];[file.path: = Archive/2026/Report.md];[file.parent: = Archive/2026];[file.mtime: = legacy-mtime];[file.ctime: = legacy-ctime];[file.ext: = legacy-ext]'.split(
			';',
		)) {
			assertEval(docs, q, config, ['Archive/2026/Report.md']);
		}
		assertEval(docs, '[file.name: = Fake.txt]', config, []);
		// Virtual file.* keys are always present ([file.*]), while [file.parent:] matches vault-root notes
		const rootAndSubDocs = [...docs, makeDoc(config, 'RootNote.md')];
		assertEval(rootAndSubDocs, '[file.parent]', config, [
			'Archive/2026/Report.md',
			'RootNote.md',
		]);
		assertEval(rootAndSubDocs, '[file.parent:]', config, ['RootNote.md']);
		assertEval(rootAndSubDocs, '[file.parent] ![file.parent:]', config, [
			'Archive/2026/Report.md',
		]);
		assertEval(rootAndSubDocs, '[file.size:]', config, []);
	});

	it('evaluates case-sensitive vs case-insensitive regexes on tags and blocks while keeping non-regex queries case-insensitive', () => {
		const config = makeConfig();
		const doc1 = makeDoc(config, 'upper.md', {
			frontmatter: { tags: ['#Work/Urgent'] },
			tags: [{ tag: '#BodyTag' }],
			blocks: { 'blk-alpha': { id: '^Blk-Alpha' } },
		});
		const doc2 = makeDoc(config, 'lower.md', {
			frontmatter: { tags: ['work/urgent'] },
			tags: [{ tag: '#bodytag' }],
			blocks: { 'blk-alpha': { id: 'blk-alpha' } },
		});
		const docs = [doc1, doc2];

		// Case-sensitive regex on tag: and blocks: matches authored casing
		assertEval(docs, 'tag:/^Work/', config, ['upper.md']);
		assertEval(docs, 'tag:/^work/', config, ['lower.md']);
		assertEval(docs, 'tag:/^BodyTag$/', config, ['upper.md']);
		assertEval(docs, 'tag:/^bodytag$/', config, ['lower.md']);
		assertEval(docs, 'blocks:/^Blk-Alpha$/', config, ['upper.md']);
		assertEval(docs, 'blocks:/^blk-alpha$/', config, ['lower.md']);

		// Case-insensitive regex (/.../i) and non-regex queries match both
		for (const q of [
			'tag:/^work/i',
			'#work',
			'tag:work',
			'tag: = work/urgent',
			'blocks:/^blk-alpha$/i',
			'blocks:blk-alpha',
			'blocks:^BLK-ALPHA',
		]) {
			assertEval(docs, q, config, ['upper.md', 'lower.md']);
		}
	});

	it('evaluates cssclasses scope and comparison operators across string scopes', () => {
		const config = makeConfig();
		const docs = [
			makeDoc(config, 'Wide.md', {
				frontmatter: {
					cssclasses: ['wide-page', 'cards'],
					tags: ['work', 'work/urgent'],
					aliases: ['Alpha', 'Zulu'],
				},
				headings: [{ heading: 'Overview', level: 1 }],
				blocks: { b: { id: 'b' } },
			}),
			makeDoc(config, 'Narrow.md', {
				frontmatter: {
					cssclasses: ['narrow'],
					tags: ['personal'],
					aliases: ['Beta'],
				},
			}),
		];

		assertEval(docs, 'cssclasses:wide-page', config, ['Wide.md']);
		assertEval(docs, 'cssclass:=wide-page', config, ['Wide.md']);
		assertEval(docs, 'cssclasses: = WIDE-PAGE', config, ['Wide.md']);
		assertEval(docs, 'cssclasses:/^wide/', config, ['Wide.md']);
		assertEval(docs, 'cssclasses:!=wide-page', config, ['Wide.md', 'Narrow.md']);
		assertEval(docs, 'cssclasses: >m', config, ['Wide.md', 'Narrow.md']);

		assertEval(docs, 'aliases: = Alpha', config, ['Wide.md']);
		assertEval(docs, 'aliases: = alpha', config, ['Wide.md']);
		assertEval(docs, 'aliases: != Alpha', config, ['Wide.md', 'Narrow.md']);

		assertEval(docs, 'tag: = work', config, ['Wide.md']);
		assertEval(docs, 'tag: = work/urgent', config, ['Wide.md']);
		assertEval(docs, 'tag: != work', config, ['Wide.md', 'Narrow.md']);
		assertEval(docs, 'tag: < work', config, ['Narrow.md']);

		assertEval(docs, 'blocks: = b', config, ['Wide.md']);
		assertEval(docs, 'headings: = Overview', config, ['Wide.md']);
		assertEval(docs, 'path: = Wide.md', config, ['Wide.md']);
		assertEval(docs, 'file: = Wide', config, ['Wide.md']);
		assertEval(docs, 'ext: = .md', config, ['Wide.md', 'Narrow.md']);
	});

	it('rejects bare text and regex queries while matching explicit file:, path:, aliases:, and tag: scopes', () => {
		const config = makeConfig();
		const cache: ObsidianMetadataCacheInput = {
			frontmatter: { aliases: ['CleverAlias'], tags: ['#TopicTag'], label: 'OnlyInProperty' },
			headings: [{ heading: 'OnlyInHeading', level: 1 }],
		};
		const docs = [makeDoc(config, 'DeepFolder/UniqueBase.md', cache)];
		for (const bare of 'uniquebase;deepfolder;cleveralias;topictag;/^CleverAlias$/'.split(
			';',
		)) {
			const res = compileQuery(bare, config, REF_MS);
			expect(res.executable).toBe(false);
			expect(res.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
		}
		for (const scoped of 'file:uniquebase;path:deepfolder;aliases:cleveralias;tag:topictag;aliases:/^CleverAlias$/'.split(
			';',
		)) {
			assertEval(docs, scoped, config, ['DeepFolder/UniqueBase.md']);
		}
		assertEval(docs, 'file:onlyinproperty', config, []);
		assertEval(docs, 'aliases:onlyinheading', config, []);
	});

	it('collects diagnostics in exact document, occurrence, and value order across short-circuit branches without duplicates', () => {
		const config = makeConfig();
		const doc1 = makeDoc(
			config,
			'd1.md',
			{ frontmatter: { num: ['bad1', 'bad2'], label: 'ignore-me' } },
			[{ key: 'day', value: '2026-10-20..2026-01-01', line: 9 }],
		);
		const doc2 = makeDoc(config, 'd2.md', { frontmatter: { num: 'bad3' } });
		const report = assertEval(
			[doc1, doc2],
			'file:d1 OR ([num: > 5] AND [num: < 10] AND [day: = 2026-10-22])',
			config,
			['d1.md'],
		);
		expect(
			report.propertyDiagnostics.map((d) => [
				d.filePath,
				d.propertyKey,
				d.occurrenceIndex,
				d.valueIndex,
			]),
		).toEqual([
			['d1.md', 'num', 0, 0],
			['d1.md', 'num', 0, 1],
			['d1.md', 'day', 2, 0],
			['d2.md', 'num', 0, 0],
		]);
	});

	it('enforces defensive kind guards in production evaluator when typedValues are manually corrupted', () => {
		const config = makeConfig();
		const corruptedDoc = makeDoc(config, 'corrupt.md', {
			frontmatter: {
				num: 10,
				flag: true,
				day: '2026-10-22',
				label: 'hello',
			},
		});
		corruptedDoc.propertyOccurrences[0]!.typedValues = [{ kind: 'text', value: '10' }];
		corruptedDoc.propertyOccurrences[1]!.typedValues = [{ kind: 'number', value: 1, raw: '1' }];
		corruptedDoc.propertyOccurrences[2]!.typedValues = [{ kind: 'number', value: 0, raw: '0' }];
		corruptedDoc.propertyOccurrences[3]!.typedValues = [{ kind: 'number', value: 5, raw: '5' }];

		expect(evaluateDoc(corruptedDoc, prepare('[num: = 10]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[num: 10]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[flag: = true]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[flag: true]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[day: = 2026-10-22]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[day: 2026-10-22]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[label: = 5]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[label: 5]', config))).toBe(false);
	});

	it('evaluates @this.* across scalar properties, array overlap, deep indexing, and unresolved/uncoercible fallbacks identically in evaluator and oracle', () => {
		const config = makeConfig();
		const hostDoc = makeDoc(config, 'Projects/Host.md', {
			frontmatter: {
				'Review Status': 'active',
				num: 5,
				bad_num: 'high',
				day: '2026-10-22',
				flag: true,
				tags: ['project/alpha', 'shared'],
				aliases: ['HostAlias'],
			},
			links: [{ link: 'TargetA' }],
		});
		const candidateMatch = makeDoc(config, 'Notes/Match.md', {
			frontmatter: {
				label: 'active',
				num: 10,
				day: '2026-10-22',
				flag: true,
				tags: ['project/alpha/sub', 'other'],
			},
		});
		const candidateOther = makeDoc(config, 'Notes/Other.md', {
			frontmatter: {
				label: 'archived',
				num: 2,
				day: '2026-11-01',
				flag: false,
				tags: ['unrelated'],
			},
		});

		const assertHostQuery = (query: string, expected: string[]) => {
			const compiled = compileQuery(query, config, REF_MS, hostDoc);
			expect(compiled.executable).toBe(true);
			expect(compiled.prepared).not.toBeNull();
			const docs = [candidateMatch, candidateOther];
			const prodMatches = evaluateVault(docs, compiled.prepared!).matches.map(
				(d) => d.file.path,
			);
			const oracleMatches = oracleEvaluateVault(docs, compiled.prepared!).matches.map(
				(d) => d.file.path,
			);
			expect(prodMatches).toEqual(expected);
			expect(oracleMatches).toEqual(expected);
		};

		// Quoted segment property match & numeric ordering
		assertHostQuery('[label: = @this.properties."Review Status"]', ['Notes/Match.md']);
		assertHostQuery('[num: > @this.properties.num]', ['Notes/Match.md']);
		assertHostQuery('[day: = @this.properties.day] AND [flag: = @this.properties.flag]', [
			'Notes/Match.md',
		]);

		// Hierarchical tag overlap (`tag:@this.tags`) vs exact (`tag: = @this.tags.0`)
		assertHostQuery('tag:@this.tags', ['Notes/Match.md']);
		assertHostQuery('!tag:@this.tags', ['Notes/Other.md']);
		assertHostQuery('tag: = @this.tags.0', []);

		// Deep array/object traversal (`@this.links.0.rawTarget`, `@this.links.rawTarget`, `@this.file.ext`)
		const linkCandidate = makeDoc(config, 'Notes/TargetA.md', {});
		const linkCompiled = compileQuery(
			'file:@this.links.0.rawTarget AND file:@this.links.rawTarget AND ext:@this.file.ext',
			config,
			REF_MS,
			hostDoc,
		);
		expect(evaluateDoc(linkCandidate, linkCompiled.prepared!)).toBe(true);
		expect(oracleEvaluateDoc(linkCandidate, linkCompiled.prepared!)).toBe(true);

		// Missing / unresolved `@this.*` and uncoercible `@this.*` evaluate leaf to false (`true` when negated)
		assertHostQuery('[label: = @this.properties.missing]', []);
		assertHostQuery('![label: = @this.properties.missing]', [
			'Notes/Match.md',
			'Notes/Other.md',
		]);
		assertHostQuery('tag:NOT @this.properties.missing', ['Notes/Match.md', 'Notes/Other.md']);
		assertHostQuery('[num: > @this.properties.bad_num]', []);
		assertHostQuery('![num: > @this.properties.bad_num]', ['Notes/Match.md', 'Notes/Other.md']);
	});
});
