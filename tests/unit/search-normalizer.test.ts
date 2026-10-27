import { describe, expect, it, vi } from 'vitest';
import {
	buildPropertiesViews,
	coercePropertyValue,
	FORBIDDEN_KEYS,
	initEngineConfig,
	MAX_SAFE_EPOCH_MS,
	normalizeObsidianMetadata,
	resolveQueryPropertyType,
	resolveUserPropertyType,
	sanitizeLineNumber,
	sanitizeScalar,
	type ObsidianFileInput,
	type ResolvedEngineConfig,
} from '../../src/core/search';

function getStandardConfig(): ResolvedEngineConfig {
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
	if (!res.ok) throw new Error('Expected valid config');
	return res.config;
}

function makeFile(overrides: Partial<ObsidianFileInput> = {}): ObsidianFileInput {
	return {
		path: 'Notes/A.md',
		name: 'A.md',
		basename: 'A',
		extension: 'md',
		parent: { path: 'Notes' },
		stat: {
			ctime: 1700000000000,
			mtime: 1700000005000,
			size: 512,
		},
		...overrides,
	};
}

describe('property-coercion helpers', () => {
	it('sanitizes non-clean scalars', () => {
		expect(sanitizeScalar(undefined)).toEqual({ valid: true, scalar: null });
		expect(sanitizeScalar(null)).toEqual({ valid: true, scalar: null });
		expect(sanitizeScalar(Number.NaN)).toEqual({ valid: true, scalar: null });
		expect(sanitizeScalar(Number.NEGATIVE_INFINITY)).toEqual({ valid: true, scalar: null });
		expect(sanitizeScalar(new Date('2026-10-22T15:30:00.000Z'))).toEqual({
			valid: true,
			scalar: '2026-10-22T15:30:00.000Z',
		});
		expect(sanitizeScalar(new Date('not-a-date'))).toEqual({ valid: true, scalar: null });
		expect(sanitizeScalar({ nested: true })).toEqual({ valid: false, scalar: null });
		expect(sanitizeScalar(['nested'])).toEqual({ valid: false, scalar: null });
	});

	it('sanitizes 1-based line numbers', () => {
		expect(sanitizeLineNumber(1)).toBe(1);
		expect(sanitizeLineNumber(42)).toBe(42);
		expect(sanitizeLineNumber(0)).toBeNull();
		expect(sanitizeLineNumber(-5)).toBeNull();
		expect(sanitizeLineNumber(1.5)).toBeNull();
		expect(sanitizeLineNumber(Number.NaN)).toBeNull();
		expect(sanitizeLineNumber(null)).toBeNull();
		expect(sanitizeLineNumber(undefined)).toBeNull();
	});

	it('resolves user vs query property types with correct virtual key precedence', () => {
		const config = getStandardConfig();
		const reg = config.propertyTypes;

		// Built-in special user properties
		expect(resolveUserPropertyType('tags', reg)).toBe('tags');
		expect(resolveUserPropertyType('tag', reg)).toBe('tags');
		expect(resolveUserPropertyType('aliases', reg)).toBe('multitext');
		expect(resolveUserPropertyType('alias', reg)).toBe('multitext');

		// Registered user properties
		expect(resolveUserPropertyType('score', reg)).toBe('number');
		expect(resolveUserPropertyType('due', reg)).toBe('date');
		expect(resolveUserPropertyType('unknown_prop', reg)).toBe('text');

		// User properties named after virtual file.* keys do NOT get virtual types unless registered
		expect(resolveUserPropertyType('file.size', reg)).toBe('text');
		expect(resolveUserPropertyType('file.modified', reg)).toBe('text');

		// Query properties DO apply virtual file.* types with highest precedence
		expect(resolveQueryPropertyType('file.modified', reg)).toBe('datetime');
		expect(resolveQueryPropertyType('file.created', reg)).toBe('datetime');
		expect(resolveQueryPropertyType('file.size', reg)).toBe('number');
		expect(resolveQueryPropertyType('file.extension', reg)).toBe('text');
		expect(resolveQueryPropertyType('file.name', reg)).toBe('text');
		expect(resolveQueryPropertyType('file.path', reg)).toBe('text');
		expect(resolveQueryPropertyType('file.mtime', reg)).toBe('text');
		expect(resolveQueryPropertyType('file.ctime', reg)).toBe('text');
		expect(resolveQueryPropertyType('file.ext', reg)).toBe('text');
		expect(resolveQueryPropertyType('score', reg)).toBe('number');
		expect(resolveQueryPropertyType('tags', reg)).toBe('tags');
	});

	it('coerces values across all 7 ObsidianPropertyType types and shares frozen singletons', () => {
		const null1 = coercePropertyValue(null, 'text', 'UTC');
		const null2 = coercePropertyValue(undefined, 'number', 'UTC');
		expect(null1).toBe(null2);
		expect(null1).toEqual({ kind: 'null' });
		expect(Object.isFrozen(null1)).toBe(true);

		// checkbox singletons
		const true1 = coercePropertyValue(true, 'checkbox', 'UTC');
		const true2 = coercePropertyValue(' TRUE ', 'checkbox', 'UTC');
		const false1 = coercePropertyValue(false, 'checkbox', 'UTC');
		const false2 = coercePropertyValue('false', 'checkbox', 'UTC');
		expect(true1).toBe(true2);
		expect(false1).toBe(false2);
		expect(Object.isFrozen(true1)).toBe(true);
		expect(Object.isFrozen(false1)).toBe(true);
		expect(coercePropertyValue('yes', 'checkbox', 'UTC')).toEqual({
			kind: 'invalid',
			raw: 'yes',
			expectedType: 'checkbox',
			reason: 'INVALID_VALUE',
			hint: 'Use true or false.',
		});

		// number
		expect(coercePropertyValue(-10.5, 'number', 'UTC')).toEqual({
			kind: 'number',
			value: -10.5,
			raw: '-10.5',
		});
		expect(coercePropertyValue(' 1.5e2 ', 'number', 'UTC')).toEqual({
			kind: 'number',
			value: 150,
			raw: ' 1.5e2 ',
		});
		expect(coercePropertyValue('0x10', 'number', 'UTC').kind).toBe('invalid');
		expect(coercePropertyValue(true, 'number', 'UTC').kind).toBe('invalid');
		expect(coercePropertyValue(new Date(0), 'number', 'UTC').kind).toBe('invalid');
		expect(coercePropertyValue(Number.NaN, 'number', 'UTC').kind).toBe('invalid');

		// date & datetime
		const dateVal = coercePropertyValue('2026-10-22', 'date', 'UTC');
		expect(dateVal.kind).toBe('date');
		const dateObjVal = coercePropertyValue(
			new Date('2026-10-22T15:30:00.000Z'),
			'datetime',
			'UTC',
		);
		expect(dateObjVal.kind).toBe('datetime');
		expect(coercePropertyValue(new Date('invalid'), 'date', 'UTC')).toMatchObject({
			kind: 'invalid',
			raw: 'Invalid Date',
			expectedType: 'date',
			reason: 'INVALID_VALUE',
		});
		expect(coercePropertyValue('2011-12-30', 'date', 'Pacific/Apia')).toEqual({
			kind: 'invalid',
			raw: '2011-12-30',
			expectedType: 'date',
			reason: 'SKIPPED_DATE',
			hint: 'Calendar date "2011-12-30" was skipped by a timezone transition in "Pacific/Apia".',
		});

		// text / multitext / tags
		expect(coercePropertyValue(42, 'text', 'UTC')).toEqual({ kind: 'text', value: '42' });
		expect(coercePropertyValue(true, 'multitext', 'UTC')).toEqual({
			kind: 'text',
			value: 'true',
		});
		expect(coercePropertyValue(new Date('2026-01-01T00:00:00.000Z'), 'tags', 'UTC')).toEqual({
			kind: 'text',
			value: '2026-01-01T00:00:00.000Z',
		});
		expect(coercePropertyValue(new Date('invalid'), 'text', 'UTC')).toEqual({
			kind: 'invalid',
			raw: 'Invalid Date',
			expectedType: 'text',
			reason: 'INVALID_VALUE',
			hint: null,
		});
		expect(coercePropertyValue(Number.POSITIVE_INFINITY, 'text', 'UTC')).toEqual({
			kind: 'invalid',
			raw: 'Infinity',
			expectedType: 'text',
			reason: 'INVALID_VALUE',
			hint: null,
		});
	});
});

