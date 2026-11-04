import { Temporal } from '@js-temporal/polyfill';
import {
	compareDateIntervals,
	type DateInterval,
	MAX_SAFE_EPOCH_MS,
	parseTemporalExpr,
	wallClockToUtcMs,
} from '@core/search';
import { Drop, toValue } from 'liquidjs';

/**
 * Display and iteration boundary grains supported by `TemporalDrop`, ordered from
 * coarsest (`year`) to finest (`minute`).
 */
export type DisplayGrain = 'year' | 'month' | 'day' | 'minute';

const GRAIN_RANK: Readonly<Record<DisplayGrain, number>> = Object.freeze({
	year: 0,
	month: 1,
	day: 2,
	minute: 3,
});

const BARE_RELATIVE_ATOM_RE =
	/^(?:now|(?:today|yesterday|tomorrow|(?:last|this|next)day)(?:[+-]\d+d?)?|(?:last|this|next)(?:week|month|quarter|year))$/i;

/**
 * Maximum number of elements materialized by a temporal or numeric range in Liquid templates.
 */
export const MAX_RANGE_STEPS = 10_000;

/**
 * Checks whether `raw` is a bare relative temporal anchor or signed day-offset identifier
 * (`now`, `today`, `yesterday+3d`, `thisweek`, `thisquarter`, etc.).
 */
export function isBareRelativeTemporalAtom(raw: string): boolean {
	return BARE_RELATIVE_ATOM_RE.test(raw);
}

/**
 * Normalizes a bare relative temporal atom or `a..b` expression by prefixing relative
 * segments (`now`, `today`, `yesterday+3d`, `thisweek`, etc.) with `@` for `@core/search`.
 */
export function normalizeRelativeTemporalString(raw: string): string {
	const trimmed = raw.trim();
	const parts = trimmed.split('..');
	if (parts.length === 2) {
		const left = parts[0]?.trim() ?? '';
		const right = parts[1]?.trim() ?? '';
		const normLeft = isBareRelativeTemporalAtom(left) ? `@${left}` : left;
		const normRight = isBareRelativeTemporalAtom(right) ? `@${right}` : right;
		return `${normLeft}..${normRight}`;
	}
	return isBareRelativeTemporalAtom(trimmed) ? `@${trimmed}` : trimmed;
}

/**
 * Returns the finer of two `DisplayGrain` values (`'year' -> 'month' -> 'day' -> 'minute'`).
 */
export function finestDisplayGrain(a: DisplayGrain, b: DisplayGrain): DisplayGrain {
	return GRAIN_RANK[a] >= GRAIN_RANK[b] ? a : b;
}

const GRAIN_DISPLAY_MAP: Readonly<
	Record<
		DateInterval['grain'],
		{ readonly displayGrain: DisplayGrain; readonly isRange: boolean }
	>
> = Object.freeze({
	year: { displayGrain: 'year', isRange: false },
	quarter: { displayGrain: 'month', isRange: true },
	month: { displayGrain: 'month', isRange: false },
	week: { displayGrain: 'day', isRange: true },
	day: { displayGrain: 'day', isRange: false },
	minute: { displayGrain: 'minute', isRange: false },
	second: { displayGrain: 'minute', isRange: false },
	ms: { displayGrain: 'minute', isRange: false },
	range: { displayGrain: 'day', isRange: true },
});

/**
 * Maps a `DateInterval.grain` from `@core/search` to its `DisplayGrain` and whether
 * it represents a multi-unit range (`'week' -> 7 days`, `'quarter' -> 3 months'`).
 */
export function mapIntervalGrainToDisplay(grain: DateInterval['grain']): {
	readonly displayGrain: DisplayGrain;
	readonly isRange: boolean;
} {
	return GRAIN_DISPLAY_MAP[grain];
}

/**
 * Formats an epoch-millisecond timestamp in `timeZone` at the specified `DisplayGrain`.
 */
