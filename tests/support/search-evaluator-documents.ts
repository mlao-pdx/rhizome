import * as fc from 'fast-check';
import {
	compileQuery,
	initEngineConfig,
	normalizeObsidianMetadata,
	type NormalizedDocument,
	type PreparedQuery,
	type ResolvedEngineConfig,
} from '../../src/core/search';
import { textArb } from './search-evaluator-queries';

export const timeZoneArb = fc.constantFrom(
	'UTC',
	'America/New_York',
	'Europe/London',
	'Asia/Tokyo',
	'Pacific/Apia',
);
export const referenceTimeArb = fc.integer({
	min: Date.parse('2024-01-01T00:00:00Z'),
	max: Date.parse('2028-12-31T23:59:59.999Z'),
});

const propertyKeyArb = fc.constantFrom(
	'score',
	'Score',
	' SCORE ',
	'priority',
	'due',
	'meeting',
	'sprint',
	'status',
	'labels',
	'topics',
	'done',
	'aliases',
	'tags',
	'unknown',
	'file.size',
	'file.modified',
	'file.created',
);
const scalarArb = fc.oneof(
	textArb,
	fc.integer({ min: -30, max: 30 }),
	fc.boolean(),
	fc.constant(null),
	fc.constant(undefined),
	fc.constantFrom(
		'2026-10-22',
		'2026-11-01',
		'2026-10',
		'2026-10-22T12:00:00Z',
		'2026-01-01..2026-12-31',
		'2026-10-01..2026-01-01',
		'2011-12-30',
		'@today',
		'not-a-number',
		' 1.5e2 ',
		' TRUE ',
	),
);
const rawValueArb = fc.oneof(
	scalarArb,
	fc.array(scalarArb, { maxLength: 4 }),
	fc.array(fc.array(scalarArb, { maxLength: 2 }), { maxLength: 2 }),
);
const linkArb = fc.record({
	link: fc.oneof(
		textArb,
		fc.constantFrom('alpha', '#Intro', '^block', 'beta#Summary', 'Missing'),
	),
	displayText: textArb,
});

export const documentInputArb = fc.record({
	basename: fc.constantFrom('alpha', 'beta', 'work', 'draft', 'report'),
	folder: fc.constantFrom('', 'Notes', 'Projects/Active', 'Archive'),
	extension: fc.constantFrom('md', 'pdf', 'txt'),
	ctime: referenceTimeArb,
	mtime: referenceTimeArb,
	size: fc.integer({ min: 0, max: 4096 }),
	cacheMissing: fc.boolean(),
	frontmatter: fc.array(fc.tuple(propertyKeyArb, rawValueArb), { maxLength: 10 }),
	inline: fc.array(
		fc.record({
			key: propertyKeyArb,
			value: rawValueArb,
			line: fc.integer({ min: 1, max: 100 }),
		}),
		{ maxLength: 6 },
	),
	tags: fc.array(
		fc.record({ tag: fc.oneof(textArb, fc.constantFrom('#work', '#work/urgent', '#alpha')) }),
		{ maxLength: 4 },
	),
	headings: fc.array(fc.record({ heading: textArb, level: fc.integer({ min: 1, max: 6 }) }), {
		maxLength: 4,
	}),
	links: fc.array(linkArb, { maxLength: 3 }),
	embeds: fc.array(linkArb, { maxLength: 3 }),
	blocks: fc.array(textArb, { maxLength: 3 }),
});

export type DocumentInput = typeof documentInputArb extends fc.Arbitrary<infer T> ? T : never;

export const evaluationCaseArb = fc.record({
	timeZone: timeZoneArb,
	referenceTimeMs: referenceTimeArb,
	documents: fc.array(documentInputArb, { maxLength: 6 }),
});

export function evaluatorConfig(timeZone: string): ResolvedEngineConfig {
	const result = initEngineConfig({
		timeZone,
		propertyTypes: {
			score: 'number',
			priority: 'number',
			due: 'date',
			meeting: 'datetime',
			sprint: 'date',
			status: 'text',
			labels: 'multitext',
			topics: 'tags',
			done: 'checkbox',
		},
		customScopes: [
			{
				canonicalName: 'Tasks',
				aliases: ['task'],
				extract: (doc) => doc.aliases,
				matchString: (target, query, quoted) =>
					quoted
						? target.toLowerCase() === query.toLowerCase()
						: target.toLowerCase().includes(query.toLowerCase()),
			},
		],
	});
	if (!result.ok) throw new Error(`Invalid evaluator fixture config: ${timeZone}`);
	return result.config;
}

export function evaluatorQuery(
	input: string,
	config: ResolvedEngineConfig,
	referenceTimeMs: number,
): PreparedQuery {
	const result = compileQuery(input, config, referenceTimeMs);
	if (!result.executable || !result.prepared) {
		throw new Error(
			`Generated query is not executable: ${JSON.stringify(input)}; ${JSON.stringify(result.diagnostics)}`,
		);
	}
	return result.prepared;
}

export function evaluatorVault(
	inputs: readonly DocumentInput[],
	config: ResolvedEngineConfig,
): NormalizedDocument[] {
	return inputs.map((input, index) => {
		const basename = `${input.basename}-${index}`;
		const name = `${basename}.${input.extension}`;
		const path = input.folder ? `${input.folder}/${name}` : name;
		return normalizeObsidianMetadata(
			{
				path,
				name,
				basename,
				extension: input.extension,
				parent: { path: input.folder },
				stat: { ctime: input.ctime, mtime: input.mtime, size: input.size },
			},
			input.cacheMissing
				? null
				: {
						frontmatter: Object.fromEntries(input.frontmatter),
						tags: input.tags,
						headings: input.headings,
						links: input.links,
						frontmatterLinks: input.links,
						embeds: input.embeds,
						blocks: Object.fromEntries(input.blocks.map((id) => [id, { id }])),
					},
			config,
			input.inline,
			(rawTarget) => (rawTarget === 'Missing' ? null : `Resolved/${rawTarget}.md`),
		);
	});
}
