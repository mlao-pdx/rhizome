import { type App, normalizePath } from 'obsidian';
import type { Digest64 } from '@core/hash/xxhash64';
import { XxHash64Accumulator } from '@core/hash/xxhash64';
import {
	analyzeQueryDependencyDag,
	decodeQueryReference,
	type NormalizedDocument,
	parseAndLowerQuery,
	type PropertyTypeRegistry,
	QueryReference,
	type ResolvedEngineConfig,
	type SearchAST,
	SearchLexer,
	ThisReference,
} from '@core/search';
import { HOST_QUERY_KEY } from '@core/templates';
import type { LoggerPort } from '@ports/logger-port';
import type { BacklinkIndex } from './backlink-index';
import { createMemoizedLinkResolver } from './link-resolver-memo';
import { markSensitive } from './logger-format';
import type { NormalizedDocumentCache } from './normalized-document-cache';
import { logQueryCompilation } from './vault-query-logging';
import {
	resolveDefaultTimeZone,
	resolveGroupEngineConfig,
	resolveHostDocument,
	runVaultQuery,
	sanitizeQueryEntries,
	toVaultQueryMatch,
	type VaultQueryCallback,
	type VaultQueryMatch,
	type VaultQueryOptions,
	type VaultQueryResult,
} from './vault-query-runner';

function updateMatch(acc: XxHash64Accumulator, match: VaultQueryMatch): void {
	const file = match.file;
	acc.updateString(file.path);
	acc.updateString(file.name);
	acc.updateString(file.basename);
	acc.updateString(file.extension);
	acc.updateString(file.parent);
	acc.updateString(file.created);
	acc.updateString(file.modified);
	acc.updateNumber(file.size);

	acc.updateStringArray(match.aliases);

	const aliasLocs = match.aliasLocations;
	acc.updateTag(0x22, aliasLocs.length);
	for (let i = 0; i < aliasLocs.length; i++) {
		const loc = aliasLocs[i]!;
		acc.updateString(loc.alias);
		acc.updateString(loc.source);
		acc.updateString(loc.origin);
	}

	acc.updateStringArray(match.tags);

	const tagLocs = match.tagLocations;
	acc.updateTag(0x23, tagLocs.length);
	for (let i = 0; i < tagLocs.length; i++) {
		const loc = tagLocs[i]!;
		acc.updateString(loc.tag);
		acc.updateString(loc.source);
		acc.updateString(loc.origin);
	}

	acc.updateStringArray(match.cssclasses);

	const headings = match.headings;
	acc.updateTag(0x24, headings.length);
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i]!;
		acc.updateString(h.text);
		acc.updateU32(h.level);
		acc.updateString(h.origin);
	}

	const links = match.links;
	acc.updateTag(0x25, links.length);
	for (let i = 0; i < links.length; i++) {
		const l = links[i]!;
		acc.updateString(l.link);
		acc.updateString(l.rawTarget);
		if (l.resolvedPath === null) {
			acc.updateU32(0x10000000);
		} else {
			acc.updateString(l.resolvedPath);
		}
		acc.updateString(l.subpath);
		acc.updateString(l.displayText);
		acc.updateString(l.source);
		if (l.property === null || l.property === undefined) {
			acc.updateU32(0x10000001);
		} else {
			acc.updateString(l.property);
		}
		acc.updateString(l.origin);
	}

	const embeds = match.embeds;
	acc.updateTag(0x26, embeds.length);
	for (let i = 0; i < embeds.length; i++) {
		const e = embeds[i]!;
		acc.updateString(e.link);
		acc.updateString(e.rawTarget);
		if (e.resolvedPath === null) {
			acc.updateU32(0x10000000);
		} else {
			acc.updateString(e.resolvedPath);
		}
		acc.updateString(e.subpath);
		acc.updateString(e.displayText);
		acc.updateString(e.source);
		if (e.property === null || e.property === undefined) {
			acc.updateU32(0x10000001);
		} else {
			acc.updateString(e.property);
		}
		acc.updateString(e.origin);
	}

	const blocks = match.blocks;
	acc.updateTag(0x28, blocks.length);
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i]!;
		acc.updateString(b.id);
		acc.updateString(b.origin);
	}
	acc.updateValue(match.properties);

	const propLocs = match.propertyLocations;
	acc.updateTag(0x27, propLocs.length);
	for (let i = 0; i < propLocs.length; i++) {
		const loc = propLocs[i]!;
		acc.updateString(loc.property);
		acc.updateValue(loc.value);
		acc.updateString(loc.source);
		acc.updateString(loc.origin);
	}

	const backlinks = match.backlinks;
	acc.updateTag(0x29, backlinks.length);
	for (let i = 0; i < backlinks.length; i++) {
		const backlink = backlinks[i]!;
		acc.updateString(backlink.path);
		acc.updateNumber(backlink.count);
	}

	const tasks = match.tasks;
	acc.updateTag(0x2a, tasks.length);
	for (let i = 0; i < tasks.length; i++) {
		acc.updateValue(tasks[i]!);
	}
}

