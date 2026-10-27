import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	coercePropertyValue,
	createOriginWikiLinkResolver,
	FORBIDDEN_KEYS,
	initEngineConfig,
	isVirtualFileKey,
	normalizeObsidianMetadata,
	resolveOriginWikiLink,
	resolveQueryPropertyType,
	resolveUserPropertyType,
	stripTagHash,
	VALID_PROPERTY_TYPES_LIST,
	VIRTUAL_FILE_KEYS_LIST,
	type DocumentDiagnostic,
	type InlinePropertyInput,
	type ObsidianPosInput,
	type ObsidianPropertyType,
	type PropertyTypeRegistry,
} from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';

const TIME_ZONES = [
	'UTC',
	'America/New_York',
	'Europe/London',
	'Asia/Tokyo',
	'Pacific/Apia',
] as const;

const propTypeArb: fc.Arbitrary<ObsidianPropertyType> = fc.constantFrom(
	...VALID_PROPERTY_TYPES_LIST,
);

const rawScalarOrObjectArb: fc.Arbitrary<unknown> = fc.oneof(
	fc.string({ maxLength: 32 }),
	fc.double({ noDefaultInfinity: false, noNaN: false }),
	fc.integer(),
	fc.boolean(),
	fc.constant(null),
	fc.constant(undefined),
	fc.date({ min: new Date('1970-01-01T00:00:00Z'), max: new Date('2100-12-31T23:59:59Z') }),
	fc.constant(new Date('Invalid Date')),
	fc.constantFrom(
		'2026-10-22',
		'2026-10-01..2026-01-01',
		'2026-01-01..@today',
		'2011-12-30',
		'@today',
		'true',
		'false',
		'-10.5',
	),
	fc.dictionary(fc.string({ maxLength: 6 }), fc.string({ maxLength: 6 }), { maxKeys: 2 }),
);

const propertyValueArb: fc.Arbitrary<unknown> = fc.oneof(
	rawScalarOrObjectArb,
	fc.array(rawScalarOrObjectArb, { maxLength: 5 }),
);

const propertyKeyArb: fc.Arbitrary<string> = fc.oneof(
	fc.constantFrom(
		'tags',
		'tag',
		'aliases',
		'alias',
		'score',
		'due',
		'meeting',
		'done',
		'status',
		'10',
		'2',
		'file.size',
		'position',
		'__proto__',
		'prototype',
		'constructor',
		' __PROTO__ ',
		'   ',
	),
	fc.string({ minLength: 1, maxLength: 16 }),
);

const inlinePropArb: fc.Arbitrary<InlinePropertyInput> = fc.record({
	key: propertyKeyArb,
	value: propertyValueArb,
	line: fc.option(fc.integer({ min: -5, max: 500 }), { nil: null }),
});

