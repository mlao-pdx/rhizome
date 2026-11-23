import { formatSourceCaretSnippet, type QueryExplainCutoff, type SourceSpan } from '@core/search';
import { Liquid, LiquidError, Tag, type Template, toPromise } from 'liquidjs';
import { registerFrontmatterTag } from './frontmatter-tag';
import { registerHeadingTag } from './heading-filter';
import { registerPayloadLiquidFilters } from './payload-filters';
import { applyQueryCutoffs } from './query-cutoff';
import {
	extractMatchedDocumentPaths,
	isRenderLoopTag,
	partitionNewNoteQueries,
	validateQueriesNotInLoop,
} from './query-partitioner';
import {
	checkFilterOutputSize,
	installBoundedTemplateRenderer,
	TEMPLATE_MEMORY_LIMIT,
	TEMPLATE_MEMORY_LIMIT_HINT,
	TEMPLATE_RENDER_LIMIT_MS,
	TEMPLATE_RENDER_TIME_LIMIT_HINT,
} from './render-limits';
import {
	createQueryTagEnvironment,
	maskQueryBlockBodies,
	offsetRangeToSourceSpan,
	type QueryTagBinding,
	type QueryTagEnvironment,
	registerQueryTag,
} from './query-tag';
import { registerTargetPathTag, TaggedTemplateDiagnosticError } from './target-path-tag';
import {
	buildRhizomeTemplateContext,
	extractUserQueryMap,
	HOST_QUERY_KEY,
} from './template-context';
import { readTemplateTargetState } from './template-target-state';
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
	TemplateLazyQueryOptions,
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
	if (err instanceof TaggedTemplateDiagnosticError) {
		return err.templateDiagnostic;
	}
	if (LiquidError.is(err) && err.originalError instanceof TaggedTemplateDiagnosticError) {
		return err.originalError.templateDiagnostic;
	}

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
	} else if (err instanceof Error) {
		const customHint = (err as { hint?: unknown }).hint;
		if (typeof customHint === 'string' && customHint.trim().length > 0) {
			resolvedHint = customHint.trim();
		}
	}

	const lowerMsg = rawMessage.toLowerCase();
	if (lowerMsg.includes('template render limit exceeded')) {
		rawMessage = 'Template render exceeded the 5,000 ms time limit';
		resolvedHint = TEMPLATE_RENDER_TIME_LIMIT_HINT;
	} else if (lowerMsg.includes('memory alloc limit exceeded')) {
		rawMessage = 'Template render exceeded the 32 MB memory allocation limit';
		resolvedHint = TEMPLATE_MEMORY_LIMIT_HINT;
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
 * Builds a configured, vault-scoped `Liquid` instance whose `{% query %}` and `{% heading %}`
 * tags resolve their per-parse environment through `getBinding`.
 */
function buildRhizomeLiquidInstance(
	getBinding: () => QueryTagBinding,
	fileSources: Map<string, string>,
	folders?: TemplateFolderConfig,
	readTemplateFile?: (vaultRelativePath: string) => Promise<string | null>,
): Liquid {
	installTemporalTokenizerExtensions();
	const resolvedFolders = resolveTemplateFolders(folders);
	const fs = createVaultLiquidFs(resolvedFolders, readTemplateFile, fileSources);
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
		renderLimit: TEMPLATE_RENDER_LIMIT_MS,
		memoryLimit: TEMPLATE_MEMORY_LIMIT,
		operators: createRhizomeLiquidOperators(),
	});
	installBoundedTemplateRenderer(liquid);
	registerQueryTag(liquid, getBinding);
	registerHeadingTag(liquid, getBinding);
	registerTargetPathTag(liquid, getBinding);
	registerFrontmatterTag(liquid, getBinding);
	registerTemporalLiquidExtensions(liquid);
	registerPayloadLiquidFilters(liquid);
	return liquid;
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
	return buildRhizomeLiquidInstance(
		() => ({ env, originalSource }),
		env.fileSources,
		folders,
		readTemplateFile,
	);
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

