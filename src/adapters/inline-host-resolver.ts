import { type App, getLanguage, normalizePath, Platform, type TFile } from 'obsidian';
import {
	hasInternalRhizomeFlag,
	INTERNAL_RHIZOME_CODES,
	type NormalizedDocument,
	normalizeObsidianMetadata,
	type ResolvedEngineConfig,
} from '@core/search';
import type { TemplateDiagnostic, TemplateRuntimeContext } from '@core/templates';
import type { LoggerPort } from '@ports/logger-port';
import { hashVaultQueryMatch } from './active-query-roster';
import { copyWithBacklinks, type BacklinkIndex } from './backlink-index';
import { buildFallbackConfig } from './codemirror/rhizome-analysis-cache';
import { markSensitive } from './logger-format';
import type { NormalizedDocumentCache } from './normalized-document-cache';
import { loadVaultPropertyTypes } from './vault-query-logging';
import {
	resolveDefaultTimeZone,
	toVaultQueryMatch,
	type VaultQueryMatch,
} from './vault-query-runner';

/**
 * Resolved O(1) host-note snapshot and digest for inline `◊ ...` evaluation.
 */
export interface ResolvedInlineHost {
	readonly hostMatch: VaultQueryMatch | null;
	readonly revisionHash: string;
	readonly headingStructureKey: string;
}

/**
 * Listener callbacks registered via `InlineHostResolver.subscribe`.
 */
export interface InlineHostSubscriptionHandlers {
	readonly onChange: () => void;
	readonly onRename?: ((newPath: string) => void) | undefined;
}

interface ActiveInlineSubscriber {
	readonly id: number;
	path: string;
	readonly onChange: () => void;
	readonly onRename: ((newPath: string) => void) | undefined;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: () => void;
}

interface PathSubscriberBucket {
	readonly subs: Set<ActiveInlineSubscriber>;
	lastRevisionHash: string;
	lastHeadingStructureKey: string;
}

interface MemoizedHostEntry {
	readonly doc: NormalizedDocument;
	readonly projectionRevision: number;
	readonly headingStructureKey: string;
	readonly resolved: ResolvedInlineHost;
}

function computeHeadingStructureKey(
	headings:
		| ReadonlyArray<{
				readonly level?: number;
				readonly position?: { readonly start?: { readonly line?: number } };
		  }>
		| null
		| undefined,
): string {
	if (!headings || headings.length === 0) {
		return '';
	}
	const parts: string[] = [];
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i]!;
		const line = h.position?.start?.line ?? -1;
		const level = h.level ?? 0;
		parts.push(`${line}:${level}`);
	}
	return parts.join(',');
}

/**
 * O(1) host-note resolver and per-`sourcePath` change coordinator for inline `◊ ...`
 * expressions across Reading mode and CodeMirror 6 Live Preview, strictly decoupled from
 * `ActiveQueryRoster` and vault-wide query scans.
 */
export class InlineHostResolver {
	private readonly app: App;
	private readonly logger: LoggerPort | undefined;
	private readonly backlinkIndex: BacklinkIndex | undefined;
	private readonly documentCache: NormalizedDocumentCache | undefined;
	private readonly isIgnoredFile: ((file: TFile) => boolean) | undefined;
	private config: ResolvedEngineConfig = buildFallbackConfig({});
	private configLoadPending = false;
	private configLoaded = false;
	private cachedTimeZone: string | null = null;
	private backlinkDirty = true;
	private nextSubId = 1;
	private readonly bucketsByPath = new Map<string, PathSubscriberBucket>();
	private readonly memoByPath = new Map<string, MemoizedHostEntry>();
	private readonly loggedWarningsByPath = new Map<string, Set<string>>();

	constructor(
		app: App,
		logger?: LoggerPort,
		backlinkIndex?: BacklinkIndex,
		documentCache?: NormalizedDocumentCache,
		isIgnoredFile?: (file: TFile) => boolean,
	) {
		this.app = app;
		this.logger = logger;
		this.backlinkIndex = backlinkIndex;
		this.documentCache = documentCache;
		this.isIgnoredFile = isIgnoredFile;
	}

	/** Number of distinct normalized `sourcePath` buckets with active inline subscribers. */
	get activePathCount(): number {
		return this.bucketsByPath.size;
	}

	/** Returns `true` when `path` currently has at least one active inline subscriber. */
	hasActivePath(path: string): boolean {
		return (
			typeof path === 'string' &&
			path.length > 0 &&
			this.bucketsByPath.has(normalizePath(path))
		);
	}

