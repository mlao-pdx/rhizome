import { type Extension, type Range, StateEffect, type Text } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	hoverTooltip,
	type PluginValue,
	type Tooltip,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view';
import type { App } from 'obsidian';
import {
	initEngineConfig,
	type PropertyTypeRegistry,
	type ResolvedEngineConfig,
} from '@core/search';
import {
	analyzeRhizomeCodeBlock,
	type CodeBlockAnalysis,
	type CodeBlockDiagnosticSpan,
	type CodeBlockTokenKind,
} from '@core/templates';
import type { LoggerPort } from '@ports/logger-port';
import { loadVaultPropertyTypes } from '../vault-query-logging';

/**
 * Location and content slice of a fenced `rhizome` codeblock in a CodeMirror document.
 */
export interface FencedRhizomeBlock {
	readonly bodyFrom: number;
	readonly bodyTo: number;
	readonly source: string;
}

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})\s*(.*)$/;

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

const DIAG_DECORATIONS = {
	error: Decoration.mark({ class: 'cm-rhizome-diag-error' }),
	warning: Decoration.mark({ class: 'cm-rhizome-diag-warning' }),
	hint: Decoration.mark({ class: 'cm-rhizome-diag-hint' }),
} as const;

function resolveSystemTimeZone(): string {
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof tz === 'string' && tz.trim() ? tz.trim() : 'UTC';
	} catch {
		return 'UTC';
	}
}

/**
 * Finds fenced `rhizome` codeblocks within `doc` that intersect `[windowFrom, windowTo]`.
 */
export function findRhizomeCodeBlocks(
	doc: Text,
	windowFrom: number = 0,
	windowTo: number = doc.length,
): FencedRhizomeBlock[] {
	const blocks: FencedRhizomeBlock[] = [];
	const totalLines = doc.lines;
	let inFence = false;
	let fenceChars = '';
	let isRhizomeFence = false;
	let bodyFrom = 0;

	for (let lineNo = 1; lineNo <= totalLines; lineNo++) {
		const line = doc.line(lineNo);
		if (!inFence && line.from > windowTo) {
			break;
		}
		const match = FENCE_OPEN_RE.exec(line.text);
		if (!inFence) {
			if (match) {
				fenceChars = match[1] ?? '';
				const info = (match[2] ?? '').trim();
				inFence = true;
				isRhizomeFence = /^rhizome(?:\s|$)/i.test(info);
				bodyFrom = Math.min(doc.length, line.to + 1);
			}
		} else if (match) {
			const candidateFence = match[1] ?? '';
			const trailing = (match[2] ?? '').trim();
			if (
				candidateFence[0] === fenceChars[0] &&
				candidateFence.length >= fenceChars.length &&
				trailing.length === 0
			) {
				if (isRhizomeFence) {
					const bodyTo = Math.max(bodyFrom, line.from);
					if (bodyTo >= windowFrom && bodyFrom <= windowTo) {
						blocks.push({
							bodyFrom,
							bodyTo,
							source: doc.sliceString(bodyFrom, bodyTo),
						});
					}
				}
				inFence = false;
				fenceChars = '';
				isRhizomeFence = false;
			}
		}
	}

	if (inFence && isRhizomeFence) {
		const bodyTo = doc.length;
		if (bodyTo >= windowFrom && bodyFrom <= windowTo) {
			blocks.push({
				bodyFrom,
				bodyTo,
				source: doc.sliceString(bodyFrom, bodyTo),
			});
		}
	}

	return blocks;
}

function buildFallbackConfig(propertyTypes: PropertyTypeRegistry): ResolvedEngineConfig {
	const primary = initEngineConfig({
		timeZone: resolveSystemTimeZone(),
		propertyTypes,
	});
	if (primary.ok) {
		return primary.config;
	}
	const fallback = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
	if (!fallback.ok) {
		throw new Error('Failed to initialize fallback UTC engine config');
	}
	return fallback.config;
}

