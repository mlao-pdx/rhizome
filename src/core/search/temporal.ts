import { Temporal } from '@js-temporal/polyfill';
import type { DateInterval, DateParseResult, PropertyOperator } from './types';

const STRICT_ISO_ATOM_RE =
	/^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:([+-]\d+)d|[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):?(\d{2}))?)?)?)?$/;

const RELATIVE_DAY_RE = /^@(today|yesterday|tomorrow|(?:last|this|next)day)(?:([+-]\d+)d?)?$/i;
const RELATIVE_COARSE_RE = /^@(last|this|next)(week|month|quarter|year)$/i;

export const MAX_SAFE_EPOCH_MS = 8_640_000_000_000_000;
const MAX_DAY_OFFSET = 36_500;

export interface TemporalParseOptions {
	readonly allowYearOnly: boolean;
	readonly allowRelative: boolean;
	readonly timeZone: string;
	readonly referenceTimeMs?: number | undefined;
}

export function isValidReferenceTimeMs(val: unknown): val is number {
	return (
		typeof val === 'number' && Number.isSafeInteger(val) && Math.abs(val) <= MAX_SAFE_EPOCH_MS
	);
}

export function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
	switch (month) {
		case 1:
		case 3:
		case 5:
		case 7:
		case 8:
		case 10:
		case 12:
			return 31;
		case 4:
		case 6:
		case 9:
		case 11:
			return 30;
		case 2:
			return isLeapYear(year) ? 29 : 28;
		default:
			return 0;
	}
}

export function wallClockToUtcMs(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	ms: number,
	timeZone: string,
): number {
	const pdt = new Temporal.PlainDateTime(year, month, day, hour, minute, second, ms);
	const zdt = pdt.toZonedDateTime(timeZone, { disambiguation: 'compatible' });
	return zdt.epochMilliseconds;
}

function plainDateToDayInterval(
	pd: Temporal.PlainDate,
	timeZone: string,
	raw: string,
): DateInterval {
	const nextDay = pd.add({ days: 1 });
	const start = wallClockToUtcMs(pd.year, pd.month, pd.day, 0, 0, 0, 0, timeZone);
	const end = wallClockToUtcMs(nextDay.year, nextDay.month, nextDay.day, 0, 0, 0, 0, timeZone);
	return Object.freeze({ start, end, grain: 'day' as const, raw });
}