describe('search metadata normalizer & property coercion invariants', () => {
	it('Invariant 2a: JSON-content round-trip, no undefined fields, and forbidden-key safety', async () => {
		const configRes = initEngineConfig({
			timeZone: 'America/New_York',
			propertyTypes: {
				score: 'number',
				due: 'date',
				meeting: 'datetime',
				done: 'checkbox',
				status: 'text',
			},
		});
		if (!configRes.ok) throw new Error('Expected valid config');
		const resolvedConfig = configRes.config;

		const frontmatterEntriesArb = fc.array(fc.tuple(propertyKeyArb, propertyValueArb), {
			maxLength: 8,
		});
		const inlineEntriesArb = fc.array(inlinePropArb, { maxLength: 8 });
		const tagsArb = fc.array(fc.record({ tag: fc.string({ maxLength: 16 }) }), {
			maxLength: 5,
		});
		const headingsArb = fc.array(
			fc.record({
				heading: fc.string({ maxLength: 20 }),
				level: fc.integer({ min: -2, max: 10 }),
			}),
			{ maxLength: 5 },
		);
		const linksArb = fc.array(
			fc.record({
				link: fc.oneof(
					fc.constantFrom('#Overview', '^block-1', 'Other#Sec', 'Missing'),
					fc.string({ maxLength: 20 }),
				),
				displayText: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
			}),
			{ maxLength: 5 },
		);

		await assertProperty(
			'search/normalizer__json-roundtrip-and-forbidden-key-safety',
			fc.property(
				frontmatterEntriesArb,
				inlineEntriesArb,
				tagsArb,
				headingsArb,
				linksArb,
				(fmEntries, inlineProps, tags, headings, links) => {
					const frontmatter: Record<string, unknown> = {};
					for (const [k, v] of fmEntries) {
						Object.defineProperty(frontmatter, k, {
							value: v,
							writable: true,
							enumerable: true,
							configurable: true,
						});
					}

					const doc = normalizeObsidianMetadata(
						{
							path: 'Folder/Note.md',
							name: 'Note.md',
							basename: 'Note',
							extension: 'md',
							parent: { path: 'Folder' },
							stat: { ctime: 1700000000000, mtime: 1700000005000, size: 128 },
						},
						{
							frontmatter,
							tags,
							headings,
							links,
							embeds: links,
							blocks: { '^Blk1': { id: 'Blk1' } },
						},
						resolvedConfig,
						inlineProps,
						(target) => (target === 'Missing' ? null : `${target}.md`),
					);

					// Forbidden keys must never appear in propertyKeys or properties
					for (const forbidden of FORBIDDEN_KEYS) {
						expect(doc.propertyKeys).not.toContain(forbidden);
						expect(
							Object.prototype.hasOwnProperty.call(doc.properties, forbidden),
						).toBe(false);
					}

					// No undefined values on PropertyOccurrence or DocumentDiagnostic
					for (const occ of doc.propertyOccurrences) {
						for (const val of Object.values(occ)) {
							expect(val).not.toBeUndefined();
						}
					}
					for (const diag of doc.diagnostics) {
						for (const val of Object.values(diag)) {
							expect(val).not.toBeUndefined();
						}
					}

					// JSON.parse(JSON.stringify(doc)) round-trip equivalence
					const roundTripped = JSON.parse(JSON.stringify(doc)) as unknown;
					expect(roundTripped).toEqual(doc);
				},
			),
		);
	});

	it('Invariant 3: hybrid property ordering, 1-level concatenation, and copy-on-write safety', async () => {
		const configRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: { score: 'number', due: 'date' },
		});
		if (!configRes.ok) throw new Error('Expected valid config');
		const resolvedConfig = configRes.config;

		const frontmatterEntriesArb = fc.array(
			fc.tuple(fc.constantFrom('foo', 'bar', '10', '2', 'tags', 'score'), propertyValueArb),
			{ maxLength: 6 },
		);
		const inlineEntriesArb = fc.array(
			fc.record({
				key: fc.constantFrom('foo', 'bar', '10', '2', 'tags', 'score', 'FOO', ' Bar '),
				value: propertyValueArb,
				line: fc.option(fc.integer({ min: 1, max: 200 }), { nil: null }),
			}),
			{ maxLength: 8 },
		);

		await assertProperty(
			'search/normalizer__hybrid-property-ordering-and-copy-on-write',
			fc.property(frontmatterEntriesArb, inlineEntriesArb, (fmEntries, inlineProps) => {
				const frontmatter: Record<string, unknown> = {};
				const originalFmArrays = new Map<string, { ref: unknown[]; snapshot: unknown[] }>();

				for (const [k, v] of fmEntries) {
					if (Array.isArray(v)) {
						const arr = v as unknown[];
						const clonedInput = arr.slice();
						frontmatter[k] = clonedInput;
						originalFmArrays.set(k, { ref: clonedInput, snapshot: arr.slice() });
					} else {
						frontmatter[k] = v;
						originalFmArrays.delete(k);
					}
				}

				const doc = normalizeObsidianMetadata(
					{
						path: 'Note.md',
						name: 'Note.md',
						basename: 'Note',
						extension: 'md',
						stat: { ctime: 1000, mtime: 2000, size: 64 },
					},
					{ frontmatter },
					resolvedConfig,
					inlineProps,
				);

				// 1. propertyKeys equals deduplicated sequence of occ.key in exact first-appearance order
				const expectedKeys: string[] = [];
				const occsByKey = new Map<string, typeof doc.propertyOccurrences>();
				for (const occ of doc.propertyOccurrences) {
					if (!occsByKey.has(occ.key)) {
						expectedKeys.push(occ.key);
						occsByKey.set(occ.key, []);
					}
					occsByKey.get(occ.key)!.push(occ);
				}
				expect(doc.propertyKeys).toEqual(expectedKeys);

				// 2. Single-occurrence vs multi-occurrence aggregation & defensive copying
				for (const k of doc.propertyKeys) {
					const occs = occsByKey.get(k)!;
					if (occs.length === 1) {
						const singleOcc = occs[0]!;
						expect(doc.properties[k]).toEqual(singleOcc.rawValue);
						if (Array.isArray(singleOcc.rawValue)) {
							expect(doc.properties[k]).not.toBe(singleOcc.rawValue);
						}
					} else {
						const expectedConcat: unknown[] = [];
						for (const occ of occs) {
							if (Array.isArray(occ.rawValue)) {
								expectedConcat.push(...occ.rawValue);
							} else {
								expectedConcat.push(occ.rawValue);
							}
						}
						expect(doc.properties[k]).toEqual(expectedConcat);
					}
				}

				// 3. Input frontmatter arrays are never mutated by multi-occurrence promotion,
				//    and occurrence.rawValue always defensively copies the input array.
				for (const [rawKey, { ref, snapshot }] of originalFmArrays.entries()) {
					expect(ref).toEqual(snapshot);
					const fmOcc = doc.propertyOccurrences.find(
						(o) => o.source === 'frontmatter' && o.rawKey === rawKey,
					);
					if (fmOcc) {
						expect(fmOcc.rawValue).not.toBe(ref);
					}
				}
			}),
		);
	});

	it('Invariant 4a: coercePropertyValue is non-throwing and satisfies Target-Type Consistency', async () => {
		await assertProperty(
			'search/property-coercion__target-type-consistency-and-non-throwing',
			fc.property(
				rawScalarOrObjectArb,
				propTypeArb,
				fc.constantFrom(...TIME_ZONES),
				(val, propType, tz) => {
					const tv = coercePropertyValue(val, propType, tz);

					if (val === null || val === undefined) {
						expect(tv).toEqual({ kind: 'null' });
						return;
					}

					if (tv.kind === 'invalid') {
						expect(tv.expectedType).toBe(propType);
						expect(typeof tv.raw).toBe('string');
						return;
					}

					if (propType === 'text' || propType === 'multitext' || propType === 'tags') {
						expect(tv.kind).toBe('text');
					} else {
						expect(tv.kind).toBe(propType);
					}
				},
			),
		);
	});

	it('Diagnostics Bijection Invariant: doc.diagnostics is in 1-to-1 correspondence with invalid TypedPropertyValue entries', async () => {
		const configRes = initEngineConfig({
			timeZone: 'Pacific/Apia',
			propertyTypes: {
				score: 'number',
				due: 'date',
				meeting: 'datetime',
				done: 'checkbox',
				status: 'text',
				tags: 'tags',
				aliases: 'multitext',
			},
		});
		if (!configRes.ok) throw new Error('Expected valid config');
		const resolvedConfig = configRes.config;

		const frontmatterEntriesArb = fc.array(fc.tuple(propertyKeyArb, propertyValueArb), {
			maxLength: 8,
		});
		const inlineEntriesArb = fc.array(inlinePropArb, { maxLength: 8 });

		await assertProperty(
			'search/normalizer__diagnostics-bijection-and-value-index-alignment',
			fc.property(frontmatterEntriesArb, inlineEntriesArb, (fmEntries, inlineProps) => {
				const frontmatter: Record<string, unknown> = {};
				for (const [k, v] of fmEntries) {
					Object.defineProperty(frontmatter, k, {
						value: v,
						writable: true,
						enumerable: true,
						configurable: true,
					});
				}

				const doc = normalizeObsidianMetadata(
					{
						path: 'Projects/Sprint.md',
						name: 'Sprint.md',
						basename: 'Sprint',
						extension: 'md',
						parent: { path: 'Projects' },
						stat: { ctime: 1000, mtime: 2000, size: 128 },
					},
					{ frontmatter },
					resolvedConfig,
					inlineProps,
				);

				const expectedDiagnostics: Array<{
					occurrenceIndex: number;
					valueIndex: number;
					propertyKey: string;
					rawKey: string;
					rawValue: string;
					expectedType: ObsidianPropertyType;
					source: 'frontmatter' | 'inline';
					line: number | null;
					code: DocumentDiagnostic['code'];
					hint: string | null;
				}> = [];

				doc.propertyOccurrences.forEach((occ, occIdx) => {
					if (Array.isArray(occ.rawValue)) {
						expect(occ.typedValues.length).toBe(occ.rawValue.length);
					} else {
						expect(occ.typedValues.length).toBe(1);
					}

					occ.typedValues.forEach((tv, valIdx) => {
						if (tv.kind === 'invalid') {
							expectedDiagnostics.push({
								occurrenceIndex: occIdx,
								valueIndex: valIdx,
								propertyKey: occ.key,
								rawKey: occ.rawKey,
								rawValue: tv.raw,
								expectedType: tv.expectedType,
								source: occ.source,
								line: occ.line,
								code:
									tv.reason === 'REVERSED_DATE_RANGE'
										? 'DOC_REVERSED_DATE_RANGE'
										: tv.reason === 'SKIPPED_DATE'
											? 'DOC_SKIPPED_DATE'
											: 'DOC_INVALID_PROPERTY_VALUE',
								hint: tv.hint,
							});
						}
					});
				});

				expect(doc.diagnostics.length).toBe(expectedDiagnostics.length);
				doc.diagnostics.forEach((diag, idx) => {
					expect(diag).toMatchObject(expectedDiagnostics[idx]!);
				});
			}),
		);
	});

	it('Normalized Collection & Link Split Invariant: tags, headings, blocks, links, and embeds satisfy structural bounds', async () => {
		const configRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
		if (!configRes.ok) throw new Error('Expected valid config');
		const resolvedConfig = configRes.config;

		const tagsArb = fc.array(fc.record({ tag: fc.string({ maxLength: 16 }) }), {
			maxLength: 6,
		});
		const fmTagsArb = fc.array(fc.string({ maxLength: 16 }), { maxLength: 6 });
		const headingsArb = fc.array(
			fc.record({
				heading: fc.string({ maxLength: 16 }),
				level: fc.double({ noDefaultInfinity: false, noNaN: false }),
			}),
			{ maxLength: 6 },
		);
		const linksArb = fc.array(
			fc.record({
				link: fc.oneof(
					fc.constantFrom(
						'#Head',
						'^blk',
						'Note#Head',
						'Note^blk',
						'PlainNote',
						'A#B^C',
						'A^B#C',
					),
					fc.string({ maxLength: 20 }),
				),
				displayText: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
			}),
			{ maxLength: 6 },
		);
		const blocksArb = fc.dictionary(
			fc.string({ minLength: 1, maxLength: 12 }),
			fc.record({ id: fc.string({ maxLength: 12 }) }),
			{ maxKeys: 6 },
		);
		await assertProperty(
			'search/normalizer__collection-and-link-split-invariants',
			fc.property(
				tagsArb,
				fmTagsArb,
				headingsArb,
				linksArb,
				blocksArb,
				(tags, fmTags, headings, links, blocks) => {
					const doc = normalizeObsidianMetadata(
						{
							path: 'Notes/Doc.md',
							name: 'Doc.md',
							basename: 'Doc',
							extension: 'md',
							parent: { path: 'Notes' },
							stat: { ctime: 100, mtime: 200, size: 10 },
						},
						{
							frontmatter: { tags: fmTags },
							tags,
							headings,
							links,
							embeds: links,
							blocks,
						},
						resolvedConfig,
						[],
						(target) => `Resolved/${target}.md`,
					);

					// 0. Flattened file schema
					expect(Object.keys(doc.file)).toEqual([
						'path',
						'name',
						'basename',
						'extension',
						'parent',
						'created',
						'modified',
						'size',
					]);
					expect('stat' in doc.file).toBe(false);

					// 1. tags: non-empty, no leading '#', lowercased, deduplicated, sorted set
					const expectedFmTags = fmTags
						.map((t) => stripTagHash(t))
						.filter((t) => t.length > 0);
					const expectedCacheTags = tags
						.map((t) => stripTagHash(t.tag))
						.filter((t) => t.length > 0);
					const expectedTagSet = Array.from(
						new Set(
							[...expectedFmTags, ...expectedCacheTags].map((t) => t.toLowerCase()),
						),
					).sort();
					expect(doc.tags).toEqual(expectedTagSet);
					for (let i = 0; i < doc.tags.length; i++) {
						const t = doc.tags[i]!;
						expect(t.length).toBeGreaterThan(0);
						expect(t.startsWith('#')).toBe(false);
						expect(t).toBe(t.toLowerCase());
						if (i > 0) {
							expect(doc.tags[i - 1]! < t).toBe(true);
						}
					}
					expect(doc.properties['tags']).toEqual(expectedFmTags);
					for (const occ of doc.propertyOccurrences) {
						if (occ.propertyType === 'tags') {
							const rawList = Array.isArray(occ.rawValue)
								? occ.rawValue
								: [occ.rawValue];
							for (const item of rawList) {
								if (typeof item === 'string') {
									expect(item.length).toBeGreaterThan(0);
									expect(item.startsWith('#')).toBe(false);
								}
							}
						}
					}

					// 2. headings: level is always an integer in 1..6
					for (const h of doc.headings) {
						expect(Number.isInteger(h.level)).toBe(true);
						expect(h.level).toBeGreaterThanOrEqual(1);
						expect(h.level).toBeLessThanOrEqual(6);
					}

					// 3. blocks: non-empty, no leading '^', preserves exact casing from BlockCache.id
					const expectedBlocks = Object.values(blocks)
						.map((b) => (b.id.startsWith('^') ? b.id.slice(1) : b.id))
						.filter((id) => id.length > 0);
					expect(doc.blocks).toEqual(expectedBlocks);
					for (const b of doc.blocks) {
						expect(b.length).toBeGreaterThan(0);
						expect(b.startsWith('^')).toBe(false);
					}

					// 4. links & embeds: self-link vs target+subpath decomposition
					for (const l of [...doc.links, ...doc.embeds]) {
						if (l.link.startsWith('#') || l.link.startsWith('^')) {
							expect(l.rawTarget).toBe('Notes/Doc.md');
							expect(l.resolvedPath).toBe('Notes/Doc.md');
							expect(l.subpath).toBe(l.link);
						} else {
							expect(l.rawTarget + l.subpath).toBe(l.link);
							expect(l.rawTarget.includes('#')).toBe(false);
							expect(l.rawTarget.includes('^')).toBe(false);
							if (l.subpath !== '') {
								expect(l.subpath.startsWith('#') || l.subpath.startsWith('^')).toBe(
									true,
								);
							}
						}
					}
				},
			),
		);
	});

	it('Virtual vs User Property Type Resolution Invariant: query virtual keys override registry while user properties ignore virtual keys', async () => {
		const registryArb: fc.Arbitrary<PropertyTypeRegistry> = fc.dictionary(
			fc.oneof(
				fc.constantFrom(
					...VIRTUAL_FILE_KEYS_LIST,
					'tags',
					'tag',
					'aliases',
					'alias',
					'score',
				),
				fc.string({ minLength: 1, maxLength: 12 }),
			),
			propTypeArb,
			{ maxKeys: 8 },
		);

		const keyArb = fc.oneof(
			fc.constantFrom(...VIRTUAL_FILE_KEYS_LIST, 'tags', 'tag', 'aliases', 'alias', 'score'),
			fc.string({ minLength: 1, maxLength: 12 }),
		);

		await assertProperty(
			'search/property-coercion__virtual-vs-user-property-type-precedence',
			fc.property(registryArb, keyArb, (reg, key) => {
				const lowerKey = key.trim().toLowerCase();
				const userType = resolveUserPropertyType(lowerKey, reg);
				const queryType = resolveQueryPropertyType(lowerKey, reg);

				if (isVirtualFileKey(lowerKey)) {
					if (lowerKey === 'file.modified' || lowerKey === 'file.created') {
						expect(queryType).toBe('datetime');
					} else if (lowerKey === 'file.size') {
						expect(queryType).toBe('number');
					} else {
						expect(queryType).toBe('text');
					}

					// User property resolution ignores virtual file.* status unless explicitly in reg
					const expectedUserType = Object.prototype.hasOwnProperty.call(reg, lowerKey)
						? reg[lowerKey]!
						: 'text';
					expect(userType).toBe(expectedUserType);
				} else {
					expect(queryType).toBe(userType);
					if (lowerKey === 'tags' || lowerKey === 'tag') {
						expect(userType).toBe('tags');
					} else if (lowerKey === 'aliases' || lowerKey === 'alias') {
						expect(userType).toBe('multitext');
					}
				}
			}),
		);
	});

	it('Links Appearance Order & TagLocations Set Projection Invariant: frontmatterLinks precede body links and doc.tags is the lowercased sorted set of tagLocations in frontmatter -> inline -> body order', async () => {
		const configRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
		if (!configRes.ok) throw new Error('Expected valid config');
		const resolvedConfig = configRes.config;

		const posArb: fc.Arbitrary<ObsidianPosInput> = fc
			.tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 200 }))
			.map(([start, len]) => ({
				start: { line: 1, col: 0, offset: start },
				end: { line: 1, col: 0, offset: start + len },
			}));
		const optionalPosArb = fc.option(posArb, { nil: undefined });

		const linkItemArb = fc.record({
			link: fc.oneof(
				fc.constantFrom('#Head', '^blk', 'Note#Head', 'PlainNote'),
				fc.string({ maxLength: 16 }),
			),
			displayText: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
			position: optionalPosArb,
		});

		const fmEntriesArb = fc.array(
			fc.tuple(
				fc.constantFrom('tags', 'tag', 'TAGS', 'status', 'aliases'),
				fc.oneof(
					fc.string({ maxLength: 16 }),
					fc.array(fc.string({ maxLength: 16 }), { maxLength: 4 }),
				),
			),
			{ maxLength: 5 },
		);

		const inlineTagsArb: fc.Arbitrary<InlinePropertyInput[]> = fc.array(
			fc.record({
				key: fc.constantFrom('tags', 'tag', ' TAG ', 'status'),
				value: fc.oneof(
					fc.string({ maxLength: 16 }),
					fc.array(fc.string({ maxLength: 16 }), { maxLength: 4 }),
				),
				line: fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
				position: optionalPosArb,
			}),
			{ maxLength: 5 },
		);

		const bodyTagsArb = fc.array(
			fc.record({
				tag: fc.string({ maxLength: 16 }),
				position: optionalPosArb,
			}),
			{ maxLength: 5 },
		);

		const headingsArb = fc.array(
			fc.record({
				heading: fc.oneof(
					fc.constantFrom('Overview', 'Section [1]', 'Part | Two', 'Clean Title'),
					fc.string({ maxLength: 16 }),
				),
				level: fc.integer({ min: 1, max: 6 }),
				position: optionalPosArb,
			}),
			{ maxLength: 5 },
		);

		const blocksArb = fc.dictionary(
			fc.string({ minLength: 1, maxLength: 10 }),
			fc.record({
				id: fc.oneof(
					fc.constantFrom('blk-1', '^blk-2', 'bad|id', 'clean-id'),
					fc.string({ maxLength: 12 }),
				),
				position: optionalPosArb,
			}),
			{ maxKeys: 5 },
		);

		await assertProperty(
			'search/normalizer__links-order-and-tag-locations-bijection',
			fc.property(
				fmEntriesArb,
				inlineTagsArb,
				bodyTagsArb,
				fc.array(linkItemArb, { maxLength: 5 }),
				fc.array(linkItemArb, { maxLength: 5 }),
				fc.array(linkItemArb, { maxLength: 4 }),
				headingsArb,
				blocksArb,
				(
					fmEntries,
					inlineProps,
					bodyTags,
					fmLinks,
					bodyLinks,
					embeds,
					headings,
					blocks,
				) => {
					const frontmatter: Record<string, unknown> = {};
					for (const [k, v] of fmEntries) {
						frontmatter[k] = v;
					}

					const doc = normalizeObsidianMetadata(
						{
							path: 'Folder/Note.md',
							name: 'Note.md',
							basename: 'Note',
							extension: 'md',
							parent: { path: 'Folder' },
							stat: { ctime: 100, mtime: 200, size: 50 },
						},
						{
							frontmatter,
							tags: bodyTags,
							frontmatterLinks: fmLinks,
							links: bodyLinks,
							embeds,
							headings,
							blocks,
						},
						resolvedConfig,
						inlineProps,
					);

					const noteOrigin = `[[${doc.file.path}|${doc.file.basename}]]`;

					// Invariant 1: doc.links orders frontmatterLinks before body links,
					// and every frontmatter link has origin === noteOrigin
					expect(doc.links.length).toBe(fmLinks.length + bodyLinks.length);
					let seenBodyLink = false;
					for (const l of doc.links) {
						if (l.source === 'frontmatter') {
							expect(seenBodyLink).toBe(false);
							expect(l.origin).toBe(noteOrigin);
						} else {
							expect(l.source).toBe('body');
							seenBodyLink = true;
						}
					}

					// Invariant 2: doc.tags is the lowercased sorted set projection of doc.tagLocations, which maintains monotonic source order
					expect(doc.tags).toEqual(
						Array.from(
							new Set(doc.tagLocations.map((tl) => tl.tag.toLowerCase())),
						).sort(),
					);

					const sourceOrder = { frontmatter: 0, inline: 1, body: 2 } as const;
					let maxSourceRank = 0;
					for (const tl of doc.tagLocations) {
						const rank = sourceOrder[tl.source];
						expect(rank).toBeGreaterThanOrEqual(maxSourceRank);
						maxSourceRank = rank;
						if (tl.source === 'frontmatter') {
							expect(tl.origin).toBe(noteOrigin);
						}
					}

					// Every origin on links, embeds, and tagLocations is a valid wikilink without unsafe subpath characters
					const prefix = `[[${doc.file.path}`;
					const suffix = `|${doc.file.basename}]]`;
					const allItems = [...doc.links, ...doc.embeds, ...doc.tagLocations];
					for (const item of allItems) {
						expect(item.origin.startsWith(prefix)).toBe(true);
						expect(item.origin.endsWith(suffix)).toBe(true);
						const middle = item.origin.slice(
							prefix.length,
							item.origin.length - suffix.length,
						);
						if (middle !== '') {
							expect(middle.startsWith('#')).toBe(true);
							const subpathText = middle.startsWith('#^')
								? middle.slice(2)
								: middle.slice(1);
							expect(subpathText.trim().length).toBeGreaterThan(0);
							expect(/[[\]#^|\r\n]/.test(subpathText)).toBe(false);
						}
					}

					// Invariant 3: Precomputed Origin Pool Cardinality & Equivalence
					const standaloneResolver = createOriginWikiLinkResolver(
						doc.file.path,
						doc.file.basename,
						blocks,
						headings,
					);
					for (let i = 0; i < bodyLinks.length; i++) {
						const expected = resolveOriginWikiLink(
							doc.file.path,
							doc.file.basename,
							bodyLinks[i]!.position,
							blocks,
							headings,
						);
						expect(doc.links[fmLinks.length + i]!.origin).toBe(expected);
						expect(standaloneResolver.resolve(bodyLinks[i]!.position)).toBe(expected);
					}
					for (let i = 0; i < embeds.length; i++) {
						const expected = resolveOriginWikiLink(
							doc.file.path,
							doc.file.basename,
							embeds[i]!.position,
							blocks,
							headings,
						);
						expect(doc.embeds[i]!.origin).toBe(expected);
						expect(standaloneResolver.resolve(embeds[i]!.position)).toBe(expected);
					}
					const distinctOrigins = new Set(allItems.map((item) => item.origin));
					expect(distinctOrigins.size).toBeLessThanOrEqual(
						1 + Object.keys(blocks).length + headings.length,
					);
				},
			),
		);
	});

	it('Origin 3-Tier Specificity Invariant: start-offset-only anchoring, narrowest block over heading precedence, and exact active heading syntax fallback', async () => {
		const cleanIdArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);
		const cleanHeadingArb = fc
			.stringMatching(/^[A-Za-z0-9 _-]{1,16}$/)
			.filter((s) => s.trim().length > 0);
		const unsafeCharArb = fc.constantFrom('[', ']', '#', '^', '|');

		await assertProperty(
			'search/normalizer__origin-three-tier-specificity-and-start-offset-anchoring',
			fc.property(
				fc.integer({ min: 0, max: 400 }),
				fc.integer({ min: 0, max: 200 }),
				fc.integer({ min: 0, max: 500 }),
				cleanIdArb,
				cleanIdArb,
				cleanHeadingArb,
				cleanHeadingArb,
				unsafeCharArb,
				(
					itemStart,
					initialLen,
					mutatedLen,
					outerBlockId,
					innerBlockId,
					earlyCleanHeading,
					lateHeadingBase,
					unsafeChar,
				) => {
					const filePath = 'Notes/Spec.md';
					const fileBasename = 'Spec';
					const noteOrigin = `[[${filePath}|${fileBasename}]]`;

					const pos1: ObsidianPosInput = {
						start: { line: 1, col: 0, offset: itemStart },
						end: { line: 1, col: 0, offset: itemStart + initialLen },
					};
					const pos2: ObsidianPosInput = {
						start: { line: 1, col: 0, offset: itemStart },
						end: { line: 50, col: 0, offset: itemStart + mutatedLen },
					};

					// 1. Start-offset-only containment: mutating end.offset never changes origin
					//    and Narrowest-block over heading precedence when inside nested blocks
					const outerBlock = {
						id: `^${outerBlockId}`,
						position: {
							start: { line: 1, col: 0, offset: Math.max(0, itemStart - 20) },
							end: { line: 10, col: 0, offset: itemStart + 50 },
						},
					};
					const innerBlock = {
						id: innerBlockId,
						position: {
							start: { line: 2, col: 0, offset: Math.max(0, itemStart - 5) },
							end: { line: 5, col: 0, offset: itemStart + 10 },
						},
					};
					const precedingHeading = {
						heading: earlyCleanHeading,
						level: 1,
						position: {
							start: { line: 1, col: 0, offset: Math.max(0, itemStart - 30) },
							end: { line: 1, col: 10, offset: Math.max(0, itemStart - 25) },
						},
					};

					const origin1 = resolveOriginWikiLink(
						filePath,
						fileBasename,
						pos1,
						{ outer: outerBlock, inner: innerBlock },
						[precedingHeading],
					);
					const origin2 = resolveOriginWikiLink(
						filePath,
						fileBasename,
						pos2,
						{ outer: outerBlock, inner: innerBlock },
						[precedingHeading],
					);

					expect(origin1).toBe(`[[${filePath}#^${innerBlockId}|${fileBasename}]]`);
					expect(origin2).toBe(origin1);

					// 2. When outside all blocks and preceded by a clean heading, resolves to #Heading
					//    and mutating end.offset still never changes origin
					const headingOnlyOrigin1 = resolveOriginWikiLink(
						filePath,
						fileBasename,
						pos1,
						{},
						[precedingHeading],
					);
					const headingOnlyOrigin2 = resolveOriginWikiLink(
						filePath,
						fileBasename,
						pos2,
						{},
						[precedingHeading],
					);
					expect(headingOnlyOrigin1).toBe(
						`[[${filePath}#${earlyCleanHeading}|${fileBasename}]]`,
					);
					expect(headingOnlyOrigin2).toBe(headingOnlyOrigin1);

					// 3. Exact-heading fallback: if the immediately preceding heading contains any
					//    wikilink syntax character, falls back directly to noteOrigin (does not walk
					//    back to an earlier clean heading)
					const unsafeActiveHeading = {
						heading: `${lateHeadingBase}${unsafeChar}suffix`,
						level: 2,
						position: {
							start: { line: 3, col: 0, offset: itemStart },
							end: { line: 3, col: 10, offset: itemStart + 10 },
						},
					};
					const fallbackOrigin = resolveOriginWikiLink(filePath, fileBasename, pos1, {}, [
						precedingHeading,
						unsafeActiveHeading,
					]);
					expect(fallbackOrigin).toBe(noteOrigin);
				},
			),
		);
	});
});
