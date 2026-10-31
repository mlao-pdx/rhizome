import { Temporal } from '@js-temporal/polyfill';
import {
	compareDateIntervals,
	isValidReferenceTimeMs,
	parseTemporalExpr,
	type PropertyOperator,
} from '@core/search';
import { type Context, defaultOperators, filters, type Liquid } from 'liquidjs';
import {
	coerceOperandToDateInterval,
	normalizeRelativeTemporalString,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';
import { installTemporalTokenizerExtensions } from './temporal-range-tokenizer';

/**
 * Symbol key used to attach unshadowable temporal metadata (`timeZone` and `referenceTimeMs`)
 * onto the root LiquidJS template scope (`ctx.globals`).
 */
export const TEMPORAL_CONTEXT_META_SYMBOL = Symbol.for('rhizome.temporalContextMeta');

/**
 * Pinned temporal evaluation metadata attached to the root template context.
 */
export interface TemporalContextMeta {
	readonly timeZone: string;
	readonly referenceTimeMs: number;
}

/**
 * Validates that `raw` is a supported IANA time zone identifier, falling back to `'UTC'`
 * when `raw` is empty, non-string, or rejected by `@js-temporal/polyfill`.
 */
export function resolveValidTimeZone(raw: unknown): string {
	if (typeof raw !== 'string') {
		return 'UTC';
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return 'UTC';
	}
	try {
		Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(trimmed);
		return trimmed;
	} catch {
		return 'UTC';
	}
}

function isTemporalContextMeta(val: unknown): val is TemporalContextMeta {
	if (!val || typeof val !== 'object') {
		return false;
	}
	const candidate = val as { timeZone?: unknown; referenceTimeMs?: unknown };
	return (
		typeof candidate.timeZone === 'string' &&
		candidate.timeZone.length > 0 &&
		isValidReferenceTimeMs(candidate.referenceTimeMs)
	);
}

/**
 * Reads the pinned `{ timeZone, referenceTimeMs }` from a LiquidJS `Context`, preferring the
 * unshadowable `TEMPORAL_CONTEXT_META_SYMBOL` attached to `ctx.globals` or `ctx.environments`
 * so user `{% assign tz = ... %}` or `{% assign now = ... %}` cannot corrupt temporal evaluation.
 */
export function readContextTemporalMeta(ctx: Context | undefined): TemporalContextMeta {
	if (!ctx) {
		return { timeZone: 'UTC', referenceTimeMs: Date.now() };
	}

	const ctxInternal = ctx as unknown as {
		globals?: Record<PropertyKey, unknown>;
		environments?: Record<PropertyKey, unknown>;
	};
	const symbolFromGlobals = ctxInternal.globals?.[TEMPORAL_CONTEXT_META_SYMBOL];
	if (isTemporalContextMeta(symbolFromGlobals)) {
		return symbolFromGlobals;
	}
	const symbolFromEnvs = ctxInternal.environments?.[TEMPORAL_CONTEXT_META_SYMBOL];
	if (isTemporalContextMeta(symbolFromEnvs)) {
		return symbolFromEnvs;
	}

	const rawTz: unknown = ctx.getSync(['tz']);
	const timeZone = resolveValidTimeZone(rawTz);
	const rawNow: unknown = ctx.getSync(['now']);
	const referenceTimeMs =
		rawNow instanceof TemporalDrop && isValidReferenceTimeMs(rawNow.referenceTimeMs)
			? rawNow.referenceTimeMs
			: Date.now();
	return { timeZone, referenceTimeMs };
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
