import { describe, expect, it } from 'vitest';
import {
	compareDateIntervals,
	daysInMonth,
	isLeapYear,
	isValidReferenceTimeMs,
	MAX_SAFE_EPOCH_MS,
	parseSingleTemporalAtom,
	parseTemporalExpr,
	wallClockToUtcMs,
	type DateInterval,
	type TemporalParseOptions,
} from '../../src/core/search';

const REF_TIME_MS = Date.parse('2026-10-22T15:30:00.000Z'); // Thursday, Oct 22, 2026, 11:30 AM EDT

const NY_QUERY_OPTS: TemporalParseOptions = {
	allowYearOnly: true,
	allowRelative: true,
	timeZone: 'America/New_York',
	referenceTimeMs: REF_TIME_MS,
};

const UTC_QUERY_OPTS: TemporalParseOptions = {
	allowYearOnly: true,
	allowRelative: true,
	timeZone: 'UTC',
	referenceTimeMs: REF_TIME_MS,
};

describe('temporal helpers', () => {
	it('validates referenceTimeMs bounds and safe integer requirements', () => {
		expect(isValidReferenceTimeMs(0)).toBe(true);
		expect(isValidReferenceTimeMs(REF_TIME_MS)).toBe(true);
		expect(isValidReferenceTimeMs(MAX_SAFE_EPOCH_MS)).toBe(true);
		expect(isValidReferenceTimeMs(-MAX_SAFE_EPOCH_MS)).toBe(true);

		expect(isValidReferenceTimeMs(MAX_SAFE_EPOCH_MS + 1)).toBe(false);
		expect(isValidReferenceTimeMs(-MAX_SAFE_EPOCH_MS - 1)).toBe(false);
		expect(isValidReferenceTimeMs(Number.NaN)).toBe(false);
		expect(isValidReferenceTimeMs(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isValidReferenceTimeMs(Number.NEGATIVE_INFINITY)).toBe(false);
		expect(isValidReferenceTimeMs(123.45)).toBe(false);
		expect(isValidReferenceTimeMs('1700000000000')).toBe(false);
		expect(isValidReferenceTimeMs(null)).toBe(false);
		expect(isValidReferenceTimeMs(undefined)).toBe(false);
	});

	it('computes leap years and daysInMonth accurately across Gregorian calendar rules', () => {
		expect(isLeapYear(2024)).toBe(true);
		expect(isLeapYear(2000)).toBe(true);
		expect(isLeapYear(1900)).toBe(false);
		expect(isLeapYear(2026)).toBe(false);

		expect(daysInMonth(2026, 1)).toBe(31);
		expect(daysInMonth(2026, 2)).toBe(28);
		expect(daysInMonth(2024, 2)).toBe(29);
		expect(daysInMonth(2026, 3)).toBe(31);
		expect(daysInMonth(2026, 4)).toBe(30);
		expect(daysInMonth(2026, 5)).toBe(31);
		expect(daysInMonth(2026, 6)).toBe(30);
		expect(daysInMonth(2026, 7)).toBe(31);
		expect(daysInMonth(2026, 8)).toBe(31);
		expect(daysInMonth(2026, 9)).toBe(30);
		expect(daysInMonth(2026, 10)).toBe(31);
		expect(daysInMonth(2026, 11)).toBe(30);
		expect(daysInMonth(2026, 12)).toBe(31);
		expect(daysInMonth(2026, 0)).toBe(0);
		expect(daysInMonth(2026, 13)).toBe(0);
	});

	it('resolves wallClockToUtcMs with compatible DST disambiguation', () => {
		expect(wallClockToUtcMs(2026, 10, 22, 12, 0, 0, 0, 'UTC')).toBe(
			Date.parse('2026-10-22T12:00:00.000Z'),
		);

		// Spring-forward gap in America/New_York: 2026-03-08 02:30 -> compatible shifts forward to 03:30 EDT (07:30 UTC)
		expect(wallClockToUtcMs(2026, 3, 8, 2, 30, 0, 0, 'America/New_York')).toBe(
			Date.parse('2026-03-08T07:30:00.000Z'),
		);

		// Fall-back ambiguity in America/New_York: 2026-11-01 01:30 -> compatible picks earlier occurrence (01:30 EDT = 05:30 UTC)
		expect(wallClockToUtcMs(2026, 11, 1, 1, 30, 0, 0, 'America/New_York')).toBe(
			Date.parse('2026-11-01T05:30:00.000Z'),
		);
	});
});

describe('Conformance Tests 5, 6, 7 & 14: Temporal Engine', () => {
	it('Conformance Test 5: resolves explicit offset ISO datetime and matches equivalent UTC instant', () => {
		const res = parseTemporalExpr('2026-10-22T14:00:00+02:00', NY_QUERY_OPTS);
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(Object.isFrozen(res.interval)).toBe(true);
		expect(res.interval).toEqual({
			start: Date.parse('2026-10-22T12:00:00.000Z'),
			end: Date.parse('2026-10-22T12:00:01.000Z'),
			grain: 'second',
			raw: '2026-10-22T14:00:00+02:00',
		});

		const storedPoint: DateInterval = {
			start: Date.parse('2026-10-22T12:00:00.000Z'),
			end: Date.parse('2026-10-22T12:00:00.000Z') + 1,
			grain: 'ms',
			raw: '2026-10-22T12:00:00.000Z',
		};
		expect(compareDateIntervals(storedPoint, '=', res.interval)).toBe(true);
	});

	it('Conformance Test 6: rejects invalid calendar dates and skipped calendar dates (direct and via relative offset)', () => {
		const feb31 = parseTemporalExpr('2026-02-31', NY_QUERY_OPTS);
		expect(feb31).toEqual({ ok: false, reason: 'INVALID_FORMAT' });

		const apiaOpts: TemporalParseOptions = {
			allowYearOnly: true,
			allowRelative: true,
			timeZone: 'Pacific/Apia',
			referenceTimeMs: Date.parse('2011-12-29T12:00:00.000Z'),
		};

		const directSkipped = parseTemporalExpr('2011-12-30', apiaOpts);
		expect(directSkipped).toEqual({ ok: false, reason: 'SKIPPED_DATE' });

		const relativeSkipped = parseTemporalExpr('@today+1d', apiaOpts);
		expect(relativeSkipped).toEqual({ ok: false, reason: 'SKIPPED_DATE' });

		const isoOffsetSkipped = parseTemporalExpr('2011-12-29+1d', apiaOpts);
		expect(isoOffsetSkipped).toEqual({ ok: false, reason: 'SKIPPED_DATE' });
	});

	it('Conformance Test 7: resolves IANA DST fall-back day to exact 25-hour interval in America/New_York', () => {
		const res = parseTemporalExpr('2026-11-01', NY_QUERY_OPTS);
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const expectedStart = Date.parse('2026-11-01T04:00:00.000Z');
		const expectedEnd = Date.parse('2026-11-02T05:00:00.000Z');
		expect(res.interval.start).toBe(expectedStart);
		expect(res.interval.end).toBe(expectedEnd);
		expect(res.interval.end - res.interval.start).toBe(25 * 3600 * 1000);
		expect(res.interval.grain).toBe('day');
	});

	it('Conformance Test 14a: resolves @now, @today, @yesterday, @tomorrow, day aliases, and day offsets in America/New_York', () => {
		const nowRes = parseTemporalExpr('@now', NY_QUERY_OPTS);
		expect(nowRes).toEqual({
			ok: true,
			interval: {
				start: 1792683000000,
				end: 1792683000001,
				grain: 'ms',
				raw: '@now',
			},
		});

		const todayRes = parseTemporalExpr('@today', NY_QUERY_OPTS);
		const thisdayRes = parseTemporalExpr('@thisday', NY_QUERY_OPTS);
		expect(todayRes).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-22T04:00:00.000Z'),
				end: Date.parse('2026-10-23T04:00:00.000Z'),
				grain: 'day',
				raw: '@today',
			},
		});
		if (todayRes.ok && thisdayRes.ok) {
			expect(thisdayRes.interval.start).toBe(todayRes.interval.start);
			expect(thisdayRes.interval.end).toBe(todayRes.interval.end);
		}

		const yesterdayRes = parseTemporalExpr('@yesterday', NY_QUERY_OPTS);
		const lastdayRes = parseTemporalExpr('@lastday', NY_QUERY_OPTS);
		expect(yesterdayRes).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-21T04:00:00.000Z'),
				end: Date.parse('2026-10-22T04:00:00.000Z'),
				grain: 'day',
				raw: '@yesterday',
			},
		});
		if (yesterdayRes.ok && lastdayRes.ok) {
			expect(lastdayRes.interval.start).toBe(yesterdayRes.interval.start);
			expect(lastdayRes.interval.end).toBe(yesterdayRes.interval.end);
		}

		const tomorrowRes = parseTemporalExpr('@tomorrow', NY_QUERY_OPTS);
		const nextdayRes = parseTemporalExpr('@nextday', NY_QUERY_OPTS);
		expect(tomorrowRes).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-23T04:00:00.000Z'),
				end: Date.parse('2026-10-24T04:00:00.000Z'),
				grain: 'day',
				raw: '@tomorrow',
			},
		});
		if (tomorrowRes.ok && nextdayRes.ok) {
			expect(nextdayRes.interval.start).toBe(tomorrowRes.interval.start);
			expect(nextdayRes.interval.end).toBe(tomorrowRes.interval.end);
		}

		// @today-6d..@today (7 calendar days: Oct 16 00:00 EDT to Oct 23 00:00 EDT)
		const sevenDays = parseTemporalExpr('@today-6d..@today', NY_QUERY_OPTS);
		expect(sevenDays).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-16T04:00:00.000Z'),
				end: Date.parse('2026-10-23T04:00:00.000Z'),
				grain: 'range',
				raw: '@today-6d..@today',
			},
		});

		// @today-7d..@today (8 calendar days: Oct 15 00:00 EDT to Oct 23 00:00 EDT)
		const eightDays = parseTemporalExpr('@today-7d..@today', NY_QUERY_OPTS);
		expect(eightDays).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-15T04:00:00.000Z'),
				end: Date.parse('2026-10-23T04:00:00.000Z'),
				grain: 'range',
				raw: '@today-7d..@today',
			},
		});
	});

	it('Conformance Test 14b: resolves coarse relative anchors (@last/this/next week, month, quarter, year)', () => {
		// 2026-10-22 is Thursday -> ISO week starts Monday 2026-10-19
		expect(parseTemporalExpr('@lastweek', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-12T04:00:00.000Z'),
				end: Date.parse('2026-10-19T04:00:00.000Z'),
				grain: 'week',
				raw: '@lastweek',
			},
		});
		expect(parseTemporalExpr('@thisweek', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-19T04:00:00.000Z'),
				end: Date.parse('2026-10-26T04:00:00.000Z'),
				grain: 'week',
				raw: '@thisweek',
			},
		});
		expect(parseTemporalExpr('@nextweek', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-26T04:00:00.000Z'),
				end: Date.parse('2026-11-02T05:00:00.000Z'), // Nov 1 DST fall-back to EST (+05:00)
				grain: 'week',
				raw: '@nextweek',
			},
		});

		expect(parseTemporalExpr('@lastmonth', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-09-01T04:00:00.000Z'),
				end: Date.parse('2026-10-01T04:00:00.000Z'),
				grain: 'month',
				raw: '@lastmonth',
			},
		});
		expect(parseTemporalExpr('@thismonth', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-01T04:00:00.000Z'),
				end: Date.parse('2026-11-01T04:00:00.000Z'),
				grain: 'month',
				raw: '@thismonth',
			},
		});
		expect(parseTemporalExpr('@nextmonth', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-11-01T04:00:00.000Z'),
				end: Date.parse('2026-12-01T05:00:00.000Z'),
				grain: 'month',
				raw: '@nextmonth',
			},
		});

		// October is Q4 (Oct 1 .. Jan 1)
		expect(parseTemporalExpr('@lastquarter', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-07-01T04:00:00.000Z'),
				end: Date.parse('2026-10-01T04:00:00.000Z'),
				grain: 'quarter',
				raw: '@lastquarter',
			},
		});
		expect(parseTemporalExpr('@thisquarter', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-01T04:00:00.000Z'),
				end: Date.parse('2027-01-01T05:00:00.000Z'),
				grain: 'quarter',
				raw: '@thisquarter',
			},
		});
		expect(parseTemporalExpr('@nextquarter', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2027-01-01T05:00:00.000Z'),
				end: Date.parse('2027-04-01T04:00:00.000Z'),
				grain: 'quarter',
				raw: '@nextquarter',
			},
		});

		expect(parseTemporalExpr('@lastyear', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2025-01-01T05:00:00.000Z'),
				end: Date.parse('2026-01-01T05:00:00.000Z'),
				grain: 'year',
				raw: '@lastyear',
			},
		});
		expect(parseTemporalExpr('@thisyear', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-01-01T05:00:00.000Z'),
				end: Date.parse('2027-01-01T05:00:00.000Z'),
				grain: 'year',
				raw: '@thisyear',
			},
		});
		expect(parseTemporalExpr('@nextyear', NY_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2027-01-01T05:00:00.000Z'),
				end: Date.parse('2028-01-01T05:00:00.000Z'),
				grain: 'year',
				raw: '@nextyear',
			},
		});
	});

	it('Conformance Test 14c: resolves mixed-precision positional ranges and rejects reversed ranges with hints', () => {
		const dayToYear = parseTemporalExpr('2026-10-22..2026', NY_QUERY_OPTS);
		expect(dayToYear).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-22T04:00:00.000Z'),
				end: Date.parse('2027-01-01T05:00:00.000Z'),
				grain: 'range',
				raw: '2026-10-22..2026',
			},
		});

		const yearToToday = parseTemporalExpr('@thisyear..@today', NY_QUERY_OPTS);
		expect(yearToToday).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-01-01T05:00:00.000Z'),
				end: Date.parse('2026-10-23T04:00:00.000Z'),
				grain: 'range',
				raw: '@thisyear..@today',
			},
		});

		const todayToYear = parseTemporalExpr('@today..@thisyear', NY_QUERY_OPTS);
		expect(todayToYear).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-22T04:00:00.000Z'),
				end: Date.parse('2027-01-01T05:00:00.000Z'),
				grain: 'range',
				raw: '@today..@thisyear',
			},
		});

		const revRel = parseTemporalExpr('@today..@today-7d', NY_QUERY_OPTS);
		expect(revRel).toEqual({
			ok: false,
			reason: 'REVERSED_RANGE',
			leftRaw: '@today',
			rightRaw: '@today-7d',
			hint: 'Use @today-7d..@today',
		});

		const revIso = parseTemporalExpr('2026-10-15..2026-10-01', NY_QUERY_OPTS);
		expect(revIso).toEqual({
			ok: false,
			reason: 'REVERSED_RANGE',
			leftRaw: '2026-10-15',
			rightRaw: '2026-10-01',
			hint: 'Use 2026-10-01..2026-10-15',
		});

		// Touching/abutting reversed range (s1 === e2, e.g., 2026-10-02..2026-10-01):
		// s1 >= e2 triggers REVERSED_RANGE, and because s2 < e2 <= s1 < e1 holds for all valid atoms,
		// the swapped range 2026-10-01..2026-10-02 is guaranteed valid and hinted.
		const touchingRev = parseTemporalExpr('2026-10-02..2026-10-01', NY_QUERY_OPTS);
		expect(touchingRev).toEqual({
			ok: false,
			reason: 'REVERSED_RANGE',
			leftRaw: '2026-10-02',
			rightRaw: '2026-10-01',
			hint: 'Use 2026-10-01..2026-10-02',
		});
	});
});