	/** Reloads `.obsidian/types.json` property types asynchronously and notifies affected hosts. */
	refreshPropertyTypes(): void {
		if (this.configLoadPending) {
			return;
		}
		this.configLoadPending = true;
		this.configLoaded = true;
		void loadVaultPropertyTypes(this.app, this.logger)
			.then((registry) => {
				this.config = buildFallbackConfig(registry);
				this.memoByPath.clear();
				this.checkAllBucketsForChanges();
			})
			.finally(() => {
				this.configLoadPending = false;
			});
	}

	/** Builds a `TemplateRuntimeContext` for inline evaluation against `sourcePath`. */
	buildRuntimeContext(
		sourcePath: string,
		headingLevel: number,
		referenceTimeMs: number = Date.now(),
	): TemplateRuntimeContext {
		const vaultWithGetName = this.app.vault as { getName?: () => string };
		const vaultName =
			typeof vaultWithGetName.getName === 'function' ? vaultWithGetName.getName() : '';
		const language = typeof getLanguage === 'function' ? getLanguage() : 'en';
		this.cachedTimeZone ??= resolveDefaultTimeZone();
		return {
			sourcePath,
			referenceTimeMs,
			timeZone: this.cachedTimeZone,
			vault: vaultName,
			language,
			platform: Platform,
			headingLevel,
		};
	}

	/**
	 * Synchronously resolves `sourcePath` in O(1) against `NormalizedDocumentCache` and
	 * `BacklinkIndex`. Never scans the vault when `BacklinkIndex` is already built.
	 */
	resolveSync(sourcePath: string): ResolvedInlineHost {
		if (!this.configLoaded) {
			this.refreshPropertyTypes();
		}
		if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
			return { hostMatch: null, revisionHash: 'null', headingStructureKey: '' };
		}
		if (this.documentCache !== undefined && !this.documentCache.isReady) {
			return { hostMatch: null, revisionHash: 'pending', headingStructureKey: '' };
		}

		const normalized = normalizePath(sourcePath);
		const file = this.lookupMarkdownFile(normalized, sourcePath);
		if (!file || (file as { deleted?: boolean }).deleted) {
			this.memoByPath.delete(normalized);
			return { hostMatch: null, revisionHash: 'missing', headingStructureKey: '' };
		}

		const cache = this.app.metadataCache.getFileCache(file);
		if (
			hasInternalRhizomeFlag(
				cache?.frontmatter,
				INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
			) ||
			this.isIgnoredFile?.(file) === true
		) {
			this.documentCache?.delete(file.path);
			this.memoByPath.delete(normalized);
			return { hostMatch: null, revisionHash: 'ignored', headingStructureKey: '' };
		}

		const resolveLinkPath = (rawTarget: string, linkSourcePath: string): string | null =>
			this.app.metadataCache.getFirstLinkpathDest?.(rawTarget, linkSourcePath)?.path ?? null;

		let baseDoc: NormalizedDocument | null = null;
		try {
			baseDoc =
				this.documentCache !== undefined
					? this.documentCache.ensureFresh(file, this.config, resolveLinkPath)
					: normalizeObsidianMetadata(file, cache, this.config, [], resolveLinkPath);
		} catch {
			baseDoc = null;
		}
		if (baseDoc === null) {
			this.memoByPath.delete(normalized);
			return { hostMatch: null, revisionHash: 'null', headingStructureKey: '' };
		}

		if (
			this.backlinkIndex !== undefined &&
			(this.backlinkDirty || !this.backlinkIndex.isBuilt)
		) {
			this.backlinkDirty = false;
			if (typeof this.backlinkIndex.reconcile === 'function') {
				this.backlinkIndex.reconcile();
			}
		}

		const projectionRev = this.backlinkIndex?.projectionRevision ?? 0;
		const headingStructureKey = computeHeadingStructureKey(cache?.headings);
		const memo = this.memoByPath.get(normalized);
		if (
			memo !== undefined &&
			memo.doc === baseDoc &&
			memo.projectionRevision === projectionRev &&
			memo.headingStructureKey === headingStructureKey
		) {
			return memo.resolved;
		}

