import {
	compareDateIntervals,
	isValidReferenceTimeMs,
	parseTemporalExpr,
	type PropertyOperator,
} from '@core/search';
import { Context, defaultOperators, filters, type Liquid } from 'liquidjs';
import {
	formatMomentDate,
	isStrftimeDateFormat,
	isValidIanaTimeZone,
	resolveTemporalTimeZone,
} from './moment-date-formatter';
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
 * Symbol key used to attach the owning `Liquid` instance onto `liquid.options` (`ctx.opts`)
 * so `FilteredValueDrop` and collection filter evaluators can resolve registered filters.
 */
export const LIQUID_INSTANCE_SYMBOL = Symbol.for('rhizome.liquidInstance');

/**
 * Attaches `liquid` onto `liquid.options` under `LIQUID_INSTANCE_SYMBOL`.
 */
export function attachLiquidInstanceToOptions(liquid: Liquid): void {
	const opts = liquid.options as unknown as Record<PropertyKey, unknown>;
	if (opts && typeof opts === 'object' && opts[LIQUID_INSTANCE_SYMBOL] !== liquid) {
		Object.defineProperty(opts, LIQUID_INSTANCE_SYMBOL, {
			value: liquid,
			enumerable: false,
			configurable: true,
			writable: true,
		});
	}
}

/**
 * Reads the owning `Liquid` instance from a LiquidJS `Context` (`ctx.opts`), if attached.
 */
export function readContextLiquidInstance(ctx: Context | undefined): Liquid | undefined {
	if (!ctx) return undefined;
	const opts = (ctx as unknown as { opts?: Record<PropertyKey, unknown> }).opts;
	const candidate = opts?.[LIQUID_INSTANCE_SYMBOL];
	return candidate && typeof candidate === 'object' && 'filters' in candidate
		? (candidate as Liquid)
		: undefined;
}

/**
 * Mutable heading level state holder attached to `TemporalContextMeta` under
 * `TEMPORAL_CONTEXT_META_SYMBOL` on the root template scope (`ctx.globals`),
 * shared across the root template, `{% render %}` partials, and `{% layout %}` files.
 */
export interface HeadingContextState {
	level: number;
	readonly initialLevel: number;
}

/**
 * Normalizes an optional initial host heading level into an integer in `[0, 6]`,
 * defaulting to `0` when omitted, non-numeric, or non-finite.
 */
export function normalizeInitialHeadingLevel(raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		return 0;
	}
	return Math.max(0, Math.min(6, Math.trunc(raw)));
}

/**
 * Pinned temporal, locale, and heading evaluation metadata attached to the root template context.
 */
export interface TemporalContextMeta {
	readonly timeZone: string;
	readonly referenceTimeMs: number;
	readonly language?: string | undefined;
	readonly headingState?: HeadingContextState | undefined;
}

/**
 * Resolves the host system's local IANA time zone identifier, falling back to `'UTC'`
 * if unavailable or rejected by `@js-temporal/polyfill`.
 */
export function resolveDefaultSystemTimeZone(): string {
	try {
		const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (typeof sysTz === 'string' && sysTz.trim().length > 0) {
			const trimmed = sysTz.trim();
			if (isValidIanaTimeZone(trimmed)) {
				return trimmed;
			}
		}
	} catch {
		// Fall back to 'UTC'
	}
	return 'UTC';
}

/**
 * Validates that `raw` is a supported IANA time zone identifier:
 * - When `raw === undefined`, defaults to the local system time zone (`resolveDefaultSystemTimeZone()`).
 * - When `raw` is provided but empty, non-string, or rejected by `@js-temporal/polyfill`, falls back to `'UTC'`.
 */
