import {
	FORBIDDEN_KEYS,
	LIQUID_BLOCK_COMMENT_PATTERN,
	LIQUID_INLINE_COMMENT_PATTERN,
	type SourceSpan,
} from '@core/search';
import {
	type Context,
	type Emitter,
	type Liquid,
	Tag,
	type TagToken,
	type TopLevelToken,
	TypeGuards,
} from 'liquidjs';
import type { ExtractedQueryBlock, TemplateDiagnostic } from './types';

/**
 * Valid `<name>` identifier pattern for `{% query <name> [explain] %}`.
 */
export const VALID_QUERY_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/**
 * Computes a 1-based `SourceSpan` from 0-based `[startOffset, endOffset)` character offsets in `source`.
 */
export function offsetRangeToSourceSpan(
	source: string,
	startOffset: number,
	endOffset: number,
): SourceSpan {
	const clampedStart = Math.max(0, Math.min(source.length, startOffset));
	const clampedEnd = Math.max(clampedStart, Math.min(source.length, endOffset));

	let line = 1;
	let lastLineStart = 0;
	for (let i = 0; i < clampedStart; i++) {
		const ch = source.charCodeAt(i);
		if (ch === 13) {
			// \r or \r\n
			if (i + 1 < clampedStart && source.charCodeAt(i + 1) === 10) {
				i++;
			}
			line++;
			lastLineStart = i + 1;
		} else if (ch === 10) {
			// \n
			line++;
			lastLineStart = i + 1;
		}
	}

	const startColumn = clampedStart - lastLineStart + 1;
	return Object.freeze({
		startOffset: clampedStart,
		endOffset: clampedEnd,
		startLine: line,
		startColumn,
	});
}

/**
 * Parses and validates the raw argument string of a `{% query ... %}` opening tag.
 */
export function parseQueryTagArgs(
	rawArgs: string,
	headerSpan: SourceSpan,
):
	| { readonly ok: true; readonly name: string; readonly explain: boolean }
	| { readonly ok: false; readonly diagnostic: TemplateDiagnostic } {
	const trimmed = rawArgs.trim();
	if (trimmed.length === 0) {
		return {
			ok: false,
			diagnostic: Object.freeze({
				code: 'INVALID_QUERY_TAG_ARGS',
				severity: 'error',
				issue: "Missing query variable name in '{% query %}' tag.",
				hint: "Provide a variable name after 'query', e.g., '{% query tasks %}' or '{% query tasks explain %}'.",
				span: headerSpan,
			}),
		};
	}

	const parts = trimmed.split(/\s+/);
	const rawName = parts[0] ?? '';

	if (rawName === 'explain') {
		return {
			ok: false,
			diagnostic: Object.freeze({
				code: 'INVALID_QUERY_TAG_ARGS',
				severity: 'error',
				issue: "Reserved keyword 'explain' cannot be used as a query variable name.",
				hint: "Place the variable name before 'explain', e.g., '{% query tasks explain %}'.",
				span: headerSpan,
			}),
		};
	}

	if (FORBIDDEN_KEYS.has(rawName) || !VALID_QUERY_NAME_RE.test(rawName)) {
		return {
			ok: false,
			diagnostic: Object.freeze({
				code: 'INVALID_QUERY_TAG_ARGS',
				severity: 'error',
				issue: `Invalid query variable name '${rawName}'.`,
				hint: "Query variable names must start with a letter or '_' and contain only letters, digits, '_', or '-'.",
				span: headerSpan,
			}),
		};
	}

	if (parts.length > 2) {
		return {
			ok: false,
			diagnostic: Object.freeze({
				code: 'INVALID_QUERY_TAG_ARGS',
				severity: 'error',
				issue: `Too many arguments in '{% query ${trimmed} %}' tag.`,
				hint: "Expected '{% query <name> %}' or '{% query <name> explain %}'; put filter expressions inside the tag body before '{% endquery %}'.",
				span: headerSpan,
			}),
		};
	}

	let explain = false;
	if (parts.length === 2) {
		const secondArg = parts[1] ?? '';
		if (secondArg !== 'explain') {
			return {
				ok: false,
				diagnostic: Object.freeze({
					code: 'INVALID_QUERY_TAG_ARGS',
					severity: 'error',
					issue: `Unrecognized option '${secondArg}' in '{% query ${trimmed} %}' tag.`,
					hint:
						"Only the optional 'explain' flag is supported after the query variable name, e.g., '{% query " +
						rawName +
						" explain %}'.",
					span: headerSpan,
				}),
			};
		}
		explain = true;
	}

	return { ok: true, name: rawName, explain };
}

