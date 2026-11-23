import type { SourceSpan } from '@core/search';
import {
	Context,
	evalToken,
	type Liquid,
	Tag,
	type TagToken,
	Tokenizer,
	type TopLevelToken,
	toPromise,
	toValueSync,
	TypeGuards,
	type ValueToken,
} from 'liquidjs';
import { offsetRangeToSourceSpan, type QueryTagBinding } from './query-tag';
import {
	overwriteDeepTargetValue,
	type ParsedPathSelector,
	parsePickOrAggSelectors,
	readDeepPath,
	runSelectorFilterPipeline,
	shallowClonePlainRecord,
} from './selector-evaluator';
import { TaggedTemplateDiagnosticError } from './target-path-tag';
import {
	applyFrontmatterMutation,
	readTemplateTargetState,
	serializeFrontmatterValue,
} from './template-target-state';
import { installTemporalTokenizerExtensions, unwrapLiquidValue } from './temporal-drop';
import type { TemplateDiagnostic } from './types';

function failFrontmatterArgs(
	issue: string,
	hint: string,
	span: SourceSpan,
	file: string | null,
): { readonly ok: false; readonly diagnostic: TemplateDiagnostic } {
	return {
		ok: false,
		diagnostic: Object.freeze({
			code: 'INVALID_FRONTMATTER_TAG_ARGS',
			severity: 'error',
			issue,
			hint,
			span,
			file,
		}),
	};
}

/**
 * Parses and validates comma-separated argument tokens for `{% frontmatter ... %}` at Pass 1,
 * validating static quoted selector strings eagerly.
 */
