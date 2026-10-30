import {
	type MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	normalizePath,
} from 'obsidian';
import { hasInternalRhizomeFlag, INTERNAL_RHIZOME_CODES } from '@core/search';
import {
	parseRhizomeTemplatePass1,
	renderParsedRhizomeTemplate,
	type TemplateRenderResult,
} from '@core/templates';
import type RhizomePlugin from '../main';
import { markSensitive } from './logger-format';
import type { VaultQueryResult } from './vault-query-runner';

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
 * Processes a fenced `rhizome` Markdown codeblock by parsing its template in Pass 1,
 * subscribing to reactive query updates via `plugin.query(..., onUpdate)` when queries
 * are present, and rendering the resulting Markdown into `el` via `MarkdownRenderer.render`.
 */
export async function processRhizomeCodeBlock(
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	plugin: RhizomePlugin,
): Promise<void> {
	const startedAt = Date.now();
	const referenceTimeMs = startedAt;
	const sourcePath = typeof ctx.sourcePath === 'string' ? ctx.sourcePath : '';

	const outerChild = new MarkdownRenderChild(el);
	ctx.addChild(outerChild);
	const abortController = new AbortController();
	outerChild.register(() => abortController.abort());

	let activeRenderChild: MarkdownRenderChild | null = null;
	let renderGeneration = 0;
	const renderIntoContainer = async (markdown: string, generation: number): Promise<void> => {
		if (abortController.signal.aborted || generation !== renderGeneration) {
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

	const parsed = parseRhizomeTemplatePass1(
		source,
		{
			templatesFolder: plugin.settings.templatesFolder,
			partialsFolder: plugin.settings.partialsFolder,
			layoutsFolder: plugin.settings.layoutsFolder,
			configDir: plugin.app.vault.configDir,
		},
		(vaultRelativePath) => readVaultTemplateNote(plugin, vaultRelativePath),
	);

	if (parsed.env.diagnostics.length > 0 || parsed.templates === null) {
		const generation = ++renderGeneration;
		const errorResult = await renderParsedRhizomeTemplate(
			source,
			parsed,
			Object.freeze({}),
			(query, heading) => plugin.explainQuery(query, { referenceTimeMs, heading }),
		);
		if (abortController.signal.aborted || generation !== renderGeneration) {
			return;
		}
		const durationMs = Math.max(0, Date.now() - startedAt);
		logCodeBlockRenderResult(plugin, sourcePath, errorResult, durationMs);
		await renderIntoContainer(errorResult.markdown, generation);
		return;
	}

	const queries = parsed.env.queries;
	if (queries.length === 0) {
		const generation = ++renderGeneration;
		const result = await renderParsedRhizomeTemplate(
			source,
			parsed,
			Object.freeze({}),
			(query, heading) => plugin.explainQuery(query, { referenceTimeMs, heading }),
		);
		if (abortController.signal.aborted || generation !== renderGeneration) {
			return;
		}
		const durationMs = Math.max(0, Date.now() - startedAt);
		logCodeBlockRenderResult(plugin, sourcePath, result, durationMs);
		await renderIntoContainer(result.markdown, generation);
		return;
	}

	const queryMap = Object.create(null) as Record<string, string>;
	for (const q of queries) {
		queryMap[q.name] = q.query;
	}

	const onUpdate = async (newPayload: VaultQueryResult): Promise<void> => {
		if (abortController.signal.aborted) {
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
		);
		if (abortController.signal.aborted || generation !== renderGeneration) {
			return;
		}
		const updateDurationMs = Math.max(0, Date.now() - updateStartedAt);
		logCodeBlockRenderResult(plugin, sourcePath, updatedResult, updateDurationMs);
		await renderIntoContainer(updatedResult.markdown, generation);
	};

	const initialGeneration = ++renderGeneration;
	const initialPayload = await plugin.query(
		Object.freeze(queryMap),
		{ referenceTimeMs, signal: abortController.signal },
		onUpdate,
	);
	if (abortController.signal.aborted || initialGeneration !== renderGeneration) {
		return;
	}

	const initialResult = await renderParsedRhizomeTemplate(
		source,
		parsed,
		initialPayload,
		(query, heading) => plugin.explainQuery(query, { referenceTimeMs, heading }),
	);
	if (abortController.signal.aborted || initialGeneration !== renderGeneration) {
		return;
	}

	const durationMs = Math.max(0, Date.now() - startedAt);
	logCodeBlockRenderResult(plugin, sourcePath, initialResult, durationMs);
	await renderIntoContainer(initialResult.markdown, initialGeneration);
}