describe('normalizeObsidianMetadata & Conformance Matrix scenarios', () => {
	it('Conformance Test 11a: normalizes self-links (#Overview, ^block) to source file path without calling resolveLinkPath', () => {
		const config = getStandardConfig();
		const resolveLinkPath = vi.fn((rawTarget: string) =>
			rawTarget === 'Team/Alice' ? 'People/Team/Alice.md' : null,
		);

		const doc = normalizeObsidianMetadata(
			makeFile({ path: 'Notes/A.md', name: 'A.md', basename: 'A' }),
			{
				links: [
					{ link: '#Overview' },
					{ link: '^summary-block', displayText: 'Summary' },
					{ link: 'Team/Alice#Bio', displayText: 'Alice' },
					{ link: 'MissingNote' },
				],
			},
			config,
			[],
			resolveLinkPath,
		);

		expect(doc.links).toEqual([
			{
				link: '#Overview',
				rawTarget: 'Notes/A.md',
				resolvedPath: 'Notes/A.md',
				subpath: '#Overview',
				displayText: '#Overview',
				source: 'body',
			},
			{
				link: '^summary-block',
				rawTarget: 'Notes/A.md',
				resolvedPath: 'Notes/A.md',
				subpath: '^summary-block',
				displayText: 'Summary',
				source: 'body',
			},
			{
				link: 'Team/Alice#Bio',
				rawTarget: 'Team/Alice',
				resolvedPath: 'People/Team/Alice.md',
				subpath: '#Bio',
				displayText: 'Alice',
				source: 'body',
			},
			{
				link: 'MissingNote',
				rawTarget: 'MissingNote',
				resolvedPath: null,
				subpath: '',
				displayText: 'MissingNote',
				source: 'body',
			},
		]);

		// resolveLinkPath must only be called for non-self links
		expect(resolveLinkPath).toHaveBeenCalledTimes(2);
		expect(resolveLinkPath).toHaveBeenCalledWith('Team/Alice', 'Notes/A.md');
		expect(resolveLinkPath).toHaveBeenCalledWith('MissingNote', 'Notes/A.md');
	});

	it('Conformance Test 12a: preserves exact first-seen key order (including integer-like keys) and promotes multi-occurrence keys', () => {
		const config = getStandardConfig();
		const doc = normalizeObsidianMetadata(
			makeFile(),
			{
				frontmatter: {
					foo: ['fm1', 'fm2'],
				},
			},
			config,
			[
				{ key: '10', value: 'ten', line: 5 },
				{ key: '2', value: 'two', line: 6 },
				{ key: 'foo', value: 'inline1', line: 7 },
				{ key: 'foo', value: ['inline2', 'inline3'], line: 8 },
			],
		);

		expect(doc.propertyKeys).toEqual(['foo', '10', '2']);
		expect(doc.properties['foo']).toEqual(['fm1', 'fm2', 'inline1', 'inline2', 'inline3']);
		expect(doc.properties['10']).toBe('ten');
		expect(doc.properties['2']).toBe('two');
		expect(Object.getPrototypeOf(doc.properties)).toBeNull();
	});

	it('Conformance Test 15: isolates virtual property shadowing and emits exact DocumentDiagnostic items for reversed ranges and relative anchors', () => {
		const config = getStandardConfig();
		const doc = normalizeObsidianMetadata(
			makeFile({
				path: 'Projects/Sprint-12.md',
				name: 'Sprint-12.md',
				basename: 'Sprint-12',
				parent: { path: 'Projects' },
			}),
			{
				frontmatter: {
					'file.size': 'large',
				},
			},
			config,
			[
				{ key: 'Sprint', value: '2026-10-01..2026-01-01', line: 14 },
				{ key: 'due', value: '2026-01-01..@today', line: 15 },
			],
		);

		// "file.size" in frontmatter is normalized as an ordinary 'text' user property with zero diagnostics
		expect(doc.propertyOccurrences[0]).toEqual({
			key: 'file.size',
			rawKey: 'file.size',
			source: 'frontmatter',
			line: null,
			propertyType: 'text',
			rawValue: 'large',
			typedValues: [{ kind: 'text', value: 'large' }],
		});

		expect(doc.diagnostics).toEqual([
			{
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
			},
			{
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
			},
		]);
	});

	it('Conformance Test 16e: indexes duplicate malformed list values with distinct valueIndex', () => {
		const config = getStandardConfig();
		const doc = normalizeObsidianMetadata(
			makeFile(),
			{
				frontmatter: {
					sprint: ['invalid', 'invalid'],
				},
			},
			config,
		);

		expect(doc.diagnostics).toHaveLength(2);
		expect(doc.diagnostics[0]).toMatchObject({
			code: 'DOC_INVALID_PROPERTY_VALUE',
			propertyKey: 'sprint',
			occurrenceIndex: 0,
			valueIndex: 0,
		});
		expect(doc.diagnostics[1]).toMatchObject({
			code: 'DOC_INVALID_PROPERTY_VALUE',
			propertyKey: 'sprint',
			occurrenceIndex: 0,
			valueIndex: 1,
		});
	});

	it('normalizes tags, aliases, headings, embeds, blocks, and root parent', () => {
		const config = getStandardConfig();
		const doc = normalizeObsidianMetadata(
			makeFile({
				path: 'RootNote.md',
				name: 'RootNote.md',
				basename: 'RootNote',
				parent: { path: '/' },
			}),
			{
				frontmatter: {
					position: { start: { line: 0 }, end: { line: 4 } },
					tags: ['Project', '#work/urgent', '#', '###', '##work/urgent'],
					aliases: ['First Alias', 42],
				},
				tags: [{ tag: '#work/urgent' }, { tag: 'inline-tag' }, { tag: ' # ' }],
				headings: [
					{ heading: 'H1', level: 0 },
					{ heading: 'H6', level: 9 },
					{ heading: 'H3', level: 3 },
				],
				frontmatterLinks: [{ link: 'RefNote', displayText: 'Ref' }],
				embeds: [{ link: 'Diagram.png#page=1' }],
				blocks: { '^Block-One': { id: 'Block-One' }, 'block-two': { id: 'block-two' } },
			},
			config,
			[
				{ key: 'tag', value: 'extra-tag', line: 10 },
				{ key: 'alias', value: 'Second Alias', line: 11 },
			],
		);

		expect(doc.file.parent).toBe('');
		expect(doc.tags).toEqual([
			'Project',
			'work/urgent',
			'work/urgent',
			'extra-tag',
			'work/urgent',
			'inline-tag',
		]);
		expect(doc.properties['tags']).toEqual(['Project', 'work/urgent', 'work/urgent']);
		expect(doc.properties['tag']).toBe('extra-tag');
		expect(doc.aliases).toEqual(['First Alias', '42', 'Second Alias']);
		expect(doc.headings).toEqual([
			{ text: 'H1', level: 1 },
			{ text: 'H6', level: 6 },
			{ text: 'H3', level: 3 },
		]);
		expect(doc.links).toEqual([
			{
				link: 'RefNote',
				rawTarget: 'RefNote',
				resolvedPath: null,
				subpath: '',
				displayText: 'Ref',
				source: 'frontmatter',
			},
		]);
		expect(doc.embeds).toEqual([
			{
				link: 'Diagram.png#page=1',
				rawTarget: 'Diagram.png',
				resolvedPath: null,
				subpath: '#page=1',
				displayText: 'Diagram.png#page=1',
				source: 'embed',
			},
		]);
		expect(doc.blocks).toEqual(['Block-One', 'block-two']);
		expect(doc.propertyKeys).not.toContain('position');
	});

	it('validates file stats eagerly and throws on out-of-range or non-integer stats', () => {
		const config = getStandardConfig();
		expect(() =>
			normalizeObsidianMetadata(
				makeFile({ stat: { ctime: MAX_SAFE_EPOCH_MS + 1, mtime: 0, size: 10 } }),
				null,
				config,
			),
		).toThrow(/Invalid file stat ctime/);

		expect(() =>
			normalizeObsidianMetadata(
				makeFile({ stat: { ctime: 0, mtime: 1.5, size: 10 } }),
				null,
				config,
			),
		).toThrow(/Invalid file stat mtime/);

		expect(() =>
			normalizeObsidianMetadata(
				makeFile({ stat: { ctime: 0, mtime: 0, size: -1 } }),
				null,
				config,
			),
		).toThrow(/Invalid file stat size/);
	});

	it('strips forbidden prototype-pollution keys in both normalizeObsidianMetadata and buildPropertiesViews', () => {
		const config = getStandardConfig();
		const rawFm = JSON.parse(
			'{"__proto__":"polluted","constructor":"bad","prototype":"bad"," safe ":"ok"}',
		) as Record<string, unknown>;

		const doc = normalizeObsidianMetadata(makeFile(), { frontmatter: rawFm }, config, [
			{ key: '__proto__', value: 'evil', line: 1 },
			{ key: ' CONSTRUCTOR ', value: 'evil', line: 2 },
		]);

		expect(doc.propertyKeys).toEqual(['safe']);
		expect(doc.properties['safe']).toBe('ok');
		for (const forbidden of FORBIDDEN_KEYS) {
			expect(doc.propertyKeys).not.toContain(forbidden);
			expect(Object.prototype.hasOwnProperty.call(doc.properties, forbidden)).toBe(false);
		}

		// Direct call to buildPropertiesViews also guards against forbidden keys
		const manualViews = buildPropertiesViews([
			{
				key: '__proto__',
				rawKey: '__proto__',
				source: 'inline',
				line: 1,
				propertyType: 'text',
				rawValue: 'x',
				typedValues: [{ kind: 'text', value: 'x' }],
			},
		]);
		expect(manualViews.propertyKeys).toEqual([]);
	});

	it('normalizes metadata eagerly as an isolated snapshot (resolveLinkPath called during normalization; post-call cache mutations ignored)', () => {
		const config = getStandardConfig();
		const resolveLinkPath = vi.fn(() => 'People/Alice.md');
		const cacheTags = [{ tag: '#initial' }];
		const cacheHeadings = [{ heading: 'Initial Heading', level: 2 }];

		const doc = normalizeObsidianMetadata(
			makeFile(),
			{
				tags: cacheTags,
				headings: cacheHeadings,
				links: [{ link: 'Alice' }],
			},
			config,
			[],
			resolveLinkPath,
		);

		// resolveLinkPath must be invoked eagerly during normalizeObsidianMetadata before any property read
		expect(resolveLinkPath).toHaveBeenCalledTimes(1);
		expect(resolveLinkPath).toHaveBeenCalledWith('Alice', 'Notes/A.md');

		// Mutate inputs after normalizeObsidianMetadata returns, before reading doc fields
		cacheTags.push({ tag: '#mutated' });
		cacheHeadings[0]!.heading = 'Mutated Heading';

		expect(doc.tags).toEqual(['initial']);
		expect(doc.headings).toEqual([{ text: 'Initial Heading', level: 2 }]);
	});

	it('produces plain POJO data descriptors (no getters) and supports structuredClone without pre-warming', () => {
		const config = getStandardConfig();
		const doc = normalizeObsidianMetadata(
			makeFile(),
			{
				frontmatter: {
					aliases: ['Alpha'],
					tags: ['work'],
					status: 'active',
				},
				headings: [{ heading: 'Intro', level: 1 }],
				links: [{ link: 'Target' }],
				embeds: [{ link: 'Image.png' }],
				blocks: { '^b1': { id: 'b1' } },
			},
			config,
		);

		for (const field of [
			'aliases',
			'tags',
			'headings',
			'links',
			'embeds',
			'blocks',
			'propertyKeys',
			'properties',
		] as const) {
			const desc = Object.getOwnPropertyDescriptor(doc, field);
			expect(desc).toBeDefined();
			expect(Object.prototype.hasOwnProperty.call(desc, 'get')).toBe(false);
			expect('value' in (desc ?? {})).toBe(true);
		}

		const cloned = structuredClone(doc);
		expect(cloned).toEqual(doc);
	});

	it('populates flattened doc.file fields and defensively copies frontmatter arrays, occurrence.rawValue, and single-occurrence array views in doc.properties', () => {
		const config = getStandardConfig();
		const inputStat = { ctime: 1700000000000, mtime: 1700000005000, size: 512 };
		const tfile = makeFile({ stat: inputStat });
		const fmList = ['alpha', 'beta'];

		const doc = normalizeObsidianMetadata(
			tfile,
			{
				frontmatter: {
					tags: fmList,
				},
			},
			config,
		);

		expect('stat' in doc.file).toBe(false);
		expect(doc.file.created).toBe(1700000000000);
		expect(doc.file.modified).toBe(1700000005000);
		expect(doc.file.size).toBe(512);
		expect(doc.propertyOccurrences[0]?.rawValue).not.toBe(fmList);
		expect(doc.properties['tags']).not.toBe(fmList);
		expect(doc.properties['tags']).not.toBe(doc.propertyOccurrences[0]?.rawValue);

		// Mutating caller inputs must not affect the normalized document
		inputStat.size = 999999;
		fmList.push('mutated-input');
		expect(doc.file.size).toBe(512);
		expect(doc.propertyOccurrences[0]?.rawValue).toEqual(['alpha', 'beta']);
		expect(doc.properties['tags']).toEqual(['alpha', 'beta']);

		// Mutating doc.properties[key] array must not corrupt doc.propertyOccurrences[0].rawValue
		(doc.properties['tags'] as unknown[]).push('mutated-view');
		expect(doc.propertyOccurrences[0]?.rawValue).toEqual(['alpha', 'beta']);
	});
});
