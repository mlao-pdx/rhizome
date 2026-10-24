import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	coercePropertyValue,
	compareDateIntervals,
	daysInMonth,
	MAX_SAFE_EPOCH_MS,
	parseSingleTemporalAtom,
	parseTemporalExpr,
	type DateInterval,
	type PropertyOperator,
	type TypedPropertyValue,
} from '../../src/core/search';
import { assertProperty } from '../support/assertProperty';

const TIME_ZONES = [
	'UTC',
	'America/New_York',
	'Europe/London',
	'Asia/Tokyo',
	'Pacific/Apia',
] as const;

const ALL_RELATIVE_ANCHORS = [
	'@now',
	'@today',
	'@thisday',
	'@yesterday',
	'@lastday',
	'@tomorrow',
	'@nextday',
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
] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad3 = (n: number): string => String(n).padStart(3, '0');
const pad4 = (n: number): string => String(n).padStart(4, '0');
const fmtOffset = (delta: number, withD: boolean): string =>
	`${delta >= 0 ? '+' : ''}${delta}${withD ? 'd' : ''}`;

const isoDateAtomArb: fc.Arbitrary<string> = fc.oneof(
	fc.integer({ min: 1970, max: 2100 }).map(pad4),
	fc
		.tuple(fc.integer({ min: 1970, max: 2100 }), fc.integer({ min: 1, max: 12 }))
		.map(([y, m]) => `${pad4(y)}-${pad2(m)}`),
	fc
		.tuple(
			fc.integer({ min: 1970, max: 2100 }),
			fc.integer({ min: 1, max: 12 }),
			fc.integer({ min: 1, max: 31 }),
		)
		.map(([y, m, d]) => `${pad4(y)}-${pad2(m)}-${pad2(d)}`),
	fc
		.tuple(
			fc.integer({ min: 1970, max: 2100 }),
			fc.integer({ min: 1, max: 12 }),
			fc.integer({ min: 1, max: 28 }),
			fc.integer({ min: 0, max: 23 }),
			fc.integer({ min: 0, max: 59 }),
			fc.constantFrom('', ':00', ':30', ':59.123Z', '+02:00', '-05:00'),
		)
		.map(
			([y, m, d, hh, mm, tail]) =>
				`${pad4(y)}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}${tail}`,
		),
);

const relativeAtomArb: fc.Arbitrary<string> = fc.oneof(
	fc.constantFrom(...ALL_RELATIVE_ANCHORS),
	fc
		.tuple(
			fc.constantFrom(
				'@today',
				'@yesterday',
				'@tomorrow',
				'@thisday',
				'@lastday',
				'@nextday',
			),
			fc.integer({ min: -365, max: 365 }),
			fc.boolean(),
		)
		.map(([base, delta, withD]) => `${base}${fmtOffset(delta, withD)}`),
);

const temporalAtomArb: fc.Arbitrary<string> = fc.oneof(isoDateAtomArb, relativeAtomArb);

const temporalExprArb: fc.Arbitrary<string> = fc.oneof(
	temporalAtomArb,
	fc.tuple(temporalAtomArb, temporalAtomArb).map(([a, b]) => `${a}..${b}`),
);

/**
 * Evaluates a temporal comparison operator against a coerced `TypedPropertyValue` entry,
 * enforcing Section 2.5 ("Null & Invalid Entry Rule"): entries with `kind === 'null'`
 * (from `null` or `undefined`) or `kind === 'invalid'` NEVER satisfy any operator
 * (including `!=` or `EXISTS`). Only document-level negation (`![k = Q]`) can match
 * a note whose entries fail `[k = Q]`.
 */
function evaluateTemporalPropertyEntry(
	entry: TypedPropertyValue,
	op: PropertyOperator,
	Q: DateInterval,
): boolean {
	if (entry.kind !== 'date' && entry.kind !== 'datetime') {
		return false;
	}
	if (op === 'EXISTS') return true;
	return compareDateIntervals(entry.interval, op, Q);
}

