import type { EditorView } from '@codemirror/view';
import { editorInfoField, type App, type TFile } from 'obsidian';
import {
	hasInternalRhizomeFlag,
	initEngineConfig,
	INTERNAL_RHIZOME_CODES,
	type NormalizedDocument,
	normalizeObsidianMetadata,
	type PropertyTypeRegistry,
	type ResolvedEngineConfig,
} from '@core/search';
import { analyzeRhizomeCodeBlock, type CodeBlockAnalysis } from '@core/templates';
import { copyWithBacklinks, type BacklinkIndex } from '../backlink-index';
import type { NormalizedDocumentCache } from '../normalized-document-cache';

interface HostResolutionCacheEntry {
	readonly cache: unknown;
	readonly mtime: number;
	readonly revision: number;
	readonly config: ResolvedEngineConfig;
	readonly cacheReady: boolean;
	readonly cacheRevision: string;
	readonly resolved: {
		readonly hostDoc: NormalizedDocument | null;
		readonly cacheSignature: string;
	};
}

/**
 * Resolves the vault file backing a specific editor view. Reads the view's own `editorInfoField`
 * instead of the workspace's globally active file so split panes, canvas cards, and other
 * embedded editors resolve their own host note.
 */
export function resolveEditorHostFile(view: EditorView): TFile | null {
	return view.state.field(editorInfoField, false)?.file ?? null;
}

function resolveSystemTimeZone(): string {
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof tz === 'string' && tz.trim() ? tz.trim() : 'UTC';
	} catch {
		return 'UTC';
	}
}

/**
 * Builds an engine config for the given property types, falling back to UTC when the system time
 * zone is rejected.
 */
export function buildFallbackConfig(propertyTypes: PropertyTypeRegistry): ResolvedEngineConfig {
	const primary = initEngineConfig({
		timeZone: resolveSystemTimeZone(),
		propertyTypes,
	});
	if (primary.ok) {
		return primary.config;
	}
	const fallback = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
	if (!fallback.ok) {
		throw new Error('Failed to initialize fallback UTC engine config');
	}
	return fallback.config;
}

/**
 * Shared, bounded caches for codeblock analysis and host-document resolution.
 */
export interface RhizomeAnalysisCache {
	readonly getCachedAnalysis: (source: string, view: EditorView) => CodeBlockAnalysis;
	readonly setConfig: (config: ResolvedEngineConfig) => void;
	readonly clear: () => void;
}

/**
 * Creates the analysis cache shared by the token highlighter and the lint source.
 *
 * @remarks
 * Both caches cap at 32 entries because a full-document lint pass touches every codeblock, so an
 * unbounded map would retain every block ever analyzed across every open note. Host-resolution
 * entries compare `config` by identity: replacing the config object invalidates them, which keeps
 * property-type refreshes from pairing stale host docs with fresh analysis.
 */
export function createRhizomeAnalysisCache(
	app: App,
	backlinkIndex?: BacklinkIndex,
	documentCache?: NormalizedDocumentCache,
	initialConfig: ResolvedEngineConfig = buildFallbackConfig({}),
): RhizomeAnalysisCache {
	let cachedConfig = initialConfig;
	const analysisCache = new Map<string, CodeBlockAnalysis>();
	const hostResolutionCache = new Map<string, HostResolutionCacheEntry>();
	let hostSigCounter = 0;

	const resolveHostDoc = (
		view: EditorView,
	): {
		hostDoc: NormalizedDocument | null;
		cacheSignature: string;
	} => {
		const hostFile = resolveEditorHostFile(view);
		if (!hostFile) {
			return { hostDoc: null, cacheSignature: 'null' };
		}
		const cache = app.metadataCache.getFileCache(hostFile);
		const mtime = hostFile.stat?.mtime ?? 0;
		const revision = backlinkIndex?.projectionRevision ?? 0;
		const cacheReady = documentCache?.isReady ?? false;
		const cacheRevision = documentCache?.getKey(hostFile.path)?.revision ?? '';
		const cached = hostResolutionCache.get(hostFile.path);
		if (
			cached !== undefined &&
			cached.cache === cache &&
			cached.mtime === mtime &&
			cached.revision === revision &&
			cached.config === cachedConfig &&
			cached.cacheReady === cacheReady &&
			cached.cacheRevision === cacheRevision
		) {
			return cached.resolved;
		}

		let resolved: HostResolutionCacheEntry['resolved'];
		if (
			hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY)
		) {
			// Evict any previously cached entry when the host note gains DO_NOT_INDEX_OR_QUERY.
			documentCache?.delete(hostFile.path);
			resolved = { hostDoc: null, cacheSignature: `${hostFile.path}:ignored` };
		} else {
			try {
				const resolveLinkPath = (rawTarget: string, sourcePath: string) =>
					app.metadataCache.getFirstLinkpathDest?.(rawTarget, sourcePath)?.path ?? null;
				const isIgnored = (file: TFile): boolean =>
					hasInternalRhizomeFlag(
						app.metadataCache.getFileCache(file)?.frontmatter,
						INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
					);
				const hostDoc =
					documentCache !== undefined
						? documentCache.ensureFresh(hostFile, cachedConfig, resolveLinkPath)
						: normalizeObsidianMetadata(
								hostFile,
								cache,
								cachedConfig,
								[],
								resolveLinkPath,
							);
				const withBacklinks =
					hostDoc === null
						? null
						: documentCache !== undefined && backlinkIndex !== undefined
							? copyWithBacklinks(
									hostDoc,
									backlinkIndex.snapshot(),
									hostFile,
									isIgnored,
								)
							: (backlinkIndex?.attach(hostDoc, hostFile) ?? hostDoc);
				resolved = {
					hostDoc: withBacklinks,
					cacheSignature: `${hostFile.path}:${mtime}:${revision}:${++hostSigCounter}`,
				};
			} catch {
				resolved = { hostDoc: null, cacheSignature: `${hostFile.path}:err` };
			}
		}

		const effectiveRevision = backlinkIndex?.projectionRevision ?? revision;
		const effectiveCacheRevision =
			documentCache?.getKey(hostFile.path)?.revision ?? cacheRevision;

		hostResolutionCache.set(hostFile.path, {
			cache,
			mtime,
			revision: effectiveRevision,
			config: cachedConfig,
			cacheReady,
			cacheRevision: effectiveCacheRevision,
			resolved,
		});
		if (hostResolutionCache.size > 32) {
			const oldestPath = hostResolutionCache.keys().next().value;
			if (oldestPath !== undefined) {
				hostResolutionCache.delete(oldestPath);
			}
		}
		return resolved;
	};

	const clear = (): void => {
		analysisCache.clear();
		hostResolutionCache.clear();
	};

	const setConfig = (config: ResolvedEngineConfig): void => {
		cachedConfig = config;
		clear();
	};

	const getCachedAnalysis = (source: string, view: EditorView): CodeBlockAnalysis => {
		const { hostDoc, cacheSignature } = resolveHostDoc(view);
		const cacheKey = `${cacheSignature}\0${source}`;
		const hit = analysisCache.get(cacheKey);
		if (hit) {
			return hit;
		}
		if (analysisCache.size >= 32) {
			const oldestKey = analysisCache.keys().next().value;
			if (oldestKey !== undefined) {
				analysisCache.delete(oldestKey);
			}
		}
		const computed = analyzeRhizomeCodeBlock(source, cachedConfig, Date.now(), hostDoc);
		analysisCache.set(cacheKey, computed);
		return computed;
	};

	return { getCachedAnalysis, setConfig, clear };
}
