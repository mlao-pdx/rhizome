import { type App, normalizePath, type TFile } from 'obsidian';
import { deepFreeze } from '@core/cache/deep-freeze';
import {
	compileQuery,
	explainQuery,
	evaluateDoc,
	FORBIDDEN_KEYS,
	getExecutionPlan,
	hasInternalRhizomeFlag,
	initEngineConfig,
	INTERNAL_RHIZOME_CODES,
	type BacklinkRef,
	type DocumentEvaluationContext,
	type NormalizedAliasLocation,
	type NormalizedBlock,
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
import {
	attachBacklinks,
	copyWithBacklinks,
	projectBacklinks,
	type BacklinkIndex,
	type BacklinkSnapshot,
} from './backlink-index';
import { markSensitive } from './logger-format';
import type { DocumentCacheStats, NormalizedDocumentCache } from './normalized-document-cache';
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
	 * Optional flag controlling whether `ActiveQueryRoster` includes `◊host` in its reactive
	 * payload hash for this subscriber. Defaults to `true` when `sourcePath` is present.
	 * Codeblocks that do not reference `this` or `@this` set this to `false` so editing the
	 * hosting note does not trigger a redundant reactive re-render.
	 */
	readonly includeHostInHash?: boolean | undefined;
	/**
	 * Optional initial or live heading level (or resolver) folded into `ActiveQueryRoster`'s
	 * payload hash so changes to the heading level above a mounted codeblock trigger `onUpdate`.
	 */
	readonly headingLevel?: number | (() => number) | undefined;
	/**
	 * Optional pre-resolved engine configuration to avoid redundant `.obsidian/types.json` reads
	 * when `ActiveQueryRoster` has already resolved the group's configuration.
	 */
	readonly resolvedConfig?: ResolvedEngineConfig | undefined;
	/**
	 * Optional backlink snapshot used to attach resolved backlinks to every scanned and host
	 * document in the pass. Omitted in pure/offline runs that do not need backlink data.
	 */
	readonly backlinks?: BacklinkSnapshot | undefined;
	/**
	 * Optional predicate marking vault files as excluded from backlink projection (for example
	 * `◊InternalRhizome 001` notes). Defaults to the internal-flag check.
	 */
	readonly isIgnoredFile?: ((file: TFile) => boolean) | undefined;
	/**
	 * Optional normalized-document cache. When present, the pass reconciles the cache and iterates
	 * its entries instead of normalizing every note inline.
	 */
	readonly cache?: NormalizedDocumentCache | undefined;
	/**
	 * Optional backlink index reconciled before projection when `backlinks` is not already supplied.
	 */
	readonly backlinkIndex?: BacklinkIndex | undefined;
	/**
	 * Optional reconciliation stats supplied when a pass coordinator (`ActiveQueryRoster`) has
	 * already reconciled `cache` for this pass.
	 */
	readonly reconciledStats?: DocumentCacheStats | undefined;
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
	readonly cssclasses: string[];
	readonly headings: NormalizedHeading[];
	readonly links: NormalizedLink[];
	readonly embeds: NormalizedLink[];
	readonly blocks: NormalizedBlock[];
	readonly properties: Record<string, unknown>;
	readonly propertyLocations: NormalizedPropertyLocation[];
	readonly backlinks: readonly BacklinkRef[];
}

/**
 * Result returned by `runVaultQuery` and `plugin.query`, mapping each executable query name
 * to its matched Markdown notes in vault evaluation order.
 * Queries that fail compilation (or runs where engine configuration fails) are omitted.
 */
export type VaultQueryResult = Record<string, VaultQueryMatch[]>;

/**
 * Projects a `NormalizedDocument` into a user-facing `VaultQueryMatch` POJO.
 *
 * @remarks
 * (design, 2026-11-18) Cached documents never carry backlinks and are frozen, so projection
 * always builds a fresh frozen wrapper. Backlinks are supplied by the caller from the pass's
 * snapshot; when omitted, a document's own attached backlinks are used (the direct-normalize
 * test oracle path). Only the wrapper and the backlinks array need freezing: every other field
 * is already a deep-frozen cache subtree (the oracle path freezes its document once before
 * projection).
 */
