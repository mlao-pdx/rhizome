import type { App } from 'obsidian';
import {
	compileQuery,
	type DocumentDiagnostic,
	evaluateDoc,
	evaluateVault,
	FORBIDDEN_KEYS,
	getExecutionPlan,
	initEngineConfig,
	isValidPropertyType,
	isValidReferenceTimeMs,
	type NormalizedDocument,
	type NormalizedFileInfo,
	type NormalizedHeading,
	type NormalizedLink,
	type NormalizedTagLocation,
	normalizeObsidianMetadata,
	type PreparedQuery,
	type PropertyTypeRegistry,
	type ResolveLinkPathFn,
	type SearchDiagnostic,
} from '@core/search';
import type { LoggerPort } from '@ports/logger-port';
import {
	loadVaultPropertyTypes,
	logEngineConfigFailure,
	logQueryCompilation,
	parseObsidianTypesJson,
	QueriedPropertyDiagnosticsAggregator,
} from './vault-query-logging';

export { parseObsidianTypesJson };

/**
 * Options for running or diagnosing a vault query.
 */
export interface VaultQueryOptions {
	/** Optional IANA timezone override (defaults to system timezone, falling back to 'UTC'). */
	readonly timeZone?: string | undefined;
	/** Optional property-type overrides merged on top of `.obsidian/types.json`. */
	readonly propertyTypes?: PropertyTypeRegistry | undefined;
	/** Optional reference timestamp in UTC epoch ms for `@` relative date anchors (defaults to `Date.now()`). */
	readonly referenceTimeMs?: number | undefined;
}

/**
 * Run-level environment context returned by `runVaultQuery` and `plugin.query`.
 */
export interface VaultQueryContext {
	/** Resolved IANA timezone used for query compilation and date coercion (trimmed). */
	readonly timeZone: string;
	/**
	 * Reference timestamp in UTC epoch ms for `@` relative date anchors,
	 * or `null` if an invalid `referenceTimeMs` override was supplied.
	 */
	readonly referenceTimeMs: number | null;
	/** Active normalized property-type registry (merged `.obsidian/types.json` and `options.propertyTypes`). */
	readonly propertyTypes: Readonly<PropertyTypeRegistry>;
	/**
	 * Canonical normalization fingerprint (`{"tz":...,"types":...}`) shared across all queries,
	 * or `null` if engine configuration failed.
	 */
	readonly normalizationFingerprint: string | null;
}

/**
 * Per-query compilation and lint diagnostics returned in `MultiQueryDiagnostics.queries`.
 */
export interface QueryDiagnostics {
	/** Whether the query compiled without errors and was evaluated against the vault. */
	readonly executable: boolean;
	/** Query lexer, parser, validator, config, and linter findings. */
	readonly findings: SearchDiagnostic[];
}

/**
 * Aggregate and per-query compilation and lint diagnostics returned by `runVaultQuery` and `plugin.query`.
 */
export interface MultiQueryDiagnostics {
	/** True iff engine config succeeded AND every query in `queries` has `executable === true`. */
	readonly executable: boolean;
	/** Engine/config-level findings (e.g. `ERROR_INVALID_CONFIG` for `timeZone` or `propertyTypes`). */
	readonly findings: SearchDiagnostic[];
	/** Per-query compilation and lint diagnostics keyed by query name. */
	readonly queries: Record<string, QueryDiagnostics>;
}

/**
 * User-facing matched note metadata returned in `VaultQueryResult.matches`.
 */
export interface VaultQueryMatch {
	readonly file: NormalizedFileInfo;
	readonly aliases: string[];
	readonly tags: string[];
	readonly tagLocations: NormalizedTagLocation[];
	readonly headings: NormalizedHeading[];
	readonly links: NormalizedLink[];
	readonly embeds: NormalizedLink[];
	readonly blocks: string[];
	readonly properties: Record<string, unknown>;
}

/**
 * Result returned by `runVaultQuery` and `plugin.query`.
 */
export interface VaultQueryResult {
	/** Run-level environment context (frozen, JSON-safe POJO). */
	readonly context: VaultQueryContext;
	/** Aggregate and per-query compilation and lint diagnostics. */
	readonly diagnostics: MultiQueryDiagnostics;
	/**
	 * Matched Markdown notes in vault evaluation order, keyed by query name.
	 * Queries that fail compilation are omitted from `matches`.
	 */
	readonly matches: Record<string, VaultQueryMatch[]>;
}

