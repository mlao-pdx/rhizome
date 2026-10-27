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
			'[num = 10];[num < 20];[num <= 10];[label = bravo];[label < charlie];[label <= BRAVO];[day = 2026-10-15];[day < 2026-10-20];[day <= 2026-10-15];[stamp = 2026-10-15];[stamp < 2026-10-20T10:00:00Z];[stamp <= 2026-10-15T10:00:00Z];[flag = true];[flag != false]'.split(
				';',
			);
		const bQueries =
			'[num != 10];[num > 10];[num >= 20];[label != bravo];[label > bravo];[label >= CHARLIE];[day != 2026-10-15];[day > 2026-10-15];[day >= 2026-10-20];[stamp != 2026-10-15];[stamp > 2026-10-15T10:00:00Z];[stamp >= 2026-10-20T10:00:00Z];[flag != true];[flag = false]'.split(
				';',
			);
		for (const q of aQueries) assertEval(docs, q, config, ['a.md']);
		for (const q of bQueries) assertEval(docs, q, config, ['b.md']);
	});

	it('excludes missing, null, and invalid property values from EXISTS while matching valid entries', () => {
		const config = makeConfig();
		const docs = [
			makeDoc(config, 'missing.md'),
			makeDoc(config, 'null.md', { frontmatter: { num: null } }),
			makeDoc(config, 'invalid.md', { frontmatter: { num: 'not-a-number' } }),
			makeDoc(config, 'valid.md', { frontmatter: { num: [null, 'bad', 42] } }),
		];
		assertEval(docs, '[num]', config, ['valid.md']);
	});

	it('evaluates property colon as typed equality on number, date, and checkbox, hierarchical tag matching on tags, regex on raw/normalized representations, and per-entry logical grouping', () => {
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
		for (const q of '[num: /1\\.5e2/];[day: 2026-10];[day: @today];[day: (@today OR @yesterday)];[day: /^2026-10/];[flag: true];[multi: (alpha AND -two)];[multi: (/^alpha/ AND -/two$/)];[tags: #work/urgent];[tags: work/urgent];[tags = #project];[tags = project]'.split(
			';',
		)) {
			assertEval(docs, q, config, ['raw1.md']);
		}
		for (const q of '[num: 150];[num: 1.5e2];[num: (150 OR 200)];[tags: #work];[tags: work];[tags: /^work/]'.split(
			';',
		)) {
			assertEval(docs, q, config, ['raw1.md', 'raw2.md']);
		}
		assertEval(docs, '[tags = #work]', config, ['raw2.md']);
		assertEval(docs, '[tags = work]', config, ['raw2.md']);
		assertEval(docs, '[flag: false]', config, ['raw2.md']);
		assertEval(docs, '[multi: (alpha AND beta)]', config, []);
		assertEval(docs, '[multi: (beta OR gamma)]', config, ['raw1.md', 'raw2.md']);
	});

	it('keeps empty scopes false under inner NOT while outer NOT negates the empty scope result', () => {
		const config = makeConfig();
		const docs = [makeDoc(config, 'empty.md')];
		for (const q of 'headings:(NOT intro);links:(-target);embeds:(-diagram);blocks:(-blk);aliases:(-aka);tag:(-work)'.split(
			';',
		)) {
			assertEval(docs, q, config, []);
		}
		assertEval(docs, '-headings:intro', config, ['empty.md']);
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
		for (const q of '[file.modified = 2026-06-15];[file.created = 2026-03-01];[file.size = 4096];[file.extension = md];[file.name = Report.md];[file.basename = Report];[file.path = Archive/2026/Report.md];[file.parent = Archive/2026];[file.mtime = legacy-mtime];[file.ctime = legacy-ctime];[file.ext = legacy-ext]'.split(
			';',
		)) {
			assertEval(docs, q, config, ['Archive/2026/Report.md']);
		}
		assertEval(docs, '[file.name = Fake.txt]', config, []);
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

		// Case-sensitive regex on properties and blocks matches exact authored casing;
		// tag: scope reads the lowercased doc.tags selection set
		assertEval(docs, 'tag:/^Work/', config, []);
		assertEval(docs, 'tag:/^work/', config, ['upper.md', 'lower.md']);
		assertEval(docs, 'tag:/^BodyTag$/', config, []);
		assertEval(docs, 'tag:/^bodytag$/', config, ['upper.md', 'lower.md']);
		assertEval(docs, '[tags: /^Work/]', config, ['upper.md']);
		assertEval(docs, '[tags: /^work/]', config, ['lower.md']);
		assertEval(docs, 'blocks:/^Blk-Alpha$/', config, ['upper.md']);
		assertEval(docs, 'blocks:/^blk-alpha$/', config, ['lower.md']);

		// Case-insensitive regex (/.../i) and non-regex queries match both
		for (const q of [
			'tag:/^work/i',
			'[tags: /^work/i]',
			'#work',
			'tag:work',
			'[tags: work]',
			'[tags = work/urgent]',
			'blocks:/^blk-alpha$/i',
			'blocks:blk-alpha',
			'blocks:^BLK-ALPHA',
		]) {
			assertEval(docs, q, config, ['upper.md', 'lower.md']);
		}
	});

	it('matches bare text and regex against basename, path, aliases, and tags only', () => {
		const config = makeConfig();
		const cache: ObsidianMetadataCacheInput = {
			frontmatter: { aliases: ['CleverAlias'], tags: ['#TopicTag'], label: 'OnlyInProperty' },
			headings: [{ heading: 'OnlyInHeading', level: 1 }],
		};
		const docs = [makeDoc(config, 'DeepFolder/UniqueBase.md', cache)];
		for (const q of 'uniquebase;deepfolder;cleveralias;topictag;/^CleverAlias$/'.split(';')) {
			assertEval(docs, q, config, ['DeepFolder/UniqueBase.md']);
		}
		assertEval(docs, 'onlyinproperty', config, []);
		assertEval(docs, 'onlyinheading', config, []);
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
			'file:d1 OR ([num > 5] AND [num < 10] AND [day = 2026-10-22])',
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
				tags: ['work'],
			},
		});
		corruptedDoc.propertyOccurrences[0]!.typedValues = [{ kind: 'text', value: '10' }];
		corruptedDoc.propertyOccurrences[1]!.typedValues = [{ kind: 'number', value: 1, raw: '1' }];
		corruptedDoc.propertyOccurrences[2]!.typedValues = [{ kind: 'number', value: 0, raw: '0' }];
		corruptedDoc.propertyOccurrences[3]!.typedValues = [{ kind: 'number', value: 5, raw: '5' }];
		corruptedDoc.propertyOccurrences[4]!.typedValues = [{ kind: 'number', value: 7, raw: '7' }];

		expect(evaluateDoc(corruptedDoc, prepare('[num = 10]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[num: 10]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[flag = true]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[flag: true]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[day = 2026-10-22]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[day: 2026-10-22]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[label = 5]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[label: 5]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[tags = work]', config))).toBe(false);
		expect(evaluateDoc(corruptedDoc, prepare('[tags: work]', config))).toBe(false);
	});
});