export function resolveValidTimeZone(raw: unknown): string {
	if (raw === undefined) {
		return resolveDefaultSystemTimeZone();
	}
	if (typeof raw !== 'string') {
		return 'UTC';
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return 'UTC';
	}
	return isValidIanaTimeZone(trimmed) ? trimmed : 'UTC';
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
		return { timeZone: resolveDefaultSystemTimeZone(), referenceTimeMs: Date.now() };
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

/**
 * Reads the mutable `HeadingContextState` attached to `ctx.globals` or `ctx.environments`
 * under `TEMPORAL_CONTEXT_META_SYMBOL`, if present.
 */
export function readContextHeadingState(ctx: Context | undefined): HeadingContextState | null {
	if (!ctx) {
		return null;
	}
	const ctxInternal = ctx as unknown as {
		globals?: Record<PropertyKey, unknown>;
		environments?: Record<PropertyKey, unknown>;
	};
	const symbolFromGlobals = ctxInternal.globals?.[TEMPORAL_CONTEXT_META_SYMBOL];
	if (isTemporalContextMeta(symbolFromGlobals) && symbolFromGlobals.headingState) {
		return symbolFromGlobals.headingState;
	}
	const symbolFromEnvs = ctxInternal.environments?.[TEMPORAL_CONTEXT_META_SYMBOL];
	if (isTemporalContextMeta(symbolFromEnvs) && symbolFromEnvs.headingState) {
		return symbolFromEnvs.headingState;
	}
	return null;
}

/**
 * Returns the mutable `HeadingContextState` for `ctx`, lazily attaching a default `{ level: 0, initialLevel: 0 }`
 * state holder onto `ctx.globals` if `ctx` was constructed outside `buildRhizomeTemplateContext`.
 */
export function getOrCreateContextHeadingState(ctx: Context): HeadingContextState {
	const existing = readContextHeadingState(ctx);
	if (existing) {
		return existing;
	}
	const ctxInternal = ctx as unknown as {
		globals?: Record<PropertyKey, unknown>;
	};
	if (!ctxInternal.globals || typeof ctxInternal.globals !== 'object') {
		ctxInternal.globals = {};
	}
	const headingState: HeadingContextState = { level: 0, initialLevel: 0 };
	const currentMeta = ctxInternal.globals[TEMPORAL_CONTEXT_META_SYMBOL];
	const baseMeta = isTemporalContextMeta(currentMeta)
		? currentMeta
		: { timeZone: resolveDefaultSystemTimeZone(), referenceTimeMs: Date.now() };
	Object.defineProperty(ctxInternal.globals, TEMPORAL_CONTEXT_META_SYMBOL, {
		value: Object.freeze({ ...baseMeta, headingState }),
		enumerable: false,
		configurable: true,
		writable: true,
	});
	return headingState;
}

/**
 * Reads the current logical heading level from `ctx` (`0` when no heading precedes the codeblock
 * or when no heading context state is attached).
 */
export function readContextHeadingLevel(ctx: Context | undefined): number {
	return readContextHeadingState(ctx)?.level ?? 0;
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

const builtinDateFilter = filters.date as unknown as (
	this: { context: Context },
	v: unknown,
	format?: unknown,
	timezoneOffset?: unknown,
) => unknown;

function normalizeDateInput(
	v: unknown,
	ctx: Context | undefined,
	explicitTz?: unknown,
): { normalizedValue: unknown; effectiveTz: unknown; fallbackTimeZone: string } {
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);
	const unwrapped = unwrapLiquidValue(v);
	const unwrappedTz = explicitTz !== undefined ? unwrapLiquidValue(explicitTz) : undefined;
	const baseTz = unwrapped instanceof TemporalDrop ? unwrapped.timeZone : timeZone;
	const effectiveTz = unwrappedTz !== undefined && unwrappedTz !== null ? unwrappedTz : baseTz;

	if (unwrapped instanceof TemporalDrop) {
		return {
			normalizedValue: new Date(unwrapped.start),
			effectiveTz,
			fallbackTimeZone: baseTz,
		};
	}
	if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) {
		return { normalizedValue: new Date(unwrapped), effectiveTz, fallbackTimeZone: baseTz };
	}
	if (typeof unwrapped === 'string') {
		const trimmed = unwrapped.trim();
		if (/^[+-]?\d+$/.test(trimmed)) {
			return {
				normalizedValue: new Date(Number(trimmed)),
				effectiveTz,
				fallbackTimeZone: baseTz,
			};
		}
		const parsed = parseTemporalExpr(normalizeRelativeTemporalString(trimmed), {
			allowYearOnly: true,
			allowRelative: true,
			timeZone,
			referenceTimeMs,
		});
		if (parsed.ok) {
			return {
				normalizedValue: new Date(parsed.interval.start),
				effectiveTz,
				fallbackTimeZone: baseTz,
			};
		}
	}
	return { normalizedValue: unwrapped, effectiveTz, fallbackTimeZone: baseTz };
}

