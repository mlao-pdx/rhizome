import { formatSourceCaretSnippet, type SourceSpan } from '@core/search';
import { Liquid, LiquidError, type Template } from 'liquidjs';
import {
	createQueryTagEnvironment,
	maskQueryBlockBodies,
	offsetRangeToSourceSpan,
	type QueryTagEnvironment,
	registerQueryTag,
} from './query-tag';
import type {
	ExtractedQueryBlock,
	TemplateDiagnostic,
	TemplateDiagnosticCode,
	TemplateExecutionCallbacks,
	TemplateFolderConfig,
	TemplateRenderResult,
} from './types';
import { createVaultLiquidFs, resolveTemplateFolders } from './vault-liquid-fs';

/**
 * Extracts a clean single-line issue description and `SourceSpan` from an unknown
 * LiquidJS or runtime error thrown during template parsing or rendering.
 */
export function extractLiquidErrorDiagnostic(
	source: string,
	err: unknown,
	code: TemplateDiagnosticCode,
	defaultHint: string | null,
): TemplateDiagnostic {
	let span: SourceSpan | null = null;
	let rawMessage = err instanceof Error ? err.message : String(err);
	let externalFile: string | null = null;

	if (LiquidError.is(err)) {
		if (err.originalError instanceof Error && err.originalError.message.trim().length > 0) {
			rawMessage = err.originalError.message.trim();
		} else {
			rawMessage = err.message
				.replace(/,\s*(?:file:[^,]+,\s*)?line:\d+,\s*col:\d+\s*$/, '')
				.trim();
		}
		const tok = err.token as { begin?: unknown; end?: unknown; file?: unknown } | undefined;
		if (tok && typeof tok.file === 'string' && tok.file.trim().length > 0) {
			externalFile = tok.file.trim();
		} else if (tok && typeof tok.begin === 'number' && typeof tok.end === 'number') {
			const end = Math.max(tok.begin + 1, tok.end);
			span = offsetRangeToSourceSpan(source, tok.begin, end);
		}
	}

	const firstLine = (rawMessage.split(/\r\n|\r|\n/)[0] ?? 'Template error').trim();
	const withFile =
		externalFile && !firstLine.includes(externalFile)
			? `${firstLine} (in '${externalFile}')`
			: firstLine;
	const issue = withFile.endsWith('.') ? withFile : `${withFile}.`;

	return Object.freeze({
		code,
		severity: 'error',
		issue,
		hint: defaultHint,
		span,
	});
}

/**
 * Formats one or more `TemplateDiagnostic` entries as Obsidian `[!danger]` Markdown callouts
 * with 1-based line/column coordinates and `formatSourceCaretSnippet` inline `‼️...‼️` highlights.
 */
export function formatTemplateDiagnosticsMarkdown(
	source: string,
	diagnostics: readonly TemplateDiagnostic[],
): string {
	const blocks: string[] = [];

	for (const diag of diagnostics) {
		const locSuffix = diag.span
			? ` (line ${diag.span.startLine}, column ${diag.span.startColumn})`
			: '';
		const lines: string[] = [
			`> [!danger] Template Error: \`${diag.code}\`${locSuffix}`,
			`> ${diag.issue}`,
		];

		if (diag.span) {
			const snippet = formatSourceCaretSnippet(source, diag.span);
			lines.push('>', '> ```text', `> ${snippet}`, '> ```');
		}

		if (diag.hint) {
			lines.push('>', `> *Fix*: ${diag.hint}`);
		}

		blocks.push(lines.join('\n'));
	}

	return blocks.join('\n\n');
}

/**
 * Creates a configured, vault-scoped `Liquid` instance with `{% query %}` registered and
 * dynamic partials/layouts locked down to the configured vault folders.
 */
