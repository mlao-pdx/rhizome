import {
	And,
	BangNot,
	BUILT_IN_SCOPES,
	Colon,
	CompOp,
	DateTimeLiteral,
	Identifier,
	INTERNAL_RHIZOME_CODES,
	INTERNAL_RHIZOME_PROPERTY_KEY,
	isVirtualFileKey,
	LBracket,
	LParen,
	Not,
	Or,
	parseQuery,
	QuotedString,
	RBracket,
	RegexLiteral,
	RParen,
	SearchLexer,
	TagLiteral,
	WikiLinkValue,
} from '@core/search';
import type { LogEntryMeta, LogLevel } from '@ports/logger-port';

/**
 * Pure formatting, redaction, and level-filtering helpers for the Obsidian
 * logger adapter (`obsidian-logger-adapter.ts`). Split out with zero
 * `obsidian` import so this logic is unit-testable without mocking the
 * Obsidian API.
 */

/** High-visibility marker wrapping sensitive vault-derived spans. */
export const SENSITIVE_MARKER = '‼️';

/**
 * Wraps a dynamic vault-derived string in `‼️...‼️` sensitivity markers while
 * replacing any embedded `‼️` occurrences with `!!` so an inner marker can
 * never prematurely close the outer `‼️...‼️` span.
 */
export function markSensitive(value: unknown): string {
	const raw = String(value).replaceAll(SENSITIVE_MARKER, '!!');
	return `${SENSITIVE_MARKER}${raw}${SENSITIVE_MARKER}`;
}

/**
 * Severity order, lowest to highest. The single source of truth for every
 * `LogLevel` list.
 *
 * @remarks
 * (design, 2026-08-01) The Diagnostics settings dropdown (`settings.ts`)
 * imports this instead of re-declaring its own copy, so adding/removing a
 * level can't desync the UI from `shouldLog()`'s comparison.
 */
export const LEVEL_ORDER: readonly LogLevel[] = ['debug', 'warn', 'error'];

/**
 * Frontmatter and Markdown table header written at the top of each new
 * segmented `.md` log file under `◊Rhizome/logs/`.
 */
export const LOG_FILE_HEADER = [
	'---',
	`${INTERNAL_RHIZOME_PROPERTY_KEY}:`,
	`  "${INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY}": Do not index or query.`,
	'---',
	'',
	'| Timestamp | Level | Source | Duration | Count | Description | ‼️Description‼️ |',
	'| :--- | :--- | :--- | ---: | ---: | :--- | :--- |',
	'',
].join('\n');

const UPPERCASE_LETTER_RE = /\p{Lu}|\p{Lt}/u;
const ANY_LETTER_RE = /\p{L}/u;
const VARIATION_SELECTOR_RE = /\p{Variation_Selector}/u;
const COMBINING_MARK_RE = /\p{M}/u;
const ANY_DIGIT_RE = /\p{N}/u;
const WHITESPACE_RE = /\s/u;
const SENSITIVE_SPAN_RE = /‼️([\s\S]*?)‼️/g;

const BUILT_IN_SCOPE_NAMES: ReadonlySet<string> = (() => {
	const set = new Set<string>();
	for (const def of BUILT_IN_SCOPES) {
		set.add(def.canonicalName.trim().toLowerCase());
		for (const alias of def.aliases) {
			set.add(alias.trim().toLowerCase());
		}
	}
	return set;
})();

const BUILT_IN_PROP_KEYS: ReadonlySet<string> = new Set(['tag', 'tags', 'alias', 'aliases']);

const RELATIVE_DATE_ANCHOR_RE =
	/^@(?:now|today|yesterday|tomorrow|(?:last|this|next)(?:day|week|month|quarter|year))(?:([+-])(\d+)(d?))?$/i;

/** True when `value` is a recognized `LogLevel`. */
export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === 'string' && (LEVEL_ORDER as readonly string[]).includes(value);
}

/** True when `level` is at or above `threshold` in severity. */
export function shouldLog(threshold: LogLevel, level: LogLevel): boolean {
	const thresholdIndex = LEVEL_ORDER.indexOf(threshold);
	const levelIndex = LEVEL_ORDER.indexOf(level);
	if (thresholdIndex === -1 || levelIndex === -1) {
		return false;
	}
	return levelIndex >= thresholdIndex;
}