export function formatEpochMsAtGrain(
	epochMs: number,
	grain: DisplayGrain,
	timeZone: string,
): string {
	const zdt = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
	const yyyy = String(zdt.year).padStart(4, '0');
	if (grain === 'year') return yyyy;
	const mm = String(zdt.month).padStart(2, '0');
	if (grain === 'month') return `${yyyy}-${mm}`;
	const dd = String(zdt.day).padStart(2, '0');
	if (grain === 'day') return `${yyyy}-${mm}-${dd}`;
	const hh = String(zdt.hour).padStart(2, '0');
	const min = String(zdt.minute).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

/**
 * Options for constructing a `TemporalDrop`.
 */
export interface TemporalDropInit {
	readonly start: number;
	readonly end: number;
	readonly grain: DisplayGrain;
	readonly isRange: boolean;
	readonly timeZone: string;
	readonly referenceTimeMs: number;
	readonly raw: string;
}

/**
 * LiquidJS `Drop` representing a half-open UTC millisecond interval `[start, end)`
 * with a display/boundary grain (`year`, `month`, `day`, or `minute`).
 *
 * @remarks
 * (design, 2026-10-31) Does not override `valueOf()` to return a primitive so LiquidJS's
 * `toValue(drop)` preserves the `TemporalDrop` instance for `{% for %}` iteration
 * (`[Symbol.iterator]`), direct `{{ ... }}` output (`toString()`), and interval comparison
 * operators.
 */
export class TemporalDrop extends Drop implements Iterable<TemporalDrop> {
	public readonly start: number;
	public readonly end: number;
	public readonly grain: DisplayGrain;
	public readonly isRange: boolean;
	public readonly timeZone: string;
	public readonly referenceTimeMs: number;
	public readonly raw: string;

	public constructor(init: TemporalDropInit) {
		super();
		this.start = init.start;
		this.end = init.end;
		this.grain = init.grain;
		this.isRange = init.isRange;
		this.timeZone = init.timeZone;
		this.referenceTimeMs = init.referenceTimeMs;
		this.raw = init.raw;
	}

	/**
	 * Creates a `TemporalDrop` from a `DateInterval` parsed by `@core/search`.
	 */
	public static fromDateInterval(
		interval: DateInterval,
		timeZone: string,
		referenceTimeMs: number,
	): TemporalDrop {
		const mapped = mapIntervalGrainToDisplay(interval.grain);
		return new TemporalDrop({
			start: interval.start,
			end: interval.end,
			grain: mapped.displayGrain,
			isRange: mapped.isRange,
			timeZone,
			referenceTimeMs,
			raw: interval.raw,
		});
	}

	/**
	 * Converts this `TemporalDrop` to a `@core/search` `DateInterval`.
	 */
	public toDateInterval(): DateInterval {
		return Object.freeze({
			start: this.start,
			end: this.end,
			grain: this.isRange ? 'range' : this.grain,
			raw: this.raw,
		});
	}

	/**
	 * Renders the temporal value or range as a grain-guided ISO-8601 string.
	 */
	public override toString(): string {
		const leftIso = formatEpochMsAtGrain(this.start, this.grain, this.timeZone);
		if (!this.isRange) return leftIso;
		const inclusiveEndMs = Math.max(this.start, this.end - 1);
		const rightIso = formatEpochMsAtGrain(inclusiveEndMs, this.grain, this.timeZone);
		return `${leftIso}..${rightIso}`;
	}

	/**
	 * Iterates across `[start, end)` in `timeZone` by one unit of `grain`, yielding
	 * a single-unit `TemporalDrop` for each step.
	 */
	public *[Symbol.iterator](): IterableIterator<TemporalDrop> {
		let steps = 0;
		if (this.grain === 'minute') {
			let cursorMs = Math.floor(this.start / 60_000) * 60_000;
			while (cursorMs < this.end) {
				if (++steps > MAX_RANGE_STEPS) {
					throw new Error(
						`Temporal range '${this.raw}' exceeds maximum iteration length (${MAX_RANGE_STEPS})`,
					);
				}
				const nextMs = cursorMs + 60_000;
				yield new TemporalDrop({
					start: cursorMs,
					end: nextMs,
					grain: 'minute',
					isRange: false,
					timeZone: this.timeZone,
					referenceTimeMs: this.referenceTimeMs,
					raw: formatEpochMsAtGrain(cursorMs, 'minute', this.timeZone),
				});
				cursorMs = nextMs;
			}
			return;
		}

		const startZdt = Temporal.Instant.fromEpochMilliseconds(this.start).toZonedDateTimeISO(
			this.timeZone,
		);
		let pd =
			this.grain === 'year'
				? Temporal.PlainDate.from({ year: startZdt.year, month: 1, day: 1 })
				: this.grain === 'month'
					? Temporal.PlainDate.from({
							year: startZdt.year,
							month: startZdt.month,
							day: 1,
						})
					: startZdt.toPlainDate();
		const durationStep =
			this.grain === 'year'
				? { years: 1 }
				: this.grain === 'month'
					? { months: 1 }
					: { days: 1 };

		let stepStart = wallClockToUtcMs(pd.year, pd.month, pd.day, 0, 0, 0, 0, this.timeZone);
		while (stepStart < this.end) {
			if (++steps > MAX_RANGE_STEPS) {
				throw new Error(
					`Temporal range '${this.raw}' exceeds maximum iteration length (${MAX_RANGE_STEPS})`,
				);
			}
			const nextPd = pd.add(durationStep);
			const stepEnd = wallClockToUtcMs(
				nextPd.year,
				nextPd.month,
				nextPd.day,
				0,
				0,
				0,
				0,
				this.timeZone,
			);
			const yyyy = String(pd.year).padStart(4, '0');
			const mm = String(pd.month).padStart(2, '0');
			const raw =
				this.grain === 'year'
					? yyyy
					: this.grain === 'month'
						? `${yyyy}-${mm}`
						: `${yyyy}-${mm}-${String(pd.day).padStart(2, '0')}`;
			yield new TemporalDrop({
				start: stepStart,
				end: stepEnd,
				grain: this.grain,
				isRange: false,
				timeZone: this.timeZone,
				referenceTimeMs: this.referenceTimeMs,
				raw,
			});
			pd = nextPd;
			stepStart = stepEnd;
		}
	}

	public equals(rhs: unknown): boolean {
		const other = coerceOperandToDateInterval(rhs, this.timeZone, this.referenceTimeMs);
		if (!other) return false;
		const self = this.toDateInterval();
		return compareDateIntervals(self, '=', other) || compareDateIntervals(other, '=', self);
	}

	public gt(rhs: unknown): boolean {
		const other = coerceOperandToDateInterval(rhs, this.timeZone, this.referenceTimeMs);
		return other ? compareDateIntervals(this.toDateInterval(), '>', other) : false;
	}

	public geq(rhs: unknown): boolean {
		const other = coerceOperandToDateInterval(rhs, this.timeZone, this.referenceTimeMs);
		return other ? compareDateIntervals(this.toDateInterval(), '>=', other) : false;
	}

	public lt(rhs: unknown): boolean {
		const other = coerceOperandToDateInterval(rhs, this.timeZone, this.referenceTimeMs);
		return other ? compareDateIntervals(this.toDateInterval(), '<', other) : false;
	}

	public leq(rhs: unknown): boolean {
		const other = coerceOperandToDateInterval(rhs, this.timeZone, this.referenceTimeMs);
		return other ? compareDateIntervals(this.toDateInterval(), '<=', other) : false;
	}
}

/**
 * Unwraps a LiquidJS value via `toValue`.
 */
export function unwrapLiquidValue(val: unknown): unknown {
	return toValue(val) as unknown;
}

/**
 * Coerces a Liquid expression operand (`TemporalDrop`, finite safe integer epoch ms,
 * or ISO/relative date string) into a `DateInterval` for interval comparisons.
 */
export function coerceOperandToDateInterval(
	val: unknown,
	timeZone: string,
	referenceTimeMs: number,
): DateInterval | null {
	const unwrapped = unwrapLiquidValue(val);
	if (unwrapped instanceof TemporalDrop) return unwrapped.toDateInterval();
	if (
		typeof unwrapped === 'number' &&
		Number.isSafeInteger(unwrapped) &&
		Math.abs(unwrapped) <= MAX_SAFE_EPOCH_MS
	) {
		return Object.freeze({
			start: unwrapped,
			end: unwrapped + 1,
			grain: 'ms',
			raw: String(unwrapped),
		});
	}
	if (typeof unwrapped === 'string') {
		const trimmed = unwrapped.trim();
		if (trimmed.length === 0) return null;
		const parsed = parseTemporalExpr(normalizeRelativeTemporalString(trimmed), {
			allowYearOnly: true,
			allowRelative: true,
			timeZone,
			referenceTimeMs,
		});
		if (parsed.ok) return parsed.interval;
	}
	return null;
}

/**
 * Combines two temporal endpoints (`lhs..rhs`) into a range `TemporalDrop` using the
 * Positional Range Rule (`[s1, e2)` iff `s1 < e2`) and the finest of the two endpoint grains.
 * Throws an `Error` with a `.hint` property when the range is reversed (`s1 >= e2`).
 */
export function combineTemporalRange(
	lhs: TemporalDrop,
	rhs: TemporalDrop,
	lhsLabel?: string,
	rhsLabel?: string,
): TemporalDrop {
	const leftName = (lhsLabel ?? lhs.raw).replace(/^@/, '');
	const rightName = (rhsLabel ?? rhs.raw).replace(/^@/, '');

	if (lhs.start >= rhs.end) {
		const swapHint = rhs.start < lhs.end ? `Use ${rightName}..${leftName}` : null;
		const suffix = swapHint ? `. ${swapHint}` : '';
		const err = new Error(
			`Reversed temporal range '${leftName}..${rightName}' (start reaches or exceeds end)${suffix}`,
		) as Error & { hint?: string | null };
		err.hint = swapHint;
		throw err;
	}

	return new TemporalDrop({
		start: lhs.start,
		end: rhs.end,
		grain: finestDisplayGrain(lhs.grain, rhs.grain),
		isRange: true,
		timeZone: lhs.timeZone,
		referenceTimeMs: lhs.referenceTimeMs,
		raw: `${leftName}..${rightName}`,
	});
}

export {
	formatMomentDate,
	isStrftimeDateFormat,
	isValidIanaTimeZone,
	type ResolvedTemporalTimeZone,
	resolveTemporalTimeZone,
} from './moment-date-formatter';
export {
	attachLiquidInstanceToOptions,
	createRhizomeLiquidOperators,
	dateToLongStringFilter,
	dateToRfc822Filter,
	dateToStringFilter,
	dateToXmlschemaFilter,
	LIQUID_INSTANCE_SYMBOL,
	readContextLiquidInstance,
	readContextTemporalMeta,
	registerTemporalLiquidExtensions,
	resolveDefaultSystemTimeZone,
	resolveValidTimeZone,
	rhizomeDateFilter,
	TEMPORAL_CONTEXT_META_SYMBOL,
	type TemporalContextMeta,
} from './temporal-liquid-extensions';
export {
	coerceNonNumericEndpointToTemporalDrop,
	coerceNumericEndpointToTemporalDrop,
	installTemporalTokenizerExtensions,
	parseFiniteRangeNumber,
	type RangeTokenMetadata,
} from './temporal-range-tokenizer';
