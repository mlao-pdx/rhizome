import { getLanguage, type MarkdownPostProcessorContext, normalizePath, Platform } from 'obsidian';
import {
	hasInternalRhizomeFlag,
	initEngineConfig,
	INTERNAL_RHIZOME_CODES,
	type ResolvedEngineConfig,
} from '@core/search';
import {
	resolveCodeBlockHeadingLevel,
	TargetPathClaimRegistry,
	type TemplateFolderConfig,
	type TemplateRuntimeContext,
} from '@core/templates';
import type RhizomePlugin from '../main';
import {
	buildTemplateMetadataSnapshot,
	createVaultDirectoryChildrenLookup,
} from './template-folder-ladder';
import { loadVaultPropertyTypes } from './vault-query-logging';
import { resolveDefaultTimeZone } from './vault-query-runner';

interface CachedEngineConfigEntry {
	readonly stateRevision: number;
	readonly timeZone: string;
	readonly promise: Promise<{
		readonly timeZone: string;
		readonly resolvedConfig: ResolvedEngineConfig;
	}>;
}

const engineConfigMemo = new WeakMap<RhizomePlugin, CachedEngineConfigEntry>();

export function lookupVaultMarkdownFile(
	plugin: RhizomePlugin,
	vaultRelativePath: string,
): ReturnType<typeof plugin.app.vault.getMarkdownFiles>[number] | undefined {
	const normalized = normalizePath(vaultRelativePath);
	const vaultWithLookup = plugin.app.vault as {
		getFileByPath?: (
			path: string,
		) => ReturnType<typeof plugin.app.vault.getMarkdownFiles>[number] | null;
	};
	return typeof vaultWithLookup.getFileByPath === 'function'
		? (vaultWithLookup.getFileByPath(normalized) ?? undefined)
		: plugin.app.vault.getMarkdownFiles().find((f) => f.path === normalized);
}

export function lookupHostHeadingLevel(
	plugin: RhizomePlugin,
	sourcePath: string,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
): number {
	if (sourcePath.length === 0 || typeof ctx.getSectionInfo !== 'function') {
		return 0;
	}
	const sectionInfo = ctx.getSectionInfo(el);
	const lineStart = sectionInfo?.lineStart;
	if (typeof lineStart !== 'number' || !Number.isFinite(lineStart) || lineStart <= 0) {
		return 0;
	}
	const matchedFile = lookupVaultMarkdownFile(plugin, sourcePath);
	if (!matchedFile) {
		return 0;
	}
	const cache = plugin.app.metadataCache.getFileCache(matchedFile);
	return resolveCodeBlockHeadingLevel(cache?.headings, lineStart);
}

/**
 * Loads `types.json` and initializes `ResolvedEngineConfig`, memoized per `(plugin, stateRevision, timeZone)`
 * when `activeQueryRoster` is present so concurrent and unchanged renders share a single disk read.
 */
export async function resolveCodeBlockEngineConfig(
	plugin: RhizomePlugin,
	timeZone: string = resolveDefaultTimeZone(),
): Promise<{ readonly timeZone: string; readonly resolvedConfig: ResolvedEngineConfig }> {
	const rosterRev = plugin.activeQueryRoster?.stateRevision;
	if (typeof rosterRev === 'number') {
		const cached = engineConfigMemo.get(plugin);
		if (cached && cached.stateRevision === rosterRev && cached.timeZone === timeZone) {
			return cached.promise;
		}
	}

	const loadPromise = (async () => {
		const vaultTypes = await loadVaultPropertyTypes(plugin.app, plugin.loggerAdapter);
		const cfgRes = initEngineConfig({ timeZone, propertyTypes: vaultTypes });
		if (cfgRes.ok) {
			return { timeZone, resolvedConfig: cfgRes.config };
		}
		const fallbackRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
		if (!fallbackRes.ok) {
			throw new Error('Failed to initialize fallback UTC engine config.');
		}
		return { timeZone: 'UTC', resolvedConfig: fallbackRes.config };
	})();

	if (typeof rosterRev === 'number') {
		engineConfigMemo.set(plugin, {
			stateRevision: rosterRev,
			timeZone,
			promise: loadPromise,
		});
	}
	return loadPromise;
}