function renderDiagnosticTooltipDom(diags: readonly CodeBlockDiagnosticSpan[]): HTMLElement {
	const container = document.createElement('div');
	container.className = 'cm-rhizome-tooltip';

	for (const diag of diags) {
		const item = document.createElement('div');
		item.className = `cm-rhizome-tooltip-item cm-rhizome-tooltip-${diag.severity}`;

		const header = document.createElement('div');
		header.className = 'cm-rhizome-tooltip-header';

		const badge = document.createElement('span');
		badge.className = `cm-rhizome-tooltip-badge cm-rhizome-tooltip-badge-${diag.severity}`;
		badge.textContent = diag.severity.toUpperCase();
		header.appendChild(badge);

		const codeEl = document.createElement('code');
		codeEl.className = 'cm-rhizome-tooltip-code';
		codeEl.textContent = diag.code;
		header.appendChild(codeEl);

		item.appendChild(header);

		const issueEl = document.createElement('div');
		issueEl.className = 'cm-rhizome-tooltip-issue';
		issueEl.textContent = diag.issue;
		item.appendChild(issueEl);

		if (diag.hint) {
			const hintEl = document.createElement('div');
			hintEl.className = 'cm-rhizome-tooltip-hint';
			hintEl.textContent = `Fix: ${diag.hint}`;
			item.appendChild(hintEl);
		}

		container.appendChild(item);
	}

	return container;
}

/**
 * Creates the CodeMirror 6 editor extension providing syntax highlighting, diagnostic underlines,
 * and hover tooltips inside fenced `rhizome` codeblocks.
 */
export function createRhizomeEditorExtension(app: App, logger?: LoggerPort): Extension {
	let cachedConfig: ResolvedEngineConfig = buildFallbackConfig({});
	let refreshPending = false;
	const activeViews = new Set<EditorView>();
	const configRefreshEffect = StateEffect.define<void>();
	const analysisCache = new Map<string, CodeBlockAnalysis>();

	const getCachedAnalysis = (source: string): CodeBlockAnalysis => {
		const hit = analysisCache.get(source);
		if (hit) {
			return hit;
		}
		if (analysisCache.size >= 32) {
			const oldestKey = analysisCache.keys().next().value;
			if (oldestKey !== undefined) {
				analysisCache.delete(oldestKey);
			}
		}
		const computed = analyzeRhizomeCodeBlock(source, cachedConfig, Date.now());
		analysisCache.set(source, computed);
		return computed;
	};

	const refreshPropertyTypes = (): void => {
		if (refreshPending) {
			return;
		}
		refreshPending = true;
		void loadVaultPropertyTypes(app, logger)
			.then((registry) => {
				cachedConfig = buildFallbackConfig(registry);
				analysisCache.clear();
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
				if (update.docChanged || update.viewportChanged || configChanged) {
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
				if (blocks.length === 0) {
					return Decoration.none;
				}

				const ranges: Array<Range<Decoration>> = [];

				for (const block of blocks) {
					const analysis = getCachedAnalysis(block.source);

					for (const tok of analysis.tokens) {
						const from = block.bodyFrom + tok.startOffset;
						const to = block.bodyFrom + tok.endOffset;
						if (to > from && to <= view.state.doc.length) {
							ranges.push(TOKEN_DECORATIONS[tok.kind].range(from, to));
						}
					}

					for (const diag of analysis.diagnostics) {
						const from = block.bodyFrom + diag.startOffset;
						const to = Math.min(
							view.state.doc.length,
							Math.max(from + 1, block.bodyFrom + diag.endOffset),
						);
						if (to > from) {
							ranges.push(DIAG_DECORATIONS[diag.severity].range(from, to));
						}
					}
				}

				return Decoration.set(ranges, true);
			}
		},
		{
			decorations: (v) => v.decorations,
		},
	);

	const diagnosticHover = hoverTooltip((view: EditorView, pos: number): Tooltip | null => {
		const blocks = findRhizomeCodeBlocks(view.state.doc, pos, pos);
		const block = blocks.find((b) => pos >= b.bodyFrom && pos <= b.bodyTo);
		if (!block) {
			return null;
		}

		const relPos = pos - block.bodyFrom;
		const analysis = getCachedAnalysis(block.source);
		const matching = analysis.diagnostics.filter(
			(d) => relPos >= d.startOffset && relPos <= Math.max(d.startOffset + 1, d.endOffset),
		);
		if (matching.length === 0) {
			return null;
		}

		const first = matching[0]!;
		const from = block.bodyFrom + first.startOffset;
		const to = Math.min(
			view.state.doc.length,
			Math.max(from + 1, block.bodyFrom + first.endOffset),
		);

		return {
			pos: from,
			end: to,
			above: true,
			create() {
				return { dom: renderDiagnosticTooltipDom(matching) };
			},
		};
	});

	return [highlighterPlugin, diagnosticHover];
}
