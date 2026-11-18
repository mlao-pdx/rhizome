import {
	type ParsedRhizomeTemplate,
	type TemplateFolderConfig,
	type TemplateRenderResult,
} from '@core/templates';
import type { VaultQueryResult } from './vault-query-runner';

const MAX_CACHE_ENTRIES = 64;

interface CachedPass1Entry {
	readonly templateRevision: number;
	readonly folderKey: string;
	readonly parsed: ParsedRhizomeTemplate;
	readonly referencesHost: boolean;
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
	private readonly renderCache = new Map<string, CachedRenderEntry>();

	getPass1(
		sourcePath: string,
		source: string,
		folders: TemplateFolderConfig,
		templateRevision: number,
	): { readonly parsed: ParsedRhizomeTemplate; readonly referencesHost: boolean } | undefined {
		const folderKey = buildFolderKey(folders);
		const key = `${sourcePath}\0${source}`;
		const hit = this.pass1Cache.get(key);
		if (
			hit !== undefined &&
			hit.templateRevision === templateRevision &&
			hit.folderKey === folderKey
		) {
			return { parsed: hit.parsed, referencesHost: hit.referencesHost };
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
	): void {
		const key = `${sourcePath}\0${source}`;
		setBounded(this.pass1Cache, key, {
			templateRevision,
			folderKey: buildFolderKey(folders),
			parsed,
			referencesHost,
		});
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

	deleteForSourcePath(sourcePath: string): void {
		const prefix = `${sourcePath}\0`;
		for (const key of this.pass1Cache.keys()) {
			if (key.startsWith(prefix)) {
				this.pass1Cache.delete(key);
			}
		}
		for (const key of this.renderCache.keys()) {
			if (key.startsWith(prefix)) {
				this.renderCache.delete(key);
			}
		}
	}

	clear(): void {
		this.pass1Cache.clear();
		this.renderCache.clear();
	}
}