/**
 * Generic two-phase lookahead checking whether a `comment` tag at `fromIndex - 1` has a
 * matching `endcomment` followed by an `endquery` before the next `query`.
 */
function hasMatchingCommentBeforeEndQuery<T>(
	items: readonly T[],
	fromIndex: number,
	getTagName: (item: T) => string | null,
): boolean {
	let depth = 1;
	let endCommentIdx = -1;
	for (let i = fromIndex; i < items.length; i++) {
		const name = getTagName(items[i]!);
		if (name === 'comment') {
			depth++;
		} else if (name === 'endcomment') {
			depth--;
			if (depth === 0) {
				endCommentIdx = i;
				break;
			}
		}
	}
	if (endCommentIdx === -1) {
		return false;
	}
	for (let j = endCommentIdx + 1; j < items.length; j++) {
		const name = getTagName(items[j]!);
		if (name === 'endquery') {
			return true;
		}
		if (name === 'query') {
			return false;
		}
	}
	return false;
}

/**
 * Checks whether a `{% comment %}` token at the current front of `remainTokens` has a matching
 * `{% endcomment %}` that is still followed by a closing `{% endquery %}` before the next
 * `{% query %}` block.
 */
function hasMatchingEndComment(remainTokens: readonly TopLevelToken[]): boolean {
	return hasMatchingCommentBeforeEndQuery(remainTokens, 0, (tok) =>
		TypeGuards.isTagToken(tok) ? tok.name : null,
	);
}

/**
 * Raw character offsets and argument strings for a `{% query %} ... {% endquery %}` region
 * discovered by `scanQueryBlockSpans`.
 */
export interface ScannedQueryBlockSpan {
	readonly headerStart: number;
	readonly headerEnd: number;
	readonly rawArgs: string;
	readonly bodyStart: number;
	readonly bodyEnd: number;
	readonly closeStart: number | null;
	readonly closeEnd: number | null;
}

const QUERY_OPEN_TAG_RE = /^\{%-?\s*query(?:\s+([\s\S]*?)-?%\}|%\}|\s+-%\})$/;
const ENDQUERY_TAG_RE = /^\{%-?\s*endquery(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})$/;
const COMMENT_OPEN_TAG_RE = /^\{%-?\s*comment(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})$/;
const ENDCOMMENT_TAG_RE = /^\{%-?\s*endcomment(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})$/;

const UNIFIED_OUTER_SCAN_RE = new RegExp(
	[
		/\{%-?\s*raw(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})[\s\S]*?\{%-?\s*endraw(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})/
			.source,
		LIQUID_BLOCK_COMMENT_PATTERN.source,
		LIQUID_INLINE_COMMENT_PATTERN.source,
		/\{%-?\s*(?:query|endquery|comment|endcomment)(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})/.source,
	].join('|'),
	'g',
);

const UNIFIED_INNER_TAG_RE =
	/\{%-?\s*(?:query|endquery|comment|endcomment)(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})/g;

interface InnerControlTag {
	readonly kind: 'query' | 'endquery' | 'comment' | 'endcomment';
	readonly start: number;
	readonly end: number;
}

function collectInnerControlTags(source: string): InnerControlTag[] {
	const tags: InnerControlTag[] = [];
	UNIFIED_INNER_TAG_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = UNIFIED_INNER_TAG_RE.exec(source)) !== null) {
		const text = m[0];
		const start = m.index;
		const end = start + text.length;
		if (QUERY_OPEN_TAG_RE.test(text)) {
			tags.push({ kind: 'query', start, end });
		} else if (ENDQUERY_TAG_RE.test(text)) {
			tags.push({ kind: 'endquery', start, end });
		} else if (COMMENT_OPEN_TAG_RE.test(text)) {
			tags.push({ kind: 'comment', start, end });
		} else if (ENDCOMMENT_TAG_RE.test(text)) {
			tags.push({ kind: 'endcomment', start, end });
		}
	}
	return tags;
}

function hasClosingCommentAndEndQuery(
	tags: readonly InnerControlTag[],
	fromIndex: number,
): boolean {
	return hasMatchingCommentBeforeEndQuery(tags, fromIndex, (tag) => tag.kind);
}