const matchDigestCache = new WeakMap<VaultQueryMatch, Digest64>();

function getMatchDigest(match: VaultQueryMatch): Digest64 {
	const cached = matchDigestCache.get(match);
	if (cached !== undefined) {
		return cached;
	}
	const acc = new XxHash64Accumulator();
	updateMatch(acc, match);
	const digest = acc.digest();
	matchDigestCache.set(match, digest);
	return digest;
}

/**
 * Computes a deterministic 64-bit xxHash hex digest for a single `VaultQueryMatch` POJO,
 * memoized per object reference via a `WeakMap` so matches shared across queries
 * or subscribers within a vault scan are hashed at most once.
 */
export function hashVaultQueryMatch(match: VaultQueryMatch): string {
	return getMatchDigest(match).hex;
}

/**
 * Options for `hashVaultQueryResult`.
 */
export interface HashVaultQueryResultOptions {
	/**
	 * Whether to include `◊host` (`HOST_QUERY_KEY`) in the computed digest.
	 * Defaults to `true`.
	 */
	readonly includeHost?: boolean | undefined;
	/**
	 * Optional heading level (`0..6`) folded into the digest so changes to the heading
	 * context above a codeblock invalidate its payload hash.
	 */
	readonly headingLevel?: number | undefined;
}

/**
 * Computes a deterministic 64-bit xxHash hex digest for a `VaultQueryResult` payload
 * across all present query keys and their ordered `VaultQueryMatch` arrays.
 */
export function hashVaultQueryResult(
	result: VaultQueryResult,
	options?: HashVaultQueryResultOptions,
): string {
	const includeHost = options?.includeHost ?? true;
	const acc = new XxHash64Accumulator();
	const keys = Object.keys(result)
		.filter((k) => includeHost || k !== HOST_QUERY_KEY)
		.sort();
	acc.updateTag(0x40, keys.length);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i]!;
		acc.updateString(key);
		const matches = result[key];
		if (!Array.isArray(matches)) {
			acc.updateU32(0x41000000);
			continue;
		}
		acc.updateTag(0x42, matches.length);
		for (let j = 0; j < matches.length; j++) {
			const d = getMatchDigest(matches[j]!);
			acc.updateU32(d.hi);
			acc.updateU32(d.lo);
		}
	}
	if (typeof options?.headingLevel === 'number' && Number.isFinite(options.headingLevel)) {
		acc.updateTag(0x43, Math.max(0, Math.trunc(options.headingLevel)));
	}
	return acc.digest().hex;
}

function resolveHeadingLevelOption(
	headingLevel: number | (() => number) | undefined,
): number | undefined {
	if (typeof headingLevel === 'function') {
		try {
			const val = headingLevel();
			return typeof val === 'number' && Number.isFinite(val) ? val : 0;
		} catch {
			return 0;
		}
	}
	return typeof headingLevel === 'number' && Number.isFinite(headingLevel)
		? headingLevel
		: undefined;
}

interface ActiveSubscription {
	readonly id: number;
	readonly entries: ReadonlyArray<readonly [string, string]>;
	readonly timeZone: string | undefined;
	readonly propertyTypes: PropertyTypeRegistry | undefined;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: () => void;
	readonly onUpdate: VaultQueryCallback | undefined;
	readonly onReset: (() => void) | undefined;
	readonly onSourcePathRename: ((newPath: string) => void) | undefined;
	readonly onUnchangedPayload: ((stateRevision: number, payloadHash: string) => void) | undefined;
	readonly includeHostInHash: boolean;
	readonly headingLevel: number | (() => number) | undefined;
	sourcePath: string | undefined;
	lastPayloadHash: string | null;
}

