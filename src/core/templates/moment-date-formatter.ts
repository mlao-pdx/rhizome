import { Temporal } from '@js-temporal/polyfill';

const MONTHS_LONG: readonly string[] = Object.freeze([
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
]);

const MONTHS_SHORT: readonly string[] = Object.freeze([
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
]);

const WEEKDAYS_LONG: readonly string[] = Object.freeze([
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
]);

const WEEKDAYS_SHORT: readonly string[] = Object.freeze([
	'Sun',
	'Mon',
	'Tue',
	'Wed',
	'Thu',
	'Fri',
	'Sat',
]);

const WEEKDAYS_MIN: readonly string[] = Object.freeze(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);

const LONG_DATE_FORMATS: Readonly<Record<string, string>> = Object.freeze({
	LTS: 'h:mm:ss A',
	LT: 'h:mm A',
	L: 'MM/DD/YYYY',
	LL: 'MMMM D, YYYY',
	LLL: 'MMMM D, YYYY h:mm A',
	LLLL: 'dddd, MMMM D, YYYY h:mm A',
	l: 'M/D/YYYY',
	ll: 'MMM D, YYYY',
	lll: 'MMM D, YYYY h:mm A',
	llll: 'ddd, MMM D, YYYY h:mm A',
});

const LOCAL_FORMATTING_TOKENS_RE = /(\[[^[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g;

const MOMENT_FORMATTING_TOKENS_RE =
	/(\[[^[]*\])|(\\e)|(\\)?(eHHmm|[Hh]mm(ss)?|Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Qo?|N{1,5}|YYYYYY|YYYYY|YYYY|YY|y{2,4}|yo?|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|kk?|mm?|ss?|S{1,9}|x|X|zz?|ZZ?|[\s\S])/g;

/**
 * Returns `true` when `format` contains `'%'`, selecting LiquidJS's `strftime` flavor
 * over Obsidian's Moment.js flavor.
 *
 * @remarks
 * (obsidian-idiom, 2026-11-04) Every `strftime` directive begins with `'%'` (`%Y`, `%m`,
 * `%%`, etc.), whereas Moment.js format strings use letter tokens (`YYYY-MM-DD`, `HH:mm`)
 * and `[...]` literal escapes, making `'%'` an unambiguous flavor selector.
 */
export function isStrftimeDateFormat(format: string): boolean {
	return format.includes('%');
}

function zeroFill(num: number, targetLength: number, forceSign = false): string {
	const absStr = String(Math.abs(num));
	const padCount = Math.max(0, targetLength - absStr.length);
	const sign = num >= 0 ? (forceSign ? '+' : '') : '-';
	return `${sign}${'0'.repeat(padCount)}${absStr}`;
}

function formatOrdinal(num: number): string {
	const b = num % 10;
	const suffix =
		Math.trunc((num % 100) / 10) === 1
			? 'th'
			: b === 1
				? 'st'
				: b === 2
					? 'nd'
					: b === 3
						? 'rd'
						: 'th';
	return `${num}${suffix}`;
}

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInYear(year: number): number {
	return isLeapYear(year) ? 366 : 365;
}

function firstWeekOffset(year: number, dow: number, doy: number): number {
	const fwd = 7 + dow - doy;
	const janFwdDow = new Date(Date.UTC(year, 0, fwd));
	if (Number.isFinite(janFwdDow.getUTCFullYear())) {
		janFwdDow.setUTCFullYear(year);
	}
	const fwdlw = (7 + janFwdDow.getUTCDay() - dow) % 7;
	return -fwdlw + fwd - 1;
}

function weeksInYear(year: number, dow: number, doy: number): number {
	const weekOffset = firstWeekOffset(year, dow, doy);
	const weekOffsetNext = firstWeekOffset(year + 1, dow, doy);
	return (daysInYear(year) - weekOffset + weekOffsetNext) / 7;
}

function computeMomentWeekOfYear(
	year: number,
	dayOfYear: number,
	dow: number,
	doy: number,
): { readonly week: number; readonly year: number } {
	const weekOffset = firstWeekOffset(year, dow, doy);
	const week = Math.floor((dayOfYear - weekOffset - 1) / 7) + 1;
	if (week < 1) {
		const resYear = year - 1;
		return { week: week + weeksInYear(resYear, dow, doy), year: resYear };
	}
	const maxWeeks = weeksInYear(year, dow, doy);
	if (week > maxWeeks) {
		return { week: week - maxWeeks, year: year + 1 };
	}
	return { week, year };
}

function formatUtcOffset(utcOffsetMinutes: number, separator: string): string {
	const sign = utcOffsetMinutes < 0 ? '-' : '+';
	const absMins = Math.abs(utcOffsetMinutes);
	const hh = zeroFill(Math.trunc(absMins / 60), 2);
	const mm = zeroFill(Math.trunc(absMins % 60), 2);
	return `${sign}${hh}${separator}${mm}`;
}

function expandMomentFormat(format: string): string {
	let expanded = format;
	let remainingPasses = 5;
	LOCAL_FORMATTING_TOKENS_RE.lastIndex = 0;
	while (remainingPasses >= 0 && LOCAL_FORMATTING_TOKENS_RE.test(expanded)) {
		expanded = expanded.replace(
			LOCAL_FORMATTING_TOKENS_RE,
			(match: string) => LONG_DATE_FORMATS[match] ?? match,
		);
		LOCAL_FORMATTING_TOKENS_RE.lastIndex = 0;
		remainingPasses -= 1;
	}
	return expanded;
}

function removeFormattingTokens(token: string): string {
	if (/^\[[\s\S]*\]$/.test(token)) {
		return token.slice(1, -1);
	}
	return token.replace(/\\/g, '');
}

/**
 * Resolved timezone representation shared by both Moment.js and LiquidJS `strftime`
 * branches of the `date` filter.
 */
export interface ResolvedTemporalTimeZone {
	/** Validated IANA identifier or normalized `±HH:MM` offset for `@js-temporal/polyfill`. */
	readonly timeZone: string;
	/** Validated IANA identifier or `Date.prototype.getTimezoneOffset()` minutes for LiquidJS `LiquidDate`. */
	readonly strftimeTz: number | string;
	/** Whether the resolved timezone represents UTC (`+00:00`). */
	readonly isUtc: boolean;
}

const MAX_TIMEZONE_CACHE_SIZE = 128;
const validatedIanaTimeZones = new Map<string, boolean>();

/**
 * Returns `true` when `trimmed` is a supported IANA timezone identifier in `@js-temporal/polyfill`,
 * memoizing results in a bounded cache.
 */
export function isValidIanaTimeZone(trimmed: string): boolean {
	const cached = validatedIanaTimeZones.get(trimmed);
	if (cached !== undefined) {
		return cached;
	}
	let valid = false;
	try {
		Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(trimmed);
		valid = true;
	} catch {
		valid = false;
	}
	if (validatedIanaTimeZones.size >= MAX_TIMEZONE_CACHE_SIZE) {
		const oldestKey = validatedIanaTimeZones.keys().next().value;
		if (oldestKey !== undefined) {
			validatedIanaTimeZones.delete(oldestKey);
		}
	}
	validatedIanaTimeZones.set(trimmed, valid);
	return valid;
}

const UTC_RESOLVED_ZONE: ResolvedTemporalTimeZone = Object.freeze({
	timeZone: 'UTC',
	strftimeTz: 'UTC',
	isUtc: true,
});

/**
 * Normalizes an explicit timezone argument (IANA name, ISO offset string, or LiquidJS
 * `Date.prototype.getTimezoneOffset()` minutes number) into a `ResolvedTemporalTimeZone`
 * usable by both `@js-temporal/polyfill` and LiquidJS `strftime`.
 */
export function resolveTemporalTimeZone(
	explicitTz: unknown,
	fallbackTimeZone = 'UTC',
): ResolvedTemporalTimeZone {
	const tryZone = (candidate: string): ResolvedTemporalTimeZone | null => {
		const trimmed = candidate.trim();
		if (trimmed.length === 0) return null;
		const upper = trimmed.toUpperCase();
		if (upper === 'Z' || upper === 'UTC' || upper === 'ETC/UTC' || upper === 'ETC/GMT') {
			return UTC_RESOLVED_ZONE;
		}
		const offsetMatch = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(trimmed);
		if (offsetMatch) {
			const signChar = offsetMatch[1]!;
			const hh = Number(offsetMatch[2]!);
			const mm = offsetMatch[3] !== undefined ? Number(offsetMatch[3]) : 0;
			if (hh <= 23 && mm <= 59) {
				if (hh === 0 && mm === 0) {
					return { timeZone: 'UTC', strftimeTz: 0, isUtc: true };
				}
				const isoOffset = `${signChar}${zeroFill(hh, 2)}:${zeroFill(mm, 2)}`;
				const strftimeMinutes = (signChar === '+' ? -1 : 1) * (hh * 60 + mm);
				return { timeZone: isoOffset, strftimeTz: strftimeMinutes, isUtc: false };
			}
		}
		if (isValidIanaTimeZone(trimmed)) {
			return { timeZone: trimmed, strftimeTz: trimmed, isUtc: false };
		}
		return null;
	};

	if (typeof explicitTz === 'number' && Number.isFinite(explicitTz)) {
		const truncated = Math.trunc(explicitTz);
		const utcOffsetMins = -truncated;
		if (utcOffsetMins === 0) {
			return { timeZone: 'UTC', strftimeTz: 0, isUtc: true };
		}
		if (Math.abs(utcOffsetMins) < 24 * 60) {
			return {
				timeZone: formatUtcOffset(utcOffsetMins, ':'),
				strftimeTz: truncated,
				isUtc: false,
			};
		}
	}

	if (typeof explicitTz === 'string') {
		const resolved = tryZone(explicitTz);
		if (resolved) return resolved;
	}

	return tryZone(fallbackTimeZone) ?? UTC_RESOLVED_ZONE;
}

interface MomentTokenContext {
	readonly epochMs: number;
	readonly zdt: Temporal.ZonedDateTime;
	readonly isUtc: boolean;
	readonly utcOffsetMinutes: number;
	readonly localeWeek: { readonly week: number; readonly year: number };
	readonly isoWeek: { readonly week: number; readonly year: number };
}

type MomentTokenEvaluator = (ctx: MomentTokenContext) => string;

const MOMENT_TOKEN_EVALUATORS: Readonly<Record<string, MomentTokenEvaluator>> = Object.freeze({
	Y: ({ zdt }) => (zdt.year <= 9999 ? zeroFill(zdt.year, 4) : `+${zdt.year}`),
	YY: ({ zdt }) => zeroFill(zdt.year % 100, 2),
	YYYY: ({ zdt }) => zeroFill(zdt.year, 4),
	YYYYY: ({ zdt }) => zeroFill(zdt.year, 5),
	YYYYYY: ({ zdt }) => zeroFill(zdt.year, 6, true),
	y: ({ zdt }) => zeroFill(zdt.year >= 1 ? zdt.year : 1 - zdt.year, 1),
	yy: ({ zdt }) => zeroFill(zdt.year >= 1 ? zdt.year : 1 - zdt.year, 2),
	yyy: ({ zdt }) => zeroFill(zdt.year >= 1 ? zdt.year : 1 - zdt.year, 3),
	yyyy: ({ zdt }) => zeroFill(zdt.year >= 1 ? zdt.year : 1 - zdt.year, 4),
	yo: ({ zdt }) => formatOrdinal(zdt.year >= 1 ? zdt.year : 1 - zdt.year),
	N: ({ zdt }) => (zdt.year >= 1 ? 'AD' : 'BC'),
	NN: ({ zdt }) => (zdt.year >= 1 ? 'AD' : 'BC'),
	NNN: ({ zdt }) => (zdt.year >= 1 ? 'AD' : 'BC'),
	NNNN: ({ zdt }) => (zdt.year >= 1 ? 'Anno Domini' : 'Before Christ'),
	NNNNN: ({ zdt }) => (zdt.year >= 1 ? 'AD' : 'BC'),
	Q: ({ zdt }) => String(Math.ceil(zdt.month / 3)),
	Qo: ({ zdt }) => formatOrdinal(Math.ceil(zdt.month / 3)),
	M: ({ zdt }) => String(zdt.month),
	MM: ({ zdt }) => zeroFill(zdt.month, 2),
	Mo: ({ zdt }) => formatOrdinal(zdt.month),
	MMM: ({ zdt }) => MONTHS_SHORT[zdt.month - 1] ?? '',
	MMMM: ({ zdt }) => MONTHS_LONG[zdt.month - 1] ?? '',
	D: ({ zdt }) => String(zdt.day),
	DD: ({ zdt }) => zeroFill(zdt.day, 2),
	Do: ({ zdt }) => formatOrdinal(zdt.day),
	DDD: ({ zdt }) => String(zdt.dayOfYear),
	DDDD: ({ zdt }) => zeroFill(zdt.dayOfYear, 3),
	DDDo: ({ zdt }) => formatOrdinal(zdt.dayOfYear),
	d: ({ zdt }) => String(zdt.dayOfWeek % 7),
	do: ({ zdt }) => formatOrdinal(zdt.dayOfWeek % 7),
	dd: ({ zdt }) => WEEKDAYS_MIN[zdt.dayOfWeek % 7] ?? '',
	ddd: ({ zdt }) => WEEKDAYS_SHORT[zdt.dayOfWeek % 7] ?? '',
	dddd: ({ zdt }) => WEEKDAYS_LONG[zdt.dayOfWeek % 7] ?? '',
	e: ({ zdt }) => String(zdt.dayOfWeek % 7),
	E: ({ zdt }) => String(zdt.dayOfWeek),
	eHHmm: ({ zdt }) => `${zdt.dayOfWeek % 7}${zeroFill(zdt.hour, 2)}${zeroFill(zdt.minute, 2)}`,
	w: ({ localeWeek }) => String(localeWeek.week),
	ww: ({ localeWeek }) => zeroFill(localeWeek.week, 2),
	wo: ({ localeWeek }) => formatOrdinal(localeWeek.week),
	W: ({ isoWeek }) => String(isoWeek.week),
	WW: ({ isoWeek }) => zeroFill(isoWeek.week, 2),
	Wo: ({ isoWeek }) => formatOrdinal(isoWeek.week),
	gg: ({ localeWeek }) => zeroFill(localeWeek.year % 100, 2),
	gggg: ({ localeWeek }) => zeroFill(localeWeek.year, 4),
	ggggg: ({ localeWeek }) => zeroFill(localeWeek.year, 5),
	GG: ({ isoWeek }) => zeroFill(isoWeek.year % 100, 2),
	GGGG: ({ isoWeek }) => zeroFill(isoWeek.year, 4),
	GGGGG: ({ isoWeek }) => zeroFill(isoWeek.year, 5),
	H: ({ zdt }) => String(zdt.hour),
	HH: ({ zdt }) => zeroFill(zdt.hour, 2),
	h: ({ zdt }) => String(zdt.hour % 12 || 12),
	hh: ({ zdt }) => zeroFill(zdt.hour % 12 || 12, 2),
	k: ({ zdt }) => String(zdt.hour || 24),
	kk: ({ zdt }) => zeroFill(zdt.hour || 24, 2),
	hmm: ({ zdt }) => `${zdt.hour % 12 || 12}${zeroFill(zdt.minute, 2)}`,
	hmmss: ({ zdt }) =>
		`${zdt.hour % 12 || 12}${zeroFill(zdt.minute, 2)}${zeroFill(zdt.second, 2)}`,
	Hmm: ({ zdt }) => `${zdt.hour}${zeroFill(zdt.minute, 2)}`,
	Hmmss: ({ zdt }) => `${zdt.hour}${zeroFill(zdt.minute, 2)}${zeroFill(zdt.second, 2)}`,
	a: ({ zdt }) => (zdt.hour < 12 ? 'am' : 'pm'),
	A: ({ zdt }) => (zdt.hour < 12 ? 'AM' : 'PM'),
	m: ({ zdt }) => String(zdt.minute),
	mm: ({ zdt }) => zeroFill(zdt.minute, 2),
	s: ({ zdt }) => String(zdt.second),
	ss: ({ zdt }) => zeroFill(zdt.second, 2),
	S: ({ zdt }) => String(Math.trunc(zdt.millisecond / 100)),
	SS: ({ zdt }) => zeroFill(Math.trunc(zdt.millisecond / 10), 2),
	SSS: ({ zdt }) => zeroFill(zdt.millisecond, 3),
	SSSS: ({ zdt }) => zeroFill(zdt.millisecond * 10, 4),
	SSSSS: ({ zdt }) => zeroFill(zdt.millisecond * 100, 5),
	SSSSSS: ({ zdt }) => zeroFill(zdt.millisecond * 1_000, 6),
	SSSSSSS: ({ zdt }) => zeroFill(zdt.millisecond * 10_000, 7),
	SSSSSSSS: ({ zdt }) => zeroFill(zdt.millisecond * 100_000, 8),
	SSSSSSSSS: ({ zdt }) => zeroFill(zdt.millisecond * 1_000_000, 9),
	Z: ({ utcOffsetMinutes }) => formatUtcOffset(utcOffsetMinutes, ':'),
	ZZ: ({ utcOffsetMinutes }) => formatUtcOffset(utcOffsetMinutes, ''),
	z: ({ isUtc }) => (isUtc ? 'UTC' : ''),
	zz: ({ isUtc }) => (isUtc ? 'Coordinated Universal Time' : ''),
	X: ({ epochMs }) => String(Math.floor(epochMs / 1000)),
	x: ({ epochMs }) => String(epochMs),
});

const MAX_FORMAT_CACHE_SIZE = 256;
const compiledMomentFormatCache = new Map<string, readonly (MomentTokenEvaluator | string)[]>();

function getCompiledMomentFormatSteps(format: string): readonly (MomentTokenEvaluator | string)[] {
	const cached = compiledMomentFormatCache.get(format);
	if (cached !== undefined) {
		return cached;
	}
	const expanded = expandMomentFormat(format);
	const tokens = expanded.match(MOMENT_FORMATTING_TOKENS_RE);
	const steps: (MomentTokenEvaluator | string)[] = [];
	if (tokens) {
		for (const tok of tokens) {
			const evaluator = Object.prototype.hasOwnProperty.call(MOMENT_TOKEN_EVALUATORS, tok)
				? MOMENT_TOKEN_EVALUATORS[tok]
				: undefined;
			steps.push(evaluator ?? removeFormattingTokens(tok));
		}
	}
	const frozenSteps = Object.freeze(steps);
	if (compiledMomentFormatCache.size >= MAX_FORMAT_CACHE_SIZE) {
		const oldestKey = compiledMomentFormatCache.keys().next().value;
		if (oldestKey !== undefined) {
			compiledMomentFormatCache.delete(oldestKey);
		}
	}
	compiledMomentFormatCache.set(format, frozenSteps);
	return frozenSteps;
}

/**
 * Formats an epoch-millisecond timestamp using Obsidian's native Moment.js format syntax
 * in the resolved `effectiveTz` (defaulting to `fallbackTimeZone`).
 */
export function formatMomentDate(
	epochMs: number,
	format: string,
	effectiveTz?: unknown,
	fallbackTimeZone = 'UTC',
): string {
	if (format.length === 0) {
		return '';
	}
	const steps = getCompiledMomentFormatSteps(format);
	if (steps.length === 0) {
		return '';
	}
	const { timeZone, isUtc } = resolveTemporalTimeZone(effectiveTz, fallbackTimeZone);
	const zdt = Temporal.Instant.fromEpochMilliseconds(Math.trunc(epochMs)).toZonedDateTimeISO(
		timeZone,
	);
	const utcOffsetMinutes = Math.trunc(zdt.offsetNanoseconds / 60_000_000_000);

	let localeWeekCache: { readonly week: number; readonly year: number } | undefined;
	let isoWeekCache: { readonly week: number; readonly year: number } | undefined;

	const ctx: MomentTokenContext = {
		epochMs: Math.trunc(epochMs),
		zdt,
		isUtc,
		utcOffsetMinutes,
		get localeWeek() {
			localeWeekCache ??= computeMomentWeekOfYear(zdt.year, zdt.dayOfYear, 0, 6);
			return localeWeekCache;
		},
		get isoWeek() {
			isoWeekCache ??= computeMomentWeekOfYear(zdt.year, zdt.dayOfYear, 1, 4);
			return isoWeekCache;
		},
	};

	let out = '';
	for (const step of steps) {
		out += typeof step === 'function' ? step(ctx) : step;
	}
	return out;
}
