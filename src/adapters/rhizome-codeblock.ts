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
import {
	allExtractedQueriesExecutable,
	countExtractedQueryRecords,
	exceedsLargeMarkdownThreshold,
	formatLargeRenderStandbyCallout,
	LARGE_MARKDOWN_CHAR_THRESHOLD,
	LARGE_MARKDOWN_LINE_THRESHOLD,
	LARGE_QUERY_RECORD_THRESHOLD,
	measureMarkdownOutput,
} from './codeblock-render-cache';
import { markSensitive } from './logger-format';
import { resolveDefaultTimeZone, type VaultQueryResult } from './vault-query-runner';

export {
	countExtractedQueryRecords,
	exceedsLargeMarkdownThreshold,
	formatLargeRenderStandbyCallout,
	LARGE_MARKDOWN_CHAR_THRESHOLD,
	LARGE_MARKDOWN_LINE_THRESHOLD,
	LARGE_QUERY_RECORD_THRESHOLD,
	measureMarkdownOutput,
	resolveCodeBlockHeadingLevel,
};

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

interface CodeBlockRenderTelemetry {
	readonly parseMs: number;
	readonly liquidMs: number;
	readonly markdownRenderMs: number;
	readonly records: number;
	readonly outputChars: number;
	readonly outputLines: number;
	readonly standbyShown?: boolean | undefined;
	readonly cacheHit?: 'remount' | 'payload' | undefined;
}

function logCodeBlockRenderResult(
	plugin: RhizomePlugin,
	sourcePath: string,
	result: TemplateRenderResult,
	telemetry: CodeBlockRenderTelemetry,
): void {
	const durationMs = telemetry.parseMs + telemetry.liquidMs + telemetry.markdownRenderMs;
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
				parseMs: telemetry.parseMs,
				liquidMs: telemetry.liquidMs,
				markdownRenderMs: telemetry.markdownRenderMs,
				records: telemetry.records,
				outputChars: telemetry.outputChars,
				outputLines: telemetry.outputLines,
				...(telemetry.standbyShown ? { standbyShown: true } : {}),
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
				parseMs: telemetry.parseMs,
				liquidMs: telemetry.liquidMs,
				markdownRenderMs: telemetry.markdownRenderMs,
				records: telemetry.records,
				outputChars: telemetry.outputChars,
				outputLines: telemetry.outputLines,
				...(telemetry.standbyShown ? { standbyShown: true } : {}),
				...(telemetry.cacheHit !== undefined
					? { cached: true, cacheHit: telemetry.cacheHit }
					: {}),
			},
		);
	}
}

const PAINT_YIELD_FALLBACK_MS = 32;

/**
 * Yields to the browser rendering pipeline (`requestAnimationFrame` followed by a macrotask,
 * bounded by a `32 ms` fallback timer when the window is occluded or minimized) so a standby
 * callout mounted into `el` is composited and painted before heavy synchronous template or
 * DOM work blocks the main thread. Resolves early if either signal aborts.
 */
