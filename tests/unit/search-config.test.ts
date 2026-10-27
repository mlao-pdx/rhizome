import { describe, expect, it } from 'vitest';
import {
	BUILT_IN_SCOPES,
	initEngineConfig,
	isValidPropertyType,
	isVirtualFileKey,
	substringStringMatch,
	VALID_PROPERTY_TYPES_LIST,
	VIRTUAL_FILE_KEYS_LIST,
	type NormalizedDocument,
	type ObsidianPropertyType,
	type ScopeDefinition,
} from '../../src/core/search';

function createFixtureDoc(): NormalizedDocument {
	return {
		normalizationFingerprint: '{"tz":"UTC","types":[]}',
		file: {
			path: 'Projects/Active/Sprint-12.md',
			name: 'Sprint-12.md',
			basename: 'Sprint-12',
			extension: 'md',
			parent: 'Projects/Active',
			created: 1700000000000,
			modified: 1700000005000,
			size: 2048,
		},
		aliases: ['Q4 Sprint', 'Active Roadmap'],
		tags: ['project', 'work/urgent'],
		tagLocations: [
			{
				tag: 'project',
				source: 'frontmatter',
				origin: '[[Projects/Active/Sprint-12.md|Sprint-12]]',
			},
			{
				tag: 'work/urgent',
				source: 'body',
				origin: '[[Projects/Active/Sprint-12.md#Overview|Sprint-12]]',
			},
		],
		headings: [
			{ text: 'Overview', level: 1 },
			{ text: 'Action Items', level: 2 },
		],
		links: [
			{
				link: 'Team/Alice#Bio',
				rawTarget: 'Team/Alice',
				resolvedPath: 'People/Team/Alice.md',
				subpath: '#Bio',
				displayText: 'Alice Lead',
				source: 'body',
				origin: '[[Projects/Active/Sprint-12.md#Overview|Sprint-12]]',
			},
			{
				link: 'MissingNote',
				rawTarget: 'MissingNote',
				resolvedPath: null,
				subpath: '',
				displayText: 'Ghost Link',
				source: 'frontmatter',
				origin: '[[Projects/Active/Sprint-12.md|Sprint-12]]',
			},
		],
		embeds: [
			{
				link: 'Diagrams/Arch.png',
				rawTarget: 'Diagrams/Arch.png',
				resolvedPath: 'Assets/Diagrams/Arch.png',
				subpath: '',
				displayText: 'Arch.png',
				source: 'embed',
				origin: '[[Projects/Active/Sprint-12.md#^summary-block|Sprint-12]]',
			},
			{
				link: 'MissingEmbed.png',
				rawTarget: 'MissingEmbed.png',
				resolvedPath: null,
				subpath: '',
				displayText: 'MissingEmbed.png',
				source: 'embed',
				origin: '[[Projects/Active/Sprint-12.md|Sprint-12]]',
			},
		],
		blocks: ['summary-block', 'decision-1'],
		propertyOccurrences: [],
		propertyKeys: [],
		properties: Object.create(null) as Record<string, unknown>,
		diagnostics: [],
	};
}

describe('types & constants', () => {
	it('freezes VALID_PROPERTY_TYPES_LIST, VIRTUAL_FILE_KEYS_LIST, and BUILT_IN_SCOPES', () => {
		expect(Object.isFrozen(VALID_PROPERTY_TYPES_LIST)).toBe(true);
		expect(Object.isFrozen(VIRTUAL_FILE_KEYS_LIST)).toBe(true);
		expect(Object.isFrozen(BUILT_IN_SCOPES)).toBe(true);
		for (const scope of BUILT_IN_SCOPES) {
			expect(Object.isFrozen(scope)).toBe(true);
			expect(Object.isFrozen(scope.aliases)).toBe(true);
		}
	});

	it('validates ObsidianPropertyType values with isValidPropertyType', () => {
		expect(VALID_PROPERTY_TYPES_LIST).toEqual([
			'text',
			'multitext',
			'number',
			'checkbox',
			'date',
			'datetime',
			'tags',
		]);
		for (const t of VALID_PROPERTY_TYPES_LIST) {
			expect(isValidPropertyType(t)).toBe(true);
		}
		expect(isValidPropertyType('boolean')).toBe(false);
		expect(isValidPropertyType('float')).toBe(false);
		expect(isValidPropertyType('TEXT')).toBe(false);
		expect(isValidPropertyType('')).toBe(false);
		expect(isValidPropertyType(null)).toBe(false);
		expect(isValidPropertyType(undefined)).toBe(false);
		expect(isValidPropertyType(42)).toBe(false);
		expect(isValidPropertyType({})).toBe(false);
	});

	it('validates virtual file keys with isVirtualFileKey', () => {
		expect(VIRTUAL_FILE_KEYS_LIST).toEqual([
			'file.modified',
			'file.created',
			'file.size',
			'file.extension',
			'file.name',
			'file.basename',
			'file.path',
			'file.parent',
		]);
		for (const key of VIRTUAL_FILE_KEYS_LIST) {
			expect(isVirtualFileKey(key)).toBe(true);
		}
		expect(isVirtualFileKey('file.mtime')).toBe(false);
		expect(isVirtualFileKey('file.ctime')).toBe(false);
		expect(isVirtualFileKey('file.ext')).toBe(false);
		expect(isVirtualFileKey('status')).toBe(false);
		expect(isVirtualFileKey('file.unknown')).toBe(false);
		expect(isVirtualFileKey('FILE.SIZE')).toBe(false);
		expect(isVirtualFileKey('')).toBe(false);
	});
});