describe('search temporal property invariants', () => {
	it('Invariant 4b: parseTemporalExpr never throws for arbitrary referenceTimeMs values', async () => {
		const arbRefMs = fc.oneof(
			fc.double({ noDefaultInfinity: false, noNaN: false }),
			fc.integer(),
			fc.constantFrom(
				0,
				MAX_SAFE_EPOCH_MS,
				-MAX_SAFE_EPOCH_MS,
				MAX_SAFE_EPOCH_MS + 1,
				-MAX_SAFE_EPOCH_MS - 1,
				Number.MAX_SAFE_INTEGER,
				Number.MIN_SAFE_INTEGER,
			),
		);

		await assertProperty(
			'search/temporal__arbitrary-reference-time-never-throws',
			fc.property(
				temporalExprArb,
				fc.constantFrom(...TIME_ZONES),
				fc.boolean(),
				fc.boolean(),
				arbRefMs,
				(expr, timeZone, allowYearOnly, allowRelative, referenceTimeMs) => {
					const res = parseTemporalExpr(expr, {
						allowYearOnly,
						allowRelative,
						timeZone,
						referenceTimeMs,
					});
					expect(typeof res.ok).toBe('boolean');
				},
			),
		);
	});

	it('Invariant 6a: every ok parseTemporalExpr result is a frozen DateInterval with safe integer start < end, self-range A..A matches atom A, and every REVERSED_RANGE has a valid swappable hint', async () => {
		const ordinaryRefArb = fc.integer({
			min: Date.parse('1970-01-01T00:00:00.000Z'),
			max: Date.parse('2100-12-31T23:59:59.999Z'),
		});

		await assertProperty(
			'search/temporal__ok-intervals-are-valid-and-frozen',
			fc.property(
				temporalExprArb,
				fc.constantFrom(...TIME_ZONES),
				fc.boolean(),
				fc.boolean(),
				ordinaryRefArb,
				(expr, timeZone, allowYearOnly, allowRelative, referenceTimeMs) => {
					const opts = {
						allowYearOnly,
						allowRelative,
						timeZone,
						referenceTimeMs,
					};
					const res = parseTemporalExpr(expr, opts);
					if (res.ok) {
						expect(Object.isFrozen(res.interval)).toBe(true);
						expect(Number.isSafeInteger(res.interval.start)).toBe(true);
						expect(Number.isSafeInteger(res.interval.end)).toBe(true);
						expect(res.interval.start).toBeLessThan(res.interval.end);

						// Self-range identity: if expr is a single atom A (no '..'), then A..A is valid
						// and produces the exact same [start, end) interval as A.
						if (!expr.includes('..')) {
							const selfRange = parseTemporalExpr(`${expr}..${expr}`, opts);
							expect(selfRange.ok).toBe(true);
							if (selfRange.ok) {
								expect(selfRange.interval.start).toBe(res.interval.start);
								expect(selfRange.interval.end).toBe(res.interval.end);
								expect(selfRange.interval.grain).toBe('range');
								expect(
									compareDateIntervals(res.interval, '=', selfRange.interval),
								).toBe(true);
								expect(
									compareDateIntervals(selfRange.interval, '=', res.interval),
								).toBe(true);
							}
						}
					} else if (res.reason === 'REVERSED_RANGE') {
						// Because s1 >= e2 on two valid atoms (s1 < e1 and s2 < e2) implies s2 < e2 <= s1 < e1,
						// s2 < e1 always holds and swapping endpoints always produces a valid range.
						expect(res.hint).toBe(`Use ${res.rightRaw}..${res.leftRaw}`);
						const swapped = parseTemporalExpr(`${res.rightRaw}..${res.leftRaw}`, opts);
						expect(swapped.ok).toBe(true);
					}
				},
			),
		);
	});

	it('Invariant 6b: relative day aliases and arbitrary day-offset shifts (@yesterday+(k+1)d, @today+kd, @tomorrow+(k-1)d) agree and abut across timezones', async () => {
		const refArb = fc.integer({
			min: Date.parse('1970-01-01T00:00:00.000Z'),
			max: Date.parse('2100-12-31T23:59:59.999Z'),
		});

		await assertProperty(
			'search/temporal__relative-day-alias-equivalence',
			fc.property(
				fc.constantFrom(...TIME_ZONES),
				refArb,
				fc.integer({ min: -36524, max: 36524 }),
				fc.boolean(),
				(timeZone, referenceTimeMs, k, withD) => {
					const opts = {
						allowYearOnly: true,
						allowRelative: true,
						timeZone,
						referenceTimeMs,
					};

					const shiftedFamily: string[] = [
						`@today${fmtOffset(k, withD)}`,
						`@thisday${fmtOffset(k, withD)}`,
						`@yesterday${fmtOffset(k + 1, withD)}`,
						`@lastday${fmtOffset(k + 1, withD)}`,
						`@tomorrow${fmtOffset(k - 1, withD)}`,
						`@nextday${fmtOffset(k - 1, withD)}`,
					];
					if (k === -1) shiftedFamily.push('@yesterday', '@lastday');
					if (k === 0) shiftedFamily.push('@today', '@thisday', '@today-0d', '@today+0d');
					if (k === 1) shiftedFamily.push('@tomorrow', '@nextday');

					const first = parseTemporalExpr(shiftedFamily[0]!, opts);
					for (const expr of shiftedFamily.slice(1)) {
						const current = parseTemporalExpr(expr, opts);
						expect(current.ok).toBe(first.ok);
						if (first.ok && current.ok) {
							expect(current.interval.start).toBe(first.interval.start);
							expect(current.interval.end).toBe(first.interval.end);
							expect(current.interval.grain).toBe(first.interval.grain);
						} else if (!first.ok && !current.ok) {
							expect(current.reason).toBe(first.reason);
						}
					}

					// Consecutive day offsets k and k+1 abut when neither day is skipped
					const nextDayRes = parseTemporalExpr(`@today${fmtOffset(k + 1, true)}`, opts);
					if (first.ok && nextDayRes.ok) {
						expect(first.interval.end).toBe(nextDayRes.interval.start);
						expect(compareDateIntervals(first.interval, '<', nextDayRes.interval)).toBe(
							true,
						);
						expect(compareDateIntervals(nextDayRes.interval, '>', first.interval)).toBe(
							true,
						);
					}
				},
			),
		);
	});

	it('Invariant 6c: ordinary reference times (1970..2100) resolve all 19 relative anchors, form contiguous [@last*, @this*, @next*] partitions, and satisfy cross-grain @today containment/ordering', async () => {
		const ordinaryRefArb = fc.integer({
			min: Date.parse('1970-01-01T00:00:00.000Z'),
			max: Date.parse('2100-12-31T23:59:59.999Z'),
		});

		const tripletUnits = ['day', 'week', 'month', 'quarter', 'year'] as const;

		await assertProperty(
			'search/temporal__ordinary-reference-times-resolve-all-anchors',
			fc.property(
				fc.constantFrom('UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'),
				ordinaryRefArb,
				(timeZone, referenceTimeMs) => {
					const opts = {
						allowYearOnly: true,
						allowRelative: true,
						timeZone,
						referenceTimeMs,
					};
					for (const anchor of ALL_RELATIVE_ANCHORS) {
						const res = parseTemporalExpr(anchor, opts);
						expect(res.ok).toBe(true);
						if (res.ok) {
							expect(res.interval.start).toBeLessThan(res.interval.end);
						}
					}

					const nowRes = parseTemporalExpr('@now', opts);
					const todayRes = parseTemporalExpr('@today', opts);
					expect(nowRes.ok && todayRes.ok).toBe(true);
					if (!nowRes.ok || !todayRes.ok) return;

					// @now is contained in @today
					expect(compareDateIntervals(nowRes.interval, '=', todayRes.interval)).toBe(
						true,
					);

					for (const unit of tripletUnits) {
						const lastRes = parseTemporalExpr(`@last${unit}`, opts);
						const thisRes = parseTemporalExpr(`@this${unit}`, opts);
						const nextRes = parseTemporalExpr(`@next${unit}`, opts);
						const spanRes = parseTemporalExpr(`@last${unit}..@next${unit}`, opts);

						expect(lastRes.ok && thisRes.ok && nextRes.ok && spanRes.ok).toBe(true);
						if (lastRes.ok && thisRes.ok && nextRes.ok && spanRes.ok) {
							// Contiguous abutting boundaries: [s1, e1) + [s2, e2) + [s3, e3) where e1 === s2 and e2 === s3
							expect(lastRes.interval.end).toBe(thisRes.interval.start);
							expect(thisRes.interval.end).toBe(nextRes.interval.start);

							// Reference instant falls inside @this<unit>
							expect(thisRes.interval.start).toBeLessThanOrEqual(referenceTimeMs);
							expect(referenceTimeMs).toBeLessThan(thisRes.interval.end);

							// Cross-grain containment & ordering for @today against @this<unit>, @next<unit>, and @last<unit>:
							// - @today = @this(day|week|month|quarter|year)
							// - @today < @next(day|week|month|quarter|year)
							// - @today > @last(day|week|month|quarter|year)
							expect(
								compareDateIntervals(todayRes.interval, '=', thisRes.interval),
							).toBe(true);
							expect(
								compareDateIntervals(todayRes.interval, '<', nextRes.interval),
							).toBe(true);
							expect(
								compareDateIntervals(todayRes.interval, '>', lastRes.interval),
							).toBe(true);

							// Full @last<unit>..@next<unit> range equals the union of the three contiguous periods
							expect(spanRes.interval.start).toBe(lastRes.interval.start);
							expect(spanRes.interval.end).toBe(nextRes.interval.end);
							expect(spanRes.interval.end - spanRes.interval.start).toBe(
								lastRes.interval.end -
									lastRes.interval.start +
									(thisRes.interval.end - thisRes.interval.start) +
									(nextRes.interval.end - nextRes.interval.start),
							);
						}
					}

					// Calendar hierarchy chain: @thisday ⊆ @thismonth ⊆ @thisquarter ⊆ @thisyear
					const thisMonth = parseTemporalExpr('@thismonth', opts);
					const thisQuarter = parseTemporalExpr('@thisquarter', opts);
					const thisYear = parseTemporalExpr('@thisyear', opts);
					if (thisMonth.ok && thisQuarter.ok && thisYear.ok) {
						expect(
							compareDateIntervals(thisMonth.interval, '=', thisQuarter.interval),
						).toBe(true);
						expect(
							compareDateIntervals(thisQuarter.interval, '=', thisYear.interval),
						).toBe(true);
					}
				},
			),
		);
	});

	it('Invariant 6d: point timestamp interval D = [t, t+1) partitions {<, =, >} and satisfies (= iff >= && <=) against any valid DateInterval Q', async () => {
		const pointTimeArb = fc.integer({
			min: -10_000_000_000_000,
			max: 10_000_000_000_000,
		});
		const queryIntervalArb: fc.Arbitrary<DateInterval> = fc
			.tuple(
				fc.integer({ min: -10_000_000_000_000, max: 10_000_000_000_000 }),
				fc.integer({ min: 1, max: 100_000_000_000 }),
			)
			.map(([start, span]) =>
				Object.freeze({
					start,
					end: start + span,
					grain: 'range' as const,
					raw: 'Q',
				}),
			);

		await assertProperty(
			'search/temporal__point-timestamp-partitioning',
			fc.property(pointTimeArb, queryIntervalArb, (t, Q) => {
				const D: DateInterval = Object.freeze({
					start: t,
					end: t + 1,
					grain: 'ms',
					raw: 'D',
				});

				const isLt = compareDateIntervals(D, '<', Q);
				const isEq = compareDateIntervals(D, '=', Q);
				const isGt = compareDateIntervals(D, '>', Q);
				const isGte = compareDateIntervals(D, '>=', Q);
				const isLte = compareDateIntervals(D, '<=', Q);
				const isNeq = compareDateIntervals(D, '!=', Q);

				const trueCount = Number(isLt) + Number(isEq) + Number(isGt);
				expect(trueCount).toBe(1);
				expect(isEq).toBe(isGte && isLte);
				expect(isNeq).toBe(!isEq);
			}),
		);
	});

	it('Invariant 6e: general interval algebra on valid DateIntervals D, Q, R and non-complementarity of != vs NOT on null/undefined/invalid property entries', async () => {
		const intervalArb: fc.Arbitrary<DateInterval> = fc
			.tuple(
				fc.integer({ min: -10_000_000_000_000, max: 10_000_000_000_000 }),
				fc.integer({ min: 1, max: 100_000_000_000 }),
			)
			.map(([start, span]) =>
				Object.freeze({
					start,
					end: start + span,
					grain: 'range' as const,
					raw: 'I',
				}),
			);

		const nullOrInvalidInputArb = fc.oneof(
			fc.constantFrom(
				null,
				undefined,
				'',
				'not-a-date',
				'2026-02-31',
				'2026-10-15..2026-10-01',
				'@today',
			),
			fc.boolean(),
			fc.double({ noDefaultInfinity: false, noNaN: false }),
		);

		await assertProperty(
			'search/temporal__general-interval-algebra-and-null-negation-semantics',
			fc.property(
				intervalArb,
				intervalArb,
				intervalArb,
				nullOrInvalidInputArb,
				fc.constantFrom('date' as const, 'datetime' as const),
				(D, Q, R, badRaw, propType) => {
					const isEq = compareDateIntervals(D, '=', Q);
					const isNeq = compareDateIntervals(D, '!=', Q);
					const isLt = compareDateIntervals(D, '<', Q);
					const isGt = compareDateIntervals(D, '>', Q);
					const isLte = compareDateIntervals(D, '<=', Q);
					const isGte = compareDateIntervals(D, '>=', Q);

					// 1. Pure valid DateInterval laws:
					// Containment (=) is equivalent to (>= && <=), and (!=) is !(D = Q) on valid intervals
					expect(isEq).toBe(isGte && isLte);
					expect(isNeq).toBe(!isEq);

					// Reflexivity & antisymmetry of containment (=)
					expect(compareDateIntervals(D, '=', D)).toBe(true);
					if (isEq && compareDateIntervals(Q, '=', D)) {
						expect(D.start).toBe(Q.start);
						expect(D.end).toBe(Q.end);
					}

					// Transitivity of containment (=)
					if (isEq && compareDateIntervals(Q, '=', R)) {
						expect(compareDateIntervals(D, '=', R)).toBe(true);
					}

					// Converse duality of strict before/after: (D < Q) iff (Q > D)
					expect(isLt).toBe(compareDateIntervals(Q, '>', D));
					expect(isGt).toBe(compareDateIntervals(Q, '<', D));

					// Strict order implies weak order and excludes containment
					if (isLt) {
						expect(isLte).toBe(true);
						expect(isGte).toBe(false);
						expect(isEq).toBe(false);
						expect(isGt).toBe(false);
					}
					if (isGt) {
						expect(isGte).toBe(true);
						expect(isLte).toBe(false);
						expect(isEq).toBe(false);
						expect(isLt).toBe(false);
					}

					// At most one of <, =, > can hold (wider or overlapping intervals satisfy 0 of the 3)
					expect(Number(isLt) + Number(isEq) + Number(isGt)).toBeLessThanOrEqual(1);

					// 2. Null / undefined / invalid property entry semantics vs document-level NOT:
					// Per Section 2.5 ("Null & Invalid Entry Rule"), null/undefined/invalid entries
					// produce { kind: 'null' } or { kind: 'invalid' } and NEVER satisfy ANY operator
					// (including '!=' and 'EXISTS'). Thus `[k != Q]` is false, whereas document-level
					// `NOT [k = Q]` (!evaluateTemporalPropertyEntry(coerced, '=', Q)) is true!
					const coerced = coercePropertyValue(badRaw, propType, 'UTC');
					expect(coerced.kind === 'null' || coerced.kind === 'invalid').toBe(true);

					for (const op of ['EXISTS', ':', '=', '!=', '<', '>', '<=', '>='] as const) {
						expect(evaluateTemporalPropertyEntry(coerced, op, Q)).toBe(false);
					}
					const docLevelNotEq = !evaluateTemporalPropertyEntry(coerced, '=', Q);
					expect(docLevelNotEq).toBe(true);
				},
			),
		);
	});

	it('Invariant 6f: ISO prefix-grain nesting (ms < second < minute < day < month < year) and explicit offset timezone invariance', async () => {
		const calendarTimestampArb = fc.tuple(
			fc.integer({ min: 1970, max: 2100 }),
			fc.integer({ min: 1, max: 12 }),
			fc.integer({ min: 1, max: 31 }),
			fc.integer({ min: 0, max: 23 }),
			fc.integer({ min: 0, max: 59 }),
			fc.integer({ min: 0, max: 59 }),
			fc.integer({ min: 0, max: 999 }),
			fc.constantFrom('Z', '+00:00', '+02:00', '-05:00', '+05:30', '-0800'),
		);

		await assertProperty(
			'search/temporal__iso-prefix-hierarchy-and-explicit-offset-invariance',
			fc.property(
				fc.constantFrom('UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'),
				calendarTimestampArb,
				(timeZone, [year, month, rawDay, hour, minute, second, ms, tzSuffix]) => {
					const maxDay = daysInMonth(year, month);
					const day = Math.min(rawDay, maxDay);

					const yStr = pad4(year);
					const ymStr = `${yStr}-${pad2(month)}`;
					const ymdStr = `${ymStr}-${pad2(day)}`;
					const ymdHmStr = `${ymdStr}T${pad2(hour)}:${pad2(minute)}`;
					const ymdHmsStr = `${ymdHmStr}:${pad2(second)}`;
					const ymdHmsMsStr = `${ymdHmsStr}.${pad3(ms)}`;

					const opts = {
						allowYearOnly: true,
						allowRelative: false,
						timeZone,
					};

					const yRes = parseSingleTemporalAtom(yStr, opts);
					const ymRes = parseSingleTemporalAtom(ymStr, opts);
					const ymdRes = parseSingleTemporalAtom(ymdStr, opts);
					const ymdHmRes = parseSingleTemporalAtom(ymdHmStr, opts);
					const ymdHmsRes = parseSingleTemporalAtom(ymdHmsStr, opts);
					const ymdHmsMsRes = parseSingleTemporalAtom(ymdHmsMsStr, opts);

					expect(
						yRes.ok &&
							ymRes.ok &&
							ymdRes.ok &&
							ymdHmRes.ok &&
							ymdHmsRes.ok &&
							ymdHmsMsRes.ok,
					).toBe(true);

					if (
						yRes.ok &&
						ymRes.ok &&
						ymdRes.ok &&
						ymdHmRes.ok &&
						ymdHmsRes.ok &&
						ymdHmsMsRes.ok
					) {
						// Prefix containment chain: ms ⊆ second ⊆ minute ⊆ day ⊆ month ⊆ year
						expect(
							compareDateIntervals(ymdHmsMsRes.interval, '=', ymdHmsRes.interval),
						).toBe(true);
						expect(
							compareDateIntervals(ymdHmsRes.interval, '=', ymdHmRes.interval),
						).toBe(true);
						expect(compareDateIntervals(ymdHmRes.interval, '=', ymdRes.interval)).toBe(
							true,
						);
						expect(compareDateIntervals(ymdRes.interval, '=', ymRes.interval)).toBe(
							true,
						);
						expect(compareDateIntervals(ymRes.interval, '=', yRes.interval)).toBe(true);

						// First day and last day of month align with month boundaries
						const firstDayRes = parseSingleTemporalAtom(`${ymStr}-01`, opts);
						const lastDayRes = parseSingleTemporalAtom(
							`${ymStr}-${pad2(maxDay)}`,
							opts,
						);
						if (firstDayRes.ok && lastDayRes.ok) {
							expect(firstDayRes.interval.start).toBe(ymRes.interval.start);
							expect(lastDayRes.interval.end).toBe(ymRes.interval.end);
						}

						// Jan and Dec align with year boundaries
						if (month === 1) {
							expect(ymRes.interval.start).toBe(yRes.interval.start);
						}
						if (month === 12) {
							expect(ymRes.interval.end).toBe(yRes.interval.end);
						}
					}

					// Explicit offset invariance: parsing with tzSuffix produces identical { start, end, grain }
					// across all configured IANA timezones
					const explicitLiteral = `${ymdHmsMsStr}${tzSuffix}`;
					const utcParsed = parseSingleTemporalAtom(explicitLiteral, {
						allowYearOnly: true,
						allowRelative: false,
						timeZone: 'UTC',
					});
					const localParsed = parseSingleTemporalAtom(explicitLiteral, opts);
					expect(utcParsed.ok).toBe(true);
					expect(localParsed.ok).toBe(true);
					if (utcParsed.ok && localParsed.ok) {
						expect(localParsed.interval.start).toBe(utcParsed.interval.start);
						expect(localParsed.interval.end).toBe(utcParsed.interval.end);
						expect(localParsed.interval.grain).toBe(utcParsed.interval.grain);
					}
				},
			),
		);
	});
});
