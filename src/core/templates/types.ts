import type {
	BacklinkRef,
	DiagnosticCode,
	NormalizedAliasLocation,
	NormalizedBlock,
	NormalizedDocument,
	NormalizedFileInfo,
	NormalizedHeading,
	NormalizedLink,
	NormalizedPropertyLocation,
	NormalizedTagLocation,
	NormalizedTask,
	ResolvedEngineConfig,
	SourceSpan,
} from '@core/search';

/**
 * Execution mode exposed at `◊.trigger` in the root Liquid template scope.
 */
export type TemplateTrigger = 'newNote' | 'atCursor' | 'dynamicCodeblock';

/**
 * Post-creation tab behavior for a `"newNote"` template block, controlled by `{% targetPath %}`.
 */
export type TemplateTargetTabMode = 'background' | 'active' | 'closed';

/**
 * Configurable starting rung on the graceful-degradation folder ladder for `template.folders.default`.
 */
export type NewNoteDefaultFolderRung =
	'notebookNavigator' | 'obsidianFiles' | 'activeNote' | 'vaultRoot';

export const NEW_NOTE_DEFAULT_FOLDER_RUNGS: readonly NewNoteDefaultFolderRung[] = Object.freeze([
	'notebookNavigator',
	'obsidianFiles',
	'activeNote',
	'vaultRoot',
]);

export function isNewNoteDefaultFolderRung(value: unknown): value is NewNoteDefaultFolderRung {
	return (
		typeof value === 'string' &&
		(NEW_NOTE_DEFAULT_FOLDER_RUNGS as readonly string[]).includes(value)
	);
}

/**
 * Graceful-degradation folder ladder rungs exposed at `template.folders.*`.
 * Each rung resolves to a vault-relative folder path (no leading/trailing `/`) or `""` for vault root.
 */
export interface TemplateFolderLadder {
	readonly notebookNavigator: string;
	readonly obsidianFiles: string;
	readonly activeNote: string;
	readonly default: string;
}

/**
 * Normalized metadata snapshot of the source template note exposed under `template` in `"newNote"`
 * and `"atCursor"` modes (`null` in `"dynamicCodeblock"` outside `templatesFolder`).
 */
export interface TemplateMetadataObject {
	readonly file: NormalizedFileInfo;
	readonly aliases: readonly string[];
	readonly aliasLocations: readonly NormalizedAliasLocation[];
	readonly tags: readonly string[];
	readonly tagLocations: readonly NormalizedTagLocation[];
	readonly cssclasses: readonly string[];
	readonly headings: readonly NormalizedHeading[];
	readonly links: readonly NormalizedLink[];
	readonly embeds: readonly NormalizedLink[];
	readonly blocks: readonly NormalizedBlock[];
	readonly tasks: readonly NormalizedTask[];
	readonly properties: Readonly<Record<string, unknown>>;
	readonly propertyLocations: readonly NormalizedPropertyLocation[];
	readonly backlinks: readonly BacklinkRef[];
	readonly folders: TemplateFolderLadder;
}

/**
 * Port interface for stateful per-invocation `{% targetPath %}` collision resolution across blocks.
 */
export interface TargetPathClaimPort {
	claim(blockIndex: number, normalizedPath: string): string;
}

/**
 * Options passed to `TemplateExecutionCallbacks.runQueries` when evaluating deferred `@this.*`
 * queries lazily during Pass 2 in `"newNote"` mode.
 */
export interface TemplateLazyQueryOptions {
	readonly hostDoc?: NormalizedDocument | null | undefined;
	readonly priorQueryPaths?: Readonly<Record<string, readonly string[]>> | undefined;
}

/**
 * Metadata and source spans for a single `{% query <name> [cutoff: <int>] %} ... {% endquery %}`
 * block extracted during Pass 1 of template compilation.
 */
export interface ExtractedQueryBlock {
	readonly name: string;
	readonly query: string;
	readonly cutoff: number;
	readonly explicitCutoff: boolean;
	readonly headerSpan: SourceSpan;
	readonly bodySpan: SourceSpan;
	readonly fullSpan: SourceSpan;
	readonly file?: string | null;
}

/**
 * Diagnostic codes emitted by the LiquidJS template parser, `{% query %}` tag validator,
 * and runtime renderer.
 */
