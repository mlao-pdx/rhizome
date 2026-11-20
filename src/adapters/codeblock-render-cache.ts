import {
	type ParsedRhizomeTemplate,
	type TemplateFolderConfig,
	type TemplateRenderResult,
} from '@core/templates';
import { SENTINEL_CHAR_THRESHOLD, SENTINEL_LINE_THRESHOLD } from './render-sentinel-store';
import type { VaultQueryResult } from './vault-query-runner';

const MAX_CACHE_ENTRIES = 64;

/**
 * Checkpoint 1 threshold: minimum total matched records across a codeblock's extracted
 * `{% query %}` blocks to display an initial `[!info]` standby callout before running
 * LiquidJS Pass 2 (`renderParsedRhizomeTemplate`) when the template contains a loop tag.
 */
export const LARGE_QUERY_RECORD_THRESHOLD = 12_000;

/**
 * Checkpoint 2 line threshold: minimum rendered Markdown line count (`1` + newline count)
 * to display an initial `[!info]` standby callout before running `MarkdownRenderer.render`.
 */
export const LARGE_MARKDOWN_LINE_THRESHOLD = 5_000;

/**
 * Checkpoint 2 character threshold: minimum rendered Markdown character length to display
 * an initial `[!info]` standby callout before running `MarkdownRenderer.render`.
 */
export const LARGE_MARKDOWN_CHAR_THRESHOLD = 100_000;

/**
 * Character and line counts for a rendered Markdown string produced by Pass 2.
 */
export interface MarkdownOutputMetrics {
	readonly chars: number;
	readonly lines: number;
}

/**
 * Sums the matched record counts across all extracted user `{% query %}` blocks in `parsed`
 * (excluding internal keys such as `◊host`).
 */
export function countExtractedQueryRecords(
	parsed: ParsedRhizomeTemplate,
	payload: VaultQueryResult,
): number {
	let total = 0;
	for (const q of parsed.env.queries) {
		const matches = payload[q.name];
		if (Array.isArray(matches)) {
			total += matches.length;
		}
	}
	return total;
}

/**
 * Computes the character length and 1-based line count (`0` when empty) of `markdown`
 * in a single allocation-free pass.
 */
export function measureMarkdownOutput(markdown: string): MarkdownOutputMetrics {
	const chars = markdown.length;
	if (chars === 0) {
		return { chars: 0, lines: 0 };
	}
	let lines = 1;
	for (let i = 0; i < chars; i++) {
		if (markdown.charCodeAt(i) === 10) {
			lines++;
		}
	}
	return { chars, lines };
}

/**
 * Returns `true` when `metrics` reaches or exceeds Checkpoint 2 (`LARGE_MARKDOWN_LINE_THRESHOLD`
 * or `LARGE_MARKDOWN_CHAR_THRESHOLD`).
 */
export function exceedsLargeMarkdownThreshold(metrics: MarkdownOutputMetrics): boolean {
	return (
		metrics.lines >= LARGE_MARKDOWN_LINE_THRESHOLD ||
		metrics.chars >= LARGE_MARKDOWN_CHAR_THRESHOLD
	);
}

/**
 * Returns `true` when `metrics` crosses the write-ahead crash sentinel threshold
 * (`SENTINEL_CHAR_THRESHOLD` `64 KiB` or `SENTINEL_LINE_THRESHOLD` `5,000` lines).
 */
export function exceedsSentinelThreshold(metrics: MarkdownOutputMetrics): boolean {
	return metrics.chars >= SENTINEL_CHAR_THRESHOLD || metrics.lines >= SENTINEL_LINE_THRESHOLD;
}

/**
 * Returns `true` when `result` is a Pass 2 runtime render failure (`TEMPLATE_RENDER_ERROR`,
 * such as hitting the `5,000 ms` render deadline or `3.25 MiB` output cap) that is safe to
 * cache across Live Preview remounts until vault state or templates change.
 */
export function isRuntimeRenderErrorResult(result: TemplateRenderResult): boolean {
	return (
		!result.ok &&
		result.diagnostics.length > 0 &&
		result.diagnostics.every((d) => d.code === 'TEMPLATE_RENDER_ERROR')
	);
}

interface CachedPass1Entry {
	readonly templateRevision: number;
	readonly folderKey: string;
	readonly parsed: ParsedRhizomeTemplate;
	readonly referencesHost: boolean;
	readonly hasLoopTag?: boolean | undefined;
}

interface CachedRenderEntry {
	readonly templateRevision: number;
	readonly folderKey: string;
	readonly payloadHash: string;
	readonly stateRevision: number;
	readonly payload: VaultQueryResult;
	readonly result: TemplateRenderResult;
}

function buildFolderKey(folders: TemplateFolderConfig): string {
	return `${folders.configDir ?? ''}\0${folders.templatesFolder ?? ''}\0${folders.partialsFolder ?? ''}\0${folders.layoutsFolder ?? ''}`;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
	if (map.has(key)) {
		map.delete(key);
	} else if (map.size >= MAX_CACHE_ENTRIES) {
		const oldestKey = map.keys().next().value;
		if (oldestKey !== undefined) {
			map.delete(oldestKey);
		}
	}
	map.set(key, value);
}