describe('ISO grains, options gating & boundary cases', () => {
	it('enforces allowYearOnly and allowRelative options', () => {
		const storedOpts: TemporalParseOptions = {
			allowYearOnly: false,
			allowRelative: false,
			timeZone: 'UTC',
		};

		expect(parseTemporalExpr('2026', storedOpts)).toEqual({
			ok: false,
			reason: 'INVALID_FORMAT',
		});
		expect(parseTemporalExpr('2026', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-01-01T00:00:00.000Z'),
				end: Date.parse('2027-01-01T00:00:00.000Z'),
				grain: 'year',
				raw: '2026',
			},
		});

		expect(parseTemporalExpr('@today', storedOpts)).toEqual({
			ok: false,
			reason: 'RELATIVE_NOT_ALLOWED',
		});
		expect(parseTemporalExpr('2026-01-01..@today', storedOpts)).toEqual({
			ok: false,
			reason: 'RELATIVE_NOT_ALLOWED',
		});
		expect(parseTemporalExpr('@today..2026-12-31', storedOpts)).toEqual({
			ok: false,
			reason: 'RELATIVE_NOT_ALLOWED',
		});
	});

	it('resolves month, day, minute, second, and millisecond ISO grains and ISO day offsets', () => {
		expect(parseTemporalExpr('2026-12', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-12-01T00:00:00.000Z'),
				end: Date.parse('2027-01-01T00:00:00.000Z'),
				grain: 'month',
				raw: '2026-12',
			},
		});

		expect(parseTemporalExpr('2026-10-22+10d', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-11-01T00:00:00.000Z'),
				end: Date.parse('2026-11-02T00:00:00.000Z'),
				grain: 'day',
				raw: '2026-10-22+10d',
			},
		});

		// Full Julian century (36,525 days, including leap days) is accepted at the boundary
		expect(parseTemporalExpr('2000-01-01+36525d', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2100-01-01T00:00:00.000Z'),
				end: Date.parse('2100-01-02T00:00:00.000Z'),
				grain: 'day',
				raw: '2000-01-01+36525d',
			},
		});
		expect(parseTemporalExpr('@today+36525d', UTC_QUERY_OPTS).ok).toBe(true);
		expect(parseTemporalExpr('@today-36525d', UTC_QUERY_OPTS).ok).toBe(true);

		expect(parseTemporalExpr('2026-10-22 14:05', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-22T14:05:00.000Z'),
				end: Date.parse('2026-10-22T14:06:00.000Z'),
				grain: 'minute',
				raw: '2026-10-22 14:05',
			},
		});

		expect(parseTemporalExpr('2026-10-22T14:05Z', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-22T14:05:00.000Z'),
				end: Date.parse('2026-10-22T14:06:00.000Z'),
				grain: 'minute',
				raw: '2026-10-22T14:05Z',
			},
		});

		expect(parseTemporalExpr('2026-10-22T14:05:30', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-22T14:05:30.000Z'),
				end: Date.parse('2026-10-22T14:05:31.000Z'),
				grain: 'second',
				raw: '2026-10-22T14:05:30',
			},
		});

		// Fractional seconds truncated/padded to 3 digits
		expect(parseTemporalExpr('2026-10-22T14:05:30.5Z', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-22T14:05:30.500Z'),
				end: Date.parse('2026-10-22T14:05:30.500Z') + 1,
				grain: 'ms',
				raw: '2026-10-22T14:05:30.5Z',
			},
		});
		expect(parseTemporalExpr('2026-10-22T14:05:30.123999-0400', UTC_QUERY_OPTS)).toEqual({
			ok: true,
			interval: {
				start: Date.parse('2026-10-22T18:05:30.123Z'),
				end: Date.parse('2026-10-22T18:05:30.123Z') + 1,
				grain: 'ms',
				raw: '2026-10-22T14:05:30.123999-0400',
			},
		});
	});

	it('rejects malformed inputs, excessive day offsets, and multi-dot ranges', () => {
		for (const bad of [
			'',
			'   ',
			'0999-01-01',
			'2026-00-01',
			'2026-13-01',
			'2026-04-31',
			'2026-10-22T24:00:00',
			'2026-10-22T12:60:00',
			'2026-10-22T12:00:60',
			'2026-10-22T12:00:00+24:00',
			'2026-10-22T12:00:00+02:60',
			'2026-10-22+36526d',
			'2026-10-22-36526d',
			'@today+36526d',
			'@today-36526d',
			'@unknown',
			'2026-01-01..',
			'..2026-01-01',
			'2026-01-01..2026-01-02..2026-01-03',
		]) {
			expect(parseTemporalExpr(bad, UTC_QUERY_OPTS)).toEqual({
				ok: false,
				reason: 'INVALID_FORMAT',
			});
		}

		expect(
			parseSingleTemporalAtom('@today', { ...UTC_QUERY_OPTS, referenceTimeMs: Number.NaN }),
		).toEqual({
			ok: false,
			reason: 'INVALID_FORMAT',
		});
	});
});

