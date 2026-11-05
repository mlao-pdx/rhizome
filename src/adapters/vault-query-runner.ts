import { type App, normalizePath } from 'obsidian';
import {
	compileQuery,
	explainQuery,
	evaluateDoc,
	FORBIDDEN_KEYS,
	getExecutionPlan,
	hasInternalRhizomeFlag,
	initEngineConfig,
	INTERNAL_RHIZOME_CODES,
	type NormalizedAliasLocation,
	type NormalizedDocument,
	type NormalizedFileInfo,
	type NormalizedHeading,
	type NormalizedLink,
	type NormalizedPropertyLocation,
	type NormalizedTagLocation,
	normalizeObsidianMetadata,
	type PreparedQuery,
	type PropertyTypeRegistry,
	type ResolvedEngineConfig,
	type ResolveLinkPathFn,
} from '@core/search';
import { HOST_QUERY_KEY } from '@core/templates';
import type { LoggerPort } from '@ports/logger-port';
import { markSensitive } from './logger-format';
import {
	loadVaultPropertyTypes,
	logEngineConfigFailure,
	logQueryCompilation,
	parseObsidianTypesJson,
	QueriedPropertyDiagnosticsAggregator,
} from './vault-query-logging';

export { parseObsidianTypesJson };

/**
 * Options for running or explaining a vault query.
 */
export interface VaultQueryOptions {
	/** Optional IANA timezone override (defaults to system timezone, falling back to 'UTC'). */
	readonly timeZone?: string | undefined;
	/** Optional property-type overrides merged on top of `.obsidian/types.json`. */
	readonly propertyTypes?: PropertyTypeRegistry | undefined;
	/** Optional reference timestamp in UTC epoch ms for `@` relative date anchors (defaults to `Date.now()`). */
	readonly referenceTimeMs?: number | undefined;
	/** Optional alternate level-1 Markdown heading for `explainQuery` / `explainVaultQuery` (defaults to `'Query Explain Plan'`). */
	readonly heading?: string | undefined;
	/** Optional AbortSignal to unregister a reactive `onUpdate` callback when the caller unloads. */
	readonly signal?: AbortSignal | undefined;
	/**
	 * Optional callback invoked by `ActiveQueryRoster.resetAll()` when a template, partial,
	 * layout, or template folder setting changes, forcing the subscriber to re-run Pass 1.
	 */
	readonly onReset?: (() => void) | undefined;
	/**
	 * Optional vault-relative path of the hosting Markdown note for O(1) `@this.*` and `this.*`
	 * resolution prior to query compilation.
	 */
	readonly sourcePath?: string | undefined;
	/**
	 * Optional pre-normalized hosting note document (takes precedence over `sourcePath` when provided).
	 */
	readonly hostDoc?: NormalizedDocument | null | undefined;
	/**
	 * Optional per-query host document map used by `ActiveQueryRoster` when batching `@this.*`
	 * queries across multiple open notes in a single vault scan.
	 */
	readonly queryHostDocs?:
		Readonly<Record<string, NormalizedDocument | null | undefined>> | undefined;
	/**
	 * Optional callback invoked by `ActiveQueryRoster.handleFileRename()` when the hosting note
	 * at `sourcePath` is renamed.
	 */
	readonly onSourcePathRename?: ((newPath: string) => void) | undefined;
	/**
	 * Optional pre-resolved engine configuration to avoid redundant `.obsidian/types.json` reads
	 * when `ActiveQueryRoster` has already resolved the group's configuration.
	 */
	readonly resolvedConfig?: ResolvedEngineConfig | undefined;
}

/**
 * Callback invoked by `ActiveQueryRoster` when a reactive query's matched payload changes.
 */
export type VaultQueryCallback = (result: VaultQueryResult) => void | Promise<void>;

/**
 * User-facing matched note metadata returned in `VaultQueryResult`.
 */
export interface VaultQueryMatch {
	readonly file: NormalizedFileInfo;
	readonly aliases: string[];
	readonly aliasLocations: NormalizedAliasLocation[];
	readonly tags: string[];
	readonly tagLocations: NormalizedTagLocation[];
	readonly headings: NormalizedHeading[];
	readonly links: NormalizedLink[];
	readonly embeds: NormalizedLink[];
	readonly blocks: string[];
	readonly properties: Record<string, unknown>;
	readonly propertyLocations: NormalizedPropertyLocation[];
}

/**
 * Result returned by `runVaultQuery` and `plugin.query`, mapping each executable query name
 * to its matched Markdown notes in vault evaluation order.
 * Queries that fail compilation (or runs where engine configuration fails) are omitted.
 */
export type VaultQueryResult = Record<string, VaultQueryMatch[]>;

/**
 * Projects a `NormalizedDocument` into a user-facing `VaultQueryMatch` POJO.
 */
