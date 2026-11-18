import {
	getLanguage,
	type MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	normalizePath,
	Platform,
} from 'obsidian';
import { hasInternalRhizomeFlag, INTERNAL_RHIZOME_CODES } from '@core/search';
import {
	parsedTemplateReferencesHost,
	parseRhizomeTemplatePass1Async,
	renderParsedRhizomeTemplate,
	resolveCodeBlockHeadingLevel,
	type TemplateRenderResult,
	type TemplateRuntimeContext,
} from '@core/templates';
import type RhizomePlugin from '../main';
import { hashVaultQueryResult } from './active-query-roster';
import { allExtractedQueriesExecutable } from './codeblock-render-cache';
import { markSensitive } from './logger-format';
import { resolveDefaultTimeZone, type VaultQueryResult } from './vault-query-runner';

export { resolveCodeBlockHeadingLevel };

function lookupHostHeadingLevel(
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
	const normalized = normalizePath(sourcePath);
	const vaultWithLookup = plugin.app.vault as {
		getFileByPath?: (
			path: string,
		) => ReturnType<typeof plugin.app.vault.getMarkdownFiles>[number] | null;
	};
	const matchedFile =
		typeof vaultWithLookup.getFileByPath === 'function'
			? (vaultWithLookup.getFileByPath(normalized) ?? undefined)
			: plugin.app.vault.getMarkdownFiles().find((f) => f.path === normalized);
	if (!matchedFile) {
		return 0;
	}
	const cache = plugin.app.metadataCache.getFileCache(matchedFile);
	return resolveCodeBlockHeadingLevel(cache?.headings, lineStart);
}

function buildRuntimeContext(
	plugin: RhizomePlugin,
	referenceTimeMs: number,
	sourcePath: string,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
): TemplateRuntimeContext {
	const vaultWithGetName = plugin.app.vault as { getName?: () => string };
	const vaultName =
		typeof vaultWithGetName.getName === 'function' ? vaultWithGetName.getName() : '';
	const language = typeof getLanguage === 'function' ? getLanguage() : 'en';
	return {
		sourcePath,
		referenceTimeMs,
		timeZone: resolveDefaultTimeZone(),
		vault: vaultName,
		language,
		platform: Platform,
		headingLevel: lookupHostHeadingLevel(plugin, sourcePath, ctx, el),
	};
}

