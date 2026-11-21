import { Temporal } from '@js-temporal/polyfill';
import type { DateInterval, DateParseResult, PropertyOperator } from './types';

const STRICT_ISO_ATOM_RE =
	/^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:([+-]\d+)d|[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):?(\d{2}))?)?)?)?$/;

const RELATIVE_DAY_RE = /^@(today|yesterday|tomorrow|(?:last|this|next)day)(?:([+-]\d+)d?)?$/i;
const RELATIVE_COARSE_RE = /^@(last|this|next)(week|month|quarter|year)$/i;

export const MAX_SAFE_EPOCH_MS = 8_640_000_000_000_000;
const MAX_DAY_OFFSET = 36_525;
const MAX_4DIGIT_YEAR_EPOCH_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z
const MIN_MODERN_INTL_EPOCH_MS = 94_694_400_000; // 1973-01-01T00:00:00.000Z (after sub-minute LMT offsets ended)
const MAX_MODERN_INTL_EPOCH_MS = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z
const MAX_CACHED_ZONES = 32;
const MAX_MINUTE_BUCKETS_PER_ZONE = 4_096;

const PAD2: readonly string[] = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

interface ZoneMinuteFormatterEntry {
	readonly dtf: Intl.DateTimeFormat | null;
	readonly buckets: Map<number, string>;
}

const minuteFormatZoneCache = new Map<string, ZoneMinuteFormatterEntry>();

function getZoneMinuteFormatter(timeZone: string): ZoneMinuteFormatterEntry | null {
	const existing = minuteFormatZoneCache.get(timeZone);
	if (existing !== undefined) {
		return existing;
	}
	try {
		// Validate once against Temporal so invalid timeZone identifiers still throw identically.
		Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone);
	} catch {
		return null;
	}
	let dtf: Intl.DateTimeFormat | null = null;
	try {
		dtf = new Intl.DateTimeFormat('en-US', {
			timeZone,
			calendar: 'iso8601',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		});
	} catch {
		dtf = null;
	}
	if (minuteFormatZoneCache.size >= MAX_CACHED_ZONES) {
		const oldestZone = minuteFormatZoneCache.keys().next().value;
		if (oldestZone !== undefined) {
			minuteFormatZoneCache.delete(oldestZone);
		}
	}
	const created: ZoneMinuteFormatterEntry = { dtf, buckets: new Map<number, string>() };
	minuteFormatZoneCache.set(timeZone, created);
	return created;
}

function formatUtcEpochMsToMinuteIsoFast(epochMs: number): string {
	const totalMinutes = Math.floor(epochMs / 60_000);
	const minuteOfDay = totalMinutes % 1_440;
	const hour = Math.floor(minuteOfDay / 60);
	const minute = minuteOfDay % 60;
	const days = Math.floor(totalMinutes / 1_440);

	// Howard Hinnant's civil-from-days algorithm for proleptic Gregorian calendar
	const z = days + 719_468;
	const era = Math.floor(z / 146_097);
	const doe = z - era * 146_097;
	const yoe = Math.floor(
		(doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) /
			365,
	);
	const y = yoe + era * 400;
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp < 10 ? mp + 3 : mp - 9;
	const year = y + (month <= 2 ? 1 : 0);

	const yyyy = year >= 1_000 ? String(year) : String(year).padStart(4, '0');
	return `${yyyy}-${PAD2[month]!}-${PAD2[day]!}T${PAD2[hour]!}:${PAD2[minute]!}`;
}

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
	if (timeZone === 'UTC' && year >= 100 && year <= 9_999) {
		return Date.UTC(year, month - 1, day, hour, minute, second, ms);
	}
	const pdt = new Temporal.PlainDateTime(year, month, day, hour, minute, second, ms);
	const zdt = pdt.toZonedDateTime(timeZone, { disambiguation: 'compatible' });
	return zdt.epochMilliseconds;
}

/**
 * Formats a UTC epoch-millisecond timestamp as a minute-grain ISO-8601 string
 * (`YYYY-MM-DDTHH:mm`) in `timeZone`.
 */
export function formatEpochMsToMinuteIso(epochMs: number, timeZone: string): string {
	if (Number.isSafeInteger(epochMs)) {
		if (timeZone === 'UTC' && epochMs >= 0 && epochMs <= MAX_4DIGIT_YEAR_EPOCH_MS) {
			return formatUtcEpochMsToMinuteIsoFast(epochMs);
		}
		if (epochMs >= MIN_MODERN_INTL_EPOCH_MS && epochMs <= MAX_MODERN_INTL_EPOCH_MS) {
			const zoneEntry = getZoneMinuteFormatter(timeZone);
			if (zoneEntry?.dtf) {
				const minuteBucket = Math.floor(epochMs / 60_000);
				const cached = zoneEntry.buckets.get(minuteBucket);
				if (cached !== undefined) {
					return cached;
				}
				const parts = zoneEntry.dtf.formatToParts(minuteBucket * 60_000);
				let year = '';
				let month = '';
				let day = '';
				let hour = '';
				let minute = '';
				for (const part of parts) {
					switch (part.type) {
						case 'year':
							year = part.value;
							break;
						case 'month':
							month = part.value;
							break;
						case 'day':
							day = part.value;
							break;
						case 'hour':
							hour = part.value;
							break;
						case 'minute':
							minute = part.value;
							break;
					}
				}
				if (year && month && day && hour && minute) {
					const hh = hour === '24' ? '00' : hour;
					const formatted = `${year.padStart(4, '0')}-${month}-${day}T${hh}:${minute}`;
					if (zoneEntry.buckets.size >= MAX_MINUTE_BUCKETS_PER_ZONE) {
						const oldest = zoneEntry.buckets.keys().next().value;
						if (oldest !== undefined) {
							zoneEntry.buckets.delete(oldest);
						}
					}
					zoneEntry.buckets.set(minuteBucket, formatted);
					return formatted;
				}
			}
		}
	}
	const zdt = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
	const yyyy =
		zdt.year < 0
			? `-${String(Math.abs(zdt.year)).padStart(6, '0')}`
			: String(zdt.year).padStart(4, '0');
	const mm = String(zdt.month).padStart(2, '0');
	const dd = String(zdt.day).padStart(2, '0');
	const hh = String(zdt.hour).padStart(2, '0');
	const min = String(zdt.minute).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
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
