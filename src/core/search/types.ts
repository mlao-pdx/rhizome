export type ObsidianPropertyType =
	'text' | 'multitext' | 'number' | 'checkbox' | 'date' | 'datetime' | 'tags';

export const VALID_PROPERTY_TYPES_LIST: readonly ObsidianPropertyType[] = Object.freeze([
	'text',
	'multitext',
	'number',
	'checkbox',
	'date',
	'datetime',
	'tags',
]);

const PRIVATE_VALID_PROPERTY_TYPES = new Set<string>(VALID_PROPERTY_TYPES_LIST);

export function isValidPropertyType(val: unknown): val is ObsidianPropertyType {
	return typeof val === 'string' && PRIVATE_VALID_PROPERTY_TYPES.has(val);
}

export const VIRTUAL_FILE_KEYS_LIST: readonly string[] = Object.freeze([
	'file.modified',
	'file.created',
	'file.size',
	'file.extension',
	'file.name',
	'file.basename',
	'file.path',
	'file.parent',
]);

const PRIVATE_VIRTUAL_FILE_KEYS = new Set<string>(VIRTUAL_FILE_KEYS_LIST);

export function isVirtualFileKey(key: string): boolean {
	return PRIVATE_VIRTUAL_FILE_KEYS.has(key);
}

export type PropertyTypeRegistry = Record<string, ObsidianPropertyType>;

export type DateGrain =
	'year' | 'quarter' | 'month' | 'week' | 'day' | 'minute' | 'second' | 'ms' | 'range';

export interface DateInterval {
	/** Inclusive UTC epoch ms (safe integer within `[-8.64e15, 8.64e15]`) */
	readonly start: number;
	/** Exclusive UTC epoch ms (safe integer, strictly `start < end`; may equal `MAX_SAFE_EPOCH_MS + 1`) */
	readonly end: number;
	readonly grain: DateGrain;
	readonly raw: string;
}

export type DateParseResult =
	| { ok: true; interval: DateInterval }
	| { ok: false; reason: 'INVALID_FORMAT' | 'SKIPPED_DATE' | 'RELATIVE_NOT_ALLOWED' }
	| {
			ok: false;
			reason: 'REVERSED_RANGE';
			leftRaw: string;
			rightRaw: string;
			hint: string | null; // e.g., "Use 2026-01-01..2026-10-01"
	  };

/**
 * Target-Type Consistency Invariant:
 * Coercing a value for target type `T` MUST ONLY produce:
 * - `{ kind: 'null' }` (when input is `null` or `undefined`)
 * - `{ kind: 'invalid', raw, expectedType: T, reason, hint }` (when input is incompatible with `T`)
 * - `{ kind: 'text' }` (when `T` is `'text' | 'multitext' | 'tags'`)
 * - `{ kind: T }` (when `T` is `'number' | 'checkbox' | 'date' | 'datetime'`)
 */
export type TypedPropertyValue =
	| { kind: 'text'; value: string }
	| { kind: 'number'; value: number; raw: string }
	| { kind: 'checkbox'; value: boolean; raw: string }
	| { kind: 'date' | 'datetime'; interval: DateInterval; raw: string }
	| { kind: 'null' }
	| {
			kind: 'invalid';
			raw: string;
			expectedType: ObsidianPropertyType;
			reason:
				| 'INVALID_VALUE'
				| 'REVERSED_DATE_RANGE'
				| 'SKIPPED_DATE'
				| 'RELATIVE_IN_STORED_PROPERTY';
			hint: string | null;
	  };

export type SanitizedScalar = string | number | boolean | null;

export interface PropertyOccurrence {
	key: string; // Normalized: rawKey.trim().toLowerCase()
	rawKey: string; // Key casing as provided in cache/inline
	source: 'frontmatter' | 'inline';
	line: number | null; // Positive safe integer (1-based) when available; null otherwise
	propertyType: ObsidianPropertyType;
	rawValue: SanitizedScalar | SanitizedScalar[];
	typedValues: TypedPropertyValue[];
}

export type DocumentDiagnosticCode =
	'DOC_REVERSED_DATE_RANGE' | 'DOC_SKIPPED_DATE' | 'DOC_INVALID_PROPERTY_VALUE';

/**
 * Pure POJO diagnostic for a malformed property value on a `NormalizedDocument`.
 * Emitted in occurrence order and array-element order (one diagnostic per invalid scalar element).
 * Uses `null` instead of `undefined` for strict LiquidJS template compatibility.
 */
