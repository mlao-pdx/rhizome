import { type App, normalizePath, type TFile } from 'obsidian';
import { deepFreeze } from '@core/cache/deep-freeze';
import {
	analyzeQueryDependencyDag,
	compileQuery,
	createGraphEvaluationContext,
	explainQuery,
	evaluateDoc,
	FORBIDDEN_KEYS,
	getExecutionPlan,
	hasInternalRhizomeFlag,
	initEngineConfig,
	INTERNAL_RHIZOME_CODES,
	type BacklinkRef,
	type CompileResult,
	type DocumentEvaluationContext,
	type NormalizedAliasLocation,
	type NormalizedBlock,
	type NormalizedDocument,
	type NormalizedFileInfo,
	type NormalizedHeading,
	type NormalizedLink,
	type NormalizedPropertyLocation,
	type NormalizedTagLocation,
	type NormalizedTask,
	normalizeObsidianMetadata,
	type PreparedQuery,
	type PropertyTypeRegistry,
	type QueryExplainCutoff,
	type ResolvedEngineConfig,
	type ResolveLinkPathFn,
	VaultGraphSnapshot,
} from '@core/search';
import { HOST_QUERY_KEY } from '@core/templates';
import type { LoggerPort } from '@ports/logger-port';
import {
	attachBacklinks,
	backlinkArraysEqual,
	copyWithBacklinks,
	isSnapshotSourcesUnchanged,
	projectBacklinks,
	projectBacklinksWithEntries,
	type BacklinkIndex,
	type BacklinkSnapshot,
	type CachedSnapshotSourceEntry,
} from './backlink-index';
import { createMemoizedLinkResolver } from './link-resolver-memo';
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
	/**
	 * Optional Pass 2 record cutoff metadata displayed in the `# Query Explain Plan` header
	 * when `explainVaultQuery` is invoked from a `{% query %}` template block.
	 */
	readonly cutoff?: QueryExplainCutoff | undefined;
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
	/**
	 * Optional pre-pass reconciliation duration in milliseconds supplied when a coordinator
	 * (`ActiveQueryRoster`) reconciled the backlink index and document cache before calling
	 * `runVaultQuery`.
	 */
	readonly reconcileDurationMs?: number | undefined;
	/**
	 * Optional callback invoked by `ActiveQueryRoster` when a reactive nudge pass confirms
	 * that this subscriber's payload hash did not change at the given `stateRevision`.
	 */
	readonly onUnchangedPayload?:
		((stateRevision: number, payloadHash: string) => void) | undefined;
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
	readonly tasks: NormalizedTask[];
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

const EMPTY_BACKLINKS: readonly BacklinkRef[] = Object.freeze([]);

interface CachedMatchProjection {
	readonly match: VaultQueryMatch;
	sources: ReadonlyMap<TFile, number> | undefined;
	snapshotEntries: readonly CachedSnapshotSourceEntry[] | undefined;
}

const projectedMatchCache = new WeakMap<NormalizedDocument, CachedMatchProjection>();

function buildFrozenVaultQueryMatch(
	doc: NormalizedDocument,
	frozenBacklinks: readonly BacklinkRef[],
): VaultQueryMatch {
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
		tasks: doc.tasks,
		properties: doc.properties,
		propertyLocations: doc.propertyLocations,
		backlinks: frozenBacklinks,
	});
}

function getOrUpdateCachedProjection(
	doc: NormalizedDocument,
	backlinks: BacklinkSnapshot | undefined,
	file: TFile,
	isIgnored: (file: TFile) => boolean,
): CachedMatchProjection {
	const sources = backlinks?.get(file);
	const cached = projectedMatchCache.get(doc);

	if (sources === undefined || sources.size === 0) {
		if (cached !== undefined && cached.match.backlinks.length === 0) {
			cached.sources = undefined;
			cached.snapshotEntries = undefined;
			return cached;
		}
		const match = buildFrozenVaultQueryMatch(doc, EMPTY_BACKLINKS);
		const next: CachedMatchProjection = {
			match,
			sources: undefined,
			snapshotEntries: undefined,
		};
		projectedMatchCache.set(doc, next);
		return next;
	}

	if (
		cached !== undefined &&
		cached.sources === sources &&
		cached.snapshotEntries !== undefined &&
		isSnapshotSourcesUnchanged(cached.snapshotEntries, isIgnored)
	) {
		return cached;
	}

	const { refs, entries } = projectBacklinksWithEntries(sources, isIgnored);
	if (cached !== undefined && backlinkArraysEqual(cached.match.backlinks, refs)) {
		cached.sources = sources;
		cached.snapshotEntries = entries;
		return cached;
	}

	const frozenRefs = refs.length === 0 ? EMPTY_BACKLINKS : deepFreeze(refs);
	const match = buildFrozenVaultQueryMatch(doc, frozenRefs);
	const next: CachedMatchProjection = {
		match,
		sources,
		snapshotEntries: entries,
	};
	projectedMatchCache.set(doc, next);
	return next;
}