async function readVaultTemplateNote(
	plugin: RhizomePlugin,
	vaultRelativePath: string,
): Promise<string | null> {
	const normalized = normalizePath(vaultRelativePath);
	const vaultWithLookup = plugin.app.vault as {
		getFileByPath?: (
			path: string,
		) => ReturnType<typeof plugin.app.vault.getMarkdownFiles>[number] | null;
	};
	const matchedFile =
		typeof vaultWithLookup.getFileByPath === 'function'
			? (vaultWithLookup.getFileByPath(normalized) ?? undefined)
			: plugin.app.vault.getMarkdownFiles().find((f) => f.path === normalized);
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

function logCodeBlockRenderResult(
	plugin: RhizomePlugin,
	sourcePath: string,
	result: TemplateRenderResult,
	durationMs: number,
	cacheHit?: 'remount' | 'payload',
): void {
	if (!result.ok) {
		const isRenderError = result.diagnostics.some((d) => d.code === 'TEMPLATE_RENDER_ERROR');
		plugin.loggerAdapter?.log(
			'warn',
			`Template ${isRenderError ? 'render' : 'parse'} diagnostics in ${markSensitive(sourcePath)}`,
			{
				source: isRenderError ? 'template.render' : 'template.parse',
				durationMs,
				count: result.diagnostics.length,
				queryCount: result.queries.length,
				codes: result.diagnostics.map((d) => d.code),
			},
		);
	} else {
		plugin.loggerAdapter?.log(
			'debug',
			`Rendered rhizome codeblock in ${markSensitive(sourcePath)}`,
			{
				source: 'template.render',
				durationMs,
				count: result.queries.length,
				...(cacheHit !== undefined ? { cached: true, cacheHit } : {}),
			},
		);
	}
}

/**
 * Processes a fenced `rhizome` Markdown codeblock by parsing its template and any
 * referenced partials/layouts in Pass 1, subscribing to reactive query updates (`onUpdate`)
 * and template/partial/layout resets (`onReset`) via `plugin.query(...)`, and rendering
 * the resulting Markdown into `el` via `MarkdownRenderer.render`.
 */
export async function processRhizomeCodeBlock(
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	plugin: RhizomePlugin,
): Promise<void> {
	let currentSourcePath = typeof ctx.sourcePath === 'string' ? ctx.sourcePath : '';
	const onSourcePathRename = (newPath: string): void => {
		if (currentSourcePath.length > 0 && currentSourcePath !== newPath) {
			plugin.codeBlockRenderCache?.deleteForSourcePath(currentSourcePath);
		}
		currentSourcePath = newPath;
	};

	const outerChild = new MarkdownRenderChild(el);
	ctx.addChild(outerChild);
	const outerAbortController = new AbortController();
	let activeCycleController: AbortController | null = null;
	outerChild.register(() => {
		outerAbortController.abort();
		activeCycleController?.abort();
	});

	let activeRenderChild: MarkdownRenderChild | null = null;
	let renderGeneration = 0;
	const renderIntoContainer = async (
		markdown: string,
		generation: number,
		cycleSignal: AbortSignal,
	): Promise<void> => {
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			generation !== renderGeneration
		) {
			return;
		}
		if (activeRenderChild !== null) {
			outerChild.removeChild(activeRenderChild);
		}
		const emptyFn = (el as { empty?: () => void }).empty;
		if (typeof emptyFn === 'function') {
			emptyFn.call(el);
		}
		const renderChild = new MarkdownRenderChild(el);
		activeRenderChild = renderChild;
		outerChild.addChild(renderChild);
		await MarkdownRenderer.render(plugin.app, markdown, el, currentSourcePath, renderChild);
	};

	const runCycle = async (): Promise<void> => {
		if (outerAbortController.signal.aborted) {
			return;
		}
		activeCycleController?.abort();
		const cycleController = new AbortController();
		activeCycleController = cycleController;
		const cycleSignal = cycleController.signal;

		const parseStartedAt = Date.now();
		const referenceTimeMs = parseStartedAt;
		const onReset = (): void => {
			if (outerAbortController.signal.aborted) {
				return;
			}
			cycleController.abort();
			void runCycle();
		};

		const folderConfig = {
			templatesFolder: plugin.settings.templatesFolder,
			partialsFolder: plugin.settings.partialsFolder,
			layoutsFolder: plugin.settings.layoutsFolder,
			configDir: plugin.app.vault.configDir,
		};
		const renderCache = plugin.codeBlockRenderCache;
		const templateRevision = plugin.activeQueryRoster?.templateRevision ?? 0;

		const cachedPass1 = renderCache?.getPass1(
			currentSourcePath,
			source,
			folderConfig,
			templateRevision,
		);
		let parsed: Awaited<ReturnType<typeof parseRhizomeTemplatePass1Async>>;
		let referencesHost: boolean;
		let parseDurationMs = 0;

		if (cachedPass1 !== undefined) {
			parsed = cachedPass1.parsed;
			referencesHost = cachedPass1.referencesHost;
		} else {
			parsed = await parseRhizomeTemplatePass1Async(
				source,
				folderConfig,
				(vaultRelativePath) => readVaultTemplateNote(plugin, vaultRelativePath),
			);
			parseDurationMs = Math.max(0, Date.now() - parseStartedAt);
			referencesHost = parsedTemplateReferencesHost(source, parsed);
			if (parsed.env.diagnostics.length === 0 && parsed.templates !== null) {
				renderCache?.setPass1(
					currentSourcePath,
					source,
					folderConfig,
					templateRevision,
					parsed,
					referencesHost,
				);
			}
		}
		if (outerAbortController.signal.aborted || cycleSignal.aborted) {
			return;
		}

		if (parsed.env.diagnostics.length > 0 || parsed.templates === null) {
			const generation = ++renderGeneration;
			await plugin.query(Object.freeze({}), {
				referenceTimeMs,
				signal: cycleSignal,
				onReset,
				onSourcePathRename,
				includeHostInHash: false,
				...(currentSourcePath.length > 0 ? { sourcePath: currentSourcePath } : {}),
			});
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			const renderStartedAt = Date.now();
			const errorResult = await renderParsedRhizomeTemplate(
				source,
				parsed,
				Object.freeze({}),
				(query, heading) =>
					plugin.explainQuery(query, {
						referenceTimeMs,
						heading,
						...(currentSourcePath.length > 0 ? { sourcePath: currentSourcePath } : {}),
					}),
				buildRuntimeContext(plugin, referenceTimeMs, currentSourcePath, ctx, el),
			);
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			const durationMs = parseDurationMs + Math.max(0, Date.now() - renderStartedAt);
			logCodeBlockRenderResult(plugin, currentSourcePath, errorResult, durationMs);
			await renderIntoContainer(errorResult.markdown, generation, cycleSignal);
			return;
		}

		const queries = parsed.env.queries;
		const queryMap = Object.create(null) as Record<string, string>;
		for (const q of queries) {
			queryMap[q.name] = q.query;
		}
		const frozenQueryMap = Object.freeze(queryMap);
		const resolveCurrentHeadingLevel = (): number =>
			lookupHostHeadingLevel(plugin, currentSourcePath, ctx, el);

		const onUpdate = async (newPayload: VaultQueryResult): Promise<void> => {
			if (outerAbortController.signal.aborted || cycleSignal.aborted) {
				return;
			}
			const generation = ++renderGeneration;
			const updateStartedAt = Date.now();
			const runtimeCtx = buildRuntimeContext(
				plugin,
				updateStartedAt,
				currentSourcePath,
				ctx,
				el,
			);
			const currentHeadingLevel = runtimeCtx.headingLevel ?? 0;
			const currentTemplateRev = plugin.activeQueryRoster?.templateRevision ?? 0;
			const currentStateRev = plugin.activeQueryRoster?.stateRevision ?? 0;
			const payloadHash = hashVaultQueryResult(newPayload, {
				includeHost: referencesHost,
				headingLevel: currentHeadingLevel,
			});

			const updatedResult = await renderParsedRhizomeTemplate(
				source,
				parsed,
				newPayload,
				(query, heading) =>
					plugin.explainQuery(query, {
						referenceTimeMs: updateStartedAt,
						heading,
						...(currentSourcePath.length > 0 ? { sourcePath: currentSourcePath } : {}),
					}),
				runtimeCtx,
			);
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			if (updatedResult.ok && allExtractedQueriesExecutable(parsed, newPayload)) {
				renderCache?.setRender(
					currentSourcePath,
					source,
					currentHeadingLevel,
					folderConfig,
					currentTemplateRev,
					currentStateRev,
					payloadHash,
					newPayload,
					updatedResult,
				);
			}
			const updateDurationMs = Math.max(0, Date.now() - updateStartedAt);
			logCodeBlockRenderResult(plugin, currentSourcePath, updatedResult, updateDurationMs);
			await renderIntoContainer(updatedResult.markdown, generation, cycleSignal);
		};

		const initialGeneration = ++renderGeneration;
		const hasQueries = Object.keys(queryMap).length > 0;
		const initialHeadingLevel = resolveCurrentHeadingLevel();
		const onUnchangedPayload = (stateRev: number, unchangedPayloadHash: string): void => {
			if (outerAbortController.signal.aborted || cycleSignal.aborted) {
				return;
			}
			renderCache?.advanceStateRevision(
				currentSourcePath,
				source,
				resolveCurrentHeadingLevel(),
				folderConfig,
				plugin.activeQueryRoster?.templateRevision ?? 0,
				unchangedPayloadHash,
				stateRev,
			);
		};
		const stateRevisionBeforeQuery = plugin.activeQueryRoster?.stateRevision ?? 0;
		const remountHit = renderCache?.getRemountHit(
			currentSourcePath,
			source,
			initialHeadingLevel,
			folderConfig,
			templateRevision,
			stateRevisionBeforeQuery,
		);
		if (remountHit !== undefined) {
			plugin.activeQueryRoster?.register(
				frozenQueryMap,
				{
					referenceTimeMs,
					signal: cycleSignal,
					onReset,
					onSourcePathRename,
					onUnchangedPayload,
					includeHostInHash: referencesHost,
					headingLevel: resolveCurrentHeadingLevel,
					...(currentSourcePath.length > 0 ? { sourcePath: currentSourcePath } : {}),
				},
				remountHit.payload,
				hasQueries || currentSourcePath.length > 0 ? onUpdate : undefined,
			);
			const durationMs = Math.max(0, Date.now() - parseStartedAt);
			logCodeBlockRenderResult(
				plugin,
				currentSourcePath,
				remountHit.result,
				durationMs,
				'remount',
			);
			await renderIntoContainer(remountHit.result.markdown, initialGeneration, cycleSignal);
			return;
		}

		const initialPayload = await plugin.query(
			frozenQueryMap,
			{
				referenceTimeMs,
				signal: cycleSignal,
				onReset,
				onSourcePathRename,
				onUnchangedPayload,
				includeHostInHash: referencesHost,
				headingLevel: resolveCurrentHeadingLevel,
				...(currentSourcePath.length > 0 ? { sourcePath: currentSourcePath } : {}),
			},
			hasQueries || currentSourcePath.length > 0 ? onUpdate : undefined,
		);
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			initialGeneration !== renderGeneration
		) {
			return;
		}

		const runtimeCtx = buildRuntimeContext(plugin, referenceTimeMs, currentSourcePath, ctx, el);
		const currentHeadingLevel = runtimeCtx.headingLevel ?? 0;
		const currentTemplateRev = plugin.activeQueryRoster?.templateRevision ?? 0;
		const currentStateRev = plugin.activeQueryRoster?.stateRevision ?? 0;
		const allExecutable = allExtractedQueriesExecutable(parsed, initialPayload);
		const payloadHash = hashVaultQueryResult(initialPayload, {
			includeHost: referencesHost,
			headingLevel: currentHeadingLevel,
		});
		const cachedByPayload = allExecutable
			? renderCache?.getRenderByPayloadHash(
					currentSourcePath,
					source,
					currentHeadingLevel,
					folderConfig,
					currentTemplateRev,
					payloadHash,
				)
			: undefined;
		if (cachedByPayload !== undefined) {
			renderCache?.setRender(
				currentSourcePath,
				source,
				currentHeadingLevel,
				folderConfig,
				currentTemplateRev,
				currentStateRev,
				payloadHash,
				initialPayload,
				cachedByPayload,
			);
			logCodeBlockRenderResult(
				plugin,
				currentSourcePath,
				cachedByPayload,
				parseDurationMs,
				'payload',
			);
			await renderIntoContainer(cachedByPayload.markdown, initialGeneration, cycleSignal);
			return;
		}

		const renderStartedAt = Date.now();
		const initialResult = await renderParsedRhizomeTemplate(
			source,
			parsed,
			initialPayload,
			(query, heading) =>
				plugin.explainQuery(query, {
					referenceTimeMs,
					heading,
					...(currentSourcePath.length > 0 ? { sourcePath: currentSourcePath } : {}),
				}),
			runtimeCtx,
		);
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			initialGeneration !== renderGeneration
		) {
			return;
		}

		if (initialResult.ok && allExecutable) {
			renderCache?.setRender(
				currentSourcePath,
				source,
				currentHeadingLevel,
				folderConfig,
				currentTemplateRev,
				currentStateRev,
				payloadHash,
				initialPayload,
				initialResult,
			);
		}

		const durationMs = parseDurationMs + Math.max(0, Date.now() - renderStartedAt);
		logCodeBlockRenderResult(plugin, currentSourcePath, initialResult, durationMs);
		await renderIntoContainer(initialResult.markdown, initialGeneration, cycleSignal);
	};

	await runCycle();
}