/**
 * Redacts a sensitive string character-by-character while preserving structural shape:
 * - Uppercase letters (`\p{Lu}`, `\p{Lt}`): `'X'`
 * - Lowercase / other letters (`\p{L}`, `\p{M}`): `'x'`
 * - Digits (`\p{N}`): `'9'`
 * - Whitespace: preserved as-is
 * - Rhizome system prefix `'◊'` and ASCII punctuation (`0x21..0x7E`): preserved as-is
 * - Other symbols / emojis: `'·'` (interpunct)
 */
export function redactSensitiveText(input: string): string {
	let out = '';
	for (const ch of input) {
		if (VARIATION_SELECTOR_RE.test(ch)) {
			continue;
		} else if (ch === '◊' || WHITESPACE_RE.test(ch)) {
			out += ch;
		} else if (UPPERCASE_LETTER_RE.test(ch)) {
			out += 'X';
		} else if (ANY_LETTER_RE.test(ch)) {
			out += 'x';
		} else if (COMBINING_MARK_RE.test(ch)) {
			continue;
		} else if (ANY_DIGIT_RE.test(ch)) {
			out += '9';
		} else {
			const code = ch.codePointAt(0) ?? 0;
			if (code >= 0x21 && code <= 0x7e) {
				out += ch;
			} else {
				out += '·';
			}
		}
	}
	return out;
}

function isReservedPropertyKey(rawKey: string): boolean {
	const lower = rawKey.trim().toLowerCase();
	return isVirtualFileKey(lower) || BUILT_IN_PROP_KEYS.has(lower);
}

function redactDateTimeAtom(atom: string): string {
	const relMatch = RELATIVE_DATE_ANCHOR_RE.exec(atom);
	if (relMatch) {
		const sign = relMatch[1];
		const digits = relMatch[2];
		const dSuffix = relMatch[3] ?? '';
		if (!sign || !digits) {
			return atom;
		}
		const baseLen = atom.length - (sign.length + digits.length + dSuffix.length);
		return `${atom.slice(0, baseLen)}${sign}${'9'.repeat(digits.length)}${dSuffix}`;
	}
	return redactSensitiveText(atom);
}

function redactDateTimeTokenImage(image: string): string {
	const rangeIdx = image.indexOf('..');
	if (rangeIdx !== -1) {
		const left = image.slice(0, rangeIdx);
		const right = image.slice(rangeIdx + 2);
		return `${redactDateTimeAtom(left)}..${redactDateTimeAtom(right)}`;
	}
	return redactDateTimeAtom(image);
}

function redactQuotedTokenImage(image: string): string {
	if (image.length < 2) {
		return redactSensitiveText(image);
	}
	const quote = image[0]!;
	const inner = image.slice(1, -1);
	let redactedInner = '';
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!;
		if (ch === '\\' && i + 1 < inner.length) {
			const next = inner[i + 1]!;
			if (next === 'n' || next === 'r' || next === 't' || next === '\\' || next === quote) {
				redactedInner += `\\${next}`;
				i++;
				continue;
			}
		}
		redactedInner += redactSensitiveText(ch);
	}
	return `${quote}${redactedInner}${quote}`;
}

function redactRegexTokenImage(image: string): string {
	const lastSlash = image.lastIndexOf('/');
	if (!image.startsWith('/') || lastSlash <= 0) {
		return redactSensitiveText(image);
	}
	const pattern = image.slice(1, lastSlash);
	const flags = image.slice(lastSlash + 1);
	let redactedPattern = '';
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === '\\' && i + 1 < pattern.length) {
			const next = pattern[i + 1]!;
			if ('dDsSwWbBfnrtv0/.+*?^$()[]{}|\\'.includes(next)) {
				redactedPattern += `\\${next}`;
				i++;
				continue;
			}
		}
		redactedPattern += redactSensitiveText(ch);
	}
	return `/${redactedPattern}/${flags}`;
}

/**
 * Redacts a search query expression.
 *
 * - When `parseQuery(query)` fails (`ast === null`, i.e. the query has a `SYNTAX_ERROR`),
 *   falls back directly to `redactSensitiveText(query)`.
 * - When `parseQuery(query)` succeeds, preserves Rhizome query grammar syntax
 *   (boolean operators, parens/brackets, comparison operators, built-in scope names,
 *   virtual/built-in property keys, relative `@` date anchors, and regex flags/escapes)
 *   and masks user-supplied identifiers, property keys, tags, strings, and numbers.
 */