const THIS_QUERY_REF_RE = /@this(?![a-zA-Z0-9_+-])/;
const LIQUID_TAG_OR_OUTPUT_RE = /\{%-?([\s\S]*?)-?%\}|\{\{-?([\s\S]*?)-?\}\}/g;
const LIQUID_QUOTED_STRING_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const BARE_THIS_IDENTIFIER_RE = /(?<![a-zA-Z0-9_.-])\bthis\b(?![a-zA-Z0-9_-])/;
const LOOP_TAG_RE =
	/\{%-?\s*(?:for|tablerow)\b|\{%-?\s*render\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s+for\b/;

function stripLiquidRawAndComments(source: string): string {
	return maskQueryBlockBodies(source).replace(
		/\{%-?\s*raw(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})[\s\S]*?\{%-?\s*endraw(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})|\{%-?\s*comment(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})[\s\S]*?\{%-?\s*endcomment(?:\s+[\s\S]*?-?%\}|%\}|\s+-%\})|\{%-?\s*#[\s\S]*?-?%\}/g,
		'',
	);
}

function liquidSourceReferencesThis(rawSource: string): boolean {
	const cleaned = stripLiquidRawAndComments(rawSource);
	LIQUID_TAG_OR_OUTPUT_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = LIQUID_TAG_OR_OUTPUT_RE.exec(cleaned)) !== null) {
		const inner = (match[1] ?? match[2] ?? '').replace(LIQUID_QUOTED_STRING_RE, ' ');
		if (BARE_THIS_IDENTIFIER_RE.test(inner)) {
			return true;
		}
	}
	return false;
}

/**
 * Checks whether a parsed template, any of its referenced partial/layout files, or any of its
 * extracted `{% query %}` blocks reference the hosting note via `this` or `@this`.
 */
export function parsedTemplateReferencesHost(
	source: string,
	parsed: ParsedRhizomeTemplate,
): boolean {
	for (const q of parsed.env.queries) {
		if (THIS_QUERY_REF_RE.test(q.query)) {
			return true;
		}
	}
	if (liquidSourceReferencesThis(source)) {
		return true;
	}
	for (const fileSource of parsed.env.fileSources.values()) {
		if (liquidSourceReferencesThis(fileSource)) {
			return true;
		}
	}
	return false;
}

/**
 * Checks whether the stripped root template or any of its referenced partial/layout files
 * contains a Liquid loop tag (`{% for %}`, `{% tablerow %}`, or `{% render '...' for ... %}`).
 */
export function parsedTemplateHasLoopTag(
	rawSource: string,
	parsed: ParsedRhizomeTemplate,
): boolean {
	if (LOOP_TAG_RE.test(stripLiquidRawAndComments(rawSource))) {
		return true;
	}
	for (const fileSource of parsed.env.fileSources.values()) {
		if (LOOP_TAG_RE.test(stripLiquidRawAndComments(fileSource))) {
			return true;
		}
	}
	return false;
}

/**
 * Parses the masked root source, validates static partial/layout filenames, and records any
 * Liquid parse error in `env.diagnostics`. Shared by the synchronous Pass 1 entry points so
 * analyzer and render diagnostics cannot drift.
 */
