import { FORBIDDEN_KEYS } from './property-coercion';
import type { LeafMatcher } from './types';

const ALLOWED_REGEX_FLAGS = new Set(['i', 'm', 's', 'u']);

/**
 * Validates that `flags` contains only unique characters from `{'i', 'm', 's', 'u'}`
 * and that `new RegExp(pattern, flags)` succeeds.
 */
export function validateRegexLiteral(pattern: string, flags: string): RegExp | null {
	const seen = new Set<string>();
	for (const ch of flags) {
		if (!ALLOWED_REGEX_FLAGS.has(ch) || seen.has(ch)) return null;
		seen.add(ch);
	}
	try {
		return new RegExp(pattern, flags);
	} catch {
		return null;
	}
}

/**
 * Evaluates a validated regex `LeafMatcher` against `target`.
 * Throws if `leaf` contains an invalid regex pattern or flags.
 */
export function testRegex(target: string, leaf: Extract<LeafMatcher, { kind: 'regex' }>): boolean {
	const rx = validateRegexLiteral(leaf.pattern, leaf.flags);
	if (!rx) throw new Error(`Invalid regex literal in AST: /${leaf.pattern}/${leaf.flags}`);
	return rx.test(target);
}

/**
 * Strips outer `"` or `'` quotes and decodes `\"`, `\'`, `\\`, `\n`, `\r`, and `\t`.
 * Any other escaped character `\c` is preserved literally as `\` + `c`.
 */
export function decodeQuotedString(rawTokenText: string): string {
	const inner = rawTokenText.slice(1, -1);
	let out = '';
	let i = 0;
	while (i < inner.length) {
		const ch = inner[i]!;
		if (ch === '\\' && i + 1 < inner.length) {
			const next = inner[i + 1]!;
			if (next === '"' || next === "'" || next === '\\') out += next;
			else if (next === 'n') out += '\n';
			else if (next === 'r') out += '\r';
			else if (next === 't') out += '\t';
			else out += '\\' + next;
			i += 2;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

/**
 * Splits a `RegexLiteral` token text (`/pattern/flags`) at the last `/` into `pattern` and `flags`.
 */
export function decodeRegexLiteral(rawTokenText: string): { pattern: string; flags: string } {
	const lastSlash = rawTokenText.lastIndexOf('/');
	return {
		pattern: rawTokenText.slice(1, lastSlash),
		flags: rawTokenText.slice(lastSlash + 1),
	};
}

/**
 * Strips outer `[[` and `]]`, removes any optional `|alias` suffix, and trims whitespace.
 */
export function decodeWikiLinkValue(rawTokenText: string): string {
	const inner = rawTokenText.slice(2, -2);
	const pipeIdx = inner.indexOf('|');
	return (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
}

export type DecodedThisReferenceResult =
	| { readonly ok: true; readonly segments: string[] }
	| { readonly ok: false; readonly issue: string; readonly hint: string | null };

/**
 * Parses and validates a `@this.<path>` token into its decoded path segments.
 * Rejects bare `@this`, trailing dots (`@this.`), empty segments (`@this..foo`, `@this.""`),
 * and prototype-pollution keys (`__proto__`, `prototype`, `constructor`).
 */
export function decodeThisReference(rawTokenText: string): DecodedThisReferenceResult {
	if (rawTokenText === '@this') {
		return {
			ok: false,
			issue: 'Host reference "@this" requires a field path (e.g. "@this.file.basename" or "@this.tags").',
			hint: 'Specify a field on @this such as "@this.file.basename", "@this.tags", or "@this.properties.status".',
		};
	}
	if (!rawTokenText.startsWith('@this.')) {
		return {
			ok: false,
			issue: `Invalid host reference "${rawTokenText}".`,
			hint: 'Use "@this.<field>" (e.g. "@this.file.basename").',
		};
	}
	if (rawTokenText.endsWith('.')) {
		return {
			ok: false,
			issue: `Host reference "${rawTokenText}" cannot end with a trailing dot.`,
			hint: 'Specify a field segment after "." (e.g. "@this.file.basename").',
		};
	}

	const segments: string[] = [];
	let i = 5; // Position of first '.' after '@this'
	while (i < rawTokenText.length) {
		i++; // Skip '.'
		if (i >= rawTokenText.length || rawTokenText[i] === '.') {
			return {
				ok: false,
				issue: `Host reference "${rawTokenText}" contains an empty path segment.`,
				hint: 'Remove consecutive dots in the @this path.',
			};
		}

		let segment: string;
		const quoteChar = rawTokenText[i];
		if (quoteChar === '"' || quoteChar === "'") {
			const startQuote = i;
			i++;
			while (i < rawTokenText.length && rawTokenText[i] !== quoteChar) {
				if (rawTokenText[i] === '\\') {
					i += 2;
				} else {
					i++;
				}
			}
			if (i >= rawTokenText.length || rawTokenText[i] !== quoteChar) {
				return {
					ok: false,
					issue: `Host reference "${rawTokenText}" has an unclosed quoted segment.`,
					hint: 'Close the quoted segment in the @this path.',
				};
			}
			i++; // Advance past closing quote
			if (i < rawTokenText.length && rawTokenText[i] !== '.') {
				return {
					ok: false,
					issue: `Invalid characters after quoted segment in "${rawTokenText}".`,
					hint: 'Separate @this path segments with ".".',
				};
			}
			segment = decodeQuotedString(rawTokenText.slice(startQuote, i));
		} else {
			const startUnquoted = i;
			while (i < rawTokenText.length && rawTokenText[i] !== '.') {
				i++;
			}
			segment = rawTokenText.slice(startUnquoted, i);
		}

		if (segment.length === 0) {
			return {
				ok: false,
				issue: `Host reference "${rawTokenText}" contains an empty path segment.`,
				hint: 'Provide a non-empty field or property name after ".".',
			};
		}
		if (FORBIDDEN_KEYS.has(segment) || FORBIDDEN_KEYS.has(segment.trim().toLowerCase())) {
			return {
				ok: false,
				issue: `Host reference "${rawTokenText}" contains forbidden segment "${segment}".`,
				hint: null,
			};
		}
		segments.push(segment);
	}

	return { ok: true, segments };
}