function resolveEpochMsFromNormalizedValue(normalizedValue: unknown): number | null {
	if (normalizedValue instanceof Date) {
		const ms = normalizedValue.getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof normalizedValue === 'string') {
		const trimmed = normalizedValue.trim();
		if (trimmed.length === 0) {
			return null;
		}
		const ms = Date.parse(trimmed);
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

function stringifyFormatArg(rawFormat: unknown, fallbackFormat: string): string {
	if (rawFormat === null || rawFormat === undefined) {
		return fallbackFormat;
	}
	if (typeof rawFormat === 'string') {
		return rawFormat;
	}
	if (
		typeof rawFormat === 'number' ||
		typeof rawFormat === 'boolean' ||
		typeof rawFormat === 'bigint'
	) {
		return String(rawFormat);
	}
	return '';
}

function resolveFilterContext(filterThis: { context?: Context } | void): Context {
	const ctx =
		filterThis && typeof filterThis === 'object' && filterThis.context
			? filterThis.context
			: new Context({});
	const opts = (ctx as unknown as { opts?: { locale?: string } }).opts;
	if (opts && (!opts.locale || opts.locale.trim().length === 0)) {
		(ctx as unknown as { opts: { locale: string } }).opts = {
			...opts,
			locale: 'en',
		};
	}
	return ctx;
}

/**
 * Dual-flavor Liquid `date` filter:
 * - Formats with LiquidJS `strftime` when the resolved format string contains `'%'`
 *   (including when `format` is omitted and defaults to `opts.dateFormat`).
 * - Formats with Obsidian's native Moment.js token syntax when the format string
 *   does not contain `'%'`.
 */
export function rhizomeDateFilter(
	this: { context?: Context } | void,
	v: unknown,
	format?: unknown,
	timezoneOffset?: unknown,
): unknown {
	const ctx = resolveFilterContext(this);
	const { normalizedValue, effectiveTz, fallbackTimeZone } = normalizeDateInput(
		v,
		ctx,
		timezoneOffset,
	);
	const rawFormat = unwrapLiquidValue(format);
	const defaultFormat = (ctx as unknown as { opts?: { dateFormat?: unknown } }).opts?.dateFormat;
	const fallbackFormat =
		typeof defaultFormat === 'string' ? defaultFormat : '%A, %B %-e, %Y at %-l:%M %P %z';
	const formatStr = stringifyFormatArg(rawFormat, fallbackFormat);

	if (isStrftimeDateFormat(formatStr)) {
		const { strftimeTz } = resolveTemporalTimeZone(effectiveTz, fallbackTimeZone);
		return builtinDateFilter.call({ context: ctx }, normalizedValue, format, strftimeTz);
	}

	const epochMs = resolveEpochMsFromNormalizedValue(normalizedValue);
	if (epochMs === null) {
		return v;
	}
	return formatMomentDate(epochMs, formatStr, effectiveTz, fallbackTimeZone);
}

/**
 * Liquid `date_to_xmlschema` filter (`%Y-%m-%dT%H:%M:%S%:z`), normalized for `TemporalDrop`
 * and millisecond timestamps.
 */
export function dateToXmlschemaFilter(this: { context?: Context } | void, v: unknown): unknown {
	const ctx = resolveFilterContext(this);
	const { normalizedValue, effectiveTz, fallbackTimeZone } = normalizeDateInput(v, ctx);
	const { strftimeTz } = resolveTemporalTimeZone(effectiveTz, fallbackTimeZone);
	return builtinDateFilter.call(
		{ context: ctx },
		normalizedValue,
		'%Y-%m-%dT%H:%M:%S%:z',
		strftimeTz,
	);
}

/**
 * Liquid `date_to_rfc822` filter (`%a, %d %b %Y %H:%M:%S %z`), normalized for `TemporalDrop`
 * and millisecond timestamps.
 */
export function dateToRfc822Filter(this: { context?: Context } | void, v: unknown): unknown {
	const ctx = resolveFilterContext(this);
	const { normalizedValue, effectiveTz, fallbackTimeZone } = normalizeDateInput(v, ctx);
	const { strftimeTz } = resolveTemporalTimeZone(effectiveTz, fallbackTimeZone);
	return builtinDateFilter.call(
		{ context: ctx },
		normalizedValue,
		'%a, %d %b %Y %H:%M:%S %z',
		strftimeTz,
	);
}

function formatStringifyDate(
	filterThis: { context?: Context } | void,
	v: unknown,
	monthType: '%b' | '%B',
	type?: unknown,
	style?: unknown,
): unknown {
	const ctx = resolveFilterContext(filterThis);
	const { normalizedValue, effectiveTz, fallbackTimeZone } = normalizeDateInput(v, ctx);
	const { strftimeTz } = resolveTemporalTimeZone(effectiveTz, fallbackTimeZone);
	const fmt =
		type === 'ordinal'
			? style === 'US'
				? `${monthType} %-d%q, %Y`
				: `%-d%q ${monthType} %Y`
			: `%d ${monthType} %Y`;
	return builtinDateFilter.call({ context: ctx }, normalizedValue, fmt, strftimeTz);
}

/**
 * Liquid `date_to_string` filter (`%d %b %Y` or ordinal), normalized for `TemporalDrop`
 * and millisecond timestamps.
 */
export function dateToStringFilter(
	this: { context?: Context } | void,
	v: unknown,
	type?: unknown,
	style?: unknown,
): unknown {
	return formatStringifyDate(this, v, '%b', type, style);
}

/**
 * Liquid `date_to_long_string` filter (`%d %B %Y` or ordinal), normalized for `TemporalDrop`
 * and millisecond timestamps.
 */
export function dateToLongStringFilter(
	this: { context?: Context } | void,
	v: unknown,
	type?: unknown,
	style?: unknown,
): unknown {
	return formatStringifyDate(this, v, '%B', type, style);
}

/**
 * Registers the millisecond-aware, `TemporalDrop`-aware, and Moment.js/`strftime` dual-flavor
 * `date` filter (and companion `date_to_*` filters) on `liquid`.
 */
export function registerTemporalLiquidExtensions(liquid: Liquid): void {
	installTemporalTokenizerExtensions();
	attachLiquidInstanceToOptions(liquid);

	liquid.registerFilter('date', rhizomeDateFilter);
	liquid.registerFilter('date_to_xmlschema', dateToXmlschemaFilter);
	liquid.registerFilter('date_to_rfc822', dateToRfc822Filter);
	liquid.registerFilter('date_to_string', dateToStringFilter);
	liquid.registerFilter('date_to_long_string', dateToLongStringFilter);
}