		const isIgnored = (candidate: TFile): boolean =>
			this.isIgnoredFile?.(candidate) === true ||
			hasInternalRhizomeFlag(
				this.app.metadataCache.getFileCache(candidate)?.frontmatter,
				INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
			);
		const docWithBacklinks =
			this.backlinkIndex !== undefined
				? copyWithBacklinks(baseDoc, this.backlinkIndex.snapshot(), file, isIgnored)
				: baseDoc;
		const hostMatch = toVaultQueryMatch(docWithBacklinks);
		const revisionHash = hashVaultQueryMatch(hostMatch);
		const resolved: ResolvedInlineHost = Object.freeze({
			hostMatch,
			revisionHash,
			headingStructureKey,
		});
		if (this.memoByPath.size >= 64 && !this.memoByPath.has(normalized)) {
			const oldest = this.memoByPath.keys().next().value;
			if (oldest !== undefined) {
				this.memoByPath.delete(oldest);
			}
		}
		this.memoByPath.set(normalized, {
			doc: baseDoc,
			projectionRevision: projectionRev,
			headingStructureKey,
			resolved,
		});
		return resolved;
	}

	/** Subscribes to metadata, backlink, and rename changes affecting `sourcePath`. */
	subscribe(
		sourcePath: string,
		handlers: InlineHostSubscriptionHandlers,
		signal?: AbortSignal,
	): () => void {
		if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0 || signal?.aborted) {
			return () => {};
		}
		const normalized = normalizePath(sourcePath);
		const initial = this.resolveSync(normalized);
		let bucket = this.bucketsByPath.get(normalized);
		if (!bucket) {
			bucket = {
				subs: new Set(),
				lastRevisionHash: initial.revisionHash,
				lastHeadingStructureKey: initial.headingStructureKey,
			};
			this.bucketsByPath.set(normalized, bucket);
		}

		const sub: ActiveInlineSubscriber = {
			id: this.nextSubId++,
			path: normalized,
			onChange: handlers.onChange,
			onRename: handlers.onRename,
			signal,
			onAbort: () => {
				this.unsubscribeInternal(sub);
			},
		};
		bucket.subs.add(sub);
		signal?.addEventListener('abort', sub.onAbort, { once: true });

		return () => {
			signal?.removeEventListener('abort', sub.onAbort);
			this.unsubscribeInternal(sub);
		};
	}

	/** Notifies the resolver that `path`'s metadata cache entry changed or was deleted. */
	notifyMetadataChanged(path: string): void {
		if (typeof path !== 'string' || path.length === 0) {
			return;
		}
		const normalized = normalizePath(path);
		const typesPath = normalizePath(`${this.app.vault.configDir}/types.json`);
		if (normalized === typesPath) {
			this.refreshPropertyTypes();
			return;
		}
		this.loggedWarningsByPath.delete(normalized);
		this.memoByPath.delete(normalized);

		const outgoingLinksChanged =
			this.backlinkIndex !== undefined &&
			(!this.backlinkIndex.isBuilt || this.backlinkIndex.hasSourceChanged(normalized));
		if (outgoingLinksChanged) {
			this.backlinkDirty = true;
		}
		if (this.bucketsByPath.size === 0) {
			return;
		}
		if (outgoingLinksChanged) {
			this.checkAllBucketsForChanges();
			return;
		}
		const directBucket = this.bucketsByPath.get(normalized);
		if (directBucket) {
			this.checkBucketForChanges(normalized, directBucket);
		}
	}

	/** Notifies the resolver that link resolution completed for one or more files. */
	notifyLinksResolved(): void {
		this.backlinkDirty = true;
		if (this.bucketsByPath.size === 0) {
			return;
		}
		this.checkAllBucketsForChanges();
	}

	/** Propagates a vault file rename across tracked inline host subscriptions. */
	notifyFileRename(oldPath: string, newPath: string): void {
		if (typeof oldPath !== 'string' || typeof newPath !== 'string' || !oldPath || !newPath) {
			return;
		}
		const normOld = normalizePath(oldPath);
		const normNew = normalizePath(newPath);
		this.loggedWarningsByPath.delete(normOld);
		this.memoByPath.delete(normOld);
		this.memoByPath.delete(normNew);
		this.backlinkDirty = true;

		const oldBucket = this.bucketsByPath.get(normOld);
		if (oldBucket && normOld !== normNew) {
			this.bucketsByPath.delete(normOld);
			let targetBucket = this.bucketsByPath.get(normNew);
			if (!targetBucket) {
				targetBucket = {
					subs: new Set(),
					lastRevisionHash: '',
					lastHeadingStructureKey: '',
				};
				this.bucketsByPath.set(normNew, targetBucket);
			}
			for (const sub of [...oldBucket.subs]) {
				if (sub.signal?.aborted) {
					continue;
				}
				sub.path = normNew;
				targetBucket.subs.add(sub);
				try {
					sub.onRename?.(normNew);
				} catch {
					// Ignore subscriber error during rename notification
				}
			}
		}

		if (this.bucketsByPath.size > 0) {
			this.checkAllBucketsForChanges();
		}
	}

	/** Notifies active inline subscribers after cold vault readiness or full index rebuild. */
	notifyIndexRebuilt(): void {
		this.memoByPath.clear();
		this.loggedWarningsByPath.clear();
		this.backlinkDirty = true;
		this.refreshPropertyTypes();
		if (this.bucketsByPath.size > 0) {
			this.checkAllBucketsForChanges();
		}
	}

	/**
	 * Logs a deduplicated `'warn'` entry (`source: 'template.inline'`) with vault-derived
	 * `sourcePath`, `expr`, and `diagnostic.issue` wrapped in `markSensitive(...)`.
	 */
	logInlineWarningOnce(
		sourcePath: string,
		expr: string,
		diagnostic: Pick<TemplateDiagnostic, 'code' | 'issue'>,
	): void {
		if (!this.logger) {
			return;
		}
		const normalized = sourcePath.trim().length > 0 ? normalizePath(sourcePath) : '<detached>';
		const dedupKey = `${expr}\0${diagnostic.code}\0${diagnostic.issue}`;
		let seen = this.loggedWarningsByPath.get(normalized);
		if (!seen) {
			seen = new Set<string>();
			this.loggedWarningsByPath.set(normalized, seen);
		}
		if (seen.has(dedupKey)) {
			return;
		}
		seen.add(dedupKey);

		const targetLabel = sourcePath.trim().length > 0 ? markSensitive(sourcePath) : '<detached>';
		this.logger.log('warn', `Inline rhizome expression error in ${targetLabel}`, {
			source: 'template.inline',
			code: diagnostic.code,
			expression: markSensitive(expr),
			issue: markSensitive(diagnostic.issue),
		});
	}

	/** Clears all active subscriptions and caches on plugin unload. */
	dispose(): void {
		for (const bucket of this.bucketsByPath.values()) {
			for (const sub of bucket.subs) {
				sub.signal?.removeEventListener('abort', sub.onAbort);
			}
		}
		this.bucketsByPath.clear();
		this.memoByPath.clear();
		this.loggedWarningsByPath.clear();
	}

	private unsubscribeInternal(sub: ActiveInlineSubscriber): void {
		const bucket = this.bucketsByPath.get(sub.path);
		if (!bucket) {
			return;
		}
		bucket.subs.delete(sub);
		if (bucket.subs.size === 0) {
			this.bucketsByPath.delete(sub.path);
			this.loggedWarningsByPath.delete(sub.path);
		}
	}

	private checkBucketForChanges(path: string, bucket: PathSubscriberBucket): void {
		for (const sub of [...bucket.subs]) {
			if (sub.signal?.aborted) {
				bucket.subs.delete(sub);
			}
		}
		if (bucket.subs.size === 0) {
			this.bucketsByPath.delete(path);
			return;
		}
		const next = this.resolveSync(path);
		if (
			next.revisionHash !== bucket.lastRevisionHash ||
			next.headingStructureKey !== bucket.lastHeadingStructureKey
		) {
			bucket.lastRevisionHash = next.revisionHash;
			bucket.lastHeadingStructureKey = next.headingStructureKey;
			for (const sub of [...bucket.subs]) {
				if (sub.signal?.aborted) {
					continue;
				}
				try {
					sub.onChange();
				} catch {
					// Ignore subscriber callback error
				}
			}
		}
	}

	private checkAllBucketsForChanges(): void {
		for (const [path, bucket] of [...this.bucketsByPath.entries()]) {
			this.checkBucketForChanges(path, bucket);
		}
	}

	private lookupMarkdownFile(normalized: string, rawPath: string): TFile | null {
		const vaultWithLookup = this.app.vault as {
			getFileByPath?: (path: string) => TFile | null;
		};
		if (typeof vaultWithLookup.getFileByPath === 'function') {
			const direct = vaultWithLookup.getFileByPath(normalized);
			if (direct) {
				return direct;
			}
		}
		return (
			this.app.vault
				.getMarkdownFiles()
				.find((f) => f.path === normalized || f.path === rawPath) ?? null
		);
	}
}