function buildConfigGroupKey(
	timeZone: string | undefined,
	propertyTypes: PropertyTypeRegistry | undefined,
): string {
	const resolvedTz = timeZone !== undefined ? timeZone : resolveDefaultTimeZone();
	const acc = new XxHash64Accumulator();
	acc.updateString(resolvedTz);
	acc.updateValue(propertyTypes ?? null);
	return acc.digest().hex;
}

/**
 * Options for `ActiveQueryRoster.nudge`.
 */
export interface NudgeOptions {
	/**
	 * When `true`, reconciles the document cache and backlink index first and exits without
	 * re-evaluating queries if neither changed and no rename is pending.
	 */
	readonly onlyIfChanged?: boolean | undefined;
}

/**
 * Tracks active reactive `plugin.query(..., onUpdate)` subscribers, coalesces vault
 * change nudges into single-pass deduplicated `runVaultQuery` runs, and invokes each
 * subscriber's `onUpdate` callback only when its reconstructed payload hash changes.
 */
export class ActiveQueryRoster {
	private readonly app: App;
	private readonly logger: LoggerPort | undefined;
	private readonly backlinkIndex: BacklinkIndex | undefined;
	private readonly documentCache: NormalizedDocumentCache | undefined;
	private readonly subscriptions = new Map<number, ActiveSubscription>();
	private nextId = 1;
	private activeNudgePromise: Promise<void> | null = null;
	private rerunPending = false;
	private rerunOnlyIfChanged = true;
	private renamePending = false;
	private refreshScheduled = false;
	private dirtySinceLastCompletedPass = false;
	private vaultRevision = 0;
	private resetRevision = 0;

	constructor(
		app: App,
		logger?: LoggerPort,
		backlinkIndex?: BacklinkIndex,
		documentCache?: NormalizedDocumentCache,
	) {
		this.app = app;
		this.logger = logger;
		this.backlinkIndex = backlinkIndex;
		this.documentCache = documentCache;
	}

	/** Number of currently active reactive query subscriptions. */
	get size(): number {
		return this.subscriptions.size;
	}

	/**
	 * Monotonic revision counter bumped whenever a vault/metadata change is observed or
	 * a nudge/reset pass runs. Used by the codeblock render cache to detect whether an
	 * unmounted and remounted codeblock can reuse its last query payload without re-scanning.
	 */
	get stateRevision(): number {
		return this.vaultRevision;
	}

	/**
	 * Monotonic revision counter bumped whenever `resetAll()` or `clear()` invalidates
	 * template/partial/layout state.
	 */
	get templateRevision(): number {
		return this.resetRevision;
	}

	/**
	 * Marks that a vault or metadata event occurred so unmounted codeblocks do not reuse
	 * a pre-event query payload on remount before the debounced nudge fires.
	 */
	markVaultDirty(): void {
		this.vaultRevision++;
	}

	/**
	 * Marks that a debounced refresh timer has been scheduled so an in-flight time-sliced
	 * nudge pass can supersede early and hand off to the trailing pass.
	 */
	notifyRefreshScheduled(): void {
		this.vaultRevision++;
		this.refreshScheduled = true;
	}

	/**
	 * Clears the external refresh-timer flag once the scheduled timer fires or is cancelled.
	 */
	clearRefreshScheduled(): void {
		this.refreshScheduled = false;
	}