function parseAndValidateRoot(
	liquid: Liquid,
	source: string,
	env: QueryTagEnvironment,
): Template[] | null {
	let templates: Template[] | null = null;

	try {
		templates = liquid.parse(maskQueryBlockBodies(source));
		validateStaticPartialAndLayoutFilenames(source, env, templates, null);
		validateQueriesNotInLoop(source, env, templates, null, false);
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

	return templates;
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
	const templates = parseAndValidateRoot(liquid, source, env);

	return { liquid, env, templates };
}

interface AnalysisLiquidCache {
	readonly liquid: Liquid;
}

let analysisLiquidCache: AnalysisLiquidCache | null = null;
let analysisBinding: QueryTagBinding | null = null;

/**
 * Runs the synchronous root Pass 1 used by the CodeMirror 6 editor analyzer, reusing one
 * configured `Liquid` instance across calls so keystroke-driven analysis does not rebuild the
 * filesystem, operators, tokenizer extensions, tags, and filters on every cache miss.
 */
export function parseRhizomeTemplatePass1ForAnalysis(source: string): ParsedRhizomeTemplate {
	const env = createQueryTagEnvironment();
	analysisBinding = { env, originalSource: source };

	if (analysisLiquidCache === null) {
		const fileSources = new Map<string, string>();
		analysisLiquidCache = {
			liquid: buildRhizomeLiquidInstance(() => {
				if (analysisBinding === null) {
					throw new Error('Analysis Liquid binding was not initialized.');
				}
				return analysisBinding;
			}, fileSources),
		};
	}

	const liquid = analysisLiquidCache.liquid;
	const templates = parseAndValidateRoot(liquid, source, env);

	return { liquid, env, templates };
}

interface InspectableTag {
	readonly name: string;
	readonly token: Tag['token'];
	readonly file?: unknown;
	readonly forBinding?: unknown;
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
	visitedFiles: Map<string, { readonly templates: Template[]; readonly resolvedFile: string }>,
	visitedDirectLoopFiles: Set<string>,
	indirectLoopFiles: Map<
		string,
		{ readonly templates: Template[]; readonly resolvedFile: string }
	>,
	inDirectLoop: boolean = false,
	inIndirectLoop: boolean = false,
): Promise<void> {
	for (const tpl of templates) {
		if (!(tpl instanceof Tag)) {
			continue;
		}
		const tag = tpl as unknown as InspectableTag;

		if (tag.name === 'query') {
			if (inDirectLoop) {
				validateQueriesNotInLoop(rootSource, parsed.env, [tpl], currentFile, true);
			}
			continue;
		}

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
					visitedDirectLoopFiles,
					indirectLoopFiles,
					inDirectLoop,
					inIndirectLoop,
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

			const childDirectLoop = isRenderLoopTag(tag);
			const childIndirectLoop = !childDirectLoop && (inDirectLoop || inIndirectLoop);
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

			const visitedEntry = visitedFiles.get(canonicalKey);
			if (visitedEntry !== undefined) {
				writeLiquidLookupAliasCache(
					parsed.liquid,
					tag.name,
					rawFile,
					visitedEntry.templates,
				);
				if (childDirectLoop && !visitedDirectLoopFiles.has(canonicalKey)) {
					visitedDirectLoopFiles.add(canonicalKey);
					validateQueriesNotInLoop(
						rootSource,
						parsed.env,
						visitedEntry.templates,
						visitedEntry.resolvedFile,
						true,
					);
				} else if (childIndirectLoop && !indirectLoopFiles.has(canonicalKey)) {
					indirectLoopFiles.set(canonicalKey, visitedEntry);
					activeStack.add(canonicalKey);
					await walkTemplateTreePass1(
						rootSource,
						parsed,
						resolvedFolders,
						visitedEntry.templates,
						visitedEntry.resolvedFile,
						activeStack,
						visitedFiles,
						visitedDirectLoopFiles,
						indirectLoopFiles,
						false,
						true,
					);
					activeStack.delete(canonicalKey);
				}
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
				const entry = {
					templates: childTemplates,
					resolvedFile: resolvedChildFile,
				};
				if (childDirectLoop) {
					visitedDirectLoopFiles.add(canonicalKey);
				} else if (childIndirectLoop) {
					indirectLoopFiles.set(canonicalKey, entry);
				}
				visitedFiles.set(canonicalKey, entry);
				await walkTemplateTreePass1(
					rootSource,
					parsed,
					resolvedFolders,
					childTemplates,
					resolvedChildFile,
					activeStack,
					visitedFiles,
					visitedDirectLoopFiles,
					indirectLoopFiles,
					childDirectLoop,
					childIndirectLoop,
				);
			}
			activeStack.delete(canonicalKey);
			continue;
		}

		const nextDirectLoop = inDirectLoop || tag.name === 'for' || tag.name === 'tablerow';
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
				visitedDirectLoopFiles,
				indirectLoopFiles,
				nextDirectLoop,
				inIndirectLoop,
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
		const visitedFiles = new Map<
			string,
			{ readonly templates: Template[]; readonly resolvedFile: string }
		>();
		const visitedDirectLoopFiles = new Set<string>();
		const indirectLoopFiles = new Map<
			string,
			{ readonly templates: Template[]; readonly resolvedFile: string }
		>();
		await walkTemplateTreePass1(
			source,
			parsed,
			resolvedFolders,
			parsed.templates,
			null,
			activeStack,
			visitedFiles,
			visitedDirectLoopFiles,
			indirectLoopFiles,
			false,
			false,
		);
		if (indirectLoopFiles.size > 0 && parsed.env.queries.length > 0) {
			const { lazyQueryNames } = partitionNewNoteQueries(parsed.env.queries);
			if (lazyQueryNames.size > 0) {
				for (const entry of indirectLoopFiles.values()) {
					validateQueriesNotInLoop(
						source,
						parsed.env,
						entry.templates,
						entry.resolvedFile,
						true,
						lazyQueryNames,
					);
				}
			}
		}
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
	explainQuery: (
		query: string,
		heading: string,
		cutoff?: QueryExplainCutoff,
		lazyOptions?: TemplateLazyQueryOptions,
	) => Promise<string>,
	runtimeContext?: TemplateRuntimeContext,
	lazyRunQueries?: (
		queries: Readonly<Record<string, string>>,
		lazyOptions?: TemplateLazyQueryOptions,
	) => Promise<Record<string, unknown[]>>,
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
		parsed.env.uncutQueryPaths.clear();
		parsed.env.lazyCutoffCallouts.length = 0;
		parsed.env.lazyQueryNames = null;
		parsed.env.runLazyQuery = null;

		try {
			const safePayload: Readonly<Record<string, unknown[]>> =
				payload && typeof payload === 'object' ? payload : Object.freeze({});
			const isNewNoteLazyMode =
				runtimeContext?.trigger === 'newNote' && typeof lazyRunQueries === 'function';
			const partitioned = isNewNoteLazyMode ? partitionNewNoteQueries(queries) : null;
			const pass15Queries = partitioned ? partitioned.staticQueries : queries;

			for (const q of pass15Queries) {
				if (Object.prototype.hasOwnProperty.call(safePayload, q.name)) {
					parsed.env.uncutQueryPaths.set(
						q.name,
						extractMatchedDocumentPaths(safePayload[q.name]),
					);
				}
			}

			const { effectivePayload: baseEffectivePayload, calloutsMarkdown } = applyQueryCutoffs(
				pass15Queries,
				safePayload,
				runtimeContext,
			);
			let effectivePayload = baseEffectivePayload;
			if (partitioned && partitioned.lazyQueryNames.size > 0) {
				const emptyFrozenRows: unknown[] = Object.freeze([]) as unknown as unknown[];
				const seededPayload: Record<string, unknown[]> = Object.assign(
					Object.create(null) as Record<string, unknown[]>,
					baseEffectivePayload,
				);
				for (const lazyName of partitioned.lazyQueryNames) {
					seededPayload[lazyName] = emptyFrozenRows;
				}
				effectivePayload = Object.freeze(seededPayload);
			}
			parsed.env.payload = extractUserQueryMap(effectivePayload);
			parsed.env.explainQuery = explainQuery;

			if (partitioned && partitioned.lazyQueryNames.size > 0 && lazyRunQueries) {
				const queryBlockByName = new Map<string, ExtractedQueryBlock>();
				for (const q of queries) {
					queryBlockByName.set(q.name, q);
				}
				parsed.env.lazyQueryNames = partitioned.lazyQueryNames;
				parsed.env.runLazyQuery = async (name, queryText, lazyOpts) => {
					const rawRes = await lazyRunQueries(
						Object.freeze({ [name]: queryText }),
						lazyOpts,
					);
					if (
						!rawRes ||
						typeof rawRes !== 'object' ||
						!Object.prototype.hasOwnProperty.call(rawRes, name)
					) {
						return {
							matched: false,
							rawRows: [],
							effectiveRows: [],
							calloutMarkdown: '',
						};
					}
					const candidateRows = rawRes[name];
					const rawRows = Array.isArray(candidateRows) ? candidateRows : [];
					parsed.env.uncutQueryPaths.set(name, extractMatchedDocumentPaths(rawRows));
					const qBlock = queryBlockByName.get(name);
					if (!qBlock) {
						return {
							matched: true,
							rawRows,
							effectiveRows: rawRows,
							calloutMarkdown: '',
						};
					}
					const cutoffRes = applyQueryCutoffs(
						[qBlock],
						{ [name]: rawRows },
						runtimeContext,
					);
					const effectiveRows = cutoffRes.effectivePayload[name] ?? rawRows;
					return {
						matched: true,
						rawRows,
						effectiveRows,
						calloutMarkdown: cutoffRes.calloutsMarkdown,
					};
				};
			}

			const rootScope = buildRhizomeTemplateContext(effectivePayload, runtimeContext);
			const renderedRaw: unknown = await parsed.liquid.render(templates, rootScope, {
				globals: rootScope,
				renderLimit: TEMPLATE_RENDER_LIMIT_MS,
				memoryLimit: TEMPLATE_MEMORY_LIMIT,
			});
			const renderedMarkdown = typeof renderedRaw === 'string' ? renderedRaw : '';
			const allCallouts = [calloutsMarkdown, ...parsed.env.lazyCutoffCallouts]
				.filter((s) => s.length > 0)
				.join('\n\n');
			const finalMarkdown =
				allCallouts.length === 0
					? renderedMarkdown
					: renderedMarkdown.trim().length === 0
						? allCallouts
						: `${allCallouts}\n\n${renderedMarkdown}`;
			checkFilterOutputSize(finalMarkdown.length);

			const targetState = readTemplateTargetState(rootScope);
			const newNoteFields =
				targetState?.trigger === 'newNote'
					? {
							targetPath: targetState.targetPath,
							tabMode: targetState.tabMode,
							frontmatter: targetState.frontmatterSnapshot,
							hasFrontmatterMutations: targetState.hasFrontmatterMutations,
						}
					: {};

			return Object.freeze({
				ok: true,
				markdown: finalMarkdown,
				queries,
				diagnostics: Object.freeze([]),
				...newNoteFields,
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
		} finally {
			parsed.env.lazyQueryNames = null;
			parsed.env.runLazyQuery = null;
			parsed.env.lazyCutoffCallouts.length = 0;
			parsed.env.uncutQueryPaths.clear();
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
 *    blocks, and rejects duplicate `<name>` definitions, loop-nested queries, or circular file
 *    references before touching the vault.
 * 2. **Pass 2 (Single-Pass / Hybrid Lazy Vault Query & Render):** Executes static queries in Pass 1.5
 *    (and in `"newNote"` mode defers `@this.*` queries and their `@query.*` dependents to Pass 2),
 *    then renders the Liquid template with the batch payload as root scope.
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
		const isNewNoteMode = callbacks.runtimeContext?.trigger === 'newNote';
		const pass15Queries = isNewNoteMode
			? partitionNewNoteQueries(queries).staticQueries
			: queries;

		const payload: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
		const queryMap = Object.create(null) as Record<string, string>;
		for (const q of pass15Queries) {
			queryMap[q.name] = q.query;
		}
		const sourcePath = callbacks.runtimeContext?.sourcePath;
		const hasSourcePath =
			!isNewNoteMode && typeof sourcePath === 'string' && sourcePath.length > 0;
		const hasQueries = Object.keys(queryMap).length > 0;

		if (typeof callbacks.resolveHost === 'function') {
			if (hasQueries) {
				const rawPayload = await callbacks.runQueries(Object.freeze(queryMap));
				if (rawPayload && typeof rawPayload === 'object') {
					Object.assign(payload, rawPayload);
				}
			}
			if (hasSourcePath) {
				const hostMatch = await callbacks.resolveHost(sourcePath);
				payload[HOST_QUERY_KEY] = hostMatch ? [hostMatch] : [];
			}
		} else if (hasQueries || hasSourcePath) {
			const rawPayload = await callbacks.runQueries(Object.freeze(queryMap));
			if (rawPayload && typeof rawPayload === 'object') {
				Object.assign(payload, rawPayload);
			}
		}

		return await renderParsedRhizomeTemplate(
			source,
			parsed,
			payload,
			(q, heading, cutoff, lazyOpts) => callbacks.explainQuery(q, heading, cutoff, lazyOpts),
			callbacks.runtimeContext,
			isNewNoteMode ? (qMap, lazyOpts) => callbacks.runQueries(qMap, lazyOpts) : undefined,
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