export function createRhizomeLiquidInstance(
	env: QueryTagEnvironment,
	originalSource?: string,
	folders?: TemplateFolderConfig,
	readTemplateFile?: (vaultRelativePath: string) => Promise<string | null>,
): Liquid {
	const resolvedFolders = resolveTemplateFolders(folders);
	const fs = createVaultLiquidFs(resolvedFolders, readTemplateFile);
	const liquid = new Liquid({
		fs,
		root: [resolvedFolders.templatesFolder],
		partials: [resolvedFolders.partialsFolder],
		layouts: [resolvedFolders.layoutsFolder],
		extname: '.md',
		dynamicPartials: true,
		relativeReference: false,
		ownPropertyOnly: true,
	});
	registerQueryTag(liquid, env, originalSource);
	return liquid;
}

/**
 * Runs Pass 1 (static Liquid parse and `{% query %}` block extraction) without executing
 * any vault queries.
 */
export function parseRhizomeTemplatePass1(
	source: string,
	folders?: TemplateFolderConfig,
	readTemplateFile?: (vaultRelativePath: string) => Promise<string | null>,
): {
	readonly liquid: Liquid;
	readonly env: QueryTagEnvironment;
	readonly templates: Template[] | null;
} {
	const env = createQueryTagEnvironment();
	const liquid = createRhizomeLiquidInstance(env, source, folders, readTemplateFile);
	let templates: Template[] | null = null;

	try {
		templates = liquid.parse(maskQueryBlockBodies(source));
	} catch (err: unknown) {
		env.diagnostics.push(
			extractLiquidErrorDiagnostic(
				source,
				err,
				'TEMPLATE_SYNTAX_ERROR',
				'Check that all Liquid tags (`{% ... %}`) and output expressions (`{{ ... }}`) are balanced and closed.',
			),
		);
	}

	return { liquid, env, templates };
}

/**
 * Executes a `rhizome` LiquidJS template in two passes:
 * 1. **Pass 1 (Static Parse & Extract):** Parses the Liquid AST, validates `{% query <name> [explain] %}`
 *    blocks, and rejects duplicate `<name>` definitions before touching the vault.
 * 2. **Pass 2 (Single-Pass Vault Query & Render):** Executes all extracted queries in a single
 *    `callbacks.runQueries` batch, then renders the Liquid template with the batch payload as root scope.
 */
export async function renderRhizomeTemplate(
	source: string,
	callbacks: TemplateExecutionCallbacks,
): Promise<TemplateRenderResult> {
	const { liquid, env, templates } = parseRhizomeTemplatePass1(
		source,
		callbacks.folders,
		callbacks.readTemplateFile,
	);
	const queries: readonly ExtractedQueryBlock[] = Object.freeze([...env.queries]);

	if (env.diagnostics.length > 0 || templates === null) {
		const frozenDiags = Object.freeze([...env.diagnostics]);
		return Object.freeze({
			ok: false,
			markdown: formatTemplateDiagnosticsMarkdown(source, frozenDiags),
			queries,
			diagnostics: frozenDiags,
		});
	}

	try {
		let payload: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
		if (queries.length > 0) {
			const queryMap = Object.create(null) as Record<string, string>;
			for (const q of queries) {
				queryMap[q.name] = q.query;
			}
			const rawPayload = await callbacks.runQueries(Object.freeze(queryMap));
			if (rawPayload && typeof rawPayload === 'object') {
				payload = rawPayload;
			}
		}

		env.payload = payload;
		env.explainQuery = (q, heading) => callbacks.explainQuery(q, heading);

		const renderedRaw: unknown = await liquid.render(templates, payload);
		const markdown = typeof renderedRaw === 'string' ? renderedRaw : '';

		return Object.freeze({
			ok: true,
			markdown,
			queries,
			diagnostics: Object.freeze([]),
		});
	} catch (err: unknown) {
		const renderDiag = extractLiquidErrorDiagnostic(
			source,
			err,
			'TEMPLATE_RENDER_ERROR',
			'Verify the template expressions and filter arguments inside this codeblock.',
		);
		const frozenDiags = Object.freeze([renderDiag]);
		return Object.freeze({
			ok: false,
			markdown: formatTemplateDiagnosticsMarkdown(source, frozenDiags),
			queries,
			diagnostics: frozenDiags,
		});
	}
}