export function parseSingleTemporalAtom(
	rawAtom: string,
	opts: TemporalParseOptions,
): DateParseResult {
	const str = rawAtom.trim();
	const { allowYearOnly, allowRelative, timeZone, referenceTimeMs } = opts;

	if (str.startsWith('@')) {
		if (!allowRelative) return { ok: false, reason: 'RELATIVE_NOT_ALLOWED' };
		if (!isValidReferenceTimeMs(referenceTimeMs)) {
			return { ok: false, reason: 'INVALID_FORMAT' };
		}
		const lower = str.toLowerCase();

		if (lower === '@now') {
			return {
				ok: true,
				interval: Object.freeze({
					start: referenceTimeMs,
					end: referenceTimeMs + 1,
					grain: 'ms',
					raw: str,
				}),
			};
		}

		let todayDate: Temporal.PlainDate;
		try {
			todayDate = Temporal.Instant.fromEpochMilliseconds(referenceTimeMs)
				.toZonedDateTimeISO(timeZone)
				.toPlainDate();
		} catch {
			return { ok: false, reason: 'INVALID_FORMAT' };
		}

		const dayMatch = RELATIVE_DAY_RE.exec(str);
		if (dayMatch && dayMatch[1] !== undefined) {
			const anchor = dayMatch[1].toLowerCase();
			const offsetStr = dayMatch[2];
			let baseDelta = 0;
			if (anchor === 'yesterday' || anchor === 'lastday') baseDelta = -1;
			else if (anchor === 'tomorrow' || anchor === 'nextday') baseDelta = 1;

			let extraOffset = 0;
			if (offsetStr !== undefined) {
				extraOffset = Number(offsetStr);
				if (!Number.isSafeInteger(extraOffset) || Math.abs(extraOffset) > MAX_DAY_OFFSET) {
					return { ok: false, reason: 'INVALID_FORMAT' };
				}
			}
			try {
				const targetDate = todayDate.add({ days: baseDelta + extraOffset });
				const interval = plainDateToDayInterval(targetDate, timeZone, str);
				if (!Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end)) {
					return { ok: false, reason: 'INVALID_FORMAT' };
				}
				if (interval.start >= interval.end) return { ok: false, reason: 'SKIPPED_DATE' };
				return { ok: true, interval };
			} catch {
				return { ok: false, reason: 'INVALID_FORMAT' };
			}
		}

		const coarseMatch = RELATIVE_COARSE_RE.exec(str);
		if (coarseMatch && coarseMatch[1] !== undefined && coarseMatch[2] !== undefined) {
			const dir = coarseMatch[1].toLowerCase();
			const unit = coarseMatch[2].toLowerCase();
			const shift = dir === 'last' ? -1 : dir === 'next' ? 1 : 0;

			try {
				if (unit === 'week') {
					const currentMonday = todayDate
						.subtract({ days: todayDate.dayOfWeek - 1 })
						.add({ weeks: shift });
					const nextMonday = currentMonday.add({ weeks: 1 });
					const start = wallClockToUtcMs(
						currentMonday.year,
						currentMonday.month,
						currentMonday.day,
						0,
						0,
						0,
						0,
						timeZone,
					);
					const end = wallClockToUtcMs(
						nextMonday.year,
						nextMonday.month,
						nextMonday.day,
						0,
						0,
						0,
						0,
						timeZone,
					);
					if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
						return { ok: false, reason: 'INVALID_FORMAT' };
					}
					if (start >= end) return { ok: false, reason: 'SKIPPED_DATE' };
					return {
						ok: true,
						interval: Object.freeze({ start, end, grain: 'week', raw: str }),
					};
				}
				if (unit === 'month') {
					const firstOfThisMonth = Temporal.PlainDate.from({
						year: todayDate.year,
						month: todayDate.month,
						day: 1,
					});
					const targetMonthStart = firstOfThisMonth.add({ months: shift });
					const nextMonthStart = targetMonthStart.add({ months: 1 });
					const start = wallClockToUtcMs(
						targetMonthStart.year,
						targetMonthStart.month,
						1,
						0,
						0,
						0,
						0,
						timeZone,
					);
					const end = wallClockToUtcMs(
						nextMonthStart.year,
						nextMonthStart.month,
						1,
						0,
						0,
						0,
						0,
						timeZone,
					);
					if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
						return { ok: false, reason: 'INVALID_FORMAT' };
					}
					if (start >= end) return { ok: false, reason: 'SKIPPED_DATE' };
					return {
						ok: true,
						interval: Object.freeze({ start, end, grain: 'month', raw: str }),
					};
				}
				if (unit === 'quarter') {
					const currentQuarterStartMonth = Math.floor((todayDate.month - 1) / 3) * 3 + 1;
					const firstOfThisQuarter = Temporal.PlainDate.from({
						year: todayDate.year,
						month: currentQuarterStartMonth,
						day: 1,
					});
					const targetQuarterStart = firstOfThisQuarter.add({ months: shift * 3 });
					const nextQuarterStart = targetQuarterStart.add({ months: 3 });
					const start = wallClockToUtcMs(
						targetQuarterStart.year,
						targetQuarterStart.month,
						1,
						0,
						0,
						0,
						0,
						timeZone,
					);
					const end = wallClockToUtcMs(
						nextQuarterStart.year,
						nextQuarterStart.month,
						1,
						0,
						0,
						0,
						0,
						timeZone,
					);
					if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
						return { ok: false, reason: 'INVALID_FORMAT' };
					}
					if (start >= end) return { ok: false, reason: 'SKIPPED_DATE' };
					return {
						ok: true,
						interval: Object.freeze({ start, end, grain: 'quarter', raw: str }),
					};
				}
				if (unit === 'year') {
					const targetYear = todayDate.year + shift;
					const start = wallClockToUtcMs(targetYear, 1, 1, 0, 0, 0, 0, timeZone);
					const end = wallClockToUtcMs(targetYear + 1, 1, 1, 0, 0, 0, 0, timeZone);
					if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
						return { ok: false, reason: 'INVALID_FORMAT' };
					}
					if (start >= end) return { ok: false, reason: 'SKIPPED_DATE' };
					return {
						ok: true,
						interval: Object.freeze({ start, end, grain: 'year', raw: str }),
					};
				}
			} catch {
				return { ok: false, reason: 'INVALID_FORMAT' };
			}
		}

		return { ok: false, reason: 'INVALID_FORMAT' };
	}

	const m = STRICT_ISO_ATOM_RE.exec(str);
	if (!m) return { ok: false, reason: 'INVALID_FORMAT' };

	const [
		,
		yStr,
		moStr,
		dStr,
		isoDayOffsetStr,
		hStr,
		miStr,
		sStr,
		fracStr,
		tzFull,
		tzSign,
		tzHStr,
		tzMStr,
	] = m;
	if (!moStr && !allowYearOnly) return { ok: false, reason: 'INVALID_FORMAT' };
	if (str.includes(' ') && !hStr) return { ok: false, reason: 'INVALID_FORMAT' };

	const year = Number(yStr);
	if (year < 1000 || year > 9999) return { ok: false, reason: 'INVALID_FORMAT' };

	const month = moStr ? Number(moStr) : 1;
	if (month < 1 || month > 12) return { ok: false, reason: 'INVALID_FORMAT' };

	const maxDay = daysInMonth(year, month);
	const day = dStr ? Number(dStr) : 1;
	if (day < 1 || day > maxDay) return { ok: false, reason: 'INVALID_FORMAT' };

	const hour = hStr ? Number(hStr) : 0;
	const minute = miStr ? Number(miStr) : 0;
	const second = sStr ? Number(sStr) : 0;
	if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'INVALID_FORMAT' };

	const ms = fracStr ? Number(fracStr.slice(0, 3).padEnd(3, '0')) : 0;

	let interval: DateInterval;
	try {
		if (tzFull) {
			let explicitOffsetMs = 0;
			if (tzFull !== 'Z') {
				const tzH = Number(tzHStr);
				const tzM = Number(tzMStr);
				if (tzH > 23 || tzM > 59) return { ok: false, reason: 'INVALID_FORMAT' };
				explicitOffsetMs = (tzSign === '-' ? -1 : 1) * (tzH * 60 + tzM) * 60_000;
			}
			const start =
				Date.UTC(year, month - 1, day, hour, minute, second, ms) - explicitOffsetMs;
			if (!sStr) {
				interval = Object.freeze({ start, end: start + 60_000, grain: 'minute', raw: str });
			} else if (!fracStr) {
				interval = Object.freeze({ start, end: start + 1_000, grain: 'second', raw: str });
			} else {
				interval = Object.freeze({ start, end: start + 1, grain: 'ms', raw: str });
			}
		} else if (!moStr) {
			const start = wallClockToUtcMs(year, 1, 1, 0, 0, 0, 0, timeZone);
			const end = wallClockToUtcMs(year + 1, 1, 1, 0, 0, 0, 0, timeZone);
			interval = Object.freeze({ start, end, grain: 'year', raw: str });
		} else if (!dStr) {
			const nextY = month === 12 ? year + 1 : year;
			const nextM = month === 12 ? 1 : month + 1;
			const start = wallClockToUtcMs(year, month, 1, 0, 0, 0, 0, timeZone);
			const end = wallClockToUtcMs(nextY, nextM, 1, 0, 0, 0, 0, timeZone);
			interval = Object.freeze({ start, end, grain: 'month', raw: str });
		} else if (!hStr) {
			let baseDate = Temporal.PlainDate.from({ year, month, day });
			if (isoDayOffsetStr !== undefined) {
				const delta = Number(isoDayOffsetStr);
				if (!Number.isSafeInteger(delta) || Math.abs(delta) > MAX_DAY_OFFSET) {
					return { ok: false, reason: 'INVALID_FORMAT' };
				}
				baseDate = baseDate.add({ days: delta });
			}
			interval = plainDateToDayInterval(baseDate, timeZone, str);
		} else {
			const start = wallClockToUtcMs(year, month, day, hour, minute, second, ms, timeZone);
			if (!sStr) {
				interval = Object.freeze({ start, end: start + 60_000, grain: 'minute', raw: str });
			} else if (!fracStr) {
				interval = Object.freeze({ start, end: start + 1_000, grain: 'second', raw: str });
			} else {
				interval = Object.freeze({ start, end: start + 1, grain: 'ms', raw: str });
			}
		}
	} catch {
		return { ok: false, reason: 'INVALID_FORMAT' };
	}

	if (!Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end)) {
		return { ok: false, reason: 'INVALID_FORMAT' };
	}
	if (interval.start >= interval.end) {
		return { ok: false, reason: 'SKIPPED_DATE' };
	}
	return { ok: true, interval };
}