export function buildBaseRuntimeContext(
	plugin: RhizomePlugin,
	referenceTimeMs: number,
	sourcePath: string,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
	resolvedConfig?: ResolvedEngineConfig,
	timeZoneOverride?: string,
): TemplateRuntimeContext {
	const vaultWithGetName = plugin.app.vault as { getName?: () => string };
	const vaultName =
		typeof vaultWithGetName.getName === 'function' ? vaultWithGetName.getName() : '';
	const language = typeof getLanguage === 'function' ? getLanguage() : 'en';
	return {
		sourcePath,
		referenceTimeMs,
		timeZone: timeZoneOverride ?? resolveDefaultTimeZone(),
		vault: vaultName,
		language,
		platform: Platform,
		headingLevel: lookupHostHeadingLevel(plugin, sourcePath, ctx, el),
		trigger: 'dynamicCodeblock',
		template: null,
		...(resolvedConfig !== undefined ? { resolvedConfig } : {}),
		configDir: plugin.app.vault.configDir,
	};
}

export async function buildDynamicRuntimeContextWithConfig(
	plugin: RhizomePlugin,
	referenceTimeMs: number,
	sourcePath: string,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
): Promise<{
	readonly runtimeContext: TemplateRuntimeContext;
	readonly resolvedConfig: ResolvedEngineConfig;
}> {
	const baseTz = resolveDefaultTimeZone();
	const { timeZone, resolvedConfig } = await resolveCodeBlockEngineConfig(plugin, baseTz);
	return {
		runtimeContext: buildBaseRuntimeContext(
			plugin,
			referenceTimeMs,
			sourcePath,
			ctx,
			el,
			resolvedConfig,
			timeZone,
		),
		resolvedConfig,
	};
}

export async function buildNewNotePreviewRuntimeContext(
	plugin: RhizomePlugin,
	referenceTimeMs: number,
	sourcePath: string,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
	folderConfig: TemplateFolderConfig,
): Promise<TemplateRuntimeContext> {
	const baseTz = resolveDefaultTimeZone();
	const { timeZone, resolvedConfig } = await resolveCodeBlockEngineConfig(plugin, baseTz);
	const base = buildBaseRuntimeContext(
		plugin,
		referenceTimeMs,
		sourcePath,
		ctx,
		el,
		resolvedConfig,
		timeZone,
	);
	const templateFile = lookupVaultMarkdownFile(plugin, sourcePath);
	const templateMeta = templateFile
		? await buildTemplateMetadataSnapshot(
				plugin.app,
				templateFile,
				folderConfig,
				plugin.settings.newNoteDefaultFolderRung ?? 'notebookNavigator',
				resolvedConfig,
			)
		: null;
	const claimRegistry = new TargetPathClaimRegistry(
		createVaultDirectoryChildrenLookup(plugin.app),
	);
	return {
		...base,
		headingLevel: 0,
		trigger: 'newNote',
		template: templateMeta,
		claimRegistry,
		resolvedConfig,
		configDir: plugin.app.vault.configDir,
	};
}

export async function readVaultTemplateNote(
	plugin: RhizomePlugin,
	vaultRelativePath: string,
): Promise<string | null> {
	const normalized = normalizePath(vaultRelativePath);
	const matchedFile = lookupVaultMarkdownFile(plugin, normalized);
	if (matchedFile) {
		const cache = plugin.app.metadataCache.getFileCache(matchedFile);
		if (
			hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY)
		) {
			return null;
		}
		if (typeof plugin.app.vault.cachedRead === 'function') {
			return plugin.app.vault.cachedRead(matchedFile);
		}
	}
	try {
		return await plugin.app.vault.adapter.read(normalized);
	} catch {
		return null;
	}
}
