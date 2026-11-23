import { type Extension, type Range, StateEffect } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view';
import type { App } from 'obsidian';
import { analyzeInlineRhizomeSpan, type CodeBlockTokenKind } from '@core/templates';
import type { LoggerPort } from '@ports/logger-port';
import type { BacklinkIndex } from '../backlink-index';
import type { InlineHostResolver } from '../inline-host-resolver';
import type { NormalizedDocumentCache } from '../normalized-document-cache';
import { loadVaultPropertyTypes } from '../vault-query-logging';
import { buildFallbackConfig, createRhizomeAnalysisCache } from './rhizome-analysis-cache';
import { findRhizomeCodeBlocks } from './rhizome-code-blocks';
import {
	createInlineLivePreviewExtension,
	getInlineLivePreviewDecorations,
	hostInlineRefreshEffect,
	setCompositionFrozenEffect,
} from './rhizome-inline-live-preview';
import { findRhizomeInlineSpans } from './rhizome-inline-spans';
import { createRhizomeLintExtension } from './rhizome-lint';

export { findRhizomeCodeBlocks, type FencedRhizomeBlock } from './rhizome-code-blocks';
export { resolveEditorHostFile } from './rhizome-analysis-cache';
export {
	findRhizomeInlineSpans,
	getCachedRhizomeInlineSpans,
	type ScannedInlineSpan,
} from './rhizome-inline-spans';
export { getInlineLivePreviewDecorations, hostInlineRefreshEffect, setCompositionFrozenEffect };

const TOKEN_DECORATIONS: Readonly<Record<CodeBlockTokenKind, Decoration>> = {
	'liquid-delimiter': Decoration.mark({ class: 'cm-rhizome-tok-liquid-delimiter' }),
	'liquid-keyword': Decoration.mark({ class: 'cm-rhizome-tok-liquid-keyword' }),
	'liquid-filter': Decoration.mark({ class: 'cm-rhizome-tok-liquid-filter' }),
	'liquid-variable': Decoration.mark({ class: 'cm-rhizome-tok-liquid-variable' }),
	'liquid-string': Decoration.mark({ class: 'cm-rhizome-tok-liquid-string' }),
	'liquid-number': Decoration.mark({ class: 'cm-rhizome-tok-liquid-number' }),
	comment: Decoration.mark({ class: 'cm-rhizome-tok-comment' }),
	'query-scope': Decoration.mark({ class: 'cm-rhizome-tok-query-scope' }),
	'query-property': Decoration.mark({ class: 'cm-rhizome-tok-query-property' }),
	'query-keyword': Decoration.mark({ class: 'cm-rhizome-tok-query-keyword' }),
	'query-operator': Decoration.mark({ class: 'cm-rhizome-tok-query-operator' }),
	'query-date': Decoration.mark({ class: 'cm-rhizome-tok-query-date' }),
	'query-regex': Decoration.mark({ class: 'cm-rhizome-tok-query-regex' }),
	'query-string': Decoration.mark({ class: 'cm-rhizome-tok-query-string' }),
	'query-tag': Decoration.mark({ class: 'cm-rhizome-tok-query-tag' }),
	'query-wikilink': Decoration.mark({ class: 'cm-rhizome-tok-query-wikilink' }),
	'query-identifier': Decoration.mark({ class: 'cm-rhizome-tok-query-identifier' }),
	'query-paren': Decoration.mark({ class: 'cm-rhizome-tok-query-paren' }),
};

/**
 * Creates the CodeMirror 6 editor extension providing syntax highlighting inside fenced `rhizome`
 * codeblocks and lint-backed diagnostic underlines and tooltips.
 */