/**
 * Projects a `NormalizedDocument` into a user-facing `VaultQueryMatch` POJO.
 */
export function toVaultQueryMatch(doc: NormalizedDocument): VaultQueryMatch {
	return {
		file: doc.file,
		aliases: doc.aliases,
		tags: doc.tags,
		tagLocations: doc.tagLocations,
		headings: doc.headings,
		links: doc.links,
		embeds: doc.embeds,
		blocks: doc.blocks,
		properties: doc.properties,
	};
}

/**
 * Exhaustive query and document diagnostic result returned by `diagnoseVaultQuery` and `plugin.diagnoseQuery`.
 */
export interface DiagnoseVaultQueryResult {
	/** Whether the query compiled without errors and was evaluated against the vault. */
	readonly executable: boolean;
	/** Vault-relative paths of all matching Markdown notes, in vault evaluation order. */
	readonly paths: string[];
	/** Full normalized metadata (`NormalizedDocument`) for each matching Markdown note. */
	readonly matches: NormalizedDocument[];
	/** Query lexer, parser, validator, config, and linter diagnostics. */
	readonly diagnostics: SearchDiagnostic[];
	/** Document property diagnostics for non-virtual property keys referenced by the query. */
	readonly propertyDiagnostics: DocumentDiagnostic[];
}

function resolveDefaultTimeZone(): string {
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof tz === 'string' && tz.trim() ? tz.trim() : 'UTC';
	} catch {
		return 'UTC';
	}
}

function mergePropertyTypes(
	vaultTypes: PropertyTypeRegistry,
	overrides?: PropertyTypeRegistry,
): PropertyTypeRegistry {
	if (overrides === undefined || typeof overrides !== 'object' || overrides === null) {
		return vaultTypes;
	}

	const shadowedKeys = new Set<string>();
	for (const rawKey of Object.keys(overrides)) {
		const normalizedKey = rawKey.trim().toLowerCase();
		if (normalizedKey && !FORBIDDEN_KEYS.has(normalizedKey) && !FORBIDDEN_KEYS.has(rawKey)) {
			shadowedKeys.add(normalizedKey);
		}
	}

	const merged = Object.create(null) as PropertyTypeRegistry;
	for (const [key, val] of Object.entries(vaultTypes)) {
		if (!shadowedKeys.has(key.trim().toLowerCase())) {
			merged[key] = val;
		}
	}
	for (const [rawKey, val] of Object.entries(overrides)) {
		const normalizedKey = rawKey.trim().toLowerCase();
		if (FORBIDDEN_KEYS.has(rawKey) || FORBIDDEN_KEYS.has(normalizedKey)) {
			continue;
		}
		merged[rawKey] = val;
	}

	return merged;
}

function sanitizeFallbackPropertyTypes(
	rawTypes: PropertyTypeRegistry,
): Readonly<PropertyTypeRegistry> {
	const fallback = Object.create(null) as PropertyTypeRegistry;
	for (const [rawKey, propType] of Object.entries(rawTypes)) {
		const key = rawKey.trim().toLowerCase();
		if (!key || FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(rawKey)) {
			continue;
		}
		if (!isValidPropertyType(propType)) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(fallback, key)) {
			continue;
		}
		fallback[key] = propType;
	}
	return Object.freeze(fallback);
}

function sanitizeQueryEntries(queries: unknown): Array<[string, string]> {
	if (typeof queries !== 'object' || queries === null || Array.isArray(queries)) {
		return [];
	}
	const entries: Array<[string, string]> = [];
	for (const [name, rawInput] of Object.entries(queries as Record<string, unknown>)) {
		if (FORBIDDEN_KEYS.has(name) || FORBIDDEN_KEYS.has(name.trim().toLowerCase())) {
			continue;
		}
		entries.push([name, typeof rawInput === 'string' ? rawInput : '']);
	}
	return entries;
}

/**
 * Compiles a named map of search queries against a shared config and reference timestamp,
 * and evaluates all executable queries in a single streaming pass over the vault.
 */