export type TemplateDiagnosticCode =
	| 'TEMPLATE_SYNTAX_ERROR'
	| 'INVALID_QUERY_TAG_ARGS'
	| 'INVALID_HEADING_TAG_ARGS'
	| 'INVALID_TARGET_PATH_ARGS'
	| 'INVALID_TARGET_PATH'
	| 'INVALID_FRONTMATTER_TAG_ARGS'
	| 'DUPLICATE_QUERY_NAME'
	| 'QUERY_IN_LOOP_ERROR'
	| 'TEMPLATE_RENDER_ERROR'
	| 'INLINE_QUERY_SCOPE_UNAVAILABLE';

/**
 * Pure POJO diagnostic describing a template-level or query-level syntax, argument, duplicate-name,
 * validation, or render failure. Uses `null` (never `undefined`) for optional fields.
 */
export interface TemplateDiagnostic {
	readonly code: TemplateDiagnosticCode | DiagnosticCode;
	readonly severity: 'error' | 'warning' | 'hint';
	readonly issue: string;
	readonly hint: string | null;
	readonly span: SourceSpan | null;
	readonly file?: string | null;
}

/**
 * Vault-relative folder paths for LiquidJS `root` (templates), `partials` (`{% render %}`),
 * and `layouts` (`{% layout %}`).
 */
export interface TemplateFolderConfig {
	readonly templatesFolder?: string;
	readonly partialsFolder?: string;
	readonly layoutsFolder?: string;
	readonly configDir?: string;
}

/**
 * Pure boolean platform flags exposed under `platform.*` in the root Liquid template context.
 */
export interface TemplatePlatformFlags {
	readonly isDesktop: boolean;
	readonly isMobile: boolean;
	readonly isDesktopApp: boolean;
	readonly isMobileApp: boolean;
	readonly isIosApp: boolean;
	readonly isAndroidApp: boolean;
	readonly isPhone: boolean;
	readonly isTablet: boolean;
	readonly isMacOS: boolean;
	readonly isWin: boolean;
	readonly isLinux: boolean;
	readonly isSafari: boolean;
}

/**
 * Pure runtime environment metadata injected into Pass 2 template rendering to populate
 * root globals (`vault`, `tz`, `language`, `platform.*`) and pin relative temporal literals.
 */
export interface TemplateRuntimeContext {
	readonly sourcePath?: string | undefined;
	readonly referenceTimeMs?: number | undefined;
	readonly timeZone?: string | undefined;
	readonly vault?: string | undefined;
	readonly language?: string | undefined;
	readonly platform?: Partial<TemplatePlatformFlags> | undefined;
	readonly headingLevel?: number | undefined;
	readonly trigger?: TemplateTrigger | undefined;
	readonly template?: TemplateMetadataObject | null | undefined;
	readonly initialTargetPath?: string | undefined;
	readonly blockIndex?: number | undefined;
	readonly claimRegistry?: TargetPathClaimPort | undefined;
	readonly resolvedConfig?: ResolvedEngineConfig | undefined;
	readonly configDir?: string | null | undefined;
}

/**
 * Host callbacks injected into `renderRhizomeTemplate` to execute batched vault queries
 * and read vault-scoped template partials/layouts without coupling `@core/templates` to Obsidian.
 */
export interface TemplateExecutionCallbacks {
	runQueries(
		queries: Readonly<Record<string, string>>,
		lazyOptions?: TemplateLazyQueryOptions,
	): Promise<Record<string, unknown[]>>;
	resolveHost?: (sourcePath: string) => Promise<object | null> | object | null;
	readTemplateFile?: (vaultRelativePath: string) => Promise<string | null>;
	folders?: TemplateFolderConfig;
	runtimeContext?: TemplateRuntimeContext;
}

/**
 * Result returned by `renderRhizomeTemplate`.
 */
export interface TemplateRenderResult {
	readonly ok: boolean;
	readonly markdown: string;
	readonly queries: readonly ExtractedQueryBlock[];
	readonly diagnostics: readonly TemplateDiagnostic[];
	readonly targetPath?: string | undefined;
	readonly tabMode?: TemplateTargetTabMode | undefined;
	readonly frontmatter?: Readonly<Record<string, unknown>> | undefined;
	readonly hasFrontmatterMutations?: boolean | undefined;
}