export function toVaultQueryMatch(
	doc: NormalizedDocument,
	backlinks?: readonly BacklinkRef[],
): VaultQueryMatch {
	if (!Object.isFrozen(doc)) {
		deepFreeze(doc);
	}
	const projectedBacklinks = backlinks ?? doc.backlinks ?? [];
	deepFreeze(projectedBacklinks);
	return Object.freeze({
		file: doc.file,
		aliases: doc.aliases,
		aliasLocations: doc.aliasLocations,
		tags: doc.tags,
		tagLocations: doc.tagLocations,
		cssclasses: doc.cssclasses,
		headings: doc.headings,
		links: doc.links,
		embeds: doc.embeds,
		blocks: doc.blocks,
		properties: doc.properties,
		propertyLocations: doc.propertyLocations,
		backlinks: projectedBacklinks,
	});
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
 * Builds a lazy, memoized per-document evaluation context over a pass's backlink snapshot.
 *
 * @remarks
 * (design, 2026-11-18) `backlinks:` is evaluated before projection, so cached documents (which
 * never carry backlinks) need the projection result during evaluation. The accessor projects at
 * most once per document and only when a query actually reads it, and the same array is reused
 * for the projected match payload.
 */
function createBacklinkContext(
	snapshot: BacklinkSnapshot | undefined,
	file: TFile,
	isIgnored: (file: TFile) => boolean,
): DocumentEvaluationContext | undefined {
	if (snapshot === undefined) {
		return undefined;
	}
	let projected: readonly BacklinkRef[] | undefined;
	return {
		backlinks: () => {
			projected ??= projectBacklinks(snapshot, file, isIgnored);
			return projected;
		},
	};
}

function defaultIsIgnoredFile(app: App, file: TFile): boolean {
	return hasInternalRhizomeFlag(
		app.metadataCache.getFileCache(file)?.frontmatter,
		INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
	);
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
	backlinks?: BacklinkSnapshot,
	isIgnoredFile?: (file: TFile) => boolean,
	cache?: NormalizedDocumentCache,
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
	const cacheInput = app.metadataCache.getFileCache(file);
	if (
		hasInternalRhizomeFlag(
			cacheInput?.frontmatter,
			INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
		)
	) {
		// Evict any previously cached entry when a host note gains DO_NOT_INDEX_OR_QUERY.
		cache?.delete(file.path);
		return null;
	}
	const effectiveResolveLinkPath: ResolveLinkPathFn =
		resolveLinkPath ??
		((rawTarget, linkSourcePath) =>
			app.metadataCache.getFirstLinkpathDest?.(rawTarget, linkSourcePath)?.path ?? null);
	const shouldIgnore =
		isIgnoredFile ?? ((fileToCheck: TFile) => defaultIsIgnoredFile(app, fileToCheck));
	if (cache !== undefined) {
		const doc = cache.ensureFresh(file, config, effectiveResolveLinkPath);
		if (doc === null) {
			return null;
		}
		return backlinks !== undefined
			? copyWithBacklinks(doc, backlinks, file, shouldIgnore)
			: doc;
	}
	try {
		const doc = normalizeObsidianMetadata(
			file,
			cacheInput,
			config,
			[],
			effectiveResolveLinkPath,
		);
		if (backlinks !== undefined) {
			attachBacklinks(doc, backlinks, file, shouldIgnore);
		}
		return deepFreeze(doc);
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

interface PreparedVaultPass {
	readonly backlinks: BacklinkSnapshot | undefined;
	readonly stats: DocumentCacheStats | undefined;
}

function prepareVaultPass(
	cache: NormalizedDocumentCache | undefined,
	options: VaultQueryOptions | undefined,
	config: ResolvedEngineConfig,
	resolveLinkPath: ResolveLinkPathFn,
	files: readonly TFile[] | undefined,
): PreparedVaultPass {
	const stats =
		options?.reconciledStats !== undefined
			? options.reconciledStats
			: cache !== undefined && files !== undefined
				? cache.reconcile(files, config, resolveLinkPath).stats
				: undefined;
	let backlinks = options?.backlinks;
	const index = options?.backlinkIndex;
	if (backlinks === undefined && index !== undefined) {
		if (typeof index.reconcile === 'function') {
			index.reconcile();
		}
		backlinks = index.snapshot();
	}
	return { backlinks, stats };
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

	const isIgnoredFile =
		options?.isIgnoredFile ?? ((file: TFile) => defaultIsIgnoredFile(app, file));
	const cache = options?.cache;
	const reconcileStartedAt = Date.now();
	const vaultFiles = cache !== undefined ? app.vault.getMarkdownFiles() : undefined;
	const prepared = prepareVaultPass(cache, options, resolvedConfig, resolveLinkPath, vaultFiles);
	const reconcileMs = Math.max(0, Date.now() - reconcileStartedAt);
	const backlinks = prepared.backlinks;

	const hostDoc: NormalizedDocument | null | undefined =
		options?.hostDoc !== undefined
			? options.hostDoc
			: resolveHostDocument(
					app,
					options?.sourcePath,
					resolvedConfig,
					resolveLinkPath,
					logger,
					backlinks,
					isIgnoredFile,
					cache,
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
			reconcileMs,
			evaluateMs: 0,
			projectMs: 0,
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
	let uncachedNotes = prepared.stats?.uncached ?? 0;
	const scanStartedAt = Date.now();
	let projectMs = 0;

	if (cache !== undefined && vaultFiles !== undefined) {
		for (const file of vaultFiles) {
			const doc = cache.get(file.path);
			if (doc === undefined) {
				continue;
			}
			notesScanned++;
			propDiagnosticsAggregator.recordNote(file.path, doc.diagnostics);
			const ctx = createBacklinkContext(backlinks, file, isIgnoredFile);

			let sharedMatch: VaultQueryMatch | undefined;
			for (const entry of executableQueries) {
				if (evaluateDoc(doc, entry.prepared, ctx)) {
					if (sharedMatch === undefined) {
						const projectStartedAt = Date.now();
						sharedMatch = toVaultQueryMatch(doc, ctx?.backlinks());
						projectMs += Date.now() - projectStartedAt;
					}
					entry.bucket.push(sharedMatch);
				}
			}
		}
	} else {
		for (const file of app.vault.getMarkdownFiles()) {
			if ((file as { deleted?: boolean }).deleted) {
				continue;
			}
			const cacheEntry = app.metadataCache.getFileCache(file);
			if (
				hasInternalRhizomeFlag(
					cacheEntry?.frontmatter,
					INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
				)
			) {
				continue;
			}
			notesScanned++;
			if (cacheEntry === null) {
				uncachedNotes++;
			}
			let doc: NormalizedDocument;
			try {
				doc = normalizeObsidianMetadata(
					file,
					cacheEntry,
					resolvedConfig,
					[],
					resolveLinkPath,
				);
			} catch (error) {
				logger?.log(
					'warn',
					`Skipped note that failed normalization: ${markSensitive(file.path)}`,
					{
						source: 'query.run',
						error: String(error),
					},
				);
				continue;
			}
			deepFreeze(doc);
			const ctx = createBacklinkContext(backlinks, file, isIgnoredFile);
			propDiagnosticsAggregator.recordNote(file.path, doc.diagnostics);

			let sharedMatch: VaultQueryMatch | undefined;
			for (const entry of executableQueries) {
				if (evaluateDoc(doc, entry.prepared, ctx)) {
					if (sharedMatch === undefined) {
						const projectStartedAt = Date.now();
						sharedMatch = toVaultQueryMatch(doc, ctx?.backlinks());
						projectMs += Date.now() - projectStartedAt;
					}
					entry.bucket.push(sharedMatch);
				}
			}
		}
	}

	const scanMs = Math.max(0, Date.now() - scanStartedAt);
	const evaluateMs = Math.max(0, scanMs - projectMs);
	propDiagnosticsAggregator.flush(logger);

	const matchCounts: Record<string, number> = {};
	for (const entry of executableQueries) {
		matchCounts[markSensitive(entry.name)] = entry.bucket.length;
	}
	logger?.log('debug', 'Completed vault query run', {
		source: 'query.run',
		durationMs: Math.max(0, Date.now() - startedAt),
		reconcileMs,
		evaluateMs,
		projectMs,
		count: notesScanned,
		queryCount: sanitizedEntries.length,
		executableCount: executableQueries.length,
		notesScanned,
		uncachedNotes,
		docDiagnosticCount: propDiagnosticsAggregator.diagnosticCount,
		matchCounts,
		...(prepared.stats
			? {
					cacheAdd: prepared.stats.add,
					cacheUpdate: prepared.stats.update,
					cacheRemove: prepared.stats.remove,
					cacheHits: prepared.stats.hits,
					cacheStale: prepared.stats.stale,
				}
			: {}),
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
				options.backlinks,
				options.isIgnoredFile,
				options.cache,
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