export function toVaultQueryMatch(doc: NormalizedDocument): VaultQueryMatch {
	return {
		file: doc.file,
		aliases: doc.aliases,
		aliasLocations: doc.aliasLocations,
		tags: doc.tags,
		tagLocations: doc.tagLocations,
		headings: doc.headings,
		links: doc.links,
		embeds: doc.embeds,
		blocks: doc.blocks,
		properties: doc.properties,
		propertyLocations: doc.propertyLocations,
	};
}

/**
 * Resolves the host's default IANA timezone identifier, falling back to `'UTC'`.
 */
export function resolveDefaultTimeZone(): string {
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

/**
 * Sanitizes an unknown query map into safe `[name, rawQuery]` pairs, filtering out
 * prototype-pollution keys.
 */
export function sanitizeQueryEntries(queries: unknown): Array<[string, string]> {
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
 * Resolves and normalizes a hosting Markdown note in O(1) time via `vault.getFileByPath`
 * (with fallback to `vault.getMarkdownFiles().find`).
 * Returns `undefined` when `sourcePath` is `undefined`, or `null` when the note is missing,
 * deleted, or marked with `DO_NOT_INDEX_OR_QUERY`.
 */
export function resolveHostDocument(
	app: App,
	sourcePath: string | undefined,
	config: ResolvedEngineConfig,
	resolveLinkPath?: ResolveLinkPathFn,
	logger?: LoggerPort,
): NormalizedDocument | null | undefined {
	if (sourcePath === undefined) {
		return undefined;
	}
	if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
		return null;
	}
	const normalized = normalizePath(sourcePath);
	const vaultWithLookup = app.vault as {
		getFileByPath?: (
			path: string,
		) => ReturnType<typeof app.vault.getMarkdownFiles>[number] | null;
	};
	const file =
		typeof vaultWithLookup.getFileByPath === 'function'
			? (vaultWithLookup.getFileByPath(normalized) ??
				app.vault
					.getMarkdownFiles()
					.find((f) => f.path === normalized || f.path === sourcePath))
			: app.vault
					.getMarkdownFiles()
					.find((f) => f.path === normalized || f.path === sourcePath);
	if (!file || (file as { deleted?: boolean }).deleted) {
		return null;
	}
	const cache = app.metadataCache.getFileCache(file);
	if (hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY)) {
		return null;
	}
	const effectiveResolveLinkPath: ResolveLinkPathFn =
		resolveLinkPath ??
		((rawTarget, linkSourcePath) =>
			app.metadataCache.getFirstLinkpathDest?.(rawTarget, linkSourcePath)?.path ?? null);
	try {
		return normalizeObsidianMetadata(file, cache, config, [], effectiveResolveLinkPath);
	} catch (error) {
		logger?.log('error', `Failed to normalize host note ${markSensitive(file.path)}`, {
			source: 'query.run',
			error: String(error),
		});
		return null;
	}
}

/**
 * Loads `.obsidian/types.json`, merges `propertyTypes` overrides, and initializes a
 * `ResolvedEngineConfig` for query compilation or host-note normalization.
 */