describe('BUILT_IN_SCOPES & substringStringMatch', () => {
	const doc = createFixtureDoc();

	it('matches substrings case-insensitively via substringStringMatch', () => {
		expect(substringStringMatch('Projects/Active/Sprint-12.md', 'active/sprint')).toBe(true);
		expect(substringStringMatch('Projects/Active/Sprint-12.md', 'ARCHIVE')).toBe(false);
	});

	it('resolves all 9 built-in scopes and their aliases case-insensitively', () => {
		const res = initEngineConfig();
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const expectedAliases: Array<[string, readonly string[]]> = [
			['file', ['file', 'filename']],
			['path', ['path', 'folder']],
			['ext', ['ext', 'extension']],
			['tag', ['tag']],
			['aliases', ['aliases', 'alias']],
			['headings', ['headings', 'heading', 'header', 'headers']],
			['links', ['links', 'link', 'outlink', 'outlinks']],
			['embeds', ['embeds', 'embed']],
			['blocks', ['blocks', 'block']],
		];

		for (const [canonicalName, aliases] of expectedAliases) {
			for (const alias of aliases) {
				const resolved = res.config.getScope(`  ${alias.toUpperCase()}  `);
				expect(resolved).toBeDefined();
				expect(resolved?.canonicalName).toBe(canonicalName);
				expect(resolved?.aliases).toEqual(aliases);
			}
		}
		expect(res.config.getScope('nonexistent')).toBeUndefined();
		expect(res.config.getScope('backlink')).toBeUndefined();
		expect(res.config.getScope('backlinks')).toBeUndefined();
		expect(res.config.getScope('referencedLinks')).toBeUndefined();
	});

	it('extracts and matches file, path, and ext scopes accurately', () => {
		const res = initEngineConfig();
		if (!res.ok) throw new Error('Expected ok config');

		const fileScope = res.config.getScope('filename')!;
		expect(fileScope.extract(doc)).toEqual(['Sprint-12.md', 'Sprint-12']);
		expect(fileScope.matchString('Sprint-12.md', 'sprint', false)).toBe(true);
		expect(fileScope.matchString('Sprint-12.md', 'other', false)).toBe(false);

		const pathScope = res.config.getScope('folder')!;
		expect(pathScope.extract(doc)).toEqual(['Projects/Active/Sprint-12.md']);
		expect(
			pathScope.matchString('Projects/Active/Sprint-12.md', 'projects/active', false),
		).toBe(true);

		const extScope = res.config.getScope('extension')!;
		expect(extScope.extract(doc)).toEqual(['md']);
		expect(extScope.matchString('md', 'MD', false)).toBe(true);
		expect(extScope.matchString('md', '.MD', false)).toBe(true);
		expect(extScope.matchString('markdown', 'md', false)).toBe(false);
	});

	it('extracts and matches tag scope with hierarchy prefix rules', () => {
		const res = initEngineConfig();
		if (!res.ok) throw new Error('Expected ok config');

		const tagScope = res.config.getScope('tag')!;
		expect(tagScope.extract(doc)).toEqual(['project', 'work/urgent']);
		expect(tagScope.matchString('work/urgent', 'work', false)).toBe(true);
		expect(tagScope.matchString('work/urgent', '#WORK', false)).toBe(true);
		expect(tagScope.matchString('work/urgent', '#work/urgent', false)).toBe(true);
		expect(tagScope.matchString('work-other', 'work', false)).toBe(false);
		expect(tagScope.matchString('project', 'proj', false)).toBe(false);
	});

	it('extracts and matches aliases, headings, links, embeds, and blocks', () => {
		const res = initEngineConfig();
		if (!res.ok) throw new Error('Expected ok config');

		const aliasesScope = res.config.getScope('alias')!;
		expect(aliasesScope.extract(doc)).toEqual(['Q4 Sprint', 'Active Roadmap']);
		expect(aliasesScope.matchString('Active Roadmap', 'roadmap', false)).toBe(true);

		const headingsScope = res.config.getScope('header')!;
		expect(headingsScope.extract(doc)).toEqual(['Overview', 'Action Items']);
		expect(headingsScope.matchString('Action Items', 'action', false)).toBe(true);

		const linksScope = res.config.getScope('outlinks')!;
		expect(linksScope.extract(doc)).toEqual([
			'Team/Alice#Bio',
			'Team/Alice',
			'People/Team/Alice.md',
			'Alice Lead',
			'MissingNote',
			'MissingNote',
			'Ghost Link',
		]);
		expect(linksScope.matchString('People/Team/Alice.md', 'people/team', false)).toBe(true);

		const embedsScope = res.config.getScope('embed')!;
		expect(embedsScope.extract(doc)).toEqual([
			'Diagrams/Arch.png',
			'Diagrams/Arch.png',
			'Assets/Diagrams/Arch.png',
			'MissingEmbed.png',
			'MissingEmbed.png',
		]);
		expect(embedsScope.matchString('Assets/Diagrams/Arch.png', 'arch.png', false)).toBe(true);

		const blocksScope = res.config.getScope('block')!;
		expect(blocksScope.extract(doc)).toEqual(['summary-block', 'decision-1']);
		expect(blocksScope.matchString('summary-block', 'SUMMARY-BLOCK', false)).toBe(true);
		expect(blocksScope.matchString('summary-block', '^Summary-Block', false)).toBe(true);
		expect(blocksScope.matchString('summary-block', 'summary', false)).toBe(false);
	});
});

