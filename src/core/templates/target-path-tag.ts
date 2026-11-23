import type { SourceSpan } from '@core/search';
import {
	type Context,
	type Liquid,
	Tag,
	type TagToken,
	Tokenizer,
	type TopLevelToken,
	toPromise,
	TypeGuards,
	Value,
} from 'liquidjs';
import { offsetRangeToSourceSpan, type QueryTagBinding } from './query-tag';
import { normalizeAndValidateTargetPath } from './target-path';
import { applyTargetPathMutation, readTemplateTargetState } from './template-target-state';
import {
	installTemporalTokenizerExtensions,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';
import type { TemplateDiagnostic, TemplateTargetTabMode } from './types';

/**
 * Error wrapper carrying a structured `TemplateDiagnostic` from a custom Liquid tag's
 * Pass 2 `render()` method up to `extractLiquidErrorDiagnostic`.
 */
export class TaggedTemplateDiagnosticError extends Error {
	public readonly templateDiagnostic: TemplateDiagnostic;

	public constructor(diagnostic: TemplateDiagnostic) {
		super(diagnostic.issue);
		this.name = 'TaggedTemplateDiagnosticError';
		this.templateDiagnostic = diagnostic;
	}
}

interface TrailingWordSplit {
	readonly prefix: string;
	readonly word: string | null;
}

const BARE_WORD_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

function extractUnboundTrailingBareWord(trimmed: string): TrailingWordSplit {
	let quote: string | null = null;
	let escaped = false;
	let parenDepth = 0;
	let lastTopLevelSpaceIdx = -1;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (quote !== null) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === '(') {
			parenDepth++;
			continue;
		}
		if (ch === ')') {
			parenDepth = Math.max(0, parenDepth - 1);
			continue;
		}
		if (parenDepth === 0 && /\s/.test(ch)) {
			lastTopLevelSpaceIdx = i;
		}
	}

	if (lastTopLevelSpaceIdx === -1) {
		return { prefix: trimmed, word: null };
	}

	const candidateWord = trimmed.slice(lastTopLevelSpaceIdx + 1).trim();
	const prefix = trimmed.slice(0, lastTopLevelSpaceIdx).trimEnd();
	if (prefix.length === 0 || !BARE_WORD_RE.test(candidateWord)) {
		return { prefix: trimmed, word: null };
	}

	const lastPrefixChar = prefix[prefix.length - 1];
	if (lastPrefixChar === '|' || lastPrefixChar === ':' || lastPrefixChar === ',') {
		return { prefix: trimmed, word: null };
	}

	return { prefix, word: candidateWord };
}

function failTargetPathArgs(
	issue: string,
	hint: string,
	span: SourceSpan,
	file: string | null,
): { readonly ok: false; readonly diagnostic: TemplateDiagnostic } {
	return {
		ok: false,
		diagnostic: Object.freeze({
			code: 'INVALID_TARGET_PATH_ARGS',
			severity: 'error',
			issue,
			hint,
			span,
			file,
		}),
	};
}

/**
 * Parses and validates `<FilteredValue> [closed | active]` arguments for `{% targetPath %}`.
 */
