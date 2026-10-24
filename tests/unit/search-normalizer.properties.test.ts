import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	coercePropertyValue,
	FORBIDDEN_KEYS,
	initEngineConfig,
	isCleanSanitizedScalar,
	normalizeObsidianMetadata,
	VALID_PROPERTY_TYPES_LIST,
	type InlinePropertyInput,
	type ObsidianPropertyType,
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
});
