import type { SourceSpan } from '@core/search';

/**
 * Metadata and source spans for a single `{% query <name> [explain] %} ... {% endquery %}`
 * block extracted during Pass 1 of template compilation.
 */
export interface ExtractedQueryBlock {
	readonly name: string;
	readonly query: string;
	readonly explain: boolean;
	readonly headerSpan: SourceSpan;
	readonly bodySpan: SourceSpan;
	readonly fullSpan: SourceSpan;
}

/**
 * Diagnostic codes emitted by the LiquidJS template parser, `{% query %}` tag validator,
 * and runtime renderer.
 */
export type TemplateDiagnosticCode =
	| 'TEMPLATE_SYNTAX_ERROR'
	| 'INVALID_QUERY_TAG_ARGS'
	| 'DUPLICATE_QUERY_NAME'
	| 'TEMPLATE_RENDER_ERROR';

/**
 * Pure POJO diagnostic describing a template-level syntax, argument, duplicate-name,
 * or render failure. Uses `null` (never `undefined`) for optional fields.
 */
export interface TemplateDiagnostic {
	readonly code: TemplateDiagnosticCode;
	readonly severity: 'error' | 'warning' | 'hint';
	readonly issue: string;
	readonly hint: string | null;
	readonly span: SourceSpan | null;
}

/**
 * Vault-relative folder paths for LiquidJS `root` (templates), `partials` (`{% render %}` / `{% include %}`),
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
	readonly sourcePath?: string;
	readonly referenceTimeMs?: number;
	readonly timeZone?: string;
	readonly vault?: string;
	readonly language?: string;
	readonly platform?: Partial<TemplatePlatformFlags>;
}

/**
 * Host callbacks injected into `renderRhizomeTemplate` to execute batched vault queries,
 * format inline query explain plans, and read vault-scoped template partials/layouts
 * without coupling `@core/templates` to Obsidian.
 */
export interface TemplateExecutionCallbacks {
	runQueries(queries: Readonly<Record<string, string>>): Promise<Record<string, unknown[]>>;
	explainQuery(query: string, heading: string): Promise<string>;
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
}