/**
 * Projects a `NormalizedDocument` into a user-facing `VaultQueryMatch` POJO.
 *
 * @remarks
 * (design, 2026-11-18) Cached documents never carry backlinks and are frozen, so projection
 * builds a frozen wrapper and memoizes it per `NormalizedDocument` via a `WeakMap`. Backlinks
 * are supplied by the caller from the pass's snapshot; when omitted, a document's own attached
 * backlinks are used (the direct-normalize test oracle path). Only the wrapper and the backlinks
 * array need freezing: every other field is already a deep-frozen cache subtree (the oracle path
 * freezes its document once before projection).
 */
export function toVaultQueryMatch(
	doc: NormalizedDocument,
	backlinks?: readonly BacklinkRef[],
): VaultQueryMatch {
	if (!Object.isFrozen(doc)) {
		deepFreeze(doc);
	}
	const projectedBacklinks = backlinks ?? doc.backlinks ?? EMPTY_BACKLINKS;
	const cached = projectedMatchCache.get(doc);
	if (cached !== undefined && backlinkArraysEqual(cached.match.backlinks, projectedBacklinks)) {
		return cached.match;
	}
	const frozenBacklinks =
		projectedBacklinks.length === 0 ? EMPTY_BACKLINKS : deepFreeze(projectedBacklinks);
	const match = buildFrozenVaultQueryMatch(doc, frozenBacklinks);
	projectedMatchCache.set(doc, {
		match,
		sources: undefined,
		snapshotEntries: undefined,
	});
	return match;
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
	readonly superseded: boolean;
	readonly yielded: boolean;
}

