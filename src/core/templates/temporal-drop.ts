import { Temporal } from '@js-temporal/polyfill';
import {
	compareDateIntervals,
	type DateInterval,
	isValidReferenceTimeMs,
	MAX_SAFE_EPOCH_MS,
	parseSingleTemporalAtom,
	parseTemporalExpr,
	type PropertyOperator,
	wallClockToUtcMs,
} from '@core/search';
import {
	type Context,
	defaultOperators,
	Drop,
	filters,
	type Liquid,
	Token,
	TokenKind,
	Tokenizer,
	toValue,
} from 'liquidjs';

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

const DAY_ANCHOR_NAME_RE = /^(?:today|yesterday|tomorrow|(?:last|this|next)day)$/i;
const PLUS_DAY_OFFSET_SUFFIX_RE = /^\+\d+d?(?![a-zA-Z0-9_-])/i;
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

/**
 * Maps a `DateInterval.grain` from `@core/search` to its `DisplayGrain` and whether
 * it represents a multi-unit range (`'week' -> 7 days`, `'quarter' -> 3 months'`).
 */
export function mapIntervalGrainToDisplay(grain: DateInterval['grain']): {
	readonly displayGrain: DisplayGrain;
	readonly isRange: boolean;
} {
	switch (grain) {
		case 'year':
			return { displayGrain: 'year', isRange: false };
		case 'quarter':
			return { displayGrain: 'month', isRange: true };
		case 'month':
			return { displayGrain: 'month', isRange: false };
		case 'week':
			return { displayGrain: 'day', isRange: true };
		case 'day':
			return { displayGrain: 'day', isRange: false };
		case 'minute':
		case 'second':
		case 'ms':
			return { displayGrain: 'minute', isRange: false };
		case 'range':
			return { displayGrain: 'day', isRange: true };
	}
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
	if (grain === 'year') {
		return yyyy;
	}
	const mm = String(zdt.month).padStart(2, '0');
	if (grain === 'month') {
		return `${yyyy}-${mm}`;
	}
	const dd = String(zdt.day).padStart(2, '0');
	if (grain === 'day') {
		return `${yyyy}-${mm}-${dd}`;
	}
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
 * Does not override `valueOf()` to return a primitive so LiquidJS's `toValue(drop)`
 * preserves the `TemporalDrop` instance for `{% for %}` iteration (`[Symbol.iterator]`),
 * direct `{{ ... }}` output (`toString()`), and interval comparison operators.
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
		if (!this.isRange) {
			return leftIso;
		}
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
				const stepIso = formatEpochMsAtGrain(cursorMs, 'minute', this.timeZone);
				yield new TemporalDrop({
					start: cursorMs,
					end: nextMs,
					grain: 'minute',
					isRange: false,
					timeZone: this.timeZone,
					referenceTimeMs: this.referenceTimeMs,
					raw: stepIso,
				});
				cursorMs = nextMs;
			}
			return;
		}

		const startZdt = Temporal.Instant.fromEpochMilliseconds(this.start).toZonedDateTimeISO(
			this.timeZone,
		);
		let pd: Temporal.PlainDate;
		if (this.grain === 'year') {
			pd = Temporal.PlainDate.from({ year: startZdt.year, month: 1, day: 1 });
		} else if (this.grain === 'month') {
			pd = Temporal.PlainDate.from({ year: startZdt.year, month: startZdt.month, day: 1 });
		} else {
			pd = startZdt.toPlainDate();
		}

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
			const raw =
				this.grain === 'year'
					? yyyy
					: this.grain === 'month'
						? `${yyyy}-${String(pd.month).padStart(2, '0')}`
						: `${yyyy}-${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
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
		if (!other) return false;
		return compareDateIntervals(this.toDateInterval(), '>', other);
	}

	public geq(rhs: unknown): boolean {
		const other = coerceOperandToDateInterval(rhs, this.timeZone, this.referenceTimeMs);
		if (!other) return false;
		return compareDateIntervals(this.toDateInterval(), '>=', other);
	}

	public lt(rhs: unknown): boolean {
		const other = coerceOperandToDateInterval(rhs, this.timeZone, this.referenceTimeMs);
		if (!other) return false;
		return compareDateIntervals(this.toDateInterval(), '<', other);
	}

	public leq(rhs: unknown): boolean {
		const other = coerceOperandToDateInterval(rhs, this.timeZone, this.referenceTimeMs);
		if (!other) return false;
		return compareDateIntervals(this.toDateInterval(), '<=', other);
	}
}

function unwrapLiquidValue(val: unknown): unknown {
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
	if (unwrapped instanceof TemporalDrop) {
		return unwrapped.toDateInterval();
	}
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
		if (parsed.ok) {
			return parsed.interval;
		}
	}
	return null;
}

function coerceEndpointToTemporalDrop(
	val: unknown,
	rawExpr: string,
	timeZone: string,
	referenceTimeMs: number,
): TemporalDrop | null {
	const unwrapped = unwrapLiquidValue(val);
	if (unwrapped instanceof TemporalDrop) {
		return unwrapped;
	}
	if (typeof unwrapped === 'string') {
		const trimmed = unwrapped.trim();
		if (trimmed.length === 0) return null;
		const res = parseSingleTemporalAtom(normalizeRelativeTemporalString(trimmed), {
			allowYearOnly: true,
			allowRelative: true,
			timeZone,
			referenceTimeMs,
		});
		if (res.ok) {
			return TemporalDrop.fromDateInterval(res.interval, timeZone, referenceTimeMs);
		}
	}
	if (
		typeof unwrapped === 'number' &&
		Number.isSafeInteger(unwrapped) &&
		Math.abs(unwrapped) <= MAX_SAFE_EPOCH_MS &&
		Math.abs(unwrapped) > 10_000_000_000
	) {
		return new TemporalDrop({
			start: unwrapped,
			end: unwrapped + 1,
			grain: 'minute',
			isRange: false,
			timeZone,
			referenceTimeMs,
			raw: rawExpr,
		});
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
	const s1 = lhs.start;
	const e1 = lhs.end;
	const s2 = rhs.start;
	const e2 = rhs.end;
	const leftName = (lhsLabel ?? lhs.raw).replace(/^@/, '');
	const rightName = (rhsLabel ?? rhs.raw).replace(/^@/, '');

	if (s1 >= e2) {
		const swapHint = s2 < e1 ? `Use ${rightName}..${leftName}` : null;
		const suffix = swapHint ? `. ${swapHint}` : '';
		const err = new Error(
			`Reversed temporal range '${leftName}..${rightName}' (start reaches or exceeds end)${suffix}`,
		) as Error & { hint?: string | null };
		err.hint = swapHint;
		throw err;
	}

	const finest = finestDisplayGrain(lhs.grain, rhs.grain);
	return new TemporalDrop({
		start: s1,
		end: e2,
		grain: finest,
		isRange: true,
		timeZone: lhs.timeZone,
		referenceTimeMs: lhs.referenceTimeMs,
		raw: `${leftName}..${rightName}`,
	});
}

function readContextTemporalMeta(ctx: Context): { timeZone: string; referenceTimeMs: number } {
	const rawTz: unknown = ctx.getSync(['tz']);
	const timeZone = typeof rawTz === 'string' && rawTz.length > 0 ? rawTz : 'UTC';
	const rawNow: unknown = ctx.getSync(['now']);
	const referenceTimeMs =
		rawNow instanceof TemporalDrop && isValidReferenceTimeMs(rawNow.referenceTimeMs)
			? rawNow.referenceTimeMs
			: Date.now();
	return { timeZone, referenceTimeMs };
}

function wrapDropAsMethodMissingProxy(drop: Drop): Drop {
	return new Proxy(drop, {
		get(target, prop) {
			if (prop === 'liquidMethodMissing') {
				return target.liquidMethodMissing.bind(target);
			}
			return undefined;
		},
	});
}

class RangeRhsDrop extends Drop {
	private readonly lhsVal: unknown;
	private readonly lhsRaw: string;
	private readonly rhsRaw: string;

	public constructor(lhsVal: unknown, lhsRaw: string, rhsRaw: string) {
		super();
		this.lhsVal = lhsVal;
		this.lhsRaw = lhsRaw;
		this.rhsRaw = rhsRaw;
		return wrapDropAsMethodMissingProxy(this) as this;
	}

	public override liquidMethodMissing(rhsVal: unknown, ctx: Context): unknown {
		const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);
		const lhsTemporal = coerceEndpointToTemporalDrop(
			this.lhsVal,
			this.lhsRaw,
			timeZone,
			referenceTimeMs,
		);
		const rhsTemporal = coerceEndpointToTemporalDrop(
			rhsVal,
			this.rhsRaw,
			timeZone,
			referenceTimeMs,
		);

		if (lhsTemporal && rhsTemporal) {
			return combineTemporalRange(lhsTemporal, rhsTemporal, this.lhsRaw, this.rhsRaw);
		}
		if (lhsTemporal || rhsTemporal) {
			const badSide = lhsTemporal ? this.rhsRaw : this.lhsRaw;
			throw new Error(
				`Invalid temporal range '${this.lhsRaw}..${this.rhsRaw}': '${badSide}' is not a valid temporal literal`,
			);
		}

		const low = Number(unwrapLiquidValue(this.lhsVal));
		const high = Number(unwrapLiquidValue(rhsVal));
		if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) {
			return [];
		}
		const length = Math.max(0, Math.floor(high) - Math.floor(low) + 1);
		if (length > MAX_RANGE_STEPS) {
			throw new Error(
				`Range '${this.lhsRaw}..${this.rhsRaw}' exceeds maximum length (${MAX_RANGE_STEPS})`,
			);
		}
		const arr: number[] = [];
		for (let i = 0; i < length; i++) {
			arr.push(Math.floor(low) + i);
		}
		return arr;
	}
}

class RangeLhsDrop extends Drop {
	private readonly lhsRaw: string;
	private readonly rhsRaw: string;

	public constructor(lhsRaw: string, rhsRaw: string) {
		super();
		this.lhsRaw = lhsRaw;
		this.rhsRaw = rhsRaw;
		return wrapDropAsMethodMissingProxy(this) as this;
	}

	public override liquidMethodMissing(lhsVal: unknown): unknown {
		return new RangeRhsDrop(lhsVal, this.lhsRaw, this.rhsRaw);
	}
}

class ConcreteToken extends Token {}

function createRangeEvaluationToken(
	input: string,
	begin: number,
	end: number,
	lhsToken: Token,
	rhsToken: Token,
	file: string | undefined,
): Token {
	const lhsRaw = lhsToken.getText().trim();
	const rhsRaw = rhsToken.getText().trim();

	const starterToken = new ConcreteToken(
		TokenKind.Literal,
		input,
		begin,
		begin,
		file,
	) as Token & {
		content: unknown;
	};
	starterToken.content = new RangeLhsDrop(lhsRaw, rhsRaw);

	const propAccessToken = new ConcreteToken(
		TokenKind.PropertyAccess,
		input,
		begin,
		end,
		file,
	) as Token & {
		variable: Token;
		props: Token[];
	};
	propAccessToken.variable = starterToken;
	propAccessToken.props = [lhsToken, rhsToken];
	return propAccessToken;
}

let tokenizerExtensionsInstalled = false;

/**
 * Installs idempotent prototype extensions on LiquidJS `Tokenizer` so that:
 * 1. `<dayAnchor>+<N>d` (e.g. `yesterday+3d`) tokenizes as a single identifier token.
 * 2. Both unparenthesized `lhs..rhs` and parenthesized `(lhs..rhs)` range expressions
 *    evaluate temporal and numeric ranges at render time.
 */
export function installTemporalTokenizerExtensions(): void {
	if (tokenizerExtensionsInstalled) {
		return;
	}
	tokenizerExtensionsInstalled = true;

	const tokenizerProto = Tokenizer.prototype as unknown as {
		readIdentifier: (this: Tokenizer) => ReturnType<Tokenizer['readIdentifier']>;
		readRange: (this: Tokenizer) => ReturnType<Tokenizer['readRange']>;
		readValue: (this: Tokenizer) => ReturnType<Tokenizer['readValue']>;
	};

	const origReadIdentifier = tokenizerProto.readIdentifier;
	tokenizerProto.readIdentifier = function (this: Tokenizer) {
		const token = origReadIdentifier.call(this);
		if (DAY_ANCHOR_NAME_RE.test(token.content)) {
			const rem = this.remaining();
			const plusMatch = PLUS_DAY_OFFSET_SUFFIX_RE.exec(rem);
			if (plusMatch) {
				this.advance(plusMatch[0].length);
				const mutable = token as unknown as {
					end: number;
					content: string;
					getText(): string;
				};
				mutable.end = this.p;
				mutable.content = mutable.getText();
			}
		}
		return token;
	};

	const origReadValue = tokenizerProto.readValue;

	const readSingleValue = function (this: Tokenizer) {
		return origReadValue.call(this);
	};

	tokenizerProto.readRange = function (this: Tokenizer) {
		this.skipBlank();
		const begin = this.p;
		if (this.peek() !== '(') {
			return undefined;
		}
		this.advance(1);
		const lhs = readSingleValue.call(this);
		this.assert(lhs, () => `unexpected token ${this.snapshot()}, value expected`);
		this.skipBlank();
		this.assert(this.read() === '.' && this.read() === '.', 'invalid range syntax');
		const rhs = readSingleValue.call(this);
		this.assert(rhs, () => `unexpected token ${this.snapshot()}, value expected`);
		this.skipBlank();
		this.assert(this.read() === ')', 'invalid range syntax');
		return createRangeEvaluationToken(
			this.input,
			begin,
			this.p,
			lhs!,
			rhs!,
			this.file,
		) as unknown as ReturnType<Tokenizer['readRange']>;
	};

	tokenizerProto.readValue = function (this: Tokenizer) {
		this.skipBlank();
		const begin = this.p;
		const lhs = readSingleValue.call(this);
		if (!lhs) {
			return lhs;
		}
		if (this.peek() === '.' && this.peek(1) === '.') {
			this.advance(2);
			const rhs = readSingleValue.call(this);
			this.assert(rhs, () => `unexpected token ${this.snapshot()}, value expected`);
			return createRangeEvaluationToken(
				this.input,
				begin,
				this.p,
				lhs,
				rhs!,
				this.file,
			) as unknown as ReturnType<Tokenizer['readValue']>;
		}
		return lhs;
	};
}

function evaluateTemporalOperator(
	op: PropertyOperator,
	lhs: unknown,
	rhs: unknown,
): boolean | null {
	const lhsVal = unwrapLiquidValue(lhs);
	const rhsVal = unwrapLiquidValue(rhs);
	const temporalRef =
		lhsVal instanceof TemporalDrop ? lhsVal : rhsVal instanceof TemporalDrop ? rhsVal : null;
	if (!temporalRef) {
		return null;
	}
	const lhsInterval = coerceOperandToDateInterval(
		lhsVal,
		temporalRef.timeZone,
		temporalRef.referenceTimeMs,
	);
	const rhsInterval = coerceOperandToDateInterval(
		rhsVal,
		temporalRef.timeZone,
		temporalRef.referenceTimeMs,
	);
	if (!lhsInterval || !rhsInterval) {
		return op === '!=';
	}
	if (op === '=') {
		return (
			compareDateIntervals(lhsInterval, '=', rhsInterval) ||
			compareDateIntervals(rhsInterval, '=', lhsInterval)
		);
	}
	if (op === '!=') {
		return !(
			compareDateIntervals(lhsInterval, '=', rhsInterval) ||
			compareDateIntervals(rhsInterval, '=', lhsInterval)
		);
	}
	return compareDateIntervals(lhsInterval, op, rhsInterval);
}

/**
 * Builds the custom LiquidJS operator table that preserves left/right operand order for
 * interval comparisons whenever either operand is a `TemporalDrop`.
 */
export function createRhizomeLiquidOperators(): typeof defaultOperators {
	const fallbackBinary = (
		opName: '==' | '!=' | '>' | '<' | '>=' | '<=',
		l: unknown,
		r: unknown,
		ctx: Context,
	): unknown => {
		const fn = defaultOperators[opName] as
			((lhs: unknown, rhs: unknown, context: Context) => unknown) | undefined;
		return fn ? fn(l, r, ctx) : false;
	};

	const makeBinaryOp =
		(op: PropertyOperator, opName: '==' | '!=' | '>' | '<' | '>=' | '<=') =>
		(l: unknown, r: unknown, ctx: Context) => {
			const res = evaluateTemporalOperator(op, l, r);
			return res !== null ? res : fallbackBinary(opName, l, r, ctx);
		};

	return {
		...defaultOperators,
		'==': makeBinaryOp('=', '=='),
		'!=': makeBinaryOp('!=', '!='),
		'>': makeBinaryOp('>', '>'),
		'<': makeBinaryOp('<', '<'),
		'>=': makeBinaryOp('>=', '>='),
		'<=': makeBinaryOp('<=', '<='),
	} as unknown as typeof defaultOperators;
}

/**
 * Registers the millisecond-aware and `TemporalDrop`-aware `date` filter (and companion
 * `date_to_*` filters) on `liquid`.
 */
export function registerTemporalLiquidExtensions(liquid: Liquid): void {
	installTemporalTokenizerExtensions();

	const normalizeDateInput = (
		v: unknown,
		ctx: Context,
		explicitTz?: unknown,
	): { normalizedValue: unknown; effectiveTz: unknown } => {
		const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);
		const unwrapped = unwrapLiquidValue(v);
		const effectiveTz = explicitTz !== undefined ? explicitTz : timeZone;

		if (unwrapped instanceof TemporalDrop) {
			return {
				normalizedValue: new Date(unwrapped.start),
				effectiveTz: explicitTz !== undefined ? explicitTz : unwrapped.timeZone,
			};
		}
		if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) {
			return { normalizedValue: new Date(unwrapped), effectiveTz };
		}
		if (typeof unwrapped === 'string') {
			const trimmed = unwrapped.trim();
			if (/^[+-]?\d+$/.test(trimmed)) {
				return { normalizedValue: new Date(Number(trimmed)), effectiveTz };
			}
			const parsed = parseTemporalExpr(normalizeRelativeTemporalString(trimmed), {
				allowYearOnly: true,
				allowRelative: true,
				timeZone,
				referenceTimeMs,
			});
			if (parsed.ok) {
				return { normalizedValue: new Date(parsed.interval.start), effectiveTz };
			}
		}
		return { normalizedValue: unwrapped, effectiveTz };
	};

	const builtinDateFilter = filters.date as unknown as (
		this: { context: Context },
		v: unknown,
		format?: unknown,
		timezoneOffset?: unknown,
	) => unknown;

	liquid.registerFilter(
		'date',
		function (
			this: { context: Context },
			v: unknown,
			format?: unknown,
			timezoneOffset?: unknown,
		) {
			const { normalizedValue, effectiveTz } = normalizeDateInput(
				v,
				this.context,
				timezoneOffset,
			);
			return builtinDateFilter.call(this, normalizedValue, format, effectiveTz);
		},
	);

	liquid.registerFilter('date_to_xmlschema', function (this: { context: Context }, v: unknown) {
		const { normalizedValue, effectiveTz } = normalizeDateInput(v, this.context);
		return builtinDateFilter.call(this, normalizedValue, '%Y-%m-%dT%H:%M:%S%:z', effectiveTz);
	});

	liquid.registerFilter('date_to_rfc822', function (this: { context: Context }, v: unknown) {
		const { normalizedValue, effectiveTz } = normalizeDateInput(v, this.context);
		return builtinDateFilter.call(
			this,
			normalizedValue,
			'%a, %d %b %Y %H:%M:%S %z',
			effectiveTz,
		);
	});

	const registerStringifyDateFilter = (filterName: string, monthType: '%b' | '%B'): void => {
		liquid.registerFilter(
			filterName,
			function (this: { context: Context }, v: unknown, type?: unknown, style?: unknown) {
				const { normalizedValue, effectiveTz } = normalizeDateInput(v, this.context);
				const fmt =
					type === 'ordinal'
						? style === 'US'
							? `${monthType} %-d%q, %Y`
							: `%-d%q ${monthType} %Y`
						: `%d ${monthType} %Y`;
				return builtinDateFilter.call(this, normalizedValue, fmt, effectiveTz);
			},
		);
	};

	registerStringifyDateFilter('date_to_string', '%b');
	registerStringifyDateFilter('date_to_long_string', '%B');
}
