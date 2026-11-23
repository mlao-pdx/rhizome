export type ObsidianPropertyType =
	'text' | 'multitext' | 'number' | 'checkbox' | 'date' | 'datetime';

export const VALID_PROPERTY_TYPES_LIST: readonly ObsidianPropertyType[] = Object.freeze([
	'text',
	'multitext',
	'number',
	'checkbox',
	'date',
	'datetime',
]);

const PRIVATE_VALID_PROPERTY_TYPES = new Set<string>(VALID_PROPERTY_TYPES_LIST);

export function isValidPropertyType(val: unknown): val is ObsidianPropertyType {
	return typeof val === 'string' && PRIVATE_VALID_PROPERTY_TYPES.has(val);
}

const SYSTEM_SCOPE_PROPERTY_KEYS: ReadonlyMap<string, 'tag' | 'aliases' | 'cssclasses'> = new Map([
	['tag', 'tag'],
	['tags', 'tag'],
	['alias', 'aliases'],
	['aliases', 'aliases'],
	['cssclass', 'cssclasses'],
	['cssclasses', 'cssclasses'],
]);

export function getSystemScopeForPropertyKey(
	lowerKey: string,
): 'tag' | 'aliases' | 'cssclasses' | undefined {
	return SYSTEM_SCOPE_PROPERTY_KEYS.get(lowerKey.trim().toLowerCase());
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

/**
 * Reserved frontmatter property key used by Rhizome to mark system or internal notes
 * with structured handling codes (e.g. `{"001": "Do not index or query."}`).
 */
export const INTERNAL_RHIZOME_PROPERTY_KEY = '◊InternalRhizome';

/**
 * Recognized flag codes inside the `◊InternalRhizome` frontmatter object.
 */
export const INTERNAL_RHIZOME_CODES = Object.freeze({
	DO_NOT_INDEX_OR_QUERY: '001',
} as const);

export type InternalRhizomeCode =
	(typeof INTERNAL_RHIZOME_CODES)[keyof typeof INTERNAL_RHIZOME_CODES];

/**
 * Returns `true` when `frontmatter` declares an `◊InternalRhizome` object containing `code`.
 */
export function hasInternalRhizomeFlag(
	frontmatter: Readonly<Record<string, unknown>> | null | undefined,
	code: InternalRhizomeCode,
): boolean {
	if (!frontmatter || typeof frontmatter !== 'object') {
		return false;
	}
	const flags = frontmatter[INTERNAL_RHIZOME_PROPERTY_KEY];
	if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) {
		return false;
	}
	return Object.prototype.hasOwnProperty.call(flags, code);
}

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
 * - `{ kind: 'text' }` (when `T` is `'text' | 'multitext'`)
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

export type PropertySource = 'frontmatter' | 'dataview' | 'rhizome';

export type TagSource = PropertySource | 'inline';

export interface PropertyOccurrence {
	key: string; // Normalized: rawKey.trim().toLowerCase()
	rawKey: string; // Key casing as provided in cache/inline
	source: PropertySource;
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
	source: PropertySource;
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
	created: string; // Minute-grain ISO-8601 datetime ("YYYY-MM-DDTHH:mm") in normalization timeZone
	modified: string; // Minute-grain ISO-8601 datetime ("YYYY-MM-DDTHH:mm") in normalization timeZone
	size: number; // Safe integer >= 0 (bytes)
	/** Non-enumerable alias of `extension` for Liquid / selector parity with `@this.file.ext`. */
	readonly ext: string;
	/** Non-enumerable alias of `created` for Liquid / selector parity with `@this.file.ctime`. */
	readonly ctime: string;
	/** Non-enumerable alias of `modified` for Liquid / selector parity with `@this.file.mtime`. */
	readonly mtime: string;
}

export interface NormalizedHeading {
	text: string;
	level: 1 | 2 | 3 | 4 | 5 | 6;
	origin: string;
}

export interface NormalizedBlock {
	id: string;
	origin: string;
}

