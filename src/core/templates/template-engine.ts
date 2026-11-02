import { formatSourceCaretSnippet, type SourceSpan } from '@core/search';
import { Liquid, LiquidError, Tag, type Template, toPromise } from 'liquidjs';
import { registerPayloadLiquidFilters } from './payload-filters';
import {
	createQueryTagEnvironment,
	maskQueryBlockBodies,
	offsetRangeToSourceSpan,
	type QueryTagEnvironment,
	registerQueryTag,
} from './query-tag';
import {
	buildHostNoteQuery,
	buildRhizomeTemplateContext,
	extractUserQueryMap,
	HOST_QUERY_KEY,
} from './template-context';
import {
	createRhizomeLiquidOperators,
	installTemporalTokenizerExtensions,
	registerTemporalLiquidExtensions,
} from './temporal-drop';
import type {
	ExtractedQueryBlock,
	TemplateDiagnostic,
	TemplateDiagnosticCode,
	TemplateExecutionCallbacks,
	TemplateFolderConfig,
	TemplateRenderResult,
	TemplateRuntimeContext,
} from './types';
import {
	createVaultLiquidFs,
	normalizeTemplateLookupPath,
	type ResolvedTemplateFolders,
	resolveTemplateFolders,
} from './vault-liquid-fs';

/**
 * Extracts a clean single-line issue description and `SourceSpan` from an unknown
 * LiquidJS or runtime error thrown during template parsing or rendering.
 */
export function extractLiquidErrorDiagnostic(
	source: string,
	err: unknown,
	code: TemplateDiagnosticCode,
	defaultHint: string | null,
	fileSources?: ReadonlyMap<string, string>,
	fallbackFile: string | null = null,
): TemplateDiagnostic {
	let span: SourceSpan | null = null;
	let rawMessage = err instanceof Error ? err.message : String(err);
	let externalFile: string | null = fallbackFile;
	let resolvedHint: string | null = defaultHint;

	if (LiquidError.is(err)) {
		if (err.originalError instanceof Error && err.originalError.message.trim().length > 0) {
			rawMessage = err.originalError.message.trim();
			const customHint = (err.originalError as { hint?: unknown }).hint;
			if (typeof customHint === 'string' && customHint.trim().length > 0) {
				resolvedHint = customHint.trim();
			}
		} else {
			rawMessage = err.message
				.replace(/,\s*(?:file:[^,]+,\s*)?line:\d+,\s*col:\d+\s*$/, '')
				.trim();
		}
		const tok = err.token as
			{ begin?: unknown; end?: unknown; file?: unknown; input?: unknown } | undefined;
		if (tok && typeof tok.file === 'string' && tok.file.trim().length > 0) {
			externalFile = tok.file.trim();
		}
		if (tok && typeof tok.begin === 'number' && typeof tok.end === 'number') {
			const end = Math.max(tok.begin + 1, tok.end);
			const targetSource =
				externalFile !== null
					? (fileSources?.get(externalFile) ??
						(typeof tok.input === 'string' ? tok.input : null))
					: source;
			if (typeof targetSource === 'string') {
				span = offsetRangeToSourceSpan(targetSource, tok.begin, end);
			}
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
		hint: resolvedHint,
		span,
		file: externalFile,
	});
}

/**
 * Formats one or more `TemplateDiagnostic` entries as Obsidian `[!danger]` Markdown callouts
 * with 1-based line/column coordinates and `formatSourceCaretSnippet` inline `‼️...‼️` highlights.
 */
