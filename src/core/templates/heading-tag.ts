import type { SourceSpan } from '@core/search';
import {
	type Context,
	type Emitter,
	type Liquid,
	type Parser,
	Tag,
	type TagToken,
	type Template,
	type TopLevelToken,
	toPromise,
} from 'liquidjs';
import {
	type HeadingLevelSpec,
	parseHeadingLevelSpec,
	resolveHeadingLevel,
} from './heading-filter';
import { offsetRangeToSourceSpan, type QueryTagEnvironment } from './query-tag';
import { getOrCreateContextHeadingState } from './temporal-drop';
import type { TemplateDiagnostic } from './types';

/**
 * Parses and validates the raw argument string of a `{% heading ... %}` opening tag.
 */
export function parseHeadingTagArgs(
	rawArgs: string,
	headerSpan: SourceSpan,
	file: string | null = null,
):
	| { readonly ok: true; readonly spec: HeadingLevelSpec }
	| { readonly ok: false; readonly diagnostic: TemplateDiagnostic } {
	const trimmed = rawArgs.trim();
	const withoutColon = trimmed.startsWith(':') ? trimmed.slice(1).trim() : trimmed;

	if (withoutColon.length === 0) {
		return {
			ok: false,
			diagnostic: Object.freeze({
				code: 'INVALID_HEADING_TAG_ARGS',
				severity: 'error',
				issue: "Missing heading level argument in '{% heading %}' tag.",
				hint: "Provide a target level ('1'..'6') or relative step ('promote' or 'demote'), e.g., '{% heading 2 %}' or '{% heading demote %}'.",
				span: headerSpan,
				file,
			}),
		};
	}

	const parts = withoutColon.split(/\s+/);
	if (parts.length > 1) {
		return {
			ok: false,
			diagnostic: Object.freeze({
				code: 'INVALID_HEADING_TAG_ARGS',
				severity: 'error',
				issue: `Too many arguments in '{% heading ${trimmed} %}' tag.`,
				hint: "Pass a single heading level ('1'..'6', 'promote', or 'demote'), e.g., '{% heading demote %}'.",
				span: headerSpan,
				file,
			}),
		};
	}

	const spec = parseHeadingLevelSpec(parts[0]);
	if (spec === null) {
		return {
			ok: false,
			diagnostic: Object.freeze({
				code: 'INVALID_HEADING_TAG_ARGS',
				severity: 'error',
				issue: `Invalid heading level '${parts[0] ?? ''}' in '{% heading %}' tag.`,
				hint: "Heading level must be an integer from 1 to 6, 'promote', or 'demote'.",
				span: headerSpan,
				file,
			}),
		};
	}

	return { ok: true, spec };
}

/**
 * Registers the `{% heading <1..6 | promote | demote> %} ... {% endheading %}` block tag on `liquid`.
 */
export function registerHeadingTag(
	liquid: Liquid,
	env: QueryTagEnvironment,
	originalSource?: string,
): void {
	class HeadingBlockTag extends Tag {
		public readonly templates: Template[] = [];
		private readonly levelSpec: HeadingLevelSpec | null;

		public constructor(
			tagToken: TagToken,
			remainTokens: TopLevelToken[],
			liquidInstance: Liquid,
			parser: Parser,
		) {
			super(tagToken, remainTokens, liquidInstance);

			const externalFile =
				typeof tagToken.file === 'string' && tagToken.file.trim().length > 0
					? tagToken.file.trim()
					: null;
			const source =
				(externalFile !== null ? env.fileSources.get(externalFile) : originalSource) ??
				tagToken.input;
			const headerSpan = offsetRangeToSourceSpan(source, tagToken.begin, tagToken.end);
			const parsedArgs = parseHeadingTagArgs(tagToken.args, headerSpan, externalFile);

			if (parsedArgs.ok) {
				this.levelSpec = parsedArgs.spec;
			} else {
				this.levelSpec = null;
				env.diagnostics.push(parsedArgs.diagnostic);
			}

			let endTagToken: TagToken | null = null;
			const stream = parser
				.parseStream(remainTokens)
				.on('tag:endheading', (tok: TagToken) => {
					endTagToken = tok;
					stream.stop();
				})
				.on('template', (tpl: Template) => {
					this.templates.push(tpl);
				});
			stream.start();

			if (!endTagToken) {
				env.diagnostics.push(
					Object.freeze({
						code: 'TEMPLATE_SYNTAX_ERROR',
						severity: 'error',
						issue: `Unclosed '${tagToken.getText()}' block; missing '{% endheading %}'.`,
						hint: "Close the heading block with '{% endheading %}'.",
						span: headerSpan,
						file: externalFile,
					}),
				);
				return;
			}

			const closingTok: TagToken = endTagToken;
			if (closingTok.args.trim().length > 0) {
				const endSpan = offsetRangeToSourceSpan(source, closingTok.begin, closingTok.end);
				env.diagnostics.push(
					Object.freeze({
						code: 'TEMPLATE_SYNTAX_ERROR',
						severity: 'error',
						issue: `Unexpected arguments '${closingTok.args.trim()}' in '{% endheading %}' tag.`,
						hint: "Use '{% endheading %}' with no arguments.",
						span: endSpan,
						file: externalFile,
					}),
				);
			}
		}

		public async render(ctx: Context, emitter: Emitter): Promise<void> {
			if (this.levelSpec === null) {
				return;
			}
			const state = getOrCreateContextHeadingState(ctx);
			const previousLevel = state.level;
			state.level = resolveHeadingLevel(previousLevel, this.levelSpec);
			try {
				await toPromise(this.liquid.renderer.renderTemplates(this.templates, ctx, emitter));
			} finally {
				state.level = previousLevel;
			}
		}
	}

	liquid.registerTag('heading', HeadingBlockTag);
}