export function parseTargetPathTagArgs(
	rawArgs: string,
	liquid: Liquid,
	headerSpan: SourceSpan,
	file: string | null = null,
):
	| {
			readonly ok: true;
			readonly valueExpr: Value;
			readonly tabMode: TemplateTargetTabMode;
	  }
	| { readonly ok: false; readonly diagnostic: TemplateDiagnostic } {
	const trimmed = rawArgs.trim();
	if (trimmed.length === 0) {
		return failTargetPathArgs(
			"Missing path expression in '{% targetPath %}' tag.",
			"Pass a vault-relative path expression, e.g., '{% targetPath \"Projects/Kickoff\" %}' or '{% targetPath path_var active %}'.",
			headerSpan,
			file,
		);
	}

	let exprSlice = trimmed;
	let tabMode: TemplateTargetTabMode = 'background';

	const trailing = extractUnboundTrailingBareWord(trimmed);
	if (trailing.word !== null) {
		if (trailing.word === 'active' || trailing.word === 'closed') {
			tabMode = trailing.word;
			exprSlice = trailing.prefix;
			const secondTrailing = extractUnboundTrailingBareWord(exprSlice);
			if (secondTrailing.word !== null) {
				return failTargetPathArgs(
					`Unexpected extra token '${secondTrailing.word}' before '${trailing.word}' in '{% targetPath ${trimmed} %}' tag.`,
					"Specify a single path expression followed by at most one mode ('active' or 'closed').",
					headerSpan,
					file,
				);
			}
		} else {
			return failTargetPathArgs(
				`Unrecognized mode '${trailing.word}' in '{% targetPath ${trimmed} %}' tag.`,
				"Supported trailing tab modes are 'active' and 'closed' (or omit for a background tab).",
				headerSpan,
				file,
			);
		}
	}

	installTemporalTokenizerExtensions();
	try {
		const tokenizer = new Tokenizer(exprSlice, liquid.options.operators, file ?? undefined);
		const filteredToken = tokenizer.readFilteredValue();
		tokenizer.skipBlank();
		if (!tokenizer.end()) {
			return failTargetPathArgs(
				`Unexpected trailing syntax '${tokenizer.remaining().trim()}' in '{% targetPath ${trimmed} %}' tag.`,
				'Wrap path strings in quotes or pipe through Liquid filters, e.g., \'{% targetPath folder | append: "/" | append: title active %}\'.',
				headerSpan,
				file,
			);
		}
		const postfix = (
			filteredToken.initial as unknown as {
				postfix?: readonly unknown[];
			}
		).postfix;
		const hasOperator = Array.isArray(postfix)
			? postfix.some((tok) => TypeGuards.isOperatorToken(tok))
			: false;
		if (
			!Array.isArray(postfix) ||
			postfix.length === 0 ||
			(postfix.length > 1 && !hasOperator)
		) {
			return failTargetPathArgs(
				`Invalid path expression '${exprSlice}' in '{% targetPath ${trimmed} %}' tag.`,
				'Pass a single Liquid expression (optionally piped through filters), e.g., \'{% targetPath "Projects/Kickoff" %}\'.',
				headerSpan,
				file,
			);
		}
		return {
			ok: true,
			valueExpr: new Value(filteredToken, liquid),
			tabMode,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return failTargetPathArgs(
			`Invalid '{% targetPath %}' expression: ${msg}.`,
			"Pass a valid Liquid expression and optional 'active' or 'closed' mode.",
			headerSpan,
			file,
		);
	}
}

/**
 * Registers the `{% targetPath <FilteredValue> [closed | active] %}` tag on `liquid`.
 */
export function registerTargetPathTag(liquid: Liquid, getBinding: () => QueryTagBinding): void {
	class TargetPathTag extends Tag {
		private readonly valueExpr: Value | null;
		private readonly tabMode: TemplateTargetTabMode;
		private readonly headerSpan: SourceSpan;
		private readonly externalFile: string | null;

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
			const headerSpan = offsetRangeToSourceSpan(source, tagToken.begin, tagToken.end);

			this.headerSpan = headerSpan;
			this.externalFile = externalFile;

			const parsed = parseTargetPathTagArgs(
				tagToken.args,
				liquidInstance,
				headerSpan,
				externalFile,
			);
			if (parsed.ok) {
				this.valueExpr = parsed.valueExpr;
				this.tabMode = parsed.tabMode;
			} else {
				this.valueExpr = null;
				this.tabMode = 'background';
				env.diagnostics.push(parsed.diagnostic);
			}
		}

		public async render(ctx: Context): Promise<void> {
			if (this.valueExpr === null) {
				return;
			}
			const evaluated = unwrapLiquidValue(await toPromise(this.valueExpr.value(ctx, false)));
			const rawPathValue =
				evaluated instanceof TemporalDrop
					? evaluated.toString()
					: typeof evaluated === 'number' && Number.isFinite(evaluated)
						? String(evaluated)
						: typeof evaluated === 'boolean'
							? String(evaluated)
							: evaluated;

			const state = readTemplateTargetState(ctx);
			const validated = normalizeAndValidateTargetPath(rawPathValue, {
				configDir: state?.configDir ?? null,
				span: this.headerSpan,
				file: this.externalFile,
			});
			if (!validated.ok) {
				throw new TaggedTemplateDiagnosticError(validated.diagnostic);
			}

			if (state !== null) {
				applyTargetPathMutation(state, validated.path, this.tabMode);
			}
		}
	}

	liquid.registerTag('targetPath', TargetPathTag);
}