/**
 * Returns `true` when every extracted query block in `parsed` succeeded compilation (is
 * present as a key in `payload`), meaning Pass 2 does not fall back to rendering a
 * compilation-failure explain plan.
 */
export function allExtractedQueriesExecutable(
	parsed: ParsedRhizomeTemplate,
	payload: VaultQueryResult,
): boolean {
	for (const q of parsed.env.queries) {
		if (!Object.prototype.hasOwnProperty.call(payload, q.name)) {
			return false;
		}
	}
	return true;
}

export interface InFlightCoalescedHandle<T> {
	readonly promise: Promise<T>;
	readonly isLeader: boolean;
}

interface InFlightSubscriptionEntry<T> {
	promise: Promise<T>;
	subscribers: number;
}

/**
 * Bounded per-plugin cache of Pass 1 parsed templates (`ParsedRhizomeTemplate`) and Pass 2
 * rendered outputs (`TemplateRenderResult` + last `VaultQueryResult` payload) so stepping a
 * cursor into and out of a `rhizome` codeblock in Live Preview or scrolling a codeblock into
 * and out of view reuses the cached render without re-running Pass 1, vault queries, or
 * LiquidJS Pass 2 when neither vault state nor template folders have changed.
 *
 * @remarks
 * (design, 2026-11-18) Both Pass 1 and Pass 2 entries are keyed by `sourcePath` so multiple
 * open notes that share identical codeblock `source` text never share a mutable
 * `ParsedRhizomeTemplate` (`parsed.env.payload` / `parsed.env.explainQuery`) or serialize
 * their renders through the same promise chain. Relative temporal anchors (`@now`, `@today`,
 * `now`, `today`) are pinned to the render pass and are intentionally not refreshed by
 * wall-clock timers; cached outputs remain valid until a vault/template change or a manual
 * codeblock refresh occurs.
 */
export class CodeBlockRenderCache {
	private readonly pass1Cache = new Map<string, CachedPass1Entry>();
	private readonly pass1InFlight = new Map<string, Promise<unknown>>();
	private readonly renderCache = new Map<string, CachedRenderEntry>();
	private readonly inFlight = new Map<string, InFlightSubscriptionEntry<unknown>>();

	getPass1(
		sourcePath: string,
		source: string,
		folders: TemplateFolderConfig,
		templateRevision: number,
	):
		| {
				readonly parsed: ParsedRhizomeTemplate;
				readonly referencesHost: boolean;
				readonly hasLoopTag?: boolean | undefined;
		  }
		| undefined {
		const folderKey = buildFolderKey(folders);
		const key = `${sourcePath}\0${source}`;
		const hit = this.pass1Cache.get(key);
		if (
			hit !== undefined &&
			hit.templateRevision === templateRevision &&
			hit.folderKey === folderKey
		) {
			return {
				parsed: hit.parsed,
				referencesHost: hit.referencesHost,
				hasLoopTag: hit.hasLoopTag,
			};
		}
		return undefined;
	}

	setPass1(
		sourcePath: string,
		source: string,
		folders: TemplateFolderConfig,
		templateRevision: number,
		parsed: ParsedRhizomeTemplate,
		referencesHost: boolean,
		hasLoopTag?: boolean,
	): void {
		const key = `${sourcePath}\0${source}`;
		setBounded(this.pass1Cache, key, {
			templateRevision,
			folderKey: buildFolderKey(folders),
			parsed,
			referencesHost,
			hasLoopTag,
		});
	}

	getOrRunPass1<T>(
		sourcePath: string,
		source: string,
		folders: TemplateFolderConfig,
		templateRevision: number,
		factory: () => Promise<T>,
	): Promise<T> {
		const folderKey = buildFolderKey(folders);
		const key = `${sourcePath}\0${templateRevision}\0${folderKey}\0${source}`;
		const existing = this.pass1InFlight.get(key) as Promise<T> | undefined;
		if (existing !== undefined) {
			return existing;
		}
		const runPromise = factory().finally(() => {
			if (this.pass1InFlight.get(key) === runPromise) {
				this.pass1InFlight.delete(key);
			}
		});
		this.pass1InFlight.set(key, runPromise);
		return runPromise;
	}

	/**
	 * Returns a cached `(payload, result)` when the codeblock is remounted at the exact same
	 * `stateRevision` and `templateRevision` with the same `source`, `sourcePath`, and
	 * `headingLevel`.
	 */
	getRemountHit(
		sourcePath: string,
		source: string,
		headingLevel: number,
		folders: TemplateFolderConfig,
		templateRevision: number,
		stateRevision: number,
	): { readonly payload: VaultQueryResult; readonly result: TemplateRenderResult } | undefined {
		const key = `${sourcePath}\0${headingLevel}\0${source}`;
		const hit = this.renderCache.get(key);
		if (
			hit !== undefined &&
			hit.templateRevision === templateRevision &&
			hit.stateRevision === stateRevision &&
			hit.folderKey === buildFolderKey(folders)
		) {
			return { payload: hit.payload, result: hit.result };
		}
		return undefined;
	}