/**
 * Scans `source` in linear time for `{% query ... %} ... {% endquery %}` regions outside
 * outer `{% raw %}` and `{% comment %}` blocks, using the same nested-comment rules as `QueryBlockTag`.
 */
export function scanQueryBlockSpans(source: string): readonly ScannedQueryBlockSpan[] {
	const innerTags = collectInnerControlTags(source);
	const spans: ScannedQueryBlockSpan[] = [];

	UNIFIED_OUTER_SCAN_RE.lastIndex = 0;
	let outerMatch: RegExpExecArray | null;
	while ((outerMatch = UNIFIED_OUTER_SCAN_RE.exec(source)) !== null) {
		const matchedText = outerMatch[0];
		const qMatch = QUERY_OPEN_TAG_RE.exec(matchedText);
		if (!qMatch) {
			continue;
		}

		const headerStart = outerMatch.index;
		const headerEnd = headerStart + matchedText.length;
		const rawArgs = qMatch[1] ?? '';

		let startTagIdx = 0;
		while (startTagIdx < innerTags.length && innerTags[startTagIdx]!.start < headerEnd) {
			startTagIdx++;
		}

		let commentDepth = 0;
		let closeTag: InnerControlTag | null = null;
		for (let i = startTagIdx; i < innerTags.length; i++) {
			const tag = innerTags[i]!;
			if (tag.kind === 'comment') {
				if (commentDepth > 0 || hasClosingCommentAndEndQuery(innerTags, i + 1)) {
					commentDepth++;
				}
			} else if (tag.kind === 'endcomment') {
				if (commentDepth > 0) {
					commentDepth--;
				}
			} else if (commentDepth === 0 && tag.kind === 'endquery') {
				closeTag = tag;
				break;
			}
		}

		if (closeTag) {
			spans.push(
				Object.freeze({
					headerStart,
					headerEnd,
					rawArgs,
					bodyStart: headerEnd,
					bodyEnd: closeTag.start,
					closeStart: closeTag.start,
					closeEnd: closeTag.end,
				}),
			);
			UNIFIED_OUTER_SCAN_RE.lastIndex = closeTag.end;
		} else {
			spans.push(
				Object.freeze({
					headerStart,
					headerEnd,
					rawArgs,
					bodyStart: headerEnd,
					bodyEnd: source.length,
					closeStart: null,
					closeEnd: null,
				}),
			);
			break;
		}
	}

	return Object.freeze(spans);
}

/**
 * Mutable parse/render state shared across `{% query %}` tags within a single
 * `renderRhizomeTemplate` or `analyzeRhizomeCodeBlock` invocation.
 */
export interface QueryTagEnvironment {
	readonly seenNames: Map<string, SourceSpan>;
	readonly queries: ExtractedQueryBlock[];
	readonly diagnostics: TemplateDiagnostic[];
	payload: Readonly<Record<string, unknown[]>>;
	explainQuery: ((query: string, heading: string) => Promise<string>) | null;
}

/**
 * Creates a fresh `QueryTagEnvironment` for one template parse/render cycle.
 */
export function createQueryTagEnvironment(): QueryTagEnvironment {
	return {
		seenNames: new Map<string, SourceSpan>(),
		queries: [],
		diagnostics: [],
		payload: Object.freeze({}),
		explainQuery: null,
	};
}

/**
 * Replaces the interior characters of `{% query ... %} ... {% endquery %}` blocks with spaces
 * (preserving `\r` and `\n` so character offsets and line/column coordinates remain 1-to-1) before
 * LiquidJS tokenizes the outer template.
 */
export function maskQueryBlockBodies(source: string): string {
	const spans = scanQueryBlockSpans(source);
	if (spans.length === 0) {
		return source;
	}
	const chars = source.split('');
	for (const span of spans) {
		for (let i = span.bodyStart; i < span.bodyEnd; i++) {
			const c = chars[i];
			if (c !== '\n' && c !== '\r') {
				chars[i] = ' ';
			}
		}
	}
	return chars.join('');
}

/**
 * Registers the `{% query <name> [explain] %} ... {% endquery %}` block tag on `liquid`,
 * bound to `env`.
 */