export interface NormalizedLink {
	link: string; // Raw link string from cache, e.g., "Other Note#Heading" or "#Overview"
	rawTarget: string; // Unresolved target without #heading/^block (or self path for "#Overview")
	resolvedPath: string | null; // Vault path via resolveLinkPath(), or null if unresolved
	subpath: string; // "#Heading" or "^block", or ""
	displayText: string;
	source: 'frontmatter' | 'inline' | 'embed';
	readonly property: string | null; // Trimmed authored-case property key, or null for prose links and embeds
	origin: string; // "[[NoteFullPath#^BlockId|NoteBasename]]" | "[[NoteFullPath#Heading|NoteBasename]]" | "[[NoteFullPath|NoteBasename]]"
}

export interface NormalizedTagLocation {
	tag: string; // Authored-case tag with leading '#' stripped
	source: TagSource;
	origin: string; // "[[NoteFullPath#^BlockId|NoteBasename]]" | "[[NoteFullPath#Heading|NoteBasename]]" | "[[NoteFullPath|NoteBasename]]"
}

export interface NormalizedAliasLocation {
	alias: string; // Authored-case alias string
	source: PropertySource;
	origin: string; // "[[NoteFullPath#^BlockId|NoteBasename]]" | "[[NoteFullPath#Heading|NoteBasename]]" | "[[NoteFullPath|NoteBasename]]"
}

export interface NormalizedPropertyLocation {
	property: string; // Trimmed authored-case property key
	value: SanitizedScalar | SanitizedScalar[]; // Sanitized per-occurrence value (vacuous scalar -> null)
	source: PropertySource;
	origin: string; // "[[NoteFullPath#^BlockId|NoteBasename]]" | "[[NoteFullPath#Heading|NoteBasename]]" | "[[NoteFullPath|NoteBasename]]"
}

export type TaskStatusType = 'TODO' | 'IN_PROGRESS' | 'ON_HOLD' | 'DONE' | 'CANCELLED' | 'NON_TASK';

export type TaskPriority = 'highest' | 'high' | 'medium' | 'normal' | 'low' | 'lowest';

export type TaskSignifierFormat = 'emoji' | 'dataview' | 'mixed' | 'none';

export interface NormalizedTask {
	line: number; // 1-based line number
	status: string; // 1-char checkbox symbol inside [...]
	statusType: TaskStatusType;
	completed: boolean; // statusType === 'DONE'
	done: boolean; // statusType === 'DONE' || statusType === 'CANCELLED' || statusType === 'NON_TASK'
	text: string; // Description with 11 signifiers + trailing ^block-id stripped; #tags and custom [key:: val] preserved
	cleanText: string; // Description with #tags and custom [key:: val] / (key:: val) also stripped
	priority: TaskPriority;
	priorityNumber: number; // 0 (highest) .. 5 (lowest), 3 = normal
	created: string | null; // YYYY-MM-DD
	start: string | null; // YYYY-MM-DD
	scheduled: string | null; // YYYY-MM-DD
	due: string | null; // YYYY-MM-DD
	completion: string | null; // YYYY-MM-DD
	cancelled: string | null; // YYYY-MM-DD
	repeat: string | null;
	onCompletion: string | null;
	id: string | null;
	dependsOn: string[];
	tags: string[]; // Authored-case, '#'-stripped, deduplicated tags on the task line
	blockId: string | null; // Trailing ^block-id without leading '^'
	parentLine: number | null; // 1-based line number of parent list item, or null
	format: TaskSignifierFormat; // Signifier syntax attribution on this task line
	properties: Record<string, unknown>; // Null-prototype map of custom non-signifier [key:: val] / (key:: val) on this task line
	origin: string; // "[[NoteFullPath#^BlockId|NoteBasename]]" | "[[NoteFullPath#Heading|NoteBasename]]" | "[[NoteFullPath|NoteBasename]]"
}

