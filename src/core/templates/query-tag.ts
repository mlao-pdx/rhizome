import {
	FORBIDDEN_KEYS,
	LIQUID_BLOCK_COMMENT_PATTERN,
	LIQUID_INLINE_COMMENT_PATTERN,
	type QueryExplainCutoff,
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
import { DEFAULT_QUERY_CUTOFF } from './query-cutoff';
import { readTemplateTargetState } from './template-target-state';
import type { ExtractedQueryBlock, TemplateDiagnostic, TemplateLazyQueryOptions } from './types';

/**
 * Valid `<name>` identifier pattern for `{% query <name> [explain] [cutoff: <int>] %}`.
 */
export const VALID_QUERY_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

const CUTOFF_DIGITS_RE = /^\d+$/;

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
	file: string | null = null,
):
	| {
			readonly ok: true;
			readonly name: string;
			readonly explain: boolean;
			readonly cutoff: number;
			readonly explicitCutoff: boolean;
	  }
	| { readonly ok: false; readonly diagnostic: TemplateDiagnostic } {
	const fail = (
		issue: string,
		hint: string,
	): { readonly ok: false; readonly diagnostic: TemplateDiagnostic } => ({
		ok: false,
		diagnostic: Object.freeze({
			code: 'INVALID_QUERY_TAG_ARGS',
			severity: 'error',
			issue,
			hint,
			span: headerSpan,
			file,
		}),
	});

	const trimmed = rawArgs.trim();
	if (trimmed.length === 0) {
		return fail(
			"Missing query variable name in '{% query %}' tag.",
			"Provide a variable name after 'query', e.g., '{% query tasks %}', '{% query tasks explain %}', or '{% query tasks cutoff: 500 %}'.",
		);
	}

	const parts = trimmed.split(/\s+/);
	const rawName = parts[0] ?? '';

	if (rawName === 'this') {
		return fail(
			"Reserved keyword 'this' cannot be used as a query variable name.",
			"Choose a different variable name (for example '{% query current %}'); 'this' is reserved for the hosting note.",
		);
	}

	if (rawName === 'explain') {
		return fail(
			"Reserved keyword 'explain' cannot be used as a query variable name.",
			"Place the variable name before 'explain', e.g., '{% query tasks explain %}'.",
		);
	}

	if (rawName === 'cutoff') {
		return fail(
			"Reserved keyword 'cutoff' cannot be used as a query variable name.",
			"Place the variable name before 'cutoff:', e.g., '{% query tasks cutoff: 500 %}'.",
		);
	}

	if (rawName.startsWith('cutoff:') || rawName.startsWith('cutoff=')) {
		return fail(
			`Missing query variable name before '${rawName}' in '{% query ${trimmed} %}' tag.`,
			"Place a query variable name before 'cutoff:', e.g., '{% query tasks cutoff: 500 %}'.",
		);
	}

	if (FORBIDDEN_KEYS.has(rawName) || !VALID_QUERY_NAME_RE.test(rawName)) {
		return fail(
			`Invalid query variable name '${rawName}'.`,
			"Query variable names must start with a letter or '_' and contain only letters, digits, '_', or '-'.",
		);
	}

	let explain = false;
	let cutoff = DEFAULT_QUERY_CUTOFF;
	let explicitCutoff = false;
	let i = 1;

	while (i < parts.length) {
		const token = parts[i]!;

		if (token === 'explain') {
			if (explain) {
				return fail(
					`Duplicate 'explain' option in '{% query ${trimmed} %}' tag.`,
					`Specify 'explain' at most once, e.g., '{% query ${rawName} explain %}'.`,
				);
			}
			explain = true;
			i++;
			continue;
		}

		if (token === 'cutoff') {
			const next = parts[i + 1];
			if (next !== undefined && next.startsWith(':')) {
				return fail(
					`Unexpected space before ':' in 'cutoff' option in '{% query ${trimmed} %}' tag.`,
					`Write 'cutoff:' with no space before the colon, e.g., '{% query ${rawName} cutoff: 500 %}'.`,
				);
			}
			return fail(
				`Missing ':' after 'cutoff' in '{% query ${trimmed} %}' tag.`,
				`Pass a non-negative integer after 'cutoff:', e.g., '{% query ${rawName} cutoff: 500 %}' or '{% query ${rawName} cutoff: 0 %}'.`,
			);
		}

		if (token.startsWith('cutoff=')) {
			return fail(
				`Invalid 'cutoff' syntax '${token}' in '{% query ${trimmed} %}' tag.`,
				`Use ':' instead of '=', e.g., '{% query ${rawName} cutoff: 500 %}'.`,
			);
		}

		if (token.startsWith('cutoff:')) {
			let rawVal: string;
			if (token === 'cutoff:') {
				if (i + 1 >= parts.length) {
					return fail(
						`Missing integer value after 'cutoff:' in '{% query ${trimmed} %}' tag.`,
						`Provide a non-negative integer (0 for unlimited), e.g., '{% query ${rawName} cutoff: 500 %}' or '{% query ${rawName} cutoff: 0 %}'.`,
					);
				}
				rawVal = parts[i + 1]!;
				i += 2;
			} else {
				rawVal = token.slice('cutoff:'.length);
				i += 1;
			}

			if (explicitCutoff) {
				return fail(
					`Duplicate 'cutoff:' option in '{% query ${trimmed} %}' tag.`,
					`Specify 'cutoff:' at most once, e.g., '{% query ${rawName} cutoff: 500 %}'.`,
				);
			}

			if (!CUTOFF_DIGITS_RE.test(rawVal)) {
				return fail(
					`Invalid cutoff value '${rawVal}' in '{% query ${trimmed} %}' tag.`,
					`'cutoff:' requires a base-10 non-negative integer (0 for unlimited), e.g., '{% query ${rawName} cutoff: 500 %}' or '{% query ${rawName} cutoff: 0 %}'.`,
				);
			}

			const parsedCutoff = Number(rawVal);
			if (!Number.isSafeInteger(parsedCutoff)) {
				return fail(
					`Cutoff value '${rawVal}' exceeds the maximum safe integer (${Number.MAX_SAFE_INTEGER}) in '{% query ${trimmed} %}' tag.`,
					`Choose a cutoff between 0 and ${Number.MAX_SAFE_INTEGER} (use 'cutoff: 0' for no limit).`,
				);
			}

			cutoff = parsedCutoff;
			explicitCutoff = true;
			continue;
		}

		return fail(
			`Unrecognized option '${token}' in '{% query ${trimmed} %}' tag.`,
			`Supported options after '${rawName}' are 'explain' and 'cutoff: <int>', e.g., '{% query ${rawName} explain cutoff: 500 %}'; put filter expressions inside the tag body before '{% endquery %}'.`,
		);
	}

	return { ok: true, name: rawName, explain, cutoff, explicitCutoff };
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
 * Source location and optional vault-relative file path where a query variable name was first defined.
 */
export interface SeenQueryDefinition {
	readonly span: SourceSpan;
	readonly file: string | null;
}

/**
 * Mutable parse/render state shared across `{% query %}` tags within a single
 * `renderRhizomeTemplate` or `analyzeRhizomeCodeBlock` invocation.
 */
const QUERY_REF_IN_TEXT_RE = /@query\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;

export interface QueryTagEnvironment {
	readonly seenNames: Map<string, SeenQueryDefinition>;
	readonly fileSources: Map<string, string>;
	readonly queries: ExtractedQueryBlock[];
	readonly diagnostics: TemplateDiagnostic[];
	readonly uncutQueryPaths: Map<string, readonly string[]>;
	readonly lazyCutoffCallouts: string[];
	lazyQueryNames: ReadonlySet<string> | null;
	runLazyQuery:
		| ((
				name: string,
				queryText: string,
				lazyOptions: TemplateLazyQueryOptions,
		  ) => Promise<{
				readonly matched: boolean;
				readonly rawRows: unknown[];
				readonly effectiveRows: unknown[];
				readonly calloutMarkdown: string;
		  }>)
		| null;
	pass1Complete: boolean;
	payload: Readonly<Record<string, unknown[]>>;
	explainQuery:
		| ((
				query: string,
				heading: string,
				cutoff?: QueryExplainCutoff,
				lazyOptions?: TemplateLazyQueryOptions,
		  ) => Promise<string>)
		| null;
}

/**
 * Creates a fresh `QueryTagEnvironment` for one template parse/render cycle.
 */
export function createQueryTagEnvironment(): QueryTagEnvironment {
	return {
		seenNames: new Map<string, SeenQueryDefinition>(),
		fileSources: new Map<string, string>(),
		queries: [],
		diagnostics: [],
		uncutQueryPaths: new Map<string, readonly string[]>(),
		lazyCutoffCallouts: [],
		lazyQueryNames: null,
		runLazyQuery: null,
		pass1Complete: false,
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
 * Builds the error diagnostic for a `{% query %}` header whose `{% endquery %}` is missing.
 */
export function unclosedQueryDiagnostic(
	headerText: string,
	headerSpan: SourceSpan,
	file: string | null = null,
): TemplateDiagnostic {
	return Object.freeze({
		code: 'TEMPLATE_SYNTAX_ERROR',
		severity: 'error',
		issue: `Unclosed '${headerText}' block; missing '{% endquery %}'.`,
		hint: "Close the query block with '{% endquery %}'.",
		span: headerSpan,
		file,
	});
}

/**
 * Per-parse environment and root source bound to the `{% query %}` and `{% heading %}` tags.
 * Tags read the binding through a provider so a single `Liquid` instance can be reused across
 * parses while each tag instance keeps the environment that was active when it was constructed.
 */
export interface QueryTagBinding {
	readonly env: QueryTagEnvironment;
	readonly originalSource: string | undefined;
}

/**
 * Registers the `{% query <name> [explain] [cutoff: <int>] %} ... {% endquery %}` block tag and disables
 * the deprecated `{% include %}` tag on `liquid`. The binding provider is invoked once per
 * tag construction, allowing `liquid` to be reused across parse cycles.
 */
export function registerQueryTag(liquid: Liquid, getBinding: () => QueryTagBinding): void {
	class QueryBlockTag extends Tag {
		private readonly env: QueryTagEnvironment;
		private readonly queryName: string | null;
		private readonly queryText: string;
		private readonly explainFlag: boolean;
		private readonly cutoff: number;
		private readonly explicitCutoff: boolean;

		public constructor(
			tagToken: TagToken,
			remainTokens: TopLevelToken[],
			liquidInstance: Liquid,
		) {
			super(tagToken, remainTokens, liquidInstance);

			const { env, originalSource } = getBinding();
			this.env = env;

			if (env.pass1Complete) {
				throw new Error(
					"'{% query %}' blocks cannot be parsed dynamically during render Pass 2; use static quoted filenames in '{% render %}' and '{% layout %}'.",
				);
			}

			const externalFile =
				typeof tagToken.file === 'string' && tagToken.file.trim().length > 0
					? tagToken.file.trim()
					: null;
			const source =
				(externalFile !== null ? env.fileSources.get(externalFile) : originalSource) ??
				tagToken.input;
			const headerSpan = offsetRangeToSourceSpan(source, tagToken.begin, tagToken.end);
			const parsedArgs = parseQueryTagArgs(tagToken.args, headerSpan, externalFile);

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
				this.cutoff = DEFAULT_QUERY_CUTOFF;
				this.explicitCutoff = false;
				env.diagnostics.push(
					unclosedQueryDiagnostic(tagToken.getText(), headerSpan, externalFile),
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
						file: externalFile,
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
				this.cutoff = DEFAULT_QUERY_CUTOFF;
				this.explicitCutoff = false;
				env.diagnostics.push(parsedArgs.diagnostic);
				return;
			}

			const { name, explain, cutoff, explicitCutoff } = parsedArgs;
			this.queryName = name;
			this.queryText = rawQuery;
			this.explainFlag = explain;
			this.cutoff = cutoff;
			this.explicitCutoff = explicitCutoff;

			const previousDef = env.seenNames.get(name);
			if (previousDef) {
				const prevFileNote =
					previousDef.file !== null
						? `in '${previousDef.file}', `
						: externalFile !== null
							? 'in the root codeblock, '
							: '';
				env.diagnostics.push(
					Object.freeze({
						code: 'DUPLICATE_QUERY_NAME',
						severity: 'error',
						issue: `Duplicate query variable name '${name}' (already defined ${prevFileNote}on line ${previousDef.span.startLine}, column ${previousDef.span.startColumn}).`,
						hint: `Rename one of the '{% query ${name} %}' blocks so every query in the codeblock and its partials/layouts binds a unique variable name.`,
						span: headerSpan,
						file: externalFile,
					}),
				);
				return;
			}

			env.seenNames.set(name, Object.freeze({ span: headerSpan, file: externalFile }));
			env.queries.push(
				Object.freeze({
					name,
					query: rawQuery,
					explain,
					cutoff,
					explicitCutoff,
					headerSpan,
					bodySpan,
					fullSpan,
					file: externalFile,
				}),
			);
		}

		public async render(ctx: Context, emitter: Emitter): Promise<void> {
			const env = this.env;
			if (this.queryName === null) {
				return;
			}

			let lazyOptions: TemplateLazyQueryOptions | undefined;
			if (env.lazyQueryNames?.has(this.queryName) && env.runLazyQuery) {
				const state = readTemplateTargetState(ctx);
				const priorQueryPaths: Record<string, readonly string[]> = {};
				for (const [k, v] of env.uncutQueryPaths) {
					if (k !== this.queryName) {
						priorQueryPaths[k] = v;
					}
				}
				QUERY_REF_IN_TEXT_RE.lastIndex = 0;
				let refMatch: RegExpExecArray | null;
				while ((refMatch = QUERY_REF_IN_TEXT_RE.exec(this.queryText)) !== null) {
					const refName = refMatch[1];
					if (
						refName &&
						refName !== this.queryName &&
						env.seenNames.has(refName) &&
						!(refName in priorQueryPaths)
					) {
						priorQueryPaths[refName] = Object.freeze([]);
					}
				}
				lazyOptions = {
					hostDoc: state?.virtualDoc ?? null,
					priorQueryPaths,
				};
				const lazyRes = await env.runLazyQuery(this.queryName, this.queryText, lazyOptions);
				if (lazyRes.matched) {
					const nextPayload = Object.assign(
						Object.create(null) as Record<string, unknown[]>,
						env.payload,
					);
					nextPayload[this.queryName] = lazyRes.effectiveRows;
					const frozenPayload = Object.freeze(nextPayload);
					env.payload = frozenPayload;
					if (state !== null) {
						state.rootRecord['query'] = frozenPayload;
					}
					if (lazyRes.calloutMarkdown.length > 0) {
						env.lazyCutoffCallouts.push(lazyRes.calloutMarkdown);
					}
				} else {
					const nextPayload = Object.assign(
						Object.create(null) as Record<string, unknown[]>,
						env.payload,
					);
					delete nextPayload[this.queryName];
					const frozenPayload = Object.freeze(nextPayload);
					env.payload = frozenPayload;
					if (state !== null) {
						state.rootRecord['query'] = frozenPayload;
					}
				}
			}

			if (!env.explainQuery) {
				return;
			}
			const hasPayloadKey = Object.prototype.hasOwnProperty.call(env.payload, this.queryName);
			if (this.explainFlag || !hasPayloadKey) {
				const markdown = await env.explainQuery(
					this.queryText,
					`Query Explain Plan: ${this.queryName}`,
					Object.freeze({ value: this.cutoff, explicit: this.explicitCutoff }),
					lazyOptions,
				);
				const trimmed = markdown.trim();
				if (trimmed.length > 0) {
					emitter.write(`\n\n${trimmed}\n\n`);
				}
			}
		}
	}

	class DisabledIncludeTag extends Tag {
		public constructor(
			tagToken: TagToken,
			remainTokens: TopLevelToken[],
			liquidInstance: Liquid,
		) {
			super(tagToken, remainTokens, liquidInstance);

			const { env, originalSource } = getBinding();

			const externalFile =
				typeof tagToken.file === 'string' && tagToken.file.trim().length > 0
					? tagToken.file.trim()
					: null;
			const source =
				(externalFile !== null ? env.fileSources.get(externalFile) : originalSource) ??
				tagToken.input;
			const span = offsetRangeToSourceSpan(source, tagToken.begin, tagToken.end);
			const inFileSuffix = externalFile !== null ? ` (in '${externalFile}')` : '';

			env.diagnostics.push(
				Object.freeze({
					code: 'TEMPLATE_SYNTAX_ERROR',
					severity: 'error',
					issue: `'${tagToken.getText()}' is disabled; use '{% render ... %}' instead of deprecated '{% include ... %}'${inFileSuffix}.`,
					hint: "Replace '{% include ... %}' with '{% render ... %}'.",
					span,
					file: externalFile,
				}),
			);
		}

		public render(): void {
			// No-op: blocked during Pass 1
		}
	}

	liquid.registerTag('query', QueryBlockTag);
	liquid.registerTag('include', DisabledIncludeTag);
}
