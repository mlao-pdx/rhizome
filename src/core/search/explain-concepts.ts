import { Temporal } from '@js-temporal/polyfill';
import type { ResolvedPropertyTypeInfo } from './explain-helpers';

/**
 * Canonical identifiers for the 8 context-filtered Concept Reference cards in `rhizome-sample`.
 */
export type ExplainConceptKey =
	| 'temporal-intervals'
	| 'graph-traversal'
	| 'cross-query-waves'
	| 'property-coercion'
	| 'template-graph-joins'
	| 'relative-headings'
	| 'partials-and-layouts'
	| 'template-modes-virtual-this';

/**
 * Deterministic display order for triggered `ExplainConceptKey` topics (Spec §8).
 */
export const EXPLAIN_CONCEPT_ORDER: readonly ExplainConceptKey[] = Object.freeze([
	'temporal-intervals',
	'graph-traversal',
	'cross-query-waves',
	'property-coercion',
	'template-graph-joins',
	'relative-headings',
	'partials-and-layouts',
	'template-modes-virtual-this',
]);

/**
 * Formats a concise inline property-type and origin badge for footnote-free AST bullets.
 */
export function formatPropertyTypeInlineBadge(typeInfo: ResolvedPropertyTypeInfo): string {
	if (typeInfo.origin === 'virtual') {
		return `*(virtual \`${typeInfo.type}\`)*`;
	}
	if (typeInfo.origin === 'configured') {
		return `*(\`${typeInfo.type}\` in \`types.json\`)*`;
	}
	return '*(untyped → `text`)*';
}

/**
 * Renders the Mermaid Gantt diagram illustrating half-open `[start, end)` interval comparisons
 * anchored around `referenceTimeMs` in `timeZone`. Emitted at most once per codeblock inside
 * the `'temporal-intervals'` Concepts Reference card.
 */
export function renderIntervalComparisonDiagram(referenceTimeMs: number, timeZone: string): string {
	let today: Temporal.PlainDate;
	try {
		today = Temporal.Instant.fromEpochMilliseconds(referenceTimeMs)
			.toZonedDateTimeISO(timeZone)
			.toPlainDate();
	} catch {
		today = Temporal.Instant.fromEpochMilliseconds(referenceTimeMs)
			.toZonedDateTimeISO('UTC')
			.toPlainDate();
	}
	const day = (offset: number): string => {
		try {
			return today.add({ days: offset }).toString();
		} catch {
			return today.toString();
		}
	};

	return [
		'```mermaid',
		'gantt',
		'    title [Half-Open) Interval Comparison Matches',
		'    dateFormat YYYY-MM-DD',
		'    axisFormat %Y-%m-%d',
		'    tickInterval 1day',
		'    todayMarker off',
		'',
		'    section Given',
		`    [${day(-1)} <= Criteria < ${day(2)})            :crit,   ${day(-1)}, ${day(2)}`,
		'',
		'    section : OR =',
		`    Value matches exactly           :active, ${day(-1)}, ${day(2)}`,
		`    Value starts and ends within    :active, ${day(0)}, ${day(1)}`,
		'',
		'    section !=',
		`    Value starts before             :active, ${day(-2)}, ${day(1)}`,
		`    Value ends after                :active, ${day(0)}, ${day(3)}`,
		'',
		'    section <',
		`    Value ends at start or before   :active, ${day(-2)}, ${day(-1)}`,
		'',
		'    section <=',
		`    Value ends at end or before     :active, ${day(-2)}, ${day(2)}`,
		'',
		'    section >=',
		`    Value starts at start or after  :active, ${day(-1)}, ${day(3)}`,
		'',
		'    section >',
		`    Value starts at end or after    :active, ${day(2)}, ${day(3)}`,
		'',
		'    section some<br>built-ins',
		`    @yesterday                      :active, ${day(-1)}, ${day(0)}`,
		`    @today                          :active, ${day(0)}, ${day(1)}`,
		`    @tomorrow                       :active, ${day(1)}, ${day(2)}`,
		'```',
	].join('\n');
}