export function redactQuerySyntax(query: string): string {
	if (query.length === 0) {
		return '';
	}
	const parsed = parseQuery(query);
	if (parsed.ast === null) {
		return redactSensitiveText(query);
	}
	const lexResult = SearchLexer.tokenize(query);
	const tokens = lexResult.tokens;
	if (tokens.length === 0) {
		return redactSensitiveText(query);
	}

	let out = '';
	let cursor = 0;

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		const start = tok.startOffset;
		const end = start + tok.image.length;

		if (start > cursor) {
			out += redactSensitiveText(query.slice(cursor, start));
		}

		const prevTok = i > 0 ? tokens[i - 1] : undefined;
		const nextTok = i + 1 < tokens.length ? tokens[i + 1] : undefined;
		const type = tok.tokenType;

		if (
			type === LParen ||
			type === RParen ||
			type === LBracket ||
			type === RBracket ||
			type === Colon ||
			type === CompOp ||
			type === Or ||
			type === And ||
			type === Not ||
			type === BangNot
		) {
			out += tok.image;
		} else if (type === DateTimeLiteral) {
			out += redactDateTimeTokenImage(tok.image);
		} else if (type === QuotedString) {
			if (prevTok?.tokenType === LBracket) {
				const unquoted = tok.image.slice(1, -1);
				out += isReservedPropertyKey(unquoted)
					? tok.image
					: redactQuotedTokenImage(tok.image);
			} else {
				out += redactQuotedTokenImage(tok.image);
			}
		} else if (type === RegexLiteral) {
			out += redactRegexTokenImage(tok.image);
		} else if (type === WikiLinkValue) {
			out += `[[${redactSensitiveText(tok.image.slice(2, -2))}]]`;
		} else if (type === TagLiteral) {
			out += `#${redactSensitiveText(tok.image.slice(1))}`;
		} else if (type === Identifier) {
			const isScopePosition =
				nextTok?.tokenType === Colon &&
				prevTok?.tokenType !== LBracket &&
				BUILT_IN_SCOPE_NAMES.has(tok.image.trim().toLowerCase());
			if (isScopePosition) {
				out += tok.image;
			} else if (prevTok?.tokenType === LBracket) {
				out += isReservedPropertyKey(tok.image)
					? tok.image
					: redactSensitiveText(tok.image);
			} else {
				out += redactSensitiveText(tok.image);
			}
		} else {
			out += redactSensitiveText(tok.image);
		}

		cursor = end;
	}

	if (cursor < query.length) {
		out += redactSensitiveText(query.slice(cursor));
	}

	return out;
}

/**
 * Escapes a string for safe inclusion inside a single-line GFM / Obsidian Markdown
 * table cell using classic backslash escaping (`\\`, `\|`, `\n`, `\r`, `\t`).
 */
export function escapeMarkdownTableCell(cell: string): string {
	let out = '';
	for (let i = 0; i < cell.length; i++) {
		const ch = cell[i]!;
		if (ch === '\\') {
			out += '\\\\';
		} else if (ch === '|') {
			out += '\\|';
		} else if (ch === '\n') {
			out += '\\n';
		} else if (ch === '\r') {
			out += '\\r';
		} else if (ch === '\t') {
			out += '\\t';
		} else {
			out += ch;
		}
	}
	return out;
}

function redactMarkedSpans(text: string, customSpanRedactor?: (inner: string) => string): string {
	const redactor = customSpanRedactor ?? redactSensitiveText;
	if (
		customSpanRedactor === redactQuerySyntax &&
		text.startsWith(SENSITIVE_MARKER) &&
		text.endsWith(SENSITIVE_MARKER) &&
		text.length >= SENSITIVE_MARKER.length * 2
	) {
		return redactor(text.slice(SENSITIVE_MARKER.length, -SENSITIVE_MARKER.length));
	}
	return text.replace(SENSITIVE_SPAN_RE, (_full, inner: string) => redactor(inner));
}