export async function runVaultQuery(
	app: App,
	queries: Readonly<Record<string, string>> = {},
	options?: VaultQueryOptions,
	logger?: LoggerPort,
): Promise<VaultQueryResult> {
	const startedAt = Date.now();
	const sanitizedEntries = sanitizeQueryEntries(queries);
	const timeZone = options?.timeZone !== undefined ? options.timeZone : resolveDefaultTimeZone();
	const rawRefTimeMs = options?.referenceTimeMs ?? Date.now();
	const validRefTimeMs = isValidReferenceTimeMs(rawRefTimeMs) ? rawRefTimeMs : null;

	const vaultTypes = await loadVaultPropertyTypes(app, logger);
	const mergedTypes = mergePropertyTypes(vaultTypes, options?.propertyTypes);

	const configResult = initEngineConfig({
		timeZone,
		propertyTypes: mergedTypes,
	});
	if (!configResult.ok) {
		logEngineConfigFailure(logger, timeZone, configResult.diagnostics);
		const context: VaultQueryContext = Object.freeze({
			timeZone: typeof timeZone === 'string' ? timeZone.trim() : '',
			referenceTimeMs: validRefTimeMs,
			propertyTypes: sanitizeFallbackPropertyTypes(mergedTypes),
			normalizationFingerprint: null,
		});
		const queryDiagnosticsMap: Record<string, QueryDiagnostics> = {};
		for (const [name] of sanitizedEntries) {
			queryDiagnosticsMap[name] = {
				executable: false,
				findings: [],
			};
		}
		return {
			context,
			diagnostics: {
				executable: false,
				findings: [...configResult.diagnostics],
				queries: queryDiagnosticsMap,
			},
			matches: {},
		};
	}

	const context: VaultQueryContext = Object.freeze({
		timeZone: configResult.config.timeZone,
		referenceTimeMs: validRefTimeMs,
		propertyTypes: configResult.config.propertyTypes,
		normalizationFingerprint: configResult.config.normalizationFingerprint,
	});

	const queryDiagnosticsMap: Record<string, QueryDiagnostics> = {};
	const matches: Record<string, VaultQueryMatch[]> = {};
	const executableQueries: Array<{
		name: string;
		prepared: PreparedQuery;
		bucket: VaultQueryMatch[];
	}> = [];
	let allQueriesExecutable = true;

	for (const [name, rawInput] of sanitizedEntries) {
		const compileResult = compileQuery(rawInput, configResult.config, rawRefTimeMs);
		logQueryCompilation(logger, name, rawInput, compileResult);
		queryDiagnosticsMap[name] = {
			executable: compileResult.executable,
			findings: compileResult.diagnostics,
		};
		if (compileResult.executable && compileResult.prepared) {
			const bucket: VaultQueryMatch[] = [];
			matches[name] = bucket;
			executableQueries.push({
				name,
				prepared: compileResult.prepared,
				bucket,
			});
		} else {
			allQueriesExecutable = false;
		}
	}

	const diagnostics: MultiQueryDiagnostics = {
		executable: allQueriesExecutable,
		findings: [],
		queries: queryDiagnosticsMap,
	};

	if (executableQueries.length === 0) {
		logger?.log('debug', 'Completed vault query run', {
			durationMs: Math.max(0, Date.now() - startedAt),
			queryCount: sanitizedEntries.length,
			executableCount: 0,
			notesScanned: 0,
			uncachedNotes: 0,
			docDiagnosticCount: 0,
			matchCounts: {},
		});
		return {
			context,
			diagnostics,
			matches,
		};
	}

	const queriedKeys = new Set<string>();
	for (const entry of executableQueries) {
		for (const key of getExecutionPlan(entry.prepared).queriedKeys) {
			queriedKeys.add(key);
		}
	}
	const propDiagnosticsAggregator = new QueriedPropertyDiagnosticsAggregator(queriedKeys);

	const resolveLinkPath: ResolveLinkPathFn = (rawTarget, sourcePath) =>
		app.metadataCache.getFirstLinkpathDest(rawTarget, sourcePath)?.path ?? null;

	let notesScanned = 0;
	let uncachedNotes = 0;

	for (const file of app.vault.getMarkdownFiles()) {
		if ((file as { deleted?: boolean }).deleted) {
			continue;
		}
		notesScanned++;
		const cache = app.metadataCache.getFileCache(file);
		if (cache === null) {
			uncachedNotes++;
		}
		let doc: NormalizedDocument;
		try {
			doc = normalizeObsidianMetadata(file, cache, configResult.config, [], resolveLinkPath);
		} catch (error) {
			logger?.log('error', `Failed to normalize note «${file.path}»`, {
				error: String(error),
			});
			throw error;
		}
		propDiagnosticsAggregator.recordNote(file.path, doc.diagnostics);

		let sharedMatch: VaultQueryMatch | undefined;
		for (const entry of executableQueries) {
			if (evaluateDoc(doc, entry.prepared)) {
				sharedMatch ??= toVaultQueryMatch(doc);
				entry.bucket.push(sharedMatch);
			}
		}
	}

	propDiagnosticsAggregator.flush(logger);

	const matchCounts: Record<string, number> = {};
	for (const entry of executableQueries) {
		matchCounts[`«${entry.name}»`] = entry.bucket.length;
	}
	logger?.log('debug', 'Completed vault query run', {
		durationMs: Math.max(0, Date.now() - startedAt),
		queryCount: sanitizedEntries.length,
		executableCount: executableQueries.length,
		notesScanned,
		uncachedNotes,
		docDiagnosticCount: propDiagnosticsAggregator.diagnosticCount,
		matchCounts,
	});

	return {
		context,
		diagnostics,
		matches,
	};
}

