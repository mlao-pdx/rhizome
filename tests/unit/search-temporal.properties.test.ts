import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	compareDateIntervals,
	MAX_SAFE_EPOCH_MS,
	parseTemporalExpr,
	type DateInterval,
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
const pad4 = (n: number): string => String(n).padStart(4, '0');

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
		.map(([base, delta, withD]) => {
			const sign = delta >= 0 ? '+' : '';
			return `${base}${sign}${delta}${withD ? 'd' : ''}`;
		}),
);

const temporalAtomArb: fc.Arbitrary<string> = fc.oneof(isoDateAtomArb, relativeAtomArb);

const temporalExprArb: fc.Arbitrary<string> = fc.oneof(
	temporalAtomArb,
	fc.tuple(temporalAtomArb, temporalAtomArb).map(([a, b]) => `${a}..${b}`),
);

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

	it('Invariant 6a: every ok parseTemporalExpr result is a frozen DateInterval with safe integer start < end, and every REVERSED_RANGE has a valid swappable hint', async () => {
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

	it('Invariant 6b: relative day aliases (@yesterday/@lastday/@today-1d, @today/@thisday/@today+0d, @tomorrow/@nextday/@today+1d) agree across timezones', async () => {
		const refArb = fc.integer({
			min: Date.parse('1970-01-01T00:00:00.000Z'),
			max: Date.parse('2100-12-31T23:59:59.999Z'),
		});

		const aliasFamilies: ReadonlyArray<readonly [string, ...string[]]> = [
			['@yesterday', '@lastday', '@today-1d', '@today-1'],
			['@today', '@thisday', '@today+0d', '@today-0d', '@today+0'],
			['@tomorrow', '@nextday', '@today+1d', '@today+1'],
		];

		await assertProperty(
			'search/temporal__relative-day-alias-equivalence',
			fc.property(
				fc.constantFrom(...TIME_ZONES),
				refArb,
				fc.constantFrom(...aliasFamilies),
				(timeZone, referenceTimeMs, family) => {
					const opts = {
						allowYearOnly: true,
						allowRelative: true,
						timeZone,
						referenceTimeMs,
					};
					const first = parseTemporalExpr(family[0], opts);
					for (const alias of family.slice(1)) {
						const current = parseTemporalExpr(alias, opts);
						expect(current.ok).toBe(first.ok);
						if (first.ok && current.ok) {
							expect(current.interval.start).toBe(first.interval.start);
							expect(current.interval.end).toBe(first.interval.end);
							expect(current.interval.grain).toBe(first.interval.grain);
						} else if (!first.ok && !current.ok) {
							expect(current.reason).toBe(first.reason);
						}
					}
				},
			),
		);
	});

	it('Invariant 6c: ordinary reference times (1970..2100) resolve all 19 relative anchors and form contiguous [@last*, @this*, @next*] partitions containing referenceTimeMs', async () => {
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
});