export function formatTemplateDiagnosticsMarkdown(
	source: string,
	diagnostics: readonly TemplateDiagnostic[],
	fileSources?: ReadonlyMap<string, string>,
): string {
	const blocks: string[] = [];

	for (const diag of diagnostics) {
		const diagFile =
			typeof diag.file === 'string' && diag.file.trim().length > 0 ? diag.file.trim() : null;
		let locSuffix = '';
		if (diagFile && diag.span) {
			locSuffix = ` (in '${diagFile}', line ${diag.span.startLine}, column ${diag.span.startColumn})`;
		} else if (diagFile) {
			locSuffix = ` (in '${diagFile}')`;
		} else if (diag.span) {
			locSuffix = ` (line ${diag.span.startLine}, column ${diag.span.startColumn})`;
		}
		const lines: string[] = [
			`> [!danger] Template Error: \`${diag.code}\`${locSuffix}`,
			`> ${diag.issue}`,
		];

		if (diag.span) {
			const targetSource = diagFile ? fileSources?.get(diagFile) : source;
			if (typeof targetSource === 'string') {
				const snippet = formatSourceCaretSnippet(targetSource, diag.span);
				lines.push('>', '> ```text', `> ${snippet}`, '> ```');
			}
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
 * partials/layouts locked down to the configured vault folders.
 */
export function createRhizomeLiquidInstance(
	env: QueryTagEnvironment,
	originalSource?: string,
	folders?: TemplateFolderConfig,
	readTemplateFile?: (vaultRelativePath: string) => Promise<string | null>,
): Liquid {
	installTemporalTokenizerExtensions();
	const resolvedFolders = resolveTemplateFolders(folders);
	const fs = createVaultLiquidFs(resolvedFolders, readTemplateFile, env.fileSources);
	const liquid = new Liquid({
		fs,
		root: [resolvedFolders.templatesFolder],
		partials: [resolvedFolders.partialsFolder],
		layouts: [resolvedFolders.layoutsFolder],
		extname: '.md',
		cache: true,
		dynamicPartials: true,
		relativeReference: false,
		ownPropertyOnly: true,
		operators: createRhizomeLiquidOperators(),
	});
	registerQueryTag(liquid, env, originalSource);
	registerTemporalLiquidExtensions(liquid);
	registerPayloadLiquidFilters(liquid);
	return liquid;
}

/**
 * Parsed LiquidJS template state produced by Pass 1 (`parseRhizomeTemplatePass1` or
 * `parseRhizomeTemplatePass1Async`), ready for one or more Pass 2 renders via
 * `renderParsedRhizomeTemplate`.
 */
export interface ParsedRhizomeTemplate {
	readonly liquid: Liquid;
	readonly env: QueryTagEnvironment;
	readonly templates: Template[] | null;
}

/**
 * Runs synchronous root Pass 1 (static Liquid parse and `{% query %}` block extraction
 * on the root codeblock source only) without executing any vault queries or loading
 * external partial/layout files. Used by the synchronous CodeMirror 6 editor analyzer.
 */
export function parseRhizomeTemplatePass1(
	source: string,
	folders?: TemplateFolderConfig,
	readTemplateFile?: (vaultRelativePath: string) => Promise<string | null>,
): ParsedRhizomeTemplate {
	const env = createQueryTagEnvironment();
	const liquid = createRhizomeLiquidInstance(env, source, folders, readTemplateFile);
	let templates: Template[] | null = null;

	try {
		templates = liquid.parse(maskQueryBlockBodies(source));
		validateStaticPartialAndLayoutFilenames(source, env, templates, null);
	} catch (err: unknown) {
		env.diagnostics.push(
			extractLiquidErrorDiagnostic(
				source,
				err,
				'TEMPLATE_SYNTAX_ERROR',
				'Check that all Liquid tags (`{% ... %}`) and output expressions (`{{ ... }}`) are balanced and closed.',
				env.fileSources,
			),
		);
	}

	return { liquid, env, templates };
}

interface InspectableTag {
	readonly name: string;
	readonly token: Tag['token'];
	readonly file?: unknown;
	readonly templates?: Template[];
	readonly branches?: unknown;
	readonly elseTemplates?: Template[];
}

function getInFileChildTemplates(tag: InspectableTag): Template[] {
	const children: Template[] = [];
	if (Array.isArray(tag.templates)) {
		children.push(...tag.templates);
	}
	if (Array.isArray(tag.branches)) {
		for (const rawBranch of tag.branches as unknown[]) {
			if (rawBranch && typeof rawBranch === 'object') {
				const branchTemplates = (rawBranch as { templates?: unknown }).templates;
				if (Array.isArray(branchTemplates)) {
					children.push(...(branchTemplates as Template[]));
				}
			}
		}
	}
	if (Array.isArray(tag.elseTemplates)) {
		children.push(...tag.elseTemplates);
	}
	return children;
}

function normalizeLookupCacheKey(kind: 'layout' | 'render', rawFile: string): string {
	const trimmed = rawFile.trim().replace(/\\/g, '/').replace(/^\/+/, '');
	const withoutExt = trimmed.toLowerCase().endsWith('.md')
		? trimmed.slice(0, trimmed.length - 3)
		: trimmed;
	return `${kind}:${withoutExt}`;
}

function writeLiquidLookupAliasCache(
	liquid: Liquid,
	kind: 'layout' | 'render',
	rawFile: string,
	templates: Template[],
): void {
	const cache = (liquid.options as { cache?: { write?: (k: string, v: unknown) => void } }).cache;
	if (!cache || typeof cache.write !== 'function') {
		return;
	}
	const lookupPrefix = kind === 'layout' ? 'layouts' : 'partials';
	cache.write(`${lookupPrefix}:${rawFile}`, templates);
}

function resolveTemplateNodeFileSpan(
	rootSource: string,
	env: QueryTagEnvironment,
	currentFile: string | null,
	token: { begin?: unknown; end?: unknown; input?: unknown } | undefined,
): SourceSpan | null {
	if (!token || typeof token.begin !== 'number' || typeof token.end !== 'number') {
		return null;
	}
	const targetSource =
		currentFile !== null
			? (env.fileSources.get(currentFile) ??
				(typeof token.input === 'string' ? token.input : null))
			: rootSource;
	if (typeof targetSource !== 'string') {
		return null;
	}
	return offsetRangeToSourceSpan(targetSource, token.begin, Math.max(token.begin + 1, token.end));
}

function recordDynamicFilenameDiagnostic(
	rootSource: string,
	env: QueryTagEnvironment,
	currentFile: string | null,
	tag: InspectableTag,
): void {
	const span = resolveTemplateNodeFileSpan(rootSource, env, currentFile, tag.token);
	const inFileSuffix = currentFile !== null ? ` (in '${currentFile}')` : '';
	const alreadyReported = env.diagnostics.some(
		(d) => d.file === currentFile && d.span?.startOffset === span?.startOffset,
	);
	if (!alreadyReported) {
		env.diagnostics.push(
			Object.freeze({
				code: 'TEMPLATE_SYNTAX_ERROR',
				severity: 'error',
				issue: `Dynamic or variable filename in '${tag.token.getText()}' is not supported; '{% ${tag.name} %}' requires a static quoted string filename${inFileSuffix}.`,
				hint: `Pass a static quoted string literal to '{% ${tag.name} '...' %}'.`,
				span,
				file: currentFile,
			}),
		);
	}
}

function validateStaticPartialAndLayoutFilenames(
	rootSource: string,
	env: QueryTagEnvironment,
	templates: readonly Template[],
	currentFile: string | null,
): void {
	for (const tpl of templates) {
		if (!(tpl instanceof Tag)) {
			continue;
		}
		const tag = tpl as unknown as InspectableTag;
		if (tag.name === 'layout' || tag.name === 'render') {
			if (tag.name === 'layout' && Array.isArray(tag.templates)) {
				validateStaticPartialAndLayoutFilenames(
					rootSource,
					env,
					tag.templates,
					currentFile,
				);
			}
			if (tag.file !== undefined && typeof tag.file !== 'string') {
				recordDynamicFilenameDiagnostic(rootSource, env, currentFile, tag);
			}
			continue;
		}
		const nested = getInFileChildTemplates(tag);
		if (nested.length > 0) {
			validateStaticPartialAndLayoutFilenames(rootSource, env, nested, currentFile);
		}
	}
}

async function walkTemplateTreePass1(
	rootSource: string,
	parsed: ParsedRhizomeTemplate,
	resolvedFolders: ResolvedTemplateFolders,
	templates: readonly Template[],
	currentFile: string | null,
	activeStack: Set<string>,
	visitedFiles: Map<string, Template[]>,
): Promise<void> {
	for (const tpl of templates) {
		if (!(tpl instanceof Tag)) {
			continue;
		}
		const tag = tpl as unknown as InspectableTag;

		if (tag.name === 'layout' || tag.name === 'render') {
			if (tag.name === 'layout' && Array.isArray(tag.templates)) {
				await walkTemplateTreePass1(
					rootSource,
					parsed,
					resolvedFolders,
					tag.templates,
					currentFile,
					activeStack,
					visitedFiles,
				);
			}

			const rawFile = tag.file;
			if (rawFile === undefined) {
				// e.g. {% layout none %}
				continue;
			}

			if (typeof rawFile !== 'string') {
				recordDynamicFilenameDiagnostic(rootSource, parsed.env, currentFile, tag);
				continue;
			}

			const canonicalKey = normalizeLookupCacheKey(tag.name, rawFile);
			if (activeStack.has(canonicalKey)) {
				const cycleChain = [...activeStack, canonicalKey].join(' -> ');
				const span = resolveTemplateNodeFileSpan(
					rootSource,
					parsed.env,
					currentFile,
					tag.token,
				);
				const inFileSuffix = currentFile !== null ? ` (in '${currentFile}')` : '';
				parsed.env.diagnostics.push(
					Object.freeze({
						code: 'TEMPLATE_SYNTAX_ERROR',
						severity: 'error',
						issue: `Circular template reference detected: ${cycleChain}${inFileSuffix}.`,
						hint: `Break the '${cycleChain}' cycle between your '{% render %}' / '{% layout %}' files.`,
						span,
						file: currentFile,
					}),
				);
				continue;
			}

			const visitedTemplates = visitedFiles.get(canonicalKey);
			if (visitedTemplates !== undefined) {
				writeLiquidLookupAliasCache(parsed.liquid, tag.name, rawFile, visitedTemplates);
				continue;
			}

			activeStack.add(canonicalKey);
			let childTemplates: Template[] | null = null;
			try {
				childTemplates =
					tag.name === 'layout'
						? await toPromise(
								parsed.liquid._parseLayoutFile(
									rawFile,
									false,
									currentFile ?? undefined,
								),
							)
						: await toPromise(
								parsed.liquid._parsePartialFile(
									rawFile,
									false,
									currentFile ?? undefined,
								),
							);
			} catch (err: unknown) {
				const isMissingFile =
					err instanceof Error &&
					(err.message.includes('ENOENT') ||
						err.message.includes('Failed to lookup') ||
						err.message.includes('illegal file path'));
				const diagCode: TemplateDiagnosticCode = isMissingFile
					? 'TEMPLATE_RENDER_ERROR'
					: 'TEMPLATE_SYNTAX_ERROR';
				const rawErrFile =
					LiquidError.is(err) &&
					err.token &&
					typeof (err.token as { file?: unknown }).file === 'string' &&
					(err.token as { file: string }).file.trim().length > 0
						? (err.token as { file: string }).file.trim()
						: null;
				const diag = extractLiquidErrorDiagnostic(
					rootSource,
					err,
					diagCode,
					diagCode === 'TEMPLATE_RENDER_ERROR'
						? 'Verify the referenced template file exists inside the configured vault folder.'
						: 'Check that all Liquid tags (`{% ... %}`) and output expressions (`{{ ... }}`) are balanced and closed.',
					parsed.env.fileSources,
					rawErrFile ?? currentFile,
				);
				const fallbackSpan =
					diag.span ??
					resolveTemplateNodeFileSpan(rootSource, parsed.env, currentFile, tag.token);
				parsed.env.diagnostics.push(
					Object.freeze({
						...diag,
						span: fallbackSpan,
						file: diag.file ?? currentFile,
					}),
				);
			}

			if (childTemplates !== null) {
				const firstTokFile = childTemplates[0]?.token?.file;
				const targetFolder =
					tag.name === 'layout'
						? resolvedFolders.layoutsFolder
						: resolvedFolders.partialsFolder;
				const resolvedChildFile =
					typeof firstTokFile === 'string' && firstTokFile.trim().length > 0
						? firstTokFile.trim()
						: normalizeTemplateLookupPath(targetFolder, rawFile, '.md');
				await walkTemplateTreePass1(
					rootSource,
					parsed,
					resolvedFolders,
					childTemplates,
					resolvedChildFile,
					activeStack,
					visitedFiles,
				);
				visitedFiles.set(canonicalKey, childTemplates);
			}
			activeStack.delete(canonicalKey);
			continue;
		}

		const nestedTemplates = getInFileChildTemplates(tag);
		if (nestedTemplates.length > 0) {
			await walkTemplateTreePass1(
				rootSource,
				parsed,
				resolvedFolders,
				nestedTemplates,
				currentFile,
				activeStack,
				visitedFiles,
			);
		}
	}
}

/**
 * Runs Pass 1 (static root Liquid parse, recursive DFS pre-pass across all referenced
 * `{% layout %}` and `{% render %}` files, cycle/diamond detection, static filename validation,
 * and `{% query %}` block extraction) without executing any vault queries.
 */
export async function parseRhizomeTemplatePass1Async(
	source: string,
	folders?: TemplateFolderConfig,
	readTemplateFile?: (vaultRelativePath: string) => Promise<string | null>,
): Promise<ParsedRhizomeTemplate> {
	const parsed = parseRhizomeTemplatePass1(source, folders, readTemplateFile);
	if (parsed.templates !== null && parsed.env.diagnostics.length === 0) {
		const resolvedFolders = resolveTemplateFolders(folders);
		const activeStack = new Set<string>();
		const visitedFiles = new Map<string, Template[]>();
		await walkTemplateTreePass1(
			source,
			parsed,
			resolvedFolders,
			parsed.templates,
			null,
			activeStack,
			visitedFiles,
		);
	}
	parsed.env.pass1Complete = true;
	return parsed;
}

const parsedTemplateRenderChains = new WeakMap<ParsedRhizomeTemplate, Promise<unknown>>();

/**
 * Runs Pass 2 (Liquid template rendering against a pre-fetched query `payload`) using
 * the AST and environment produced by `parseRhizomeTemplatePass1`.
 *
 * @remarks
 * (bugfix, 2026-10-30) Serializes concurrent Pass 2 renders on the same
 * `ParsedRhizomeTemplate` instance via a `WeakMap` promise chain so overlapping
 * async renders cannot clobber `parsed.env.payload` or `parsed.env.explainQuery`
 * while awaiting partials, layouts, or `explainQuery`.
 */
export async function renderParsedRhizomeTemplate(
	source: string,
	parsed: ParsedRhizomeTemplate,
	payload: Readonly<Record<string, unknown[]>>,
	explainQuery: (query: string, heading: string) => Promise<string>,
	runtimeContext?: TemplateRuntimeContext,
): Promise<TemplateRenderResult> {
	const queries: readonly ExtractedQueryBlock[] = Object.freeze([...parsed.env.queries]);

	if (parsed.env.diagnostics.length > 0 || parsed.templates === null) {
		const frozenDiags = Object.freeze([...parsed.env.diagnostics]);
		return Object.freeze({
			ok: false,
			markdown: formatTemplateDiagnosticsMarkdown(
				source,
				frozenDiags,
				parsed.env.fileSources,
			),
			queries,
			diagnostics: frozenDiags,
		});
	}

	const templates = parsed.templates;
	const previousRender = parsedTemplateRenderChains.get(parsed) ?? Promise.resolve();

	const executePass2 = async (): Promise<TemplateRenderResult> => {
		try {
			const safePayload: Readonly<Record<string, unknown[]>> =
				payload && typeof payload === 'object' ? payload : Object.freeze({});
			parsed.env.payload = extractUserQueryMap(safePayload);
			parsed.env.explainQuery = explainQuery;

			const rootScope = buildRhizomeTemplateContext(safePayload, runtimeContext);
			const renderedRaw: unknown = await parsed.liquid.render(templates, rootScope, {
				globals: rootScope,
			});
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
				parsed.env.fileSources,
			);
			const frozenDiags = Object.freeze([renderDiag]);
			return Object.freeze({
				ok: false,
				markdown: formatTemplateDiagnosticsMarkdown(
					source,
					frozenDiags,
					parsed.env.fileSources,
				),
				queries,
				diagnostics: frozenDiags,
			});
		}
	};

	const currentRender = previousRender.then(executePass2, executePass2);
	parsedTemplateRenderChains.set(parsed, currentRender);
	return currentRender;
}

/**
 * Executes a `rhizome` LiquidJS template in two passes:
 * 1. **Pass 1 (Static Parse & Extract):** Parses the Liquid AST across the root codeblock and any
 *    referenced `{% layout %}` / `{% render %}` files, validates `{% query <name> [explain] %}`
 *    blocks, and rejects duplicate `<name>` definitions or circular file references before touching the vault.
 * 2. **Pass 2 (Single-Pass Vault Query & Render):** Executes all extracted queries in a single
 *    `callbacks.runQueries` batch, then renders the Liquid template with the batch payload as root scope.
 */
export async function renderRhizomeTemplate(
	source: string,
	callbacks: TemplateExecutionCallbacks,
): Promise<TemplateRenderResult> {
	const parsed = await parseRhizomeTemplatePass1Async(
		source,
		callbacks.folders,
		callbacks.readTemplateFile,
	);
	const queries: readonly ExtractedQueryBlock[] = Object.freeze([...parsed.env.queries]);

	if (parsed.env.diagnostics.length > 0 || parsed.templates === null) {
		const frozenDiags = Object.freeze([...parsed.env.diagnostics]);
		return Object.freeze({
			ok: false,
			markdown: formatTemplateDiagnosticsMarkdown(
				source,
				frozenDiags,
				parsed.env.fileSources,
			),
			queries,
			diagnostics: frozenDiags,
		});
	}

	try {
		let payload: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
		const queryMap = Object.create(null) as Record<string, string>;
		const sourcePath = callbacks.runtimeContext?.sourcePath;
		if (typeof sourcePath === 'string' && sourcePath.length > 0) {
			queryMap[HOST_QUERY_KEY] = buildHostNoteQuery(sourcePath);
		}
		for (const q of queries) {
			queryMap[q.name] = q.query;
		}
		if (Object.keys(queryMap).length > 0) {
			const rawPayload = await callbacks.runQueries(Object.freeze(queryMap));
			if (rawPayload && typeof rawPayload === 'object') {
				payload = rawPayload;
			}
		}

		return await renderParsedRhizomeTemplate(
			source,
			parsed,
			payload,
			(q, heading) => callbacks.explainQuery(q, heading),
			callbacks.runtimeContext,
		);
	} catch (err: unknown) {
		const renderDiag = extractLiquidErrorDiagnostic(
			source,
			err,
			'TEMPLATE_RENDER_ERROR',
			'Verify the template expressions and filter arguments inside this codeblock.',
			parsed.env.fileSources,
		);
		const frozenDiags = Object.freeze([renderDiag]);
		return Object.freeze({
			ok: false,
			markdown: formatTemplateDiagnosticsMarkdown(
				source,
				frozenDiags,
				parsed.env.fileSources,
			),
			queries,
			diagnostics: frozenDiags,
		});
	}
}