export function parseFrontmatterTagArgs(
	rawArgs: string,
	liquid: Liquid,
	headerSpan: SourceSpan,
	file: string | null = null,
):
	| { readonly ok: true; readonly argTokens: readonly ValueToken[] }
	| { readonly ok: false; readonly diagnostic: TemplateDiagnostic } {
	const trimmed = rawArgs.trim();
	if (trimmed.length === 0) {
		return failFrontmatterArgs(
			"Missing selector arguments in '{% frontmatter %}' tag.",
			"Pass one or more quoted selector strings (or an array variable), e.g., '{% frontmatter \"template.tags as tags, 'active' as status\" %}'.",
			headerSpan,
			file,
		);
	}

	installTemporalTokenizerExtensions();
	const tokenizer = new Tokenizer(trimmed, liquid.options.operators, file ?? undefined);
	const argTokens: ValueToken[] = [];
	const staticCheckContext = new Context({});

	try {
		while (!tokenizer.end()) {
			tokenizer.skipBlank();
			if (tokenizer.peek() === ',') {
				return failFrontmatterArgs(
					`Unexpected ',' in '{% frontmatter ${trimmed} %}' tag.`,
					'Provide a selector expression before and after each comma, e.g., \'{% frontmatter "title", "status as state" %}\'.',
					headerSpan,
					file,
				);
			}
			const tok = tokenizer.readValue();
			if (!tok) {
				return failFrontmatterArgs(
					`Invalid argument syntax near '${tokenizer.remaining().trim()}' in '{% frontmatter %}' tag.`,
					'Wrap selector strings in quotes, e.g., \'{% frontmatter "author as meta.owner" %}\'.',
					headerSpan,
					file,
				);
			}
			if (TypeGuards.isQuotedToken(tok)) {
				const literalStr = unwrapLiquidValue(
					toValueSync(evalToken(tok, staticCheckContext)),
				);
				parsePickOrAggSelectors([literalStr], { allowLiterals: true, strict: true });
			}
			argTokens.push(tok);
			tokenizer.skipBlank();
			if (!tokenizer.end()) {
				if (tokenizer.peek() !== ',') {
					return failFrontmatterArgs(
						`Unexpected token '${tokenizer.remaining().trim()}' in '{% frontmatter %}' tag.`,
						'Wrap selector expressions in quotes (e.g., \'{% frontmatter "title as name" %}\') and separate multiple arguments with commas.',
						headerSpan,
						file,
					);
				}
				tokenizer.advance(1);
				tokenizer.skipBlank();
				if (tokenizer.end()) {
					return failFrontmatterArgs(
						`Trailing comma in '{% frontmatter ${trimmed} %}' tag.`,
						'Remove the trailing comma or provide another selector argument.',
						headerSpan,
						file,
					);
				}
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return failFrontmatterArgs(
			msg.endsWith('.') ? msg : `${msg}.`,
			"Use '<source> [| <filters>] [as <target>]' syntax inside quotes, e.g., '{% frontmatter \"today as created, 'open' as status\" %}'.",
			headerSpan,
			file,
		);
	}

	if (argTokens.length === 0) {
		return failFrontmatterArgs(
			"Missing selector arguments in '{% frontmatter %}' tag.",
			"Pass at least one selector string or array variable to '{% frontmatter %}'.",
			headerSpan,
			file,
		);
	}

	return { ok: true, argTokens: Object.freeze(argTokens) };
}

function evaluateSelectorSourceAgainstContext(
	ctx: Context,
	liquid: Liquid,
	selector: ParsedPathSelector,
): unknown {
	let rawVal: unknown;
	if (selector.isNullLiteral) {
		rawVal = null;
	} else if (selector.hasLiteral) {
		rawVal = selector.literalValue;
	} else if (selector.segments.length === 0) {
		rawVal = unwrapLiquidValue(ctx.getSync(['this']));
	} else {
		const rootVal = unwrapLiquidValue(ctx.getSync([selector.segments[0]!]));
		rawVal =
			selector.segments.length === 1
				? rootVal
				: readDeepPath(rootVal, selector.segments.slice(1));
	}

	if (selector.filterRaw === null) {
		return rawVal === undefined ? null : rawVal;
	}
	return runSelectorFilterPipeline(rawVal, selector.filterRaw, ctx, liquid);
}

/**
 * Registers the `{% frontmatter <selector>, ... %}` tag on `liquid`.
 */
export function registerFrontmatterTag(liquid: Liquid, getBinding: () => QueryTagBinding): void {
	class FrontmatterTag extends Tag {
		private readonly argTokens: readonly ValueToken[] | null;
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

			const parsed = parseFrontmatterTagArgs(
				tagToken.args,
				liquidInstance,
				headerSpan,
				externalFile,
			);
			if (parsed.ok) {
				this.argTokens = parsed.argTokens;
			} else {
				this.argTokens = null;
				env.diagnostics.push(parsed.diagnostic);
			}
		}

		public async render(ctx: Context): Promise<void> {
			if (this.argTokens === null) {
				return;
			}

			const evaluatedArgs: unknown[] = [];
			for (const tok of this.argTokens) {
				const rawVal: unknown = await toPromise(evalToken(tok, ctx));
				evaluatedArgs.push(unwrapLiquidValue(rawVal));
			}

			let selectors: ParsedPathSelector[];
			try {
				selectors = parsePickOrAggSelectors(evaluatedArgs, {
					allowLiterals: true,
					strict: true,
				});
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new TaggedTemplateDiagnosticError(
					Object.freeze({
						code: 'INVALID_FRONTMATTER_TAG_ARGS',
						severity: 'error',
						issue: msg.endsWith('.') ? msg : `${msg}.`,
						hint: "Pass non-empty selector strings ('<source> [| <filters>] [as <target>]') or an array of selector strings.",
						span: this.headerSpan,
						file: this.externalFile,
					}),
				);
			}

			const state = readTemplateTargetState(ctx);
			if (state === null) {
				return;
			}

			const nextFrontmatter = shallowClonePlainRecord(state.frontmatterRaw);
			const clonedContainers = new Set<Record<string, unknown>>([nextFrontmatter]);

			for (const selector of selectors) {
				let evaluated: unknown;
				try {
					evaluated = evaluateSelectorSourceAgainstContext(ctx, this.liquid, selector);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					throw new TaggedTemplateDiagnosticError(
						Object.freeze({
							code: 'TEMPLATE_RENDER_ERROR',
							severity: 'error',
							issue: msg.endsWith('.') ? msg : `${msg}.`,
							hint: "Verify the filter pipeline inside '{% frontmatter %}'.",
							span: this.headerSpan,
							file: this.externalFile,
						}),
					);
				}
				const serialized = serializeFrontmatterValue(evaluated);
				overwriteDeepTargetValue(
					nextFrontmatter,
					clonedContainers,
					selector.outputSegments,
					serialized,
				);
			}

			applyFrontmatterMutation(state, nextFrontmatter);
		}
	}

	liquid.registerTag('frontmatter', FrontmatterTag);
}
