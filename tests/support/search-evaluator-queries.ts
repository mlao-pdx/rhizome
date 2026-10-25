import * as fc from 'fast-check';
import { BUILT_IN_SCOPES, VIRTUAL_FILE_KEYS_LIST } from '../../src/core/search';

export const textArb = fc.oneof(
	fc.constantFrom(
		'alpha',
		'beta',
		'work',
		'work/urgent',
		'draft',
		'Intro',
		'Summary',
		'open',
		'done',
		'true',
		'false',
		'md',
		'',
	),
	fc.string({ maxLength: 16 }),
);

export function quoteQueryString(value: string): string {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`;
}

const regexArb = fc
	.tuple(
		fc.boolean(),
		fc.array(fc.constantFrom('alpha', 'work', '[a-z]', '[0-9]', '\\.', '\\/', '-'), {
			minLength: 1,
			maxLength: 3,
		}),
		fc.boolean(),
		fc.subarray(['i', 'm', 's', 'u']),
	)
	.map(
		([start, atoms, end, flags]) =>
			`/${start ? '^' : ''}${atoms.join('')}${end ? '$' : ''}/${flags.join('')}`,
	);

export const valueLeafArb = fc.oneof(
	textArb.map(quoteQueryString),
	fc.constantFrom('alpha', 'beta', 'work', 'draft', 'open', 'true', 'false'),
	regexArb,
);

export function logicalQuery(operator: 'AND' | 'OR', left: string, right: string): string {
	return `(${left}) ${operator} (${right})`;
}

function nestedQuery(leafArb: fc.Arbitrary<string>, depth: number): fc.Arbitrary<string> {
	if (depth === 0) return leafArb;
	const child = nestedQuery(leafArb, depth - 1);
	return fc.oneof(
		{ weight: 3, arbitrary: leafArb },
		{ weight: 1, arbitrary: child.map((query) => `NOT (${query})`) },
		{
			weight: 1,
			arbitrary: fc
				.tuple(fc.constantFrom('AND' as const, 'OR' as const), child, child)
				.map(([op, a, b]) => logicalQuery(op, a, b)),
		},
	);
}

export const valueExprArb = nestedQuery(valueLeafArb, 1);
export const scopeArb = fc.constantFrom(
	...BUILT_IN_SCOPES.map((scope) => scope.canonicalName),
	'filename',
	'folder',
	'extension',
	'alias',
	'header',
	'block',
	'task',
);
export const colonPropertyArb = fc.constantFrom(
	'status',
	'labels',
	'topics',
	'tags',
	'aliases',
	'score',
	'due',
	'meeting',
);
export const temporalLiteralArb = fc.constantFrom(
	'2026',
	'2026-10',
	'2026-10-22',
	'2026-11-01',
	'2026-10-22T14:00:00+02:00',
	'2026-10-01..2026-10-22',
	'@now',
	'@today',
	'@yesterday',
	'@tomorrow',
	'@lastweek',
	'@thisweek',
	'@nextweek',
	'@lastmonth',
	'@thismonth',
	'@nextmonth',
	'@lastquarter',
	'@thisquarter',
	'@nextquarter',
	'@lastyear',
	'@thisyear',
	'@nextyear',
	'@today-7d..@today',
	'@thisyear..@today',
);

const comparisonOperatorArb = fc.constantFrom('=', '!=', '<', '>', '<=', '>=');
const numberComparisonArb = fc
	.tuple(
		fc.constantFrom('score', 'priority', '" SCORE "', 'file.size'),
		comparisonOperatorArb,
		fc.integer({ min: -300, max: 300 }),
	)
	.map(([key, op, tenths]) => `[${key} ${op} ${tenths / 10}]`);
const checkboxComparisonArb = fc
	.tuple(fc.constantFrom('=', '!='), fc.boolean())
	.map(([op, value]) => `[done ${op} ${value}]`);
const temporalComparisonArb = fc
	.tuple(
		fc.constantFrom('due', 'meeting', 'sprint', 'file.mtime', 'file.ctime'),
		comparisonOperatorArb,
		temporalLiteralArb,
	)
	.map(([key, op, value]) => `[${key} ${op} ${value}]`);
const textComparisonArb = fc
	.tuple(
		fc.constantFrom(
			'status',
			'labels',
			'topics',
			'tags',
			'aliases',
			'unknown',
			...VIRTUAL_FILE_KEYS_LIST.filter(
				(key) => !['file.mtime', 'file.ctime', 'file.size'].includes(key),
			),
		),
		comparisonOperatorArb,
		textArb,
	)
	.map(([key, op, value]) => `[${key} ${op} ${quoteQueryString(value)}]`);
const propertyColonArb = fc
	.tuple(colonPropertyArb, valueExprArb)
	.map(([key, expr]) => `[${key}: (${expr})]`);
const checkboxColonArb = nestedQuery(fc.constantFrom('true', 'false'), 1).map(
	(expr) => `[done: (${expr})]`,
);
const existsArb = fc
	.constantFrom(
		'score',
		'priority',
		'due',
		'meeting',
		'sprint',
		'status',
		'labels',
		'topics',
		'tags',
		'aliases',
		'done',
		'unknown',
		...VIRTUAL_FILE_KEYS_LIST,
	)
	.map((key) => `[${key}]`);
const scopedArb = fc.tuple(scopeArb, valueExprArb).map(([scope, expr]) => `${scope}:(${expr})`);
const atomArb = fc.oneof(
	valueLeafArb,
	fc.constant('#work/urgent'),
	scopedArb,
	existsArb,
	propertyColonArb,
	checkboxColonArb,
	numberComparisonArb,
	checkboxComparisonArb,
	temporalComparisonArb,
	textComparisonArb,
);

export const executableQueryArb = nestedQuery(atomArb, 3);
export const rootQueryArb = fc.oneof(fc.constant(''), executableQueryArb);