	/**
	 * Registers a reactive query subscriber with its initial result snapshot and
	 * optional `AbortSignal` / `onReset` callback for automatic cleanup or forced re-parse.
	 */
	register(
		queries: Readonly<Record<string, string>>,
		options: VaultQueryOptions | undefined,
		initialResult: VaultQueryResult,
		onUpdate?: VaultQueryCallback,
	): () => void {
		const entries = sanitizeQueryEntries(queries);
		const signal = options?.signal;
		const onReset = options?.onReset;
		const sourcePath =
			typeof options?.sourcePath === 'string' && options.sourcePath.length > 0
				? options.sourcePath
				: undefined;
		const hasUpdateTarget =
			(entries.length > 0 || sourcePath !== undefined) && typeof onUpdate === 'function';
		if ((!hasUpdateTarget && typeof onReset !== 'function') || signal?.aborted === true) {
			return () => {};
		}

		const id = this.nextId++;
		const onAbort = () => {
			this.subscriptions.delete(id);
		};
		const includeHostInHash = options?.includeHostInHash ?? true;
		const headingLevel = options?.headingLevel;
		const sub: ActiveSubscription = {
			id,
			entries,
			timeZone: options?.timeZone,
			propertyTypes: options?.propertyTypes,
			signal,
			onAbort,
			onUpdate,
			onReset,
			onSourcePathRename: options?.onSourcePathRename,
			onUnchangedPayload: options?.onUnchangedPayload,
			includeHostInHash,
			headingLevel,
			sourcePath,
			lastPayloadHash: hashVaultQueryResult(initialResult, {
				includeHost: includeHostInHash,
				headingLevel: resolveHeadingLevelOption(headingLevel),
			}),
		};
		this.subscriptions.set(id, sub);

		signal?.addEventListener('abort', onAbort, { once: true });

		return () => {
			signal?.removeEventListener('abort', onAbort);
			this.subscriptions.delete(id);
		};
	}

	/**
	 * Deregisters all active subscriptions and invokes each non-aborted subscriber's
	 * `onReset()` callback so mounted `rhizome` codeblocks re-run Pass 1 from scratch.
	 */
	resetAll(): void {
		this.resetRevision++;
		this.vaultRevision++;
		if (this.subscriptions.size === 0) {
			return;
		}
		const snapshot = [...this.subscriptions.values()];
		this.subscriptions.clear();
		this.rerunPending = false;
		this.dirtySinceLastCompletedPass = false;
		this.renamePending = false;

		for (const sub of snapshot) {
			sub.signal?.removeEventListener('abort', sub.onAbort);
			if (sub.signal?.aborted || typeof sub.onReset !== 'function') {
				continue;
			}
			try {
				sub.onReset();
			} catch (error) {
				this.logger?.log(
					'error',
					`Reactive query reset callback failed: ${markSensitive(String(error))}`,
					{
						source: 'query.reactive',
						error: markSensitive(String(error)),
					},
				);
			}
		}
	}

	/**
	 * Re-evaluates all active subscriptions in a single-pass deduplicated vault scan
	 * per configuration group and notifies subscribers whose payload hash changed.
	 */
	nudge(referenceTimeMs: number = Date.now(), options?: NudgeOptions): Promise<void> {
		this.vaultRevision++;
		this.refreshScheduled = false;
		if (this.subscriptions.size === 0) {
			return Promise.resolve();
		}
		if (options?.onlyIfChanged !== true) {
			this.rerunOnlyIfChanged = false;
		}
		if (this.activeNudgePromise !== null) {
			this.rerunPending = true;
			return this.activeNudgePromise;
		}

		const runLoop = async (initialRefTimeMs: number): Promise<void> => {
			let currentRefTimeMs = initialRefTimeMs;
			do {
				this.rerunPending = false;
				const onlyIfChanged = this.rerunOnlyIfChanged;
				this.rerunOnlyIfChanged = true;
				await this.executeNudgePass(currentRefTimeMs, onlyIfChanged);
				currentRefTimeMs = Date.now();
			} while (this.rerunPending && this.subscriptions.size > 0);
		};

		const promise = runLoop(referenceTimeMs).finally(() => {
			this.activeNudgePromise = null;
		});
		this.activeNudgePromise = promise;
		return promise;
	}

	/** Removes all active subscriptions immediately. */
	clear(): void {
		this.resetRevision++;
		this.vaultRevision++;
		for (const sub of this.subscriptions.values()) {
			sub.signal?.removeEventListener('abort', sub.onAbort);
		}
		this.subscriptions.clear();
		this.rerunPending = false;
		this.rerunOnlyIfChanged = true;
		this.renamePending = false;
		this.refreshScheduled = false;
		this.dirtySinceLastCompletedPass = false;
	}