	/**
	 * Returns a cached `TemplateRenderResult` when a query run or reactive nudge produces
	 * the exact same `payloadHash` (which already folds in `headingLevel`) for the same
	 * `source`, `sourcePath`, and `templateRevision`.
	 */
	getRenderByPayloadHash(
		sourcePath: string,
		source: string,
		headingLevel: number,
		folders: TemplateFolderConfig,
		templateRevision: number,
		payloadHash: string,
	): TemplateRenderResult | undefined {
		const key = `${sourcePath}\0${headingLevel}\0${source}`;
		const hit = this.renderCache.get(key);
		if (
			hit !== undefined &&
			hit.templateRevision === templateRevision &&
			hit.payloadHash === payloadHash &&
			hit.folderKey === buildFolderKey(folders)
		) {
			return hit.result;
		}
		return undefined;
	}

	setRender(
		sourcePath: string,
		source: string,
		headingLevel: number,
		folders: TemplateFolderConfig,
		templateRevision: number,
		stateRevision: number,
		payloadHash: string,
		payload: VaultQueryResult,
		result: TemplateRenderResult,
	): void {
		const key = `${sourcePath}\0${headingLevel}\0${source}`;
		setBounded(this.renderCache, key, {
			templateRevision,
			folderKey: buildFolderKey(folders),
			payloadHash,
			stateRevision,
			payload,
			result,
		});
	}

	/**
	 * Advances the cached render entry's `stateRevision` when a reactive nudge confirms that
	 * the subscriber's `payloadHash` is unchanged at `stateRevision`, preserving `getRemountHit`
	 * across trailing no-op nudges.
	 */
	advanceStateRevision(
		sourcePath: string,
		source: string,
		headingLevel: number,
		folders: TemplateFolderConfig,
		templateRevision: number,
		payloadHash: string,
		stateRevision: number,
	): void {
		const key = `${sourcePath}\0${headingLevel}\0${source}`;
		const hit = this.renderCache.get(key);
		if (
			hit !== undefined &&
			hit.templateRevision === templateRevision &&
			hit.payloadHash === payloadHash &&
			hit.folderKey === buildFolderKey(folders) &&
			hit.stateRevision !== stateRevision
		) {
			this.renderCache.set(key, {
				...hit,
				stateRevision,
			});
		}
	}

	/**
	 * Coalesces concurrent identical initial renders (such as Editor + Minimap or split panes
	 * mounting the same codeblock simultaneously) so `factory` executes query + LiquidJS Pass 2
	 * once while tracking active subscribers so `factory` can skip Pass 2 if every awaiting
	 * mount aborts mid-flight.
	 */
	getOrRunInFlight<T>(
		params: {
			readonly sourcePath: string;
			readonly source: string;
			readonly headingLevel: number;
			readonly folders: TemplateFolderConfig;
			readonly templateRevision: number;
			readonly stateRevision: number;
		},
		callerSignal: AbortSignal,
		factory: (hasLiveSubscribers: () => boolean) => Promise<T>,
	): InFlightCoalescedHandle<T> {
		if (callerSignal.aborted) {
			return { promise: factory(() => false), isLeader: true };
		}
		const folderKey = buildFolderKey(params.folders);
		const key = `${params.sourcePath}\0${params.headingLevel}\0${params.templateRevision}\0${params.stateRevision}\0${folderKey}\0${params.source}`;

		let entry = this.inFlight.get(key) as InFlightSubscriptionEntry<T> | undefined;
		const isLeader = entry === undefined;
		if (!entry) {
			const created: InFlightSubscriptionEntry<T> = {
				promise: Promise.resolve() as unknown as Promise<T>,
				subscribers: 1,
			};
			entry = created;
			this.inFlight.set(key, created);
			created.promise = factory(() => created.subscribers > 0).finally(() => {
				if (this.inFlight.get(key) === created) {
					this.inFlight.delete(key);
				}
			});
		} else {
			entry.subscribers += 1;
		}

		const target = entry;
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			target.subscribers -= 1;
		};
		callerSignal.addEventListener('abort', release, { once: true });
		const trackedPromise = target.promise.finally(() => {
			callerSignal.removeEventListener('abort', release);
			release();
		});

		return { promise: trackedPromise, isLeader };
	}

	deleteForSourcePath(sourcePath: string): void {
		const prefix = `${sourcePath}\0`;
		for (const key of this.pass1Cache.keys()) {
			if (key.startsWith(prefix)) {
				this.pass1Cache.delete(key);
			}
		}
		for (const key of this.pass1InFlight.keys()) {
			if (key.startsWith(prefix)) {
				this.pass1InFlight.delete(key);
			}
		}
		for (const key of this.renderCache.keys()) {
			if (key.startsWith(prefix)) {
				this.renderCache.delete(key);
			}
		}
		for (const key of this.inFlight.keys()) {
			if (key.startsWith(prefix)) {
				this.inFlight.delete(key);
			}
		}
	}

	clear(): void {
		this.pass1Cache.clear();
		this.pass1InFlight.clear();
		this.renderCache.clear();
		this.inFlight.clear();
	}
}