describe('initEngineConfig', () => {
	it('initializes default UTC config cleanly and freezes the returned ResolvedEngineConfig', () => {
		const res = initEngineConfig();
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(res.diagnostics).toEqual([]);
		expect(Object.isFrozen(res.diagnostics)).toBe(true);
		expect(Object.isFrozen(res.config)).toBe(true);
		expect(Object.isFrozen(res.config.propertyTypes)).toBe(true);
		expect(Object.getPrototypeOf(res.config.propertyTypes)).toBeNull();
		expect(Object.isFrozen(res.config.getAllScopeNames())).toBe(true);
		expect(res.config.__brand).toBe('ResolvedEngineConfig');
		expect(res.config.timeZone).toBe('UTC');
		expect(res.config.normalizationFingerprint).toBe('{"tz":"UTC","types":[]}');
	});

	it('trims valid IANA timeZones and rejects empty or invalid timeZones with ERROR_INVALID_CONFIG', () => {
		const validRes = initEngineConfig({
			timeZone: '  America/New_York  ',
			propertyTypes: {},
		});
		expect(validRes.ok).toBe(true);
		if (validRes.ok) {
			expect(validRes.config.timeZone).toBe('America/New_York');
		}

		for (const badTz of [
			'',
			'   ',
			'Invalid/Timezone',
			'Mars/Phobos',
			123 as unknown as string,
		]) {
			const badRes = initEngineConfig({
				timeZone: badTz,
				propertyTypes: {},
			});
			expect(badRes.ok).toBe(false);
			expect(badRes.config).toBeNull();
			expect(Object.isFrozen(badRes.diagnostics)).toBe(true);
			expect(badRes.diagnostics).toHaveLength(1);
			expect(badRes.diagnostics[0]).toMatchObject({
				code: 'ERROR_INVALID_CONFIG',
				severity: 'error',
				span: null,
			});
		}
	});

	it('normalizes propertyTypes keys, ignores blank keys, deduplicates matching case collisions, and rejects conflicting collisions or invalid types', () => {
		const cleanRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: {
				' Priority ': 'number',
				DUE: 'date',
				Status: 'date',
				status: 'date',
				'   ': 'text',
			},
		});
		expect(cleanRes.ok).toBe(true);
		if (cleanRes.ok) {
			expect(cleanRes.config.propertyTypes).toEqual({
				priority: 'number',
				due: 'date',
				status: 'date',
			});
		}

		// Handle null/undefined propertyTypes gracefully at runtime
		const nullPropsRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: undefined as unknown as Record<string, ObsidianPropertyType>,
		});
		expect(nullPropsRes.ok).toBe(true);

		const conflictRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: {
				Status: 'text',
				status: 'number',
				badProp: 'float' as unknown as ObsidianPropertyType,
			},
		});
		expect(conflictRes.ok).toBe(false);
		expect(conflictRes.config).toBeNull();
		expect(conflictRes.diagnostics).toHaveLength(2);
		expect(conflictRes.diagnostics[0]?.code).toBe('ERROR_INVALID_CONFIG');
		expect(conflictRes.diagnostics[0]?.issue).toContain('Conflicting property types');
		expect(conflictRes.diagnostics[1]?.code).toBe('ERROR_INVALID_CONFIG');
		expect(conflictRes.diagnostics[1]?.issue).toContain('Unsupported ObsidianPropertyType');
	});

	it('Conformance Test 12b: trims custom scope canonicalName, deduplicates lowercase aliases, and defensively clones/freezes', () => {
		const mutableAliases = ['tasks', 'task', ' TASK '];
		const customTaskScope: ScopeDefinition = {
			canonicalName: ' Tasks ',
			aliases: mutableAliases,
			extract: () => ['urgent'],
			matchString: substringStringMatch,
		};

		const res = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: {},
			// Pass the same object reference twice to verify seenSourceDefs deduplication
			customScopes: [customTaskScope, customTaskScope],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		// Mutate caller's input array after initEngineConfig to verify defensive cloning
		mutableAliases.push('mutated');

		const byTask = res.config.getScope('task');
		const byTasks = res.config.getScope('TASKS');
		expect(byTask).toBeDefined();
		expect(byTask).toBe(byTasks);
		expect(byTask).not.toBe(customTaskScope);
		expect(Object.isFrozen(byTask)).toBe(true);
		expect(Object.isFrozen(byTask?.aliases)).toBe(true);
		expect(byTask?.canonicalName).toBe('Tasks');
		expect(byTask?.aliases).toEqual(['tasks', 'task']);
		expect(res.config.getScope('mutated')).toBeUndefined();
		expect(res.config.getAllScopeNames()).toContain('tasks');
		expect(res.config.getAllScopeNames()).toContain('task');
	});

	it('rejects invalid custom scope names, reserved boolean keywords, and built-in/custom scope collisions', () => {
		const invalidNamesRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: {},
			customScopes: [
				{
					canonicalName: '123bad',
					aliases: ['bad scope', '-dash', 'AND', 'or', 'Not'],
					extract: () => [],
					matchString: substringStringMatch,
				},
			],
		});
		expect(invalidNamesRes.ok).toBe(false);
		expect(invalidNamesRes.diagnostics).toHaveLength(6);
		for (const d of invalidNamesRes.diagnostics) {
			expect(d.code).toBe('ERROR_INVALID_CONFIG');
			expect(d.issue).toContain('Invalid custom scope name or alias');
		}

		const collisionRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: {},
			customScopes: [
				{
					canonicalName: 'customOne',
					aliases: ['folder', 'shared_alias'],
					extract: () => [],
					matchString: substringStringMatch,
				},
				{
					canonicalName: 'customTwo',
					aliases: ['shared_alias'],
					extract: () => [],
					matchString: substringStringMatch,
				},
			],
		});
		expect(collisionRes.ok).toBe(false);
		expect(collisionRes.diagnostics).toHaveLength(2);
		expect(collisionRes.diagnostics[0]?.issue).toContain(
			'Scope name "folder" collides with existing scope "path"',
		);
		expect(collisionRes.diagnostics[1]?.issue).toContain(
			'Scope name "shared_alias" collides with existing scope "customOne"',
		);
	});

	it('Conformance Test 16a: produces identical normalizationFingerprint regardless of propertyTypes key insertion order', () => {
		const resA = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: { a: 'number', b: 'date' },
		});
		const resB = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: { b: 'date', a: 'number' },
		});
		expect(resA.ok).toBe(true);
		expect(resB.ok).toBe(true);
		if (!resA.ok || !resB.ok) return;

		expect(resA.config.normalizationFingerprint).toBe(resB.config.normalizationFingerprint);
		expect(resA.config.normalizationFingerprint).toBe(
			'{"tz":"UTC","types":[["a","number"],["b","date"]]}',
		);

		// Custom scopes do not affect normalizationFingerprint
		const resWithCustomScope = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: { b: 'date', a: 'number' },
			customScopes: [
				{
					canonicalName: 'tasks',
					aliases: ['task'],
					extract: () => [],
					matchString: substringStringMatch,
				},
			],
		});
		expect(resWithCustomScope.ok).toBe(true);
		if (resWithCustomScope.ok) {
			expect(resWithCustomScope.config.normalizationFingerprint).toBe(
				resA.config.normalizationFingerprint,
			);
		}

		// Changing timeZone or propertyTypes changes normalizationFingerprint
		const resDiffTz = initEngineConfig({
			timeZone: 'America/New_York',
			propertyTypes: { a: 'number', b: 'date' },
		});
		expect(resDiffTz.ok).toBe(true);
		if (resDiffTz.ok) {
			expect(resDiffTz.config.normalizationFingerprint).not.toBe(
				resA.config.normalizationFingerprint,
			);
		}
	});
});
