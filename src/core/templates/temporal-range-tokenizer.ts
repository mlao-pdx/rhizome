import { MAX_SAFE_EPOCH_MS, parseSingleTemporalAtom } from '@core/search';
import { type Context, Drop, Token, TokenKind, Tokenizer } from 'liquidjs';
import {
	combineTemporalRange,
	MAX_RANGE_STEPS,
	normalizeRelativeTemporalString,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';
import { readContextTemporalMeta } from './temporal-liquid-extensions';

const DAY_ANCHOR_NAME_RE = /^(?:today|yesterday|tomorrow|(?:last|this|next)day)$/i;
const PLUS_DAY_OFFSET_SUFFIX_RE = /^\+\d+d?(?![a-zA-Z0-9_-])/i;
const FINITE_NUMBER_STRING_RE = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Metadata captured at tokenize time for a `lhs..rhs` or `(lhs..rhs)` range expression.
 */
export interface RangeTokenMetadata {
	readonly lhsRaw: string;
	readonly rhsRaw: string;
	readonly lhsIsNumberLiteral: boolean;
	readonly rhsIsNumberLiteral: boolean;
	readonly isParenthesized: boolean;
}

/**
 * Parses `val` as a finite number only when `val` is an actual `number` or a non-empty
 * decimal numeric string. Returns `null` for `null`, `undefined`, booleans, `""`, objects,
 * `TemporalDrop`, and non-numeric strings.
 */
export function parseFiniteRangeNumber(val: unknown): number | null {
	const unwrapped = unwrapLiquidValue(val);
	if (typeof unwrapped === 'number') {
		return Number.isFinite(unwrapped) ? unwrapped : null;
	}
	if (typeof unwrapped === 'string') {
		const trimmed = unwrapped.trim();
		if (trimmed.length > 0 && FINITE_NUMBER_STRING_RE.test(trimmed)) {
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? parsed : null;
		}
	}
	return null;
}

/**
 * Coerces a non-numeric range endpoint (`TemporalDrop` or non-empty temporal string)
 * into a `TemporalDrop`, returning `null` if it is not a valid temporal atom.
 */
export function coerceNonNumericEndpointToTemporalDrop(
	val: unknown,
	timeZone: string,
	referenceTimeMs: number,
): TemporalDrop | null {
	const unwrapped = unwrapLiquidValue(val);
	if (unwrapped instanceof TemporalDrop) return unwrapped;
	if (typeof unwrapped === 'string') {
		const trimmed = unwrapped.trim();
		if (trimmed.length === 0) return null;
		const res = parseSingleTemporalAtom(normalizeRelativeTemporalString(trimmed), {
			allowYearOnly: true,
			allowRelative: true,
			timeZone,
			referenceTimeMs,
		});
		if (res.ok) return TemporalDrop.fromDateInterval(res.interval, timeZone, referenceTimeMs);
	}
	return null;
}

/**
 * Coerces a numeric range endpoint to a `TemporalDrop` when paired with a temporal endpoint:
 * - Bare 4-digit integer literals (`1000..9999` in template source, e.g. `2020..today`) are
 *   interpreted as year-grain intervals.
 * - Safe-integer numeric variables or non-4-digit integer literals (e.g. `file.created..today`,
 *   including `0`) are interpreted as epoch milliseconds at `'minute'` display grain.
 */
export function coerceNumericEndpointToTemporalDrop(
	num: number,
	rawExpr: string,
	isNumberLiteral: boolean,
	timeZone: string,
	referenceTimeMs: number,
): TemporalDrop | null {
	if (!Number.isSafeInteger(num)) return null;
	if (isNumberLiteral && num >= 1000 && num <= 9999) {
		const res = parseSingleTemporalAtom(String(num), {
			allowYearOnly: true,
			allowRelative: false,
			timeZone,
			referenceTimeMs,
		});
		if (res.ok) return TemporalDrop.fromDateInterval(res.interval, timeZone, referenceTimeMs);
	}
	if (Math.abs(num) <= MAX_SAFE_EPOCH_MS) {
		return new TemporalDrop({
			start: num,
			end: num + 1,
			grain: 'minute',
			isRange: false,
			timeZone,
			referenceTimeMs,
			raw: rawExpr,
		});
	}
	return null;
}

function isNonEmptyNonNumericString(val: unknown): boolean {
	const unwrapped = unwrapLiquidValue(val);
	if (typeof unwrapped !== 'string') return false;
	const trimmed = unwrapped.trim();
	return trimmed.length > 0 && !FINITE_NUMBER_STRING_RE.test(trimmed);
}

function wrapDropAsMethodMissingProxy(drop: Drop): Drop {
	return new Proxy(drop, {
		get(target, prop) {
			return prop === 'liquidMethodMissing'
				? target.liquidMethodMissing.bind(target)
				: undefined;
		},
	});
}

class RangeRhsDrop extends Drop {
	private readonly lhsVal: unknown;
	private readonly meta: RangeTokenMetadata;
	private readonly capturedCtx: Context | undefined;

	public constructor(
		lhsVal: unknown,
		meta: RangeTokenMetadata,
		capturedCtx: Context | undefined,
	) {
		super();
		this.lhsVal = lhsVal;
		this.meta = meta;
		this.capturedCtx = capturedCtx;
		return wrapDropAsMethodMissingProxy(this) as this;
	}

	public override liquidMethodMissing(...args: [rhsVal?: unknown, ctx?: Context]): unknown {
		const effectiveRhsVal = args.length === 0 ? 'liquidMethodMissing' : args[0];
		const effectiveCtx = args.length >= 2 ? args[1] : this.capturedCtx;
		const { lhsRaw, rhsRaw, lhsIsNumberLiteral, rhsIsNumberLiteral, isParenthesized } =
			this.meta;

		const lhsUnwrapped = unwrapLiquidValue(this.lhsVal);
		const rhsUnwrapped = unwrapLiquidValue(effectiveRhsVal);
		const lhsNum = parseFiniteRangeNumber(lhsUnwrapped);
		const rhsNum = parseFiniteRangeNumber(rhsUnwrapped);

		if (
			lhsNum !== null &&
			rhsNum !== null &&
			!(lhsUnwrapped instanceof TemporalDrop) &&
			!(rhsUnwrapped instanceof TemporalDrop)
		) {
			if (rhsNum < lhsNum) return [];
			const length = Math.max(0, Math.floor(rhsNum) - Math.floor(lhsNum) + 1);
			if (length > MAX_RANGE_STEPS) {
				throw new Error(
					`Range '${lhsRaw}..${rhsRaw}' exceeds maximum length (${MAX_RANGE_STEPS})`,
				);
			}
			const arr: number[] = [];
			for (let i = 0; i < length; i++) arr.push(Math.floor(lhsNum) + i);
			return arr;
		}

		const { timeZone, referenceTimeMs } = readContextTemporalMeta(effectiveCtx);
		let lhsTemporal =
			typeof lhsUnwrapped === 'number'
				? null
				: coerceNonNumericEndpointToTemporalDrop(lhsUnwrapped, timeZone, referenceTimeMs);
		let rhsTemporal =
			typeof rhsUnwrapped === 'number'
				? null
				: coerceNonNumericEndpointToTemporalDrop(rhsUnwrapped, timeZone, referenceTimeMs);

		if (lhsTemporal && !rhsTemporal && typeof rhsUnwrapped === 'number') {
			rhsTemporal = coerceNumericEndpointToTemporalDrop(
				rhsUnwrapped,
				rhsRaw,
				rhsIsNumberLiteral,
				timeZone,
				referenceTimeMs,
			);
		} else if (rhsTemporal && !lhsTemporal && typeof lhsUnwrapped === 'number') {
			lhsTemporal = coerceNumericEndpointToTemporalDrop(
				lhsUnwrapped,
				lhsRaw,
				lhsIsNumberLiteral,
				timeZone,
				referenceTimeMs,
			);
		}

		if (lhsTemporal && rhsTemporal) {
			return combineTemporalRange(lhsTemporal, rhsTemporal, lhsRaw, rhsRaw);
		}
		if (lhsTemporal || rhsTemporal) {
			const badSide = lhsTemporal ? rhsRaw : lhsRaw;
			throw new Error(
				`Invalid temporal range '${lhsRaw}..${rhsRaw}': '${badSide}' is not a valid temporal literal`,
			);
		}

		const lhsHasInvalidString = isNonEmptyNonNumericString(lhsUnwrapped);
		const rhsHasInvalidString = isNonEmptyNonNumericString(rhsUnwrapped);
		if (lhsHasInvalidString || rhsHasInvalidString || !isParenthesized) {
			const badSide =
				lhsHasInvalidString || (!rhsHasInvalidString && lhsNum === null) ? lhsRaw : rhsRaw;
			throw new Error(
				`Invalid temporal range '${lhsRaw}..${rhsRaw}': '${badSide}' is not a valid temporal literal`,
			);
		}

		return [];
	}
}

class RangeLhsDrop extends Drop {
	private readonly meta: RangeTokenMetadata;

	public constructor(meta: RangeTokenMetadata) {
		super();
		this.meta = meta;
		return wrapDropAsMethodMissingProxy(this) as this;
	}

	public override liquidMethodMissing(...args: [lhsVal?: unknown, ctx?: Context]): unknown {
		const effectiveLhsVal = args.length === 0 ? 'liquidMethodMissing' : args[0];
		const effectiveCtx = args.length >= 2 ? args[1] : undefined;
		return new RangeRhsDrop(effectiveLhsVal, this.meta, effectiveCtx);
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
	isParenthesized: boolean,
): Token {
	const meta: RangeTokenMetadata = Object.freeze({
		lhsRaw: lhsToken.getText().trim(),
		rhsRaw: rhsToken.getText().trim(),
		lhsIsNumberLiteral: lhsToken.kind === TokenKind.Number,
		rhsIsNumberLiteral: rhsToken.kind === TokenKind.Number,
		isParenthesized,
	});

	const starterToken = new ConcreteToken(
		TokenKind.Literal,
		input,
		begin,
		begin,
		file,
	) as Token & { content: unknown };
	starterToken.content = new RangeLhsDrop(meta);

	const propAccessToken = new ConcreteToken(
		TokenKind.PropertyAccess,
		input,
		begin,
		end,
		file,
	) as Token & { variable: Token; props: Token[] };
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
	if (tokenizerExtensionsInstalled) return;
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
			const plusMatch = PLUS_DAY_OFFSET_SUFFIX_RE.exec(this.remaining());
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

	tokenizerProto.readRange = function (this: Tokenizer) {
		this.skipBlank();
		const begin = this.p;
		if (this.peek() !== '(') return undefined;
		this.advance(1);
		const lhs = origReadValue.call(this);
		this.assert(lhs, () => `unexpected token ${this.snapshot()}, value expected`);
		this.skipBlank();
		this.assert(this.read() === '.' && this.read() === '.', 'invalid range syntax');
		const rhs = origReadValue.call(this);
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
			true,
		) as unknown as ReturnType<Tokenizer['readRange']>;
	};

	tokenizerProto.readValue = function (this: Tokenizer) {
		this.skipBlank();
		const begin = this.p;
		const lhs = origReadValue.call(this);
		if (!lhs) return lhs;
		if (this.peek() === '.' && this.peek(1) === '.') {
			this.advance(2);
			const rhs = origReadValue.call(this);
			this.assert(rhs, () => `unexpected token ${this.snapshot()}, value expected`);
			return createRangeEvaluationToken(
				this.input,
				begin,
				this.p,
				lhs,
				rhs!,
				this.file,
				false,
			) as unknown as ReturnType<Tokenizer['readValue']>;
		}
		return lhs;
	};
}