async function prepareVaultPass(
	cache: NormalizedDocumentCache | undefined,
	options: VaultQueryOptions | undefined,
	config: ResolvedEngineConfig,
	resolveLinkPath: ResolveLinkPathFn,
	files: readonly TFile[] | undefined,
	clearLinkMemo: () => void,
): Promise<PreparedVaultPass> {
	let stats: DocumentCacheStats | undefined;
	let superseded = false;
	let yielded = false;
	if (options?.reconciledStats !== undefined) {
		stats = options.reconciledStats;
	} else if (cache !== undefined && files !== undefined) {
		const reconciled = await cache.reconcileAsync(files, config, resolveLinkPath, {
			signal: options?.signal,
			onYield: clearLinkMemo,
		});
		stats = reconciled.stats;
		superseded = reconciled.superseded;
		yielded = reconciled.yielded === true;
		if (superseded) {
			return { backlinks: options?.backlinks, stats, superseded: true, yielded };
		}
	}
	let backlinks = options?.backlinks;
	const index = options?.backlinkIndex;
	if (backlinks === undefined && index !== undefined) {
		if (typeof index.reconcile === 'function') {
			index.reconcile();
		}
		backlinks = index.snapshot();
	}
	return { backlinks, stats, superseded: false, yielded };
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

	const linkMemo = createMemoizedLinkResolver(app);
	const resolveLinkPath: ResolveLinkPathFn = linkMemo.resolveLinkPath;

	const isIgnoredFile =
		options?.isIgnoredFile ?? ((file: TFile) => defaultIsIgnoredFile(app, file));
	const cache = options?.cache;
	const preReconcileMs = Math.max(0, options?.reconcileDurationMs ?? 0);
	const reconcileStartedAt = Date.now();
	let vaultFiles = cache !== undefined ? app.vault.getMarkdownFiles() : undefined;
	const prepared = await prepareVaultPass(
		cache,
		options,
		resolvedConfig,
		resolveLinkPath,
		vaultFiles,
		linkMemo.clear,
	);
	if (prepared.superseded) {
		return {};
	}
	if (cache !== undefined && prepared.yielded) {
		vaultFiles = app.vault.getMarkdownFiles();
	}
	const reconcileMs = preReconcileMs + Math.max(0, Date.now() - reconcileStartedAt);
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

	const userKnownQueryNames = new Set<string>();
	for (const [name] of sanitizedEntries) {
		if (!name.startsWith('◊')) {
			userKnownQueryNames.add(name);
		}
	}

	const prelimCompiled: Array<{
		readonly name: string;
		readonly rawInput: string;
		readonly isInternal: boolean;
		readonly compileResult: CompileResult;
	}> = [];

	for (const [name, rawInput] of sanitizedEntries) {
		const isInternal = name.startsWith('◊');
		const queryHostDoc =
			options?.queryHostDocs &&
			Object.prototype.hasOwnProperty.call(options.queryHostDocs, name)
				? options.queryHostDocs[name]
				: hostDoc;
		const compileResult = compileQuery(
			rawInput,
			resolvedConfig,
			rawRefTimeMs,
			queryHostDoc,
			isInternal ? undefined : userKnownQueryNames,
		);
		prelimCompiled.push({ name, rawInput, isInternal, compileResult });
	}

	const dagAnalysis = analyzeQueryDependencyDag(
		prelimCompiled
			.filter((item) => !item.isInternal)
			.map((item) => ({ name: item.name, ast: item.compileResult.ast })),
		{ checkUnknownRefs: false },
	);

	interface ExecutableWaveEntry {
		readonly name: string;
		readonly prepared: PreparedQuery;
		readonly bucket: VaultQueryMatch[];
		readonly matchedDocs: NormalizedDocument[];
	}

	const executableQueries: ExecutableWaveEntry[] = [];
	const executableByName = new Map<string, ExecutableWaveEntry>();

	for (const item of prelimCompiled) {
		const cycleDiags = item.isInternal
			? undefined
			: dagAnalysis.cycleDiagnosticsByQuery.get(item.name);
		const isBlocked = !item.isInternal && dagAnalysis.blockedQueryNames.has(item.name);
		if (cycleDiags && cycleDiags.length > 0) {
			logQueryCompilation(logger, item.name, item.rawInput, {
				ast: null,
				prepared: null,
				diagnostics: [...item.compileResult.diagnostics, ...cycleDiags],
				executable: false,
			});
			continue;
		}
		logQueryCompilation(logger, item.name, item.rawInput, item.compileResult);
		if (item.compileResult.executable && item.compileResult.prepared && !isBlocked) {
			const bucket: VaultQueryMatch[] = [];
			results[item.name] = bucket;
			const entry: ExecutableWaveEntry = {
				name: item.name,
				prepared: item.compileResult.prepared,
				bucket,
				matchedDocs: [],
			};
			executableQueries.push(entry);
			executableByName.set(item.name, entry);
		}
	}

	if (executableQueries.length === 0) {
		logger?.log('debug', 'Completed vault query run', {
			source: 'query.run',
			durationMs: preReconcileMs + Math.max(0, Date.now() - startedAt),
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
	let anyUsesGraph = false;
	for (const entry of executableQueries) {
		const plan = getExecutionPlan(entry.prepared);
		if (plan.usesGraph) {
			anyUsesGraph = true;
		}
		for (const key of plan.queriedKeys) {
			queriedKeys.add(key);
		}
	}
	const propDiagnosticsAggregator = new QueriedPropertyDiagnosticsAggregator(queriedKeys);

	const executionWaves: ExecutableWaveEntry[][] = [];
	const internalEntries = prelimCompiled
		.filter((item) => item.isInternal && executableByName.has(item.name))
		.map((item) => executableByName.get(item.name)!);
	for (let w = 0; w < dagAnalysis.waves.length; w++) {
		const waveEntries: ExecutableWaveEntry[] = w === 0 ? [...internalEntries] : [];
		for (const qName of dagAnalysis.waves[w]!) {
			const entry = executableByName.get(qName);
			if (entry) {
				waveEntries.push(entry);
			}
		}
		if (waveEntries.length > 0) {
			executionWaves.push(waveEntries);
		}
	}
	if (executionWaves.length === 0 && internalEntries.length > 0) {
		executionWaves.push(internalEntries);
	}

	let notesScanned = 0;
	let uncachedNotes = prepared.stats?.uncached ?? 0;
	const scanStartedAt = Date.now();
	let projectMs = 0;

	if (!anyUsesGraph && executionWaves.length <= 1) {
		if (cache !== undefined && vaultFiles !== undefined) {
			for (const file of vaultFiles) {
				const doc = cache.get(file.path);
				if (doc === undefined) {
					continue;
				}
				notesScanned++;
				propDiagnosticsAggregator.recordNote(file.path, doc.diagnostics);

				let cachedProjection: CachedMatchProjection | undefined;
				const ctx: DocumentEvaluationContext | undefined =
					backlinks !== undefined
						? {
								backlinks: () => {
									cachedProjection ??= getOrUpdateCachedProjection(
										doc,
										backlinks,
										file,
										isIgnoredFile,
									);
									return cachedProjection.match.backlinks;
								},
							}
						: undefined;

				let sharedMatch: VaultQueryMatch | undefined;
				for (const entry of executableQueries) {
					if (evaluateDoc(doc, entry.prepared, ctx)) {
						if (sharedMatch === undefined) {
							const projectStartedAt = Date.now();
							cachedProjection ??= getOrUpdateCachedProjection(
								doc,
								backlinks,
								file,
								isIgnoredFile,
							);
							sharedMatch = cachedProjection.match;
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
	} else {
		interface MaterializedPassDoc {
			readonly doc: NormalizedDocument;
			readonly file: TFile;
			readonly getBacklinks: () => readonly BacklinkRef[];
			readonly projectMatch: () => VaultQueryMatch;
			sharedMatch: VaultQueryMatch | undefined;
		}

		const passDocs: MaterializedPassDoc[] = [];
		const passDocByPath = new Map<string, MaterializedPassDoc>();

		if (cache !== undefined && vaultFiles !== undefined) {
			for (const file of vaultFiles) {
				const doc = cache.get(file.path);
				if (doc === undefined) {
					continue;
				}
				notesScanned++;
				propDiagnosticsAggregator.recordNote(file.path, doc.diagnostics);
				let cachedProjection: CachedMatchProjection | undefined;
				const getBacklinks = (): readonly BacklinkRef[] => {
					if (backlinks === undefined) return EMPTY_BACKLINKS;
					cachedProjection ??= getOrUpdateCachedProjection(
						doc,
						backlinks,
						file,
						isIgnoredFile,
					);
					return cachedProjection.match.backlinks;
				};
				const projectMatch = (): VaultQueryMatch => {
					cachedProjection ??= getOrUpdateCachedProjection(
						doc,
						backlinks,
						file,
						isIgnoredFile,
					);
					return cachedProjection.match;
				};
				const item: MaterializedPassDoc = {
					doc,
					file,
					getBacklinks,
					projectMatch,
					sharedMatch: undefined,
				};
				passDocs.push(item);
				passDocByPath.set(doc.file.path, item);
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
				propDiagnosticsAggregator.recordNote(file.path, doc.diagnostics);
				const baseCtx = createBacklinkContext(backlinks, file, isIgnoredFile);
				const getBacklinks = (): readonly BacklinkRef[] =>
					baseCtx ? baseCtx.backlinks() : (doc.backlinks ?? EMPTY_BACKLINKS);
				const projectMatch = (): VaultQueryMatch =>
					toVaultQueryMatch(doc, baseCtx?.backlinks());
				const item: MaterializedPassDoc = {
					doc,
					file,
					getBacklinks,
					projectMatch,
					sharedMatch: undefined,
				};
				passDocs.push(item);
				passDocByPath.set(doc.file.path, item);
			}
		}

		const lazyBacklinkPathsResolver =
			backlinks !== undefined
				? (targetPath: string): readonly string[] => {
						const item = passDocByPath.get(targetPath);
						if (!item) return [];
						const sources = backlinks.get(item.file);
						if (!sources || sources.size === 0) return [];
						const out: string[] = [];
						for (const [sourceFile, count] of sources) {
							if (
								count > 0 &&
								!(sourceFile as { deleted?: boolean }).deleted &&
								!isIgnoredFile(sourceFile)
							) {
								out.push(sourceFile.path);
							}
						}
						return out;
					}
				: undefined;

		const graphSnapshot = new VaultGraphSnapshot(
			passDocs.map((p) => p.doc),
			lazyBacklinkPathsResolver,
		);
		const getBacklinksForDoc = (d: NormalizedDocument): readonly BacklinkRef[] =>
			passDocByPath.get(d.file.path)?.getBacklinks() ?? EMPTY_BACKLINKS;
		const priorQueryDocs = new Map<string, readonly NormalizedDocument[]>();

		for (let w = 0; w < executionWaves.length; w++) {
			const wave = executionWaves[w]!;
			const graphCtx = createGraphEvaluationContext(
				graphSnapshot,
				priorQueryDocs,
				getBacklinksForDoc,
			);
			for (let i = 0; i < passDocs.length; i++) {
				const item = passDocs[i]!;
				const docCtx: DocumentEvaluationContext = {
					backlinks: item.getBacklinks,
					graphContext: graphCtx,
				};
				for (let j = 0; j < wave.length; j++) {
					const entry = wave[j]!;
					if (evaluateDoc(item.doc, entry.prepared, docCtx)) {
						if (item.sharedMatch === undefined) {
							const projectStartedAt = Date.now();
							item.sharedMatch = item.projectMatch();
							projectMs += Date.now() - projectStartedAt;
						}
						entry.bucket.push(item.sharedMatch);
						entry.matchedDocs.push(item.doc);
					}
				}
			}
			for (let j = 0; j < wave.length; j++) {
				const entry = wave[j]!;
				priorQueryDocs.set(entry.name, entry.matchedDocs);
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
		durationMs: preReconcileMs + Math.max(0, Date.now() - startedAt),
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
		options?.cutoff,
	);

	logger?.log('debug', 'Generated query explanation', {
		source: 'query.explain',
		query: markSensitive(input),
		durationMs: Math.max(0, Date.now() - startedAt),
	});

	return markdown;
}