/**
 * Full Temporal Expression Parser.
 * Positional Range Rule: `<Atom1>..<Atom2>` combines into `[s1, e2)` iff `s1 < e2`.
 * If `s1 >= e2`, returns `REVERSED_RANGE` with `hint: "Use ${rightRaw}..${leftRaw}"` when `s2 < e1`.
 */
export function parseTemporalExpr(rawInput: string, opts: TemporalParseOptions): DateParseResult {
	const str = rawInput.trim();
	const rangeParts = str.split('..');
	if (rangeParts.length > 2) return { ok: false, reason: 'INVALID_FORMAT' };

	if (rangeParts.length === 2) {
		const leftRaw = rangeParts[0]?.trim() ?? '';
		const rightRaw = rangeParts[1]?.trim() ?? '';
		if (!leftRaw || !rightRaw) return { ok: false, reason: 'INVALID_FORMAT' };

		const leftRes = parseSingleTemporalAtom(leftRaw, opts);
		if (!leftRes.ok) return leftRes;

		const rightRes = parseSingleTemporalAtom(rightRaw, opts);
		if (!rightRes.ok) return rightRes;

		const s1 = leftRes.interval.start;
		const e1 = leftRes.interval.end;
		const s2 = rightRes.interval.start;
		const e2 = rightRes.interval.end;

		if (s1 >= e2) {
			return {
				ok: false,
				reason: 'REVERSED_RANGE',
				leftRaw,
				rightRaw,
				hint: s2 < e1 ? `Use ${rightRaw}..${leftRaw}` : null,
			};
		}

		return {
			ok: true,
			interval: Object.freeze({
				start: s1,
				end: e2,
				grain: 'range',
				raw: str,
			}),
		};
	}

	return parseSingleTemporalAtom(str, opts);
}

export function compareDateIntervals(
	D: DateInterval,
	op: PropertyOperator,
	Q: DateInterval,
): boolean {
	switch (op) {
		case '=':
			return D.start >= Q.start && D.end <= Q.end;
		case '!=':
			return D.start < Q.start || D.end > Q.end;
		case '<':
			return D.end <= Q.start;
		case '>=':
			return D.start >= Q.start;
		case '>':
			return D.start >= Q.end;
		case '<=':
			return D.end <= Q.end;
		default:
			return false;
	}
}