/**
 * A single resolved backlink: a source note that links to the document it is attached to.
 */
export interface BacklinkRef {
	readonly path: string;
	readonly count: number;
}

export interface NormalizedDocument {
	/** Fingerprint of the `ResolvedEngineConfig` (`timeZone` + `propertyTypes`) used to normalize this document */
	normalizationFingerprint: string;
	file: NormalizedFileInfo;
	aliases: string[]; // Authored-case, deduplicated aliases in first-seen order across all occurrences
	aliasLocations: NormalizedAliasLocation[]; // Full occurrence stream preserving authored casing, duplicates, and order (frontmatter -> inline)
	tags: string[]; // Authored-case, '#'-stripped, deduplicated, sorted set of tags across all occurrences
	tagLocations: NormalizedTagLocation[]; // Full occurrence stream preserving authored casing, duplicates, and order (frontmatter -> inline)
	cssclasses: string[];
	headings: NormalizedHeading[];
	links: NormalizedLink[]; // Outgoing links (frontmatterLinks + inline links, excluding embeds)
	embeds: NormalizedLink[]; // Outgoing embeds
	blocks: NormalizedBlock[];
	tasks: NormalizedTask[]; // Tasks extracted from the note body in line order
	propertyOccurrences: PropertyOccurrence[]; // Cache-level occurrence stream
	propertyKeys: string[]; // Exact first-seen order of trimmed authored property keys
	properties: Record<string, unknown>; // Null-prototype O(1) lookup map with authored keys and Collision Resolution Rule
	propertyLocations: NormalizedPropertyLocation[]; // Full occurrence stream of non-omitted properties with origin
	diagnostics: DocumentDiagnostic[]; // Non-fatal document property diagnostics
	/** Resolved backlinks attached downstream by the adapter; optional for pure test fixtures. */
	backlinks?: readonly BacklinkRef[];
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
	| MatchAllNode
	| LogicalNode
	| NotNode
	| ScopedFilterNode
	| ScopeGraphFilterNode
	| PropertyFilterNode
	| PropertyGraphFilterNode;

export interface MatchAllNode {
	readonly type: 'MATCH_ALL';
}

export interface LogicalNode {
	readonly type: 'LOGICAL';
	readonly operator: 'AND' | 'OR';
	readonly implicit?: boolean;
	readonly parenthesized?: boolean;
	readonly children: readonly SearchAST[];
	readonly span?: SourceSpan;
}

export interface NotNode {
	readonly type: 'NOT';
	readonly syntax: 'NOT' | '!';
	readonly child: SearchAST;
	readonly span?: SourceSpan;
}

export type LeafMatcher =
	| { readonly kind: 'string'; readonly value: string; readonly quoted: boolean }
	| { readonly kind: 'regex'; readonly pattern: string; readonly flags: string }
	| { readonly kind: 'this'; readonly raw: string; readonly segments: readonly string[] }
	| {
			readonly kind: 'query';
			readonly raw: string;
			readonly queryName: string;
			readonly segments: readonly string[];
	  };

export type ValueExprAST =
	| {
			readonly type: 'VALUE_LOGICAL';
			readonly operator: 'AND' | 'OR';
			readonly implicit?: boolean;
			readonly children: readonly ValueExprAST[];
			readonly span?: SourceSpan;
	  }
	| {
			readonly type: 'VALUE_NOT';
			readonly syntax: 'NOT' | '!';
			readonly child: ValueExprAST;
			readonly span?: SourceSpan;
	  }
	| { readonly type: 'VALUE_LEAF'; readonly matcher: LeafMatcher; readonly span?: SourceSpan };

export type ScopeOperator = ':' | '=' | '!=' | '<' | '>' | '<=' | '>=';

export interface ScopedFilterNode {
	readonly type: 'SCOPED_FILTER';
	readonly scope: string; // Trimmed canonicalName from ResolvedEngineConfig
	readonly rawScope: string; // Authored scope token text, or '#' when lowered from TagShorthand
	readonly operator?: ScopeOperator;
	readonly expr: ValueExprAST;
	readonly span?: SourceSpan;
}

export type GraphScopeName = 'links' | 'embeds' | 'backlinks';

export type GraphDirection = 'outgoing' | 'incoming';

export interface HopBounds {
	readonly minHops: number;
	readonly maxHops: number;
	readonly unbounded: boolean;
	readonly raw: string;
}

export type GraphTargetAST =
	| { readonly kind: 'subquery'; readonly ast: SearchAST; readonly span?: SourceSpan }
	| {
			readonly kind: 'query_ref';
			readonly raw: string;
			readonly queryName: string;
			readonly span?: SourceSpan;
	  }
	| { readonly kind: 'this_ref'; readonly raw: string; readonly span?: SourceSpan };

export interface ScopeGraphFilterNode {
	readonly type: 'SCOPE_GRAPH_FILTER';
	readonly scope: string;
	readonly rawScope: string;
	readonly direction: GraphDirection;
	readonly hops: HopBounds;
	readonly target: GraphTargetAST;
	readonly span?: SourceSpan;
}

export type PropertyOperator = 'EXISTS' | 'EMPTY' | ':' | '=' | '!=' | '<' | '>' | '<=' | '>=';

export interface PropertyFilterNode {
	readonly type: 'PROPERTY_FILTER';
	readonly key: string; // Decoded, trimmed, lowercased property key
	readonly rawKey: string; // Decoded property key (with outer quotes stripped if quoted)
	readonly operator: PropertyOperator;
	readonly valueExpr?: ValueExprAST; // Present iff operator !== 'EXISTS' && operator !== 'EMPTY'
	readonly span?: SourceSpan;
}

export interface PropertyGraphFilterNode {
	readonly type: 'PROPERTY_GRAPH_FILTER';
	readonly key: string; // Decoded, trimmed, lowercased property key
	readonly rawKey: string; // Decoded property key (with outer quotes stripped if quoted)
	readonly direction: GraphDirection;
	readonly hops: HopBounds;
	readonly target: GraphTargetAST;
	readonly span?: SourceSpan;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'hint';

export type DiagnosticCode =
	| 'SYNTAX_ERROR'
	| 'ERROR_INVALID_CONFIG'
	| 'ERROR_UNKNOWN_SCOPE'
	| 'ERROR_UNKNOWN_QUERY_REF'
	| 'ERROR_CIRCULAR_QUERY_REF'
	| 'ERROR_TYPE_MISMATCH'
	| 'ERROR_INVALID_OPERATOR_FOR_TYPE'
	| 'WARN_SINGLE_VALUE_CONTRADICTION'
	| 'WARN_MISSING_THIS_VALUE'
	| 'WARN_THIS_TYPE_MISMATCH'
	| 'HINT_PROP_NEQ_EXISTENCE'
	| 'HINT_PROPERTY_MATCHES_SCOPE'
	| 'HINT_AMBIGUOUS_PRECEDENCE'
	| 'HINT_WIKILINK_BRACKETS_IN_SCOPE'
	| 'HINT_UNCLOSED_REGEX';

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
/**
 * Per-pass evaluation context supplied by the adapter.
 *
 * @remarks
 * (design, 2026-11-18) Cached documents never carry backlinks, so evaluation reads a document's
 * backlinks through this context instead of from `doc.backlinks`. The accessor is lazy and
 * memoized by the adapter, so a pass that never references `backlinks:` never projects anything.
 */
export interface DocumentEvaluationContext {
	readonly backlinks: () => readonly BacklinkRef[];
	readonly graphContext?: unknown;
}

export interface ScopeDefinition {
	readonly canonicalName: string;
	readonly aliases: readonly string[];
	readonly extract: (
		doc: NormalizedDocument,
		ctx?: DocumentEvaluationContext,
	) => readonly string[];
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
	readonly hostDoc?: NormalizedDocument | null | undefined;
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