export async function resolveGroupEngineConfig(
	app: App,
	timeZone?: string,
	propertyTypes?: PropertyTypeRegistry,
	logger?: LoggerPort,
): Promise<ResolvedEngineConfig | null> {
	const resolvedTz = timeZone !== undefined ? timeZone : resolveDefaultTimeZone();
	const vaultTypes = await loadVaultPropertyTypes(app, logger);
	const mergedTypes = mergePropertyTypes(vaultTypes, propertyTypes);
	const configResult = initEngineConfig({
		timeZone: resolvedTz,
		propertyTypes: mergedTypes,
	});
	if (!configResult.ok) {
		logEngineConfigFailure(logger, resolvedTz, configResult.diagnostics);
		return null;
	}
	return configResult.config;
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

	let resolvedConfig: ResolvedEngineConfig;
	if (options?.resolvedConfig) {
		resolvedConfig = options.resolvedConfig;
	} else {
		const vaultTypes = await loadVaultPropertyTypes(app, logger);
		const mergedTypes = mergePropertyTypes(vaultTypes, options?.propertyTypes);

		const configResult = initEngineConfig({
			timeZone,
			propertyTypes: mergedTypes,
		});
		if (!configResult.ok) {
			logEngineConfigFailure(logger, timeZone, configResult.diagnostics);
			return {};
		}
		resolvedConfig = configResult.config;
	}

	const resolveLinkPath: ResolveLinkPathFn = (rawTarget, sourcePath) =>
		app.metadataCache.getFirstLinkpathDest(rawTarget, sourcePath)?.path ?? null;

	const hostDoc: NormalizedDocument | null | undefined =
		options?.hostDoc !== undefined
			? options.hostDoc
			: resolveHostDocument(
					app,
					options?.sourcePath,
					resolvedConfig,
					resolveLinkPath,
					logger,
				);

	const results: VaultQueryResult = {};
	const hasHostContext =
		options?.hostDoc !== undefined ||
		(typeof options?.sourcePath === 'string' && options.sourcePath.length > 0);
	if (hasHostContext) {
		results[HOST_QUERY_KEY] = hostDoc ? [toVaultQueryMatch(hostDoc)] : [];
	}

	const executableQueries: Array<{
		name: string;
		prepared: PreparedQuery;
		bucket: VaultQueryMatch[];
	}> = [];

	for (const [name, rawInput] of sanitizedEntries) {
		const queryHostDoc =
			options?.queryHostDocs &&
			Object.prototype.hasOwnProperty.call(options.queryHostDocs, name)
				? options.queryHostDocs[name]
				: hostDoc;
		const compileResult = compileQuery(rawInput, resolvedConfig, rawRefTimeMs, queryHostDoc);
		logQueryCompilation(logger, name, rawInput, compileResult);
		if (compileResult.executable && compileResult.prepared) {
			const bucket: VaultQueryMatch[] = [];
			results[name] = bucket;
			executableQueries.push({
				name,
				prepared: compileResult.prepared,
				bucket,
			});
		}
	}

	if (executableQueries.length === 0) {
		logger?.log('debug', 'Completed vault query run', {
			source: 'query.run',
			durationMs: Math.max(0, Date.now() - startedAt),
			count: 0,
			queryCount: sanitizedEntries.length,
			executableCount: 0,
			notesScanned: 0,
			uncachedNotes: 0,
			docDiagnosticCount: 0,
			matchCounts: {},
		});
		return results;
	}

	const queriedKeys = new Set<string>();
	for (const entry of executableQueries) {
		for (const key of getExecutionPlan(entry.prepared).queriedKeys) {
			queriedKeys.add(key);
		}
	}
	const propDiagnosticsAggregator = new QueriedPropertyDiagnosticsAggregator(queriedKeys);

	let notesScanned = 0;
	let uncachedNotes = 0;

	for (const file of app.vault.getMarkdownFiles()) {
		if ((file as { deleted?: boolean }).deleted) {
			continue;
		}
		const cache = app.metadataCache.getFileCache(file);
		if (
			hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY)
		) {
			continue;
		}
		notesScanned++;
		if (cache === null) {
			uncachedNotes++;
		}
		let doc: NormalizedDocument;
		try {
			doc = normalizeObsidianMetadata(file, cache, resolvedConfig, [], resolveLinkPath);
		} catch (error) {
			logger?.log('error', `Failed to normalize note ${markSensitive(file.path)}`, {
				source: 'query.run',
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
		matchCounts[markSensitive(entry.name)] = entry.bucket.length;
	}
	logger?.log('debug', 'Completed vault query run', {
		source: 'query.run',
		durationMs: Math.max(0, Date.now() - startedAt),
		count: notesScanned,
		queryCount: sanitizedEntries.length,
		executableCount: executableQueries.length,
		notesScanned,
		uncachedNotes,
		docDiagnosticCount: propDiagnosticsAggregator.diagnosticCount,
		matchCounts,
	});

	return results;
}

/**
 * Generates a progressive-shrinking Markdown explanation plan with inline footnotes and a
 * `## Concept Reference` section for a search query using the vault's `types.json` registry
 * without scanning or normalizing any vault notes.
 */
export async function explainVaultQuery(
	app: App,
	input: string = '',
	options?: VaultQueryOptions,
	logger?: LoggerPort,
): Promise<string> {
	const startedAt = Date.now();
	const timeZone = options?.timeZone !== undefined ? options.timeZone : resolveDefaultTimeZone();
	const referenceTimeMs = options?.referenceTimeMs ?? Date.now();
	const vaultTypes = await loadVaultPropertyTypes(app, logger);
	const mergedTypes = mergePropertyTypes(vaultTypes, options?.propertyTypes);

	let hostDoc: NormalizedDocument | null | undefined = options?.hostDoc;
	if (hostDoc === undefined && options?.sourcePath !== undefined) {
		const cfgRes = initEngineConfig({ timeZone, propertyTypes: mergedTypes });
		if (cfgRes.ok) {
			hostDoc = resolveHostDocument(
				app,
				options.sourcePath,
				cfgRes.config,
				undefined,
				logger,
			);
		}
	}

	const markdown = explainQuery(
		input,
		{ timeZone, propertyTypes: mergedTypes },
		referenceTimeMs,
		options?.heading,
		hostDoc,
	);

	logger?.log('debug', 'Generated query explanation', {
		source: 'query.explain',
		query: markSensitive(input),
		durationMs: Math.max(0, Date.now() - startedAt),
	});

	return markdown;
}