/**
 * Compiles a search query, evaluates it against the vault, and returns exhaustive query and document property diagnostics.
 */
export async function diagnoseVaultQuery(
	app: App,
	input: string = '',
	options?: VaultQueryOptions,
	logger?: LoggerPort,
): Promise<DiagnoseVaultQueryResult> {
	const startedAt = Date.now();
	const timeZone = options?.timeZone !== undefined ? options.timeZone : resolveDefaultTimeZone();
	const vaultTypes = await loadVaultPropertyTypes(app, logger);
	const mergedTypes = mergePropertyTypes(vaultTypes, options?.propertyTypes);

	const configResult = initEngineConfig({
		timeZone,
		propertyTypes: mergedTypes,
	});
	if (!configResult.ok) {
		logEngineConfigFailure(logger, timeZone, configResult.diagnostics);
		return {
			executable: false,
			paths: [],
			matches: [],
			diagnostics: [...configResult.diagnostics],
			propertyDiagnostics: [],
		};
	}

	const referenceTimeMs = options?.referenceTimeMs ?? Date.now();
	const compileResult = compileQuery(input, configResult.config, referenceTimeMs);
	logQueryCompilation(logger, 'diagnose', input, compileResult);
	if (!compileResult.executable || !compileResult.prepared) {
		return {
			executable: false,
			paths: [],
			matches: [],
			diagnostics: compileResult.diagnostics,
			propertyDiagnostics: [],
		};
	}

	const resolveLinkPath: ResolveLinkPathFn = (rawTarget, sourcePath) =>
		app.metadataCache.getFirstLinkpathDest(rawTarget, sourcePath)?.path ?? null;

	const docs: NormalizedDocument[] = [];
	let notesScanned = 0;
	let uncachedNotes = 0;

	for (const file of app.vault.getMarkdownFiles()) {
		if ((file as { deleted?: boolean }).deleted) {
			continue;
		}
		notesScanned++;
		const cache = app.metadataCache.getFileCache(file);
		if (cache === null) {
			uncachedNotes++;
		}
		try {
			docs.push(
				normalizeObsidianMetadata(file, cache, configResult.config, [], resolveLinkPath),
			);
		} catch (error) {
			logger?.log('error', `Failed to normalize note «${file.path}»`, {
				error: String(error),
			});
			throw error;
		}
	}

	const report = evaluateVault(docs, compileResult.prepared);

	logger?.log('debug', 'Completed diagnoseVaultQuery', {
		durationMs: Math.max(0, Date.now() - startedAt),
		queryCount: 1,
		executableCount: 1,
		notesScanned,
		uncachedNotes,
		docDiagnosticCount: report.propertyDiagnostics.length,
		matchCounts: { '«diagnose»': report.matches.length },
	});

	return {
		executable: true,
		paths: report.matches.map((doc) => doc.file.path),
		matches: report.matches,
		diagnostics: compileResult.diagnostics,
		propertyDiagnostics: report.propertyDiagnostics,
	};
}
