import {
	type MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	normalizePath,
} from 'obsidian';
import { hasInternalRhizomeFlag, INTERNAL_RHIZOME_CODES } from '@core/search';
import { renderRhizomeTemplate } from '@core/templates';
import type RhizomePlugin from '../main';
import { markSensitive } from './logger-format';

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

/**
 * Processes a fenced `rhizome` Markdown codeblock by executing `renderRhizomeTemplate`
 * against a pinned `referenceTimeMs` snapshot and rendering the resulting Markdown
 * into `el` via `MarkdownRenderer.render`.
 */
export async function processRhizomeCodeBlock(
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	plugin: RhizomePlugin,
): Promise<void> {
	const startedAt = Date.now();
	const referenceTimeMs = startedAt;

	const child = new MarkdownRenderChild(el);
	ctx.addChild(child);

	const result = await renderRhizomeTemplate(source, {
		runQueries: (queries) => plugin.query(queries, { referenceTimeMs }),
		explainQuery: (query, heading) => plugin.explainQuery(query, { referenceTimeMs, heading }),
		readTemplateFile: (vaultRelativePath) => readVaultTemplateNote(plugin, vaultRelativePath),
		folders: {
			templatesFolder: plugin.settings.templatesFolder,
			partialsFolder: plugin.settings.partialsFolder,
			layoutsFolder: plugin.settings.layoutsFolder,
			configDir: plugin.app.vault.configDir,
		},
	});

	const durationMs = Math.max(0, Date.now() - startedAt);
	const sourcePath = typeof ctx.sourcePath === 'string' ? ctx.sourcePath : '';

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

	await MarkdownRenderer.render(plugin.app, result.markdown, el, sourcePath, child);
}
