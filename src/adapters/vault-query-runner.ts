import type { App } from 'obsidian';
import {
	compileQuery,
	evaluateDoc,
	explainQuery,
	FORBIDDEN_KEYS,
	getExecutionPlan,
	hasInternalRhizomeFlag,
	initEngineConfig,
	INTERNAL_RHIZOME_CODES,
	type NormalizedDocument,
	type NormalizedFileInfo,
	type NormalizedHeading,
	type NormalizedLink,
	type NormalizedTagLocation,
	normalizeObsidianMetadata,
	type PreparedQuery,
	type PropertyTypeRegistry,
	type ResolveLinkPathFn,
} from '@core/search';
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
	readonly tags: string[];
	readonly tagLocations: NormalizedTagLocation[];
	readonly headings: NormalizedHeading[];
	readonly links: NormalizedLink[];
	readonly embeds: NormalizedLink[];
	readonly blocks: string[];
	readonly properties: Record<string, unknown>;
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

	const results: VaultQueryResult = {};
	const executableQueries: Array<{
		name: string;
		prepared: PreparedQuery;
		bucket: VaultQueryMatch[];
	}> = [];

	for (const [name, rawInput] of sanitizedEntries) {
		const compileResult = compileQuery(rawInput, configResult.config, rawRefTimeMs);
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

	const resolveLinkPath: ResolveLinkPathFn = (rawTarget, sourcePath) =>
		app.metadataCache.getFirstLinkpathDest(rawTarget, sourcePath)?.path ?? null;

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
			doc = normalizeObsidianMetadata(file, cache, configResult.config, [], resolveLinkPath);
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

	const markdown = explainQuery(
		input,
		{ timeZone, propertyTypes: mergedTypes },
		referenceTimeMs,
		options?.heading,
	);

	logger?.log('debug', 'Generated query explanation', {
		source: 'query.explain',
		query: markSensitive(input),
		durationMs: Math.max(0, Date.now() - startedAt),
	});

	return markdown;
}
