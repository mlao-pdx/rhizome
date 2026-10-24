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