describe('compareDateIntervals', () => {
	const Q: DateInterval = {
		start: 1000,
		end: 2000,
		grain: 'day',
		raw: 'Q',
	};

	it('evaluates all relational and equality operators on half-open intervals', () => {
		const inside: DateInterval = { start: 1200, end: 1800, grain: 'minute', raw: 'inside' };
		const exact: DateInterval = { start: 1000, end: 2000, grain: 'day', raw: 'exact' };
		const before: DateInterval = { start: 500, end: 1000, grain: 'minute', raw: 'before' };
		const after: DateInterval = { start: 2000, end: 2500, grain: 'minute', raw: 'after' };
		const overlapLeft: DateInterval = {
			start: 500,
			end: 1500,
			grain: 'range',
			raw: 'overlapL',
		};
		const overlapRight: DateInterval = {
			start: 1500,
			end: 2500,
			grain: 'range',
			raw: 'overlapR',
		};
		const wider: DateInterval = { start: 500, end: 2500, grain: 'month', raw: 'wider' };

		expect(compareDateIntervals(inside, '=', Q)).toBe(true);
		expect(compareDateIntervals(exact, '=', Q)).toBe(true);
		expect(compareDateIntervals(overlapLeft, '=', Q)).toBe(false);
		expect(compareDateIntervals(wider, '=', Q)).toBe(false);

		expect(compareDateIntervals(inside, '!=', Q)).toBe(false);
		expect(compareDateIntervals(overlapLeft, '!=', Q)).toBe(true);
		expect(compareDateIntervals(wider, '!=', Q)).toBe(true);

		expect(compareDateIntervals(before, '<', Q)).toBe(true);
		expect(compareDateIntervals(overlapLeft, '<', Q)).toBe(false);

		expect(compareDateIntervals(inside, '>=', Q)).toBe(true);
		expect(compareDateIntervals(overlapRight, '>=', Q)).toBe(true);
		expect(compareDateIntervals(overlapLeft, '>=', Q)).toBe(false);

		expect(compareDateIntervals(after, '>', Q)).toBe(true);
		expect(compareDateIntervals(overlapRight, '>', Q)).toBe(false);

		expect(compareDateIntervals(inside, '<=', Q)).toBe(true);
		expect(compareDateIntervals(overlapLeft, '<=', Q)).toBe(true);
		expect(compareDateIntervals(overlapRight, '<=', Q)).toBe(false);

		expect(compareDateIntervals(inside, 'EXISTS', Q)).toBe(false);
		expect(compareDateIntervals(inside, ':', Q)).toBe(false);
	});
});