function yieldForBrowserPaint(outerSignal: AbortSignal, cycleSignal: AbortSignal): Promise<void> {
	if (outerSignal.aborted || cycleSignal.aborted) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		let settled = false;
		let timeoutId: number | null = null;
		let fallbackTimeoutId: number | null = null;
		let rafId: number | null = null;

		const finish = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
				window.cancelAnimationFrame(rafId);
				rafId = null;
			}
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
				timeoutId = null;
			}
			if (fallbackTimeoutId !== null) {
				window.clearTimeout(fallbackTimeoutId);
				fallbackTimeoutId = null;
			}
			outerSignal.removeEventListener('abort', finish);
			cycleSignal.removeEventListener('abort', finish);
			resolve();
		};

		outerSignal.addEventListener('abort', finish, { once: true });
		cycleSignal.addEventListener('abort', finish, { once: true });

		const scheduleMacrotask = (): void => {
			rafId = null;
			if (settled || outerSignal.aborted || cycleSignal.aborted) {
				finish();
				return;
			}
			timeoutId = window.setTimeout(finish, 0);
		};

		if (typeof window.requestAnimationFrame === 'function') {
			rafId = window.requestAnimationFrame(scheduleMacrotask);
			fallbackTimeoutId = window.setTimeout(finish, PAINT_YIELD_FALLBACK_MS);
		} else {
			scheduleMacrotask();
		}
	});
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
	let hasCommittedRender = false;
	let renderGeneration = 0;
	const renderIntoContainer = async (
		markdown: string,
		generation: number,
		cycleSignal: AbortSignal,
	): Promise<number | null> => {
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			generation !== renderGeneration
		) {
			return null;
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
		const markdownStartedAt = Date.now();
		await MarkdownRenderer.render(plugin.app, markdown, el, currentSourcePath, renderChild);
		const markdownRenderMs = Math.max(0, Date.now() - markdownStartedAt);
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			generation !== renderGeneration
		) {
			return null;
		}
		return markdownRenderMs;
	};

	const showStandbyCalloutAndYield = async (
		totalRecords: number,
		generation: number,
		cycleSignal: AbortSignal,
	): Promise<boolean> => {
		const standbyMarkdown = formatLargeRenderStandbyCallout(totalRecords);
		const rendered = await renderIntoContainer(standbyMarkdown, generation, cycleSignal);
		if (rendered === null) {
			return false;
		}
		await yieldForBrowserPaint(outerAbortController.signal, cycleSignal);
		return (
			!outerAbortController.signal.aborted &&
			!cycleSignal.aborted &&
			generation === renderGeneration
		);
	};

	const commitCycleRender = async (
		result: TemplateRenderResult,
		options: {
			readonly generation: number;
			readonly cycleSignal: AbortSignal;
			readonly totalRecords: number;
			readonly parseMs: number;
			readonly liquidMs: number;
			readonly standbyAlreadyShown?: boolean | undefined;
			readonly cacheHit?: 'remount' | 'payload' | undefined;
		},
	): Promise<void> => {
		const outputMetrics = measureMarkdownOutput(result.markdown);
		let standbyShown = options.standbyAlreadyShown === true;
		if (
			!hasCommittedRender &&
			!standbyShown &&
			result.ok &&
			exceedsLargeMarkdownThreshold(outputMetrics)
		) {
			const ok = await showStandbyCalloutAndYield(
				options.totalRecords,
				options.generation,
				options.cycleSignal,
			);
			if (!ok) {
				return;
			}
			standbyShown = true;
		}
		const markdownRenderMs = await renderIntoContainer(
			result.markdown,
			options.generation,
			options.cycleSignal,
		);
		if (markdownRenderMs === null) {
			return;
		}
		hasCommittedRender = true;
		logCodeBlockRenderResult(plugin, currentSourcePath, result, {
			parseMs: options.parseMs,
			liquidMs: options.liquidMs,
			markdownRenderMs,
			records: options.totalRecords,
			outputChars: outputMetrics.chars,
			outputLines: outputMetrics.lines,
			standbyShown,
			cacheHit: options.cacheHit,
		});
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
			const liquidMs = Math.max(0, Date.now() - renderStartedAt);
			const outputMetrics = measureMarkdownOutput(errorResult.markdown);
			const markdownRenderMs = await renderIntoContainer(
				errorResult.markdown,
				generation,
				cycleSignal,
			);
			if (markdownRenderMs === null) {
				return;
			}
			hasCommittedRender = true;
			logCodeBlockRenderResult(plugin, currentSourcePath, errorResult, {
				parseMs: parseDurationMs,
				liquidMs,
				markdownRenderMs,
				records: 0,
				outputChars: outputMetrics.chars,
				outputLines: outputMetrics.lines,
			});
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
			const liquidMs = Math.max(0, Date.now() - updateStartedAt);
			const totalRecords = countExtractedQueryRecords(parsed, newPayload);
			const outputMetrics = measureMarkdownOutput(updatedResult.markdown);
			const markdownRenderMs = await renderIntoContainer(
				updatedResult.markdown,
				generation,
				cycleSignal,
			);
			if (markdownRenderMs === null) {
				return;
			}
			hasCommittedRender = true;
			logCodeBlockRenderResult(plugin, currentSourcePath, updatedResult, {
				parseMs: 0,
				liquidMs,
				markdownRenderMs,
				records: totalRecords,
				outputChars: outputMetrics.chars,
				outputLines: outputMetrics.lines,
			});
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
			const totalRecords = countExtractedQueryRecords(parsed, remountHit.payload);
			await commitCycleRender(remountHit.result, {
				generation: initialGeneration,
				cycleSignal,
				totalRecords,
				parseMs: parseDurationMs,
				liquidMs: 0,
				cacheHit: 'remount',
			});
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

		const totalRecords = countExtractedQueryRecords(parsed, initialPayload);
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
			await commitCycleRender(cachedByPayload, {
				generation: initialGeneration,
				cycleSignal,
				totalRecords,
				parseMs: parseDurationMs,
				liquidMs: 0,
				cacheHit: 'payload',
			});
			return;
		}

		let standbyShown = false;
		if (!hasCommittedRender && totalRecords >= LARGE_QUERY_RECORD_THRESHOLD) {
			const ok = await showStandbyCalloutAndYield(
				totalRecords,
				initialGeneration,
				cycleSignal,
			);
			if (!ok) {
				return;
			}
			standbyShown = true;
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
		const liquidMs = Math.max(0, Date.now() - renderStartedAt);
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

		await commitCycleRender(initialResult, {
			generation: initialGeneration,
			cycleSignal,
			totalRecords,
			parseMs: parseDurationMs,
			liquidMs,
			standbyAlreadyShown: standbyShown,
		});
	};

	await runCycle();
}