export function registerQueryTag(
	liquid: Liquid,
	env: QueryTagEnvironment,
	originalSource?: string,
): void {
	class QueryBlockTag extends Tag {
		private readonly queryName: string | null;
		private readonly queryText: string;
		private readonly explainFlag: boolean;

		public constructor(
			tagToken: TagToken,
			remainTokens: TopLevelToken[],
			liquidInstance: Liquid,
		) {
			super(tagToken, remainTokens, liquidInstance);

			if (typeof tagToken.file === 'string' && tagToken.file.trim().length > 0) {
				throw new Error(
					`'{% query %}' blocks must be declared in the top-level rhizome codeblock, not inside '${tagToken.file.trim()}'.`,
				);
			}

			const source = originalSource ?? tagToken.input;
			const headerSpan = offsetRangeToSourceSpan(source, tagToken.begin, tagToken.end);
			const parsedArgs = parseQueryTagArgs(tagToken.args, headerSpan);

			let endTagToken: TagToken | null = null;
			let commentDepth = 0;

			while (remainTokens.length > 0) {
				const tok = remainTokens.shift()!;
				if (TypeGuards.isTagToken(tok)) {
					if (tok.name === 'comment') {
						if (commentDepth > 0 || hasMatchingEndComment(remainTokens)) {
							commentDepth++;
						}
						continue;
					}
					if (tok.name === 'endcomment') {
						if (commentDepth > 0) {
							commentDepth--;
						}
						continue;
					}
					if (commentDepth === 0 && tok.name === 'endquery') {
						endTagToken = tok;
						break;
					}
				}
			}

			if (!endTagToken) {
				this.queryName = null;
				this.queryText = '';
				this.explainFlag = false;
				env.diagnostics.push(
					Object.freeze({
						code: 'TEMPLATE_SYNTAX_ERROR',
						severity: 'error',
						issue: `Unclosed '${tagToken.getText()}' block; missing '{% endquery %}'.`,
						hint: "Close the query block with '{% endquery %}'.",
						span: headerSpan,
					}),
				);
				return;
			}

			if (endTagToken.args.trim().length > 0) {
				const endSpan = offsetRangeToSourceSpan(source, endTagToken.begin, endTagToken.end);
				env.diagnostics.push(
					Object.freeze({
						code: 'INVALID_QUERY_TAG_ARGS',
						severity: 'error',
						issue: `Unexpected arguments '${endTagToken.args.trim()}' in '{% endquery %}' tag.`,
						hint: "Use '{% endquery %}' with no arguments.",
						span: endSpan,
					}),
				);
			}

			const rawQuery = source.slice(tagToken.end, endTagToken.begin);
			const bodySpan = offsetRangeToSourceSpan(source, tagToken.end, endTagToken.begin);
			const fullSpan = offsetRangeToSourceSpan(source, tagToken.begin, endTagToken.end);

			if (!parsedArgs.ok) {
				this.queryName = null;
				this.queryText = rawQuery;
				this.explainFlag = false;
				env.diagnostics.push(parsedArgs.diagnostic);
				return;
			}

			const { name, explain } = parsedArgs;
			this.queryName = name;
			this.queryText = rawQuery;
			this.explainFlag = explain;

			const previousSpan = env.seenNames.get(name);
			if (previousSpan) {
				env.diagnostics.push(
					Object.freeze({
						code: 'DUPLICATE_QUERY_NAME',
						severity: 'error',
						issue: `Duplicate query variable name '${name}' (already defined on line ${previousSpan.startLine}, column ${previousSpan.startColumn}).`,
						hint: `Rename one of the '{% query ${name} %}' blocks so every query in the codeblock binds a unique variable name.`,
						span: headerSpan,
					}),
				);
				return;
			}

			env.seenNames.set(name, headerSpan);
			env.queries.push(
				Object.freeze({
					name,
					query: rawQuery,
					explain,
					headerSpan,
					bodySpan,
					fullSpan,
				}),
			);
		}

		public async render(_ctx: Context, emitter: Emitter): Promise<void> {
			if (this.queryName === null || !env.explainQuery) {
				return;
			}
			const hasPayloadKey = Object.prototype.hasOwnProperty.call(env.payload, this.queryName);
			if (this.explainFlag || !hasPayloadKey) {
				const markdown = await env.explainQuery(
					this.queryText,
					`Query Explain Plan: ${this.queryName}`,
				);
				const trimmed = markdown.trim();
				if (trimmed.length > 0) {
					emitter.write(`\n\n${trimmed}\n\n`);
				}
			}
		}
	}

	liquid.registerTag('query', QueryBlockTag);
}