export function createRhizomeEditorExtension(
	app: App,
	logger?: LoggerPort,
	backlinkIndex?: BacklinkIndex,
	documentCache?: NormalizedDocumentCache,
	inlineHostResolver?: InlineHostResolver,
	waitForVaultReady?: (signal?: AbortSignal) => Promise<void>,
): Extension {
	let refreshPending = false;
	const activeViews = new Set<EditorView>();
	const configRefreshEffect = StateEffect.define<void>();
	const analysisCache = createRhizomeAnalysisCache(app, backlinkIndex, documentCache);

	const refreshPropertyTypes = (): void => {
		if (refreshPending) {
			return;
		}
		refreshPending = true;
		void loadVaultPropertyTypes(app, logger)
			.then((registry) => {
				analysisCache.setConfig(buildFallbackConfig(registry));
				for (const view of activeViews) {
					view.dispatch({ effects: configRefreshEffect.of(undefined) });
				}
			})
			.finally(() => {
				refreshPending = false;
			});
	};

	refreshPropertyTypes();

	const highlighterPlugin = ViewPlugin.fromClass(
		class implements PluginValue {
			decorations: DecorationSet;
			private readonly view: EditorView;

			constructor(view: EditorView) {
				this.view = view;
				activeViews.add(view);
				this.decorations = this.computeDecorations(view);
			}

			update(update: ViewUpdate): void {
				const configChanged = update.transactions.some((tr) =>
					tr.effects.some((e) => e.is(configRefreshEffect)),
				);
				const prevInlineDecos = getInlineLivePreviewDecorations(update.startState);
				const nextInlineDecos = getInlineLivePreviewDecorations(update.state);
				if (
					update.docChanged ||
					update.viewportChanged ||
					configChanged ||
					prevInlineDecos !== nextInlineDecos
				) {
					this.decorations = this.computeDecorations(update.view);
				}
			}

			destroy(): void {
				activeViews.delete(this.view);
			}

			private computeDecorations(view: EditorView): DecorationSet {
				const visible = view.visibleRanges;
				const winFrom = visible.length > 0 ? visible[0]!.from : 0;
				const winTo =
					visible.length > 0 ? visible[visible.length - 1]!.to : view.state.doc.length;
				const blocks = findRhizomeCodeBlocks(view.state.doc, winFrom, winTo);
				const inlineSpans = findRhizomeInlineSpans(view.state.doc, winFrom, winTo);
				if (blocks.length === 0 && inlineSpans.length === 0) {
					return Decoration.none;
				}

				const ranges: Array<Range<Decoration>> = [];

				for (const block of blocks) {
					const analysis = analysisCache.getCachedAnalysis(block.source, view);

					for (const tok of analysis.tokens) {
						const from = block.bodyFrom + tok.startOffset;
						const to = block.bodyFrom + tok.endOffset;
						if (to > from && to <= view.state.doc.length) {
							ranges.push(TOKEN_DECORATIONS[tok.kind].range(from, to));
						}
					}
				}

				if (inlineSpans.length > 0) {
					const replacedDecos = getInlineLivePreviewDecorations(view.state);
					for (const span of inlineSpans) {
						let isReplaced = false;
						replacedDecos.between(span.spanFrom, span.spanTo, (from, to) => {
							if (from <= span.spanFrom && to >= span.spanTo) {
								isReplaced = true;
								return false;
							}
							return undefined;
						});
						if (isReplaced) {
							continue;
						}
						const inlineAnalysis = analyzeInlineRhizomeSpan(span.rawInterior, {
							unescapeTablePipes: span.unescapeTablePipes,
						});
						for (const tok of inlineAnalysis.tokens) {
							const from = span.interiorFrom + tok.startOffset;
							const to = span.interiorFrom + tok.endOffset;
							if (to > from && to <= view.state.doc.length) {
								ranges.push(TOKEN_DECORATIONS[tok.kind].range(from, to));
							}
						}
					}
				}

				return ranges.length === 0 ? Decoration.none : Decoration.set(ranges, true);
			}
		},
		{
			decorations: (v) => v.decorations,
		},
	);

	const extensions: Extension[] = [];
	if (inlineHostResolver) {
		extensions.push(
			createInlineLivePreviewExtension(
				app,
				inlineHostResolver,
				configRefreshEffect,
				waitForVaultReady,
			),
		);
	}
	extensions.push(
		highlighterPlugin,
		createRhizomeLintExtension(
			(source, view) => analysisCache.getCachedAnalysis(source, view),
			configRefreshEffect,
		),
	);
	return extensions;
}
