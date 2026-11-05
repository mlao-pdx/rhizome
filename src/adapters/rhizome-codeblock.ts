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
	buildHostNoteQuery,
	HOST_QUERY_KEY,
	parseRhizomeTemplatePass1Async,
	renderParsedRhizomeTemplate,
	resolveCodeBlockHeadingLevel,
	type TemplateRenderResult,
	type TemplateRuntimeContext,
} from '@core/templates';
import type RhizomePlugin from '../main';
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
	const sourcePath = typeof ctx.sourcePath === 'string' ? ctx.sourcePath : '';

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
		await MarkdownRenderer.render(plugin.app, markdown, el, sourcePath, renderChild);
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

		const parsed = await parseRhizomeTemplatePass1Async(
			source,
			{
				templatesFolder: plugin.settings.templatesFolder,
				partialsFolder: plugin.settings.partialsFolder,
				layoutsFolder: plugin.settings.layoutsFolder,
				configDir: plugin.app.vault.configDir,
			},
			(vaultRelativePath) => readVaultTemplateNote(plugin, vaultRelativePath),
		);
		const parseDurationMs = Math.max(0, Date.now() - parseStartedAt);
		if (outerAbortController.signal.aborted || cycleSignal.aborted) {
			return;
		}

		if (parsed.env.diagnostics.length > 0 || parsed.templates === null) {
			const generation = ++renderGeneration;
			await plugin.query(Object.freeze({}), {
				referenceTimeMs,
				signal: cycleSignal,
				onReset,
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
				(query, heading) => plugin.explainQuery(query, { referenceTimeMs, heading }),
				buildRuntimeContext(plugin, referenceTimeMs, sourcePath, ctx, el),
			);
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			const durationMs = parseDurationMs + Math.max(0, Date.now() - renderStartedAt);
			logCodeBlockRenderResult(plugin, sourcePath, errorResult, durationMs);
			await renderIntoContainer(errorResult.markdown, generation, cycleSignal);
			return;
		}

		const queries = parsed.env.queries;
		const queryMap = Object.create(null) as Record<string, string>;
		if (sourcePath.length > 0) {
			queryMap[HOST_QUERY_KEY] = buildHostNoteQuery(sourcePath);
		}
		for (const q of queries) {
			queryMap[q.name] = q.query;
		}

		const onUpdate = async (newPayload: VaultQueryResult): Promise<void> => {
			if (outerAbortController.signal.aborted || cycleSignal.aborted) {
				return;
			}
			const generation = ++renderGeneration;
			const updateStartedAt = Date.now();
			const updatedResult = await renderParsedRhizomeTemplate(
				source,
				parsed,
				newPayload,
				(query, heading) =>
					plugin.explainQuery(query, { referenceTimeMs: updateStartedAt, heading }),
				buildRuntimeContext(plugin, updateStartedAt, sourcePath, ctx, el),
			);
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			const updateDurationMs = Math.max(0, Date.now() - updateStartedAt);
			logCodeBlockRenderResult(plugin, sourcePath, updatedResult, updateDurationMs);
			await renderIntoContainer(updatedResult.markdown, generation, cycleSignal);
		};

		const initialGeneration = ++renderGeneration;
		const hasQueries = Object.keys(queryMap).length > 0;
		const initialPayload = await plugin.query(
			Object.freeze(queryMap),
			{ referenceTimeMs, signal: cycleSignal, onReset },
			hasQueries ? onUpdate : undefined,
		);
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			initialGeneration !== renderGeneration
		) {
			return;
		}

		const renderStartedAt = Date.now();
		const initialResult = await renderParsedRhizomeTemplate(
			source,
			parsed,
			initialPayload,
			(query, heading) => plugin.explainQuery(query, { referenceTimeMs, heading }),
			buildRuntimeContext(plugin, referenceTimeMs, sourcePath, ctx, el),
		);
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			initialGeneration !== renderGeneration
		) {
			return;
		}

		const durationMs = parseDurationMs + Math.max(0, Date.now() - renderStartedAt);
		logCodeBlockRenderResult(plugin, sourcePath, initialResult, durationMs);
		await renderIntoContainer(initialResult.markdown, initialGeneration, cycleSignal);
	};

	await runCycle();
}