export interface DocumentDiagnostic {
	code: DocumentDiagnosticCode;
	filePath: string;
	fileBasename: string;
	propertyKey: string;
	rawKey: string;
	rawValue: string;
	expectedType: ObsidianPropertyType;
	source: 'frontmatter' | 'inline';
	line: number | null;
	occurrenceIndex: number;
	valueIndex: number;
	issue: string;
	hint: string | null;
}

export interface NormalizedFileInfo {
	path: string;
	name: string;
	basename: string;
	extension: string;
	parent: string; // "" for vault root
	created: number; // Safe integer UTC epoch ms within [-8.64e15, 8.64e15]
	modified: number; // Safe integer UTC epoch ms within [-8.64e15, 8.64e15]
	size: number; // Safe integer >= 0 (bytes)
}

export interface NormalizedHeading {
	text: string;
	level: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface NormalizedLink {
	link: string; // Raw link string from cache, e.g., "Other Note#Heading" or "#Overview"
	rawTarget: string; // Unresolved target without #heading/^block (or self path for "#Overview")
	resolvedPath: string | null; // Vault path via resolveLinkPath(), or null if unresolved
	subpath: string; // "#Heading" or "^block", or ""
	displayText: string;
	source: 'body' | 'frontmatter' | 'embed';
	origin: string; // "[[NoteFullPath#^BlockId|NoteBasename]]" | "[[NoteFullPath#Heading|NoteBasename]]" | "[[NoteFullPath|NoteBasename]]"
}

export interface NormalizedTagLocation {
	tag: string; // Authored-case tag with leading '#' stripped
	source: 'frontmatter' | 'inline' | 'body';
	origin: string; // "[[NoteFullPath#^BlockId|NoteBasename]]" | "[[NoteFullPath#Heading|NoteBasename]]" | "[[NoteFullPath|NoteBasename]]"
}

export interface NormalizedDocument {
	/** Fingerprint of the `ResolvedEngineConfig` (`timeZone` + `propertyTypes`) used to normalize this document */
	normalizationFingerprint: string;
	file: NormalizedFileInfo;
	aliases: string[];
	tags: string[]; // Authored-case tags with leading '#' stripped, in appearance order
	tagLocations: NormalizedTagLocation[]; // In 1-to-1 correspondence with tags (frontmatter -> inline -> body)
	headings: NormalizedHeading[];
	links: NormalizedLink[]; // Outgoing links (frontmatterLinks + body links, excluding embeds)
	embeds: NormalizedLink[]; // Outgoing embeds
	blocks: string[]; // Authored-case block IDs with any leading '^' stripped
	propertyOccurrences: PropertyOccurrence[]; // Cache-level occurrence stream
	propertyKeys: string[]; // Exact first-seen order of normalized property keys
	properties: Record<string, unknown>; // Null-prototype O(1) lookup map with per-key local occurrence order
	diagnostics: DocumentDiagnostic[]; // Non-fatal document property diagnostics
}

// ============================================================================
// AST, CONFIG, PREPARED QUERY & EVALUATION REPORT TYPES
// ============================================================================

/**
 * UTF-16 code-unit offsets and 1-based line/column coordinates.
 * `startOffset` is inclusive (0-based); `endOffset` is exclusive (0-based, `endOffset >= startOffset`).
 */
export interface SourceSpan {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly startLine: number; // 1-based
	readonly startColumn: number; // 1-based
}

export type SearchAST =
	MatchAllNode | LogicalNode | NotNode | ScopedFilterNode | PropertyFilterNode | TextMatchNode;

export interface MatchAllNode {
	readonly type: 'MATCH_ALL';
}

export interface LogicalNode {
	readonly type: 'LOGICAL';
	readonly operator: 'AND' | 'OR';
	readonly parenthesized?: boolean;
	readonly children: readonly SearchAST[];
	readonly span?: SourceSpan;
}

export interface NotNode {
	readonly type: 'NOT';
	readonly syntax: 'NOT' | '-';
	readonly child: SearchAST;
	readonly span?: SourceSpan;
}

export type LeafMatcher =
	| { readonly kind: 'string'; readonly value: string; readonly quoted: boolean }
	| { readonly kind: 'regex'; readonly pattern: string; readonly flags: string };

export type ValueExprAST =
	| {
			readonly type: 'VALUE_LOGICAL';
			readonly operator: 'AND' | 'OR';
			readonly children: readonly ValueExprAST[];
	  }
	| { readonly type: 'VALUE_NOT'; readonly syntax: 'NOT' | '-'; readonly child: ValueExprAST }
	| { readonly type: 'VALUE_LEAF'; readonly matcher: LeafMatcher };

export interface ScopedFilterNode {
	readonly type: 'SCOPED_FILTER';
	readonly scope: string; // Trimmed canonicalName from ResolvedEngineConfig
	readonly rawScope: string; // Authored scope token text, or '#' when lowered from TagShorthand
	readonly expr: ValueExprAST;
	readonly span?: SourceSpan;
}

export type PropertyOperator = 'EXISTS' | ':' | '=' | '!=' | '<' | '>' | '<=' | '>=';

export interface PropertyFilterNode {
	readonly type: 'PROPERTY_FILTER';
	readonly key: string; // Decoded, trimmed, lowercased property key
	readonly rawKey: string; // Decoded property key (with outer quotes stripped if quoted)
	readonly operator: PropertyOperator;
	readonly valueExpr?: ValueExprAST; // Present iff operator !== 'EXISTS'
	readonly span?: SourceSpan;
}

export interface TextMatchNode {
	readonly type: 'TEXT_MATCH';
	readonly matcher: LeafMatcher;
	readonly rawText: string; // Original token text for linting
	readonly span?: SourceSpan;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'hint';

export type DiagnosticCode =
	| 'SYNTAX_ERROR'
	| 'ERROR_INVALID_CONFIG'
	| 'ERROR_UNKNOWN_SCOPE'
	| 'ERROR_TYPE_MISMATCH'
	| 'ERROR_INVALID_OPERATOR_FOR_TYPE'
	| 'WARN_UNQUOTED_MULTIWORD_SCOPE'
	| 'WARN_LOWERCASE_BOOLEAN'
	| 'WARN_DANGEROUS_SPACED_HYPHEN'
	| 'WARN_SINGLE_VALUE_CONTRADICTION'
	| 'HINT_PROP_NEQ_EXISTENCE'
	| 'HINT_AMBIGUOUS_PRECEDENCE'
	| 'HINT_WIKILINK_BRACKETS_IN_SCOPE'
	| 'HINT_BARE_TEXT_NO_BODY';

export interface SearchDiagnostic {
	code: DiagnosticCode;
	severity: DiagnosticSeverity;
	issue: string;
	hint: string | null;
	span: SourceSpan | null;
}

/**
 * Custom Scope Callbacks Contract:
 * - Regex leaves (`/pattern/flags`) are compiled once per query and evaluated centrally by the engine
 *   against extracted targets, so custom scopes only need to implement string matching in `matchString`!
 * - Both `extract` and `matchString` MUST be pure, deterministic, non-mutating, non-throwing,
 *   and capture no mutable external state for the lifetime of a `ResolvedEngineConfig`.
 */
export interface ScopeDefinition {
	readonly canonicalName: string;
	readonly aliases: readonly string[];
	readonly extract: (doc: NormalizedDocument) => readonly string[];
	readonly matchString: (target: string, queryValue: string, quoted: boolean) => boolean;
}

export interface EngineConfig {
	timeZone: string;
	propertyTypes: PropertyTypeRegistry;
	customScopes?: readonly ScopeDefinition[];
}

export interface ResolvedEngineConfig {
	readonly __brand: 'ResolvedEngineConfig';
	readonly timeZone: string;
	readonly propertyTypes: Readonly<PropertyTypeRegistry>;
	/** Deterministic fingerprint of `timeZone` + `propertyTypes` for verifying document normalization compatibility */
	readonly normalizationFingerprint: string;
	readonly getScope: (nameOrAlias: string) => ScopeDefinition | undefined;
	readonly getAllScopeNames: () => readonly string[];
}

export type ConfigResult =
	| { ok: true; config: ResolvedEngineConfig; diagnostics: readonly [] }
	| { ok: false; config: null; diagnostics: readonly SearchDiagnostic[] };

/**
 * Deeply frozen prepared query produced by `compileQuery`.
 */
export interface PreparedQuery {
	readonly __brand: 'PreparedQuery';
	readonly ast: SearchAST;
	readonly resolvedConfig: ResolvedEngineConfig;
	readonly referenceTimeMs: number;
}

export interface CompileResult {
	ast: SearchAST | null;
	prepared: PreparedQuery | null;
	diagnostics: SearchDiagnostic[];
	executable: boolean;
}

export interface VaultEvaluationReport {
	/** Matched documents in exact input vault order */
	matches: NormalizedDocument[];
	/**
	 * All `DocumentDiagnostic` items from vault documents whose `propertyKey` was referenced
	 * by at least one non-virtual `PropertyFilterNode` in `ast` (in document, occurrence, and value order).
	 */
	propertyDiagnostics: DocumentDiagnostic[];
}