function cloneAndTransformValue(
	value: unknown,
	mode: 'redacted' | 'unredacted',
	keyHint?: string,
): unknown {
	if (typeof value === 'string') {
		if (mode === 'unredacted') {
			return value;
		}
		const spanRedactor = keyHint === 'query' ? redactQuerySyntax : redactSensitiveText;
		return redactMarkedSpans(value, spanRedactor);
	}
	if (Array.isArray(value)) {
		return value.map((item) => cloneAndTransformValue(item, mode, keyHint));
	}
	if (typeof value === 'object' && value !== null) {
		const out = Object.create(null) as Record<string, unknown>;
		for (const [rawK, rawV] of Object.entries(value as Record<string, unknown>)) {
			const baseKey =
				mode === 'redacted' ? redactMarkedSpans(rawK, redactSensitiveText) : rawK;
			let transformedKey = baseKey;
			if (mode === 'redacted' && Object.prototype.hasOwnProperty.call(out, transformedKey)) {
				let suffix = 2;
				while (Object.prototype.hasOwnProperty.call(out, `${baseKey}#${suffix}`)) {
					suffix++;
				}
				transformedKey = `${baseKey}#${suffix}`;
			}
			out[transformedKey] = cloneAndTransformValue(rawV, mode, rawK);
		}
		return out;
	}
	return value;
}

const RESERVED_META_KEYS: ReadonlySet<string> = new Set(['source', 'durationMs', 'count']);

function extractColumnsFromMeta(meta?: LogEntryMeta | Record<string, unknown>): {
	source: string;
	duration: string;
	count: string;
	extraMeta: Record<string, unknown> | undefined;
} {
	if (!meta) {
		return { source: 'plugin', duration: '', count: '', extraMeta: undefined };
	}

	const rawSource = meta['source'];
	const source =
		typeof rawSource === 'string' && rawSource.trim().length > 0 ? rawSource.trim() : 'plugin';

	const rawDuration = meta['durationMs'];
	const duration =
		typeof rawDuration === 'number' && Number.isFinite(rawDuration) ? `${rawDuration} ms` : '';

	const rawCount = meta['count'];
	const count =
		typeof rawCount === 'number' && Number.isFinite(rawCount)
			? String(rawCount)
			: typeof rawCount === 'string'
				? rawCount
				: '';

	const extra = Object.create(null) as Record<string, unknown>;
	let hasExtra = false;
	for (const [k, v] of Object.entries(meta)) {
		if (RESERVED_META_KEYS.has(k) || v === undefined) {
			continue;
		}
		extra[k] = v;
		hasExtra = true;
	}

	return {
		source,
		duration,
		count,
		extraMeta: hasExtra ? extra : undefined,
	};
}

/**
 * Builds the `Description` (redacted, `‼️` markers stripped) and `‼️Description‼️`
 * (unredacted, `‼️` markers preserved) strings from `message` and any non-reserved
 * `meta` fields. When neither `message` nor `meta` contains `‼️...‼️` markers, both
 * descriptions are identical.
 */
export function formatDescriptions(
	message: string,
	extraMeta?: Record<string, unknown>,
): { description: string; unredactedDescription: string } {
	const redactedMessage = redactMarkedSpans(message, redactSensitiveText);
	const unredactedMessage = message;

	if (!extraMeta || Object.keys(extraMeta).length === 0) {
		return {
			description: redactedMessage,
			unredactedDescription: unredactedMessage,
		};
	}

	const redactedMeta = cloneAndTransformValue(extraMeta, 'redacted');
	const unredactedMeta = cloneAndTransformValue(extraMeta, 'unredacted');

	return {
		description: `${redactedMessage} ${JSON.stringify(redactedMeta)}`,
		unredactedDescription: `${unredactedMessage} ${JSON.stringify(unredactedMeta)}`,
	};
}

/**
 * Formats one diagnostic log entry as a single-line Markdown table row:
 * `| <Timestamp> | <Level> | <Source> | <Duration> | <Count> | <Description> | <‼️Description‼️> |\n`
 */
export function formatLogLine(
	timestamp: string,
	level: LogLevel,
	message: string,
	meta?: LogEntryMeta | Record<string, unknown>,
): string {
	const { source, duration, count, extraMeta } = extractColumnsFromMeta(meta);
	const { description, unredactedDescription } = formatDescriptions(message, extraMeta);

	const cells = [
		escapeMarkdownTableCell(timestamp),
		escapeMarkdownTableCell(level.toUpperCase()),
		escapeMarkdownTableCell(source),
		escapeMarkdownTableCell(duration),
		escapeMarkdownTableCell(count),
		escapeMarkdownTableCell(description),
		escapeMarkdownTableCell(unredactedDescription),
	];

	return `| ${cells.join(' | ')} |\n`;
}