	/**
	 * Updates `sourcePath` on any active subscription whose hosting note was renamed from
	 * `oldPath` to `newPath`, invoking `onSourcePathRename` so mounted codeblocks stay
	 * synchronized with the renamed note.
	 */
	handleFileRename(oldPath: string, newPath: string, markPending: boolean = true): void {
		if (typeof oldPath !== 'string' || typeof newPath !== 'string' || !oldPath || !newPath) {
			return;
		}
		if (markPending) {
			this.renamePending = true;
			this.vaultRevision++;
		}
		const normOld = normalizePath(oldPath);
		const normNew = normalizePath(newPath);
		for (const sub of this.subscriptions.values()) {
			if (sub.signal?.aborted) {
				continue;
			}
			if (
				sub.sourcePath !== undefined &&
				(sub.sourcePath === oldPath || normalizePath(sub.sourcePath) === normOld)
			) {
				sub.sourcePath = newPath;
				if (normOld !== normNew) {
					sub.lastPayloadHash = null;
				}
				this.renamePending = true;
				try {
					sub.onSourcePathRename?.(newPath);
				} catch {
					// Ignore callback error during rename propagation
				}
			}
		}
	}

	private async executeNudgePass(referenceTimeMs: number, onlyIfChanged: boolean): Promise<void> {
		if (this.subscriptions.size === 0) {
			return;
		}
		const startResetRev = this.resetRevision;
		if (this.renamePending) {
			this.dirtySinceLastCompletedPass = true;
		}

		const groups = new Map<
			string,
			{
				timeZone: string | undefined;
				propertyTypes: PropertyTypeRegistry | undefined;
				subs: ActiveSubscription[];
			}
		>();

		for (const sub of this.subscriptions.values()) {
			if (sub.signal?.aborted) {
				sub.signal.removeEventListener('abort', sub.onAbort);
				this.subscriptions.delete(sub.id);
				continue;
			}
			const hasUpdateTarget =
				(sub.entries.length > 0 || sub.sourcePath !== undefined) &&
				typeof sub.onUpdate === 'function';
			if (!hasUpdateTarget) {
				continue;
			}
			const key = buildConfigGroupKey(sub.timeZone, sub.propertyTypes);
			let group = groups.get(key);
			if (!group) {
				group = {
					timeZone: sub.timeZone,
					propertyTypes: sub.propertyTypes,
					subs: [],
				};
				groups.set(key, group);
			}
			group.subs.push(sub);
		}

		if (groups.size === 0) {
			this.dirtySinceLastCompletedPass = false;
			this.renamePending = false;
			return;
		}

		const backlinkStartedAt = Date.now();
		const prevProjectionRev = this.backlinkIndex?.projectionRevision ?? 0;
		const backlinksChanged =
			typeof this.backlinkIndex?.reconcile === 'function'
				? this.backlinkIndex.reconcile()
				: false;
		const nextProjectionRev = this.backlinkIndex?.projectionRevision ?? 0;
		const backlinkProjectionChanged =
			backlinksChanged || nextProjectionRev !== prevProjectionRev;
		if (backlinkProjectionChanged) {
			this.dirtySinceLastCompletedPass = true;
		}
		const backlinks = this.backlinkIndex?.snapshot();
		const backlinkReconcileMs = Math.max(0, Date.now() - backlinkStartedAt);

		const isPassSuperseded = (): boolean =>
			this.rerunPending ||
			this.refreshScheduled ||
			this.resetRevision !== startResetRev ||
			this.subscriptions.size === 0;

		for (const group of groups.values()) {
			const isGroupCancelled = (): boolean =>
				group.subs.every(
					(s) => s.signal?.aborted === true || !this.subscriptions.has(s.id),
				);
			const shouldSupersede = (): boolean => isPassSuperseded() || isGroupCancelled();

			if (isPassSuperseded()) {
				if (!onlyIfChanged) {
					this.rerunOnlyIfChanged = false;
				}
				return;
			}
			if (isGroupCancelled()) {
				continue;
			}

			const uniqueSourcePaths = new Set<string>();
			for (const sub of group.subs) {
				if (sub.sourcePath === undefined) {
					continue;
				}
				const usesThisInQueries = sub.entries.some(([, rawQuery]) =>
					/@this(?![a-zA-Z0-9_+-])/.test(rawQuery),
				);
				if (sub.includeHostInHash || usesThisInQueries) {
					uniqueSourcePaths.add(sub.sourcePath);
				}
			}

			const linkMemo = createMemoizedLinkResolver(this.app);
			const resolveLinkPath = linkMemo.resolveLinkPath;

			let engineConfig: ResolvedEngineConfig | null = null;
			if (this.documentCache !== undefined || uniqueSourcePaths.size > 0) {
				engineConfig = await resolveGroupEngineConfig(
					this.app,
					group.timeZone,
					group.propertyTypes,
					this.logger,
				);
				linkMemo.clear();
				if (isPassSuperseded()) {
					if (!onlyIfChanged) {
						this.rerunOnlyIfChanged = false;
					}
					return;
				}
				if (isGroupCancelled()) {
					continue;
				}
			}

			const docReconcileStartedAt = Date.now();
			const docReconciled =
				this.documentCache !== undefined && engineConfig !== null
					? await this.documentCache.reconcileAsync(
							this.app.vault.getMarkdownFiles(),
							engineConfig,
							resolveLinkPath,
							{
								shouldSupersede,
								onYield: linkMemo.clear,
							},
						)
					: undefined;
			const docReconcileMs = Math.max(0, Date.now() - docReconcileStartedAt);
			const reconcileDurationMs = backlinkReconcileMs + docReconcileMs;

			if (docReconciled?.changed) {
				this.dirtySinceLastCompletedPass = true;
			}
			if (isPassSuperseded()) {
				if (!onlyIfChanged) {
					this.rerunOnlyIfChanged = false;
				}
				return;
			}
			if (docReconciled?.superseded || isGroupCancelled()) {
				continue;
			}

			const hostDocsByPath = new Map<string, NormalizedDocument | null>();
			if (uniqueSourcePaths.size > 0 && engineConfig !== null) {
				for (const sp of uniqueSourcePaths) {
					const doc = resolveHostDocument(
						this.app,
						sp,
						engineConfig,
						resolveLinkPath,
						this.logger,
						backlinks,
						undefined,
						this.documentCache,
					);
					hostDocsByPath.set(sp, doc ?? null);
				}
			}

			if (
				onlyIfChanged &&
				this.documentCache !== undefined &&
				docReconciled !== undefined &&
				!docReconciled.changed &&
				!backlinkProjectionChanged &&
				!this.dirtySinceLastCompletedPass &&
				!this.renamePending
			) {
				for (const sub of group.subs) {
					if (sub.signal?.aborted || !this.subscriptions.has(sub.id)) {
						this.subscriptions.delete(sub.id);
						continue;
					}
					if (typeof sub.onUpdate !== 'function') {
						continue;
					}
					if (sub.entries.length > 0) {
						if (sub.lastPayloadHash !== null) {
							try {
								sub.onUnchangedPayload?.(this.vaultRevision, sub.lastPayloadHash);
							} catch {
								// Ignore callback error
							}
						}
						continue;
					}
					const subscriberResult: VaultQueryResult = {};
					if (sub.sourcePath !== undefined && sub.includeHostInHash) {
						const hostDoc = hostDocsByPath.get(sub.sourcePath) ?? null;
						subscriberResult[HOST_QUERY_KEY] = hostDoc
							? [toVaultQueryMatch(hostDoc)]
							: [];
					}
					const nextHash = hashVaultQueryResult(subscriberResult, {
						includeHost: sub.includeHostInHash,
						headingLevel: resolveHeadingLevelOption(sub.headingLevel),
					});
					if (nextHash !== sub.lastPayloadHash) {
						sub.lastPayloadHash = nextHash;
						if (sub.sourcePath !== undefined && !sub.includeHostInHash) {
							const hostDoc =
								engineConfig !== null
									? resolveHostDocument(
											this.app,
											sub.sourcePath,
											engineConfig,
											resolveLinkPath,
											this.logger,
											backlinks,
											undefined,
											this.documentCache,
										)
									: null;
							subscriberResult[HOST_QUERY_KEY] = hostDoc
								? [toVaultQueryMatch(hostDoc)]
								: [];
						}
						try {
							await sub.onUpdate(subscriberResult);
						} catch (error) {
							this.logger?.log(
								'error',
								`Reactive query callback failed: ${markSensitive(String(error))}`,
								{
									source: 'query.reactive',
									error: markSensitive(String(error)),
								},
							);
						}
					} else {
						try {
							sub.onUnchangedPayload?.(this.vaultRevision, sub.lastPayloadHash);
						} catch {
							// Ignore callback error
						}
					}
				}
				continue;
			}

			const queryToDedupKey = new Map<string, string>();
			const dedupQueries: Record<string, string> = Object.create(null) as Record<
				string,
				string
			>;
			const queryHostDocs: Record<string, NormalizedDocument | null | undefined> =
				Object.create(null) as Record<string, NormalizedDocument | null | undefined>;
			const subDedupMaps = new Map<number, ReadonlyMap<string, string>>();
			let qIdx = 0;

			interface TokenizedSubQuery {
				readonly rawQuery: string;
				readonly directUsesThis: boolean;
				readonly queryRefs: ReadonlyArray<{
					readonly startOffset: number;
					readonly endOffset: number;
					readonly rawImage: string;
					readonly queryName: string;
					readonly suffixAfterName: string;
				}>;
			}

			const tokenizeSubQuery = (rawQuery: string): TokenizedSubQuery => {
				const lexed = SearchLexer.tokenize(rawQuery);
				let directUsesThis = false;
				const queryRefs: Array<{
					readonly startOffset: number;
					readonly endOffset: number;
					readonly rawImage: string;
					readonly queryName: string;
					readonly suffixAfterName: string;
				}> = [];

				for (let i = 0; i < lexed.tokens.length; i++) {
					const tok = lexed.tokens[i]!;
					if (tok.tokenType === ThisReference) {
						directUsesThis = true;
					} else if (tok.tokenType === QueryReference) {
						const decoded = decodeQueryReference(tok.image);
						if (decoded.ok) {
							const prefixLen = 7 + decoded.queryName.length; // '@query.' + queryName
							queryRefs.push({
								startOffset: tok.startOffset,
								endOffset: tok.startOffset + tok.image.length,
								rawImage: tok.image,
								queryName: decoded.queryName,
								suffixAfterName: tok.image.slice(prefixLen),
							});
						}
					}
				}

				return { rawQuery, directUsesThis, queryRefs };
			};

			for (const sub of group.subs) {
				const subSourceKey = sub.sourcePath ?? '';
				const subHostDoc =
					sub.sourcePath !== undefined
						? (hostDocsByPath.get(sub.sourcePath) ?? null)
						: undefined;

				const localInfoMap = new Map<string, TokenizedSubQuery>();
				const subDagInputs: Array<{
					readonly name: string;
					readonly ast: SearchAST | null;
				}> = [];
				const parsedDiagsByLocalName = new Map<
					string,
					ReturnType<typeof parseAndLowerQuery>['diagnostics']
				>();

				for (const [localName, rawQuery] of sub.entries) {
					localInfoMap.set(localName, tokenizeSubQuery(rawQuery));
					const parsed = parseAndLowerQuery(rawQuery);
					parsedDiagsByLocalName.set(localName, parsed.diagnostics);
					subDagInputs.push({ name: localName, ast: parsed.ast });
				}

				const subDag = analyzeQueryDependencyDag(subDagInputs, { checkUnknownRefs: true });
				for (const [localName, rawQuery] of sub.entries) {
					const unknownDiags = subDag.unknownRefDiagnosticsByQuery.get(localName) ?? [];
					const cycleDiags = subDag.cycleDiagnosticsByQuery.get(localName) ?? [];
					if (unknownDiags.length > 0 || cycleDiags.length > 0) {
						logQueryCompilation(this.logger, localName, rawQuery, {
							ast: null,
							prepared: null,
							diagnostics: [
								...(parsedDiagsByLocalName.get(localName) ?? []),
								...unknownDiags,
								...cycleDiags,
							],
							executable: false,
						});
					}
				}

				const resolvedByLocalName = new Map<string, string>();

				const resolveLocalDedupKey = (localName: string): string | undefined => {
					if (subDag.blockedQueryNames.has(localName)) {
						return undefined;
					}
					const existing = resolvedByLocalName.get(localName);
					if (existing !== undefined) {
						return existing;
					}
					const info = localInfoMap.get(localName);
					if (!info) {
						return undefined;
					}

					const resolvedRefKeys: string[] = [];
					for (let i = 0; i < info.queryRefs.length; i++) {
						const ref = info.queryRefs[i]!;
						const depKey = resolveLocalDedupKey(ref.queryName);
						if (depKey === undefined) {
							return undefined;
						}
						resolvedRefKeys.push(depKey);
					}

					let rewritten = info.rawQuery;
					for (let i = info.queryRefs.length - 1; i >= 0; i--) {
						const ref = info.queryRefs[i]!;
						const depKey = resolvedRefKeys[i]!;
						const replacement = `@query.${depKey}${ref.suffixAfterName}`;
						rewritten =
							rewritten.slice(0, ref.startOffset) +
							replacement +
							rewritten.slice(ref.endOffset);
					}

					const compositeKey = info.directUsesThis
						? `${subSourceKey}\0${rewritten}`
						: `\0${rewritten}`;
					let dedupKey = queryToDedupKey.get(compositeKey);
					if (dedupKey === undefined) {
						dedupKey = `__q${qIdx++}`;
						queryToDedupKey.set(compositeKey, dedupKey);
						dedupQueries[dedupKey] = rewritten;
						if (info.directUsesThis && sub.sourcePath !== undefined) {
							queryHostDocs[dedupKey] = subHostDoc;
						}
					}
					resolvedByLocalName.set(localName, dedupKey);
					return dedupKey;
				};

				for (const [localName] of sub.entries) {
					resolveLocalDedupKey(localName);
				}
				subDedupMaps.set(sub.id, resolvedByLocalName);
			}

			const batchResult =
				qIdx > 0
					? await runVaultQuery(
							this.app,
							dedupQueries,
							{
								timeZone: group.timeZone,
								propertyTypes: group.propertyTypes,
								referenceTimeMs,
								queryHostDocs,
								reconcileDurationMs,
								...(engineConfig ? { resolvedConfig: engineConfig } : {}),
								...(backlinks !== undefined ? { backlinks } : {}),
								...(this.documentCache ? { cache: this.documentCache } : {}),
								...(docReconciled !== undefined
									? { reconciledStats: docReconciled.stats }
									: {}),
								...(this.backlinkIndex
									? { backlinkIndex: this.backlinkIndex }
									: {}),
							},
							this.logger,
						)
					: {};

			for (const sub of group.subs) {
				if (sub.signal?.aborted || !this.subscriptions.has(sub.id)) {
					this.subscriptions.delete(sub.id);
					continue;
				}
				if (typeof sub.onUpdate !== 'function') {
					continue;
				}

				const subscriberResult: VaultQueryResult = {};
				if (sub.sourcePath !== undefined && sub.includeHostInHash) {
					const hostDoc = hostDocsByPath.get(sub.sourcePath) ?? null;
					subscriberResult[HOST_QUERY_KEY] = hostDoc ? [toVaultQueryMatch(hostDoc)] : [];
				}
				const subResolvedMap = subDedupMaps.get(sub.id);
				for (const [name] of sub.entries) {
					const dedupKey = subResolvedMap?.get(name);
					if (
						dedupKey !== undefined &&
						Object.prototype.hasOwnProperty.call(batchResult, dedupKey)
					) {
						subscriberResult[name] = [...(batchResult[dedupKey] ?? [])];
					}
				}

				const nextHash = hashVaultQueryResult(subscriberResult, {
					includeHost: sub.includeHostInHash,
					headingLevel: resolveHeadingLevelOption(sub.headingLevel),
				});
				if (nextHash !== sub.lastPayloadHash) {
					sub.lastPayloadHash = nextHash;
					if (sub.sourcePath !== undefined && !sub.includeHostInHash) {
						let hostDoc = hostDocsByPath.get(sub.sourcePath);
						if (hostDoc === undefined && engineConfig !== null) {
							hostDoc =
								resolveHostDocument(
									this.app,
									sub.sourcePath,
									engineConfig,
									resolveLinkPath,
									this.logger,
									backlinks,
									undefined,
									this.documentCache,
								) ?? null;
							hostDocsByPath.set(sub.sourcePath, hostDoc);
						}
						subscriberResult[HOST_QUERY_KEY] = hostDoc
							? [toVaultQueryMatch(hostDoc)]
							: [];
					}
					try {
						await sub.onUpdate(subscriberResult);
					} catch (error) {
						this.logger?.log(
							'error',
							`Reactive query callback failed: ${markSensitive(String(error))}`,
							{
								source: 'query.reactive',
								error: markSensitive(String(error)),
							},
						);
					}
				} else {
					try {
						sub.onUnchangedPayload?.(this.vaultRevision, sub.lastPayloadHash);
					} catch {
						// Ignore callback error
					}
				}
			}
		}

		this.dirtySinceLastCompletedPass = false;
		this.renamePending = false;
	}
}
