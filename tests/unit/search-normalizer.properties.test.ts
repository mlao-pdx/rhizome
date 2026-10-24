import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	coercePropertyValue,
	FORBIDDEN_KEYS,
	initEngineConfig,
	isCleanSanitizedScalar,
	isVirtualFileKey,
	normalizeObsidianMetadata,
	resolveQueryPropertyType,
	resolveUserPropertyType,
	VALID_PROPERTY_TYPES_LIST,
	VIRTUAL_FILE_KEYS_LIST,
	type DocumentDiagnostic,
	type InlinePropertyInput,
	type NormalizedDocument,
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
						{ 'Source.md': { 'Folder/Note.md': 1 } },
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

				// 2. Single-occurrence vs multi-occurrence aggregation & reference sharing
				for (const k of doc.propertyKeys) {
					const occs = occsByKey.get(k)!;
					if (occs.length === 1) {
						const singleOcc = occs[0]!;
						expect(doc.properties[k]).toBe(singleOcc.rawValue);
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
				//    and clean frontmatter arrays are shared by reference on their occurrence.
				for (const [rawKey, { ref, snapshot }] of originalFmArrays.entries()) {
					expect(ref).toEqual(snapshot);
					if (ref.every(isCleanSanitizedScalar)) {
						const fmOcc = doc.propertyOccurrences.find(
							(o) => o.source === 'frontmatter' && o.rawKey === rawKey,
						);
						if (fmOcc) {
							expect(fmOcc.rawValue).toBe(ref);
						}
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

	it('Lazy Getter Access-Order Independence & Memoization Invariant: all read orders produce identical documents and memoize references', async () => {
		const configRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: { score: 'number', due: 'date' },
		});
		if (!configRes.ok) throw new Error('Expected valid config');
		const resolvedConfig = configRes.config;

		const lazyKeys = [
			'aliases',
			'tags',
			'headings',
			'links',
			'embeds',
			'referencedLinks',
			'blocks',
			'propertyKeys',
			'properties',
		] as const satisfies ReadonlyArray<keyof NormalizedDocument>;

		const frontmatterEntriesArb = fc.array(
			fc.tuple(fc.constantFrom('tags', 'aliases', 'score', 'due', 'foo'), propertyValueArb),
			{ maxLength: 5 },
		);
		const inlineEntriesArb = fc.array(inlinePropArb, { maxLength: 5 });
		const permArb = fc.shuffledSubarray([...lazyKeys], {
			minLength: lazyKeys.length,
			maxLength: lazyKeys.length,
		});

		await assertProperty(
			'search/normalizer__lazy-getter-access-order-independence-and-memoization',
			fc.property(
				frontmatterEntriesArb,
				inlineEntriesArb,
				permArb,
				(fmEntries, inlineProps, order) => {
					const makeDoc = (): NormalizedDocument => {
						const frontmatter: Record<string, unknown> = {};
						for (const [k, v] of fmEntries) {
							frontmatter[k] = Array.isArray(v) ? (v as unknown[]).slice() : v;
						}
						return normalizeObsidianMetadata(
							{
								path: 'Notes/Lazy.md',
								name: 'Lazy.md',
								basename: 'Lazy',
								extension: 'md',
								parent: { path: 'Notes' },
								stat: { ctime: 1000, mtime: 2000, size: 64 },
							},
							{
								frontmatter,
								tags: [{ tag: 'TagA' }, { tag: '#TagB' }],
								headings: [{ heading: 'Intro', level: 2 }],
								links: [{ link: '#Intro' }, { link: 'Target#Sec' }],
								embeds: [{ link: 'Img.png' }],
								blocks: { '^blk-1': { id: 'blk-1' } },
							},
							resolvedConfig,
							inlineProps,
							{ 'Back.md': { 'Notes/Lazy.md': 1 } },
							(raw) => `${raw}.md`,
						);
					};

					const docPermuted = makeDoc();
					const firstReads = new Map<keyof NormalizedDocument, unknown>();
					for (const k of order) {
						firstReads.set(k, docPermuted[k]);
					}
					// Second read of every lazy getter must return the exact same memoized reference
					for (const k of lazyKeys) {
						expect(docPermuted[k]).toBe(firstReads.get(k));
					}

					// Compare against a fresh doc materialized via JSON.stringify first (and properties-before-propertyKeys)
					const docJsonFirst = makeDoc();
					const jsonSnapshot = JSON.parse(JSON.stringify(docJsonFirst)) as unknown;
					expect(docPermuted).toEqual(jsonSnapshot);
					expect(Object.keys(docPermuted)).toEqual(Object.keys(docJsonFirst));
				},
			),
		);
	});

	it('Normalized Collection & Link Split Invariant: tags, headings, blocks, referencedLinks, links, and embeds satisfy structural bounds', async () => {
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
			fc.constant({ id: 'x' }),
			{ maxKeys: 6 },
		);
		const backlinksArb = fc.dictionary(
			fc.string({ minLength: 1, maxLength: 12 }),
			fc.record({ 'Notes/Doc.md': fc.integer({ min: -2, max: 5 }) }),
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
				backlinksArb,
				(tags, fmTags, headings, links, blocks, resolvedLinks) => {
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
						resolvedLinks,
						(target) => `Resolved/${target}.md`,
					);

					// 1. tags: non-empty, lowercase, starts with '#', strictly sorted & deduplicated
					for (let i = 0; i < doc.tags.length; i++) {
						const t = doc.tags[i]!;
						expect(t.startsWith('#')).toBe(true);
						expect(t.length).toBeGreaterThan(1);
						expect(t).toBe(t.toLowerCase());
						if (i > 0) {
							expect(doc.tags[i - 1]! < t).toBe(true);
						}
					}

					// 2. headings: level is always an integer in 1..6
					for (const h of doc.headings) {
						expect(Number.isInteger(h.level)).toBe(true);
						expect(h.level).toBeGreaterThanOrEqual(1);
						expect(h.level).toBeLessThanOrEqual(6);
					}

					// 3. blocks: always lowercase
					for (const b of doc.blocks) {
						expect(b).toBe(b.toLowerCase());
					}

					// 4. referencedLinks: strictly sorted & deduplicated, and only includes positive counts
					for (let i = 0; i < doc.referencedLinks.length; i++) {
						const src = doc.referencedLinks[i]!;
						expect(resolvedLinks[src]?.['Notes/Doc.md']).toBeGreaterThan(0);
						if (i > 0) {
							expect(doc.referencedLinks[i - 1]! < src).toBe(true);
						}
					}

					// 5. links & embeds: self-link vs target+subpath decomposition
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
					if (lowerKey === 'file.mtime' || lowerKey === 'file.ctime') {
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
});
