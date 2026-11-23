import {
	type EditorState,
	type Extension,
	Facet,
	type Range,
	StateEffect,
	type StateEffectType,
	StateField,
} from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view';
import { type App, editorInfoField, editorLivePreviewField } from 'obsidian';
import { evaluateInlineRhizomeExpression } from '@core/templates';
import type { InlineHostResolver } from '../inline-host-resolver';
import { resolveEditorHostFile } from './rhizome-analysis-cache';
import { getCachedRhizomeInlineSpans, type ScannedInlineSpan } from './rhizome-inline-spans';
import { InlineRhizomeWidget } from './rhizome-inline-widget';

/**
 * StateEffect toggling IME composition freeze on `inlineLivePreviewField`.
 */
export const setCompositionFrozenEffect = StateEffect.define<boolean>();

/**
 * StateEffect dispatched when the editor's host note metadata, backlinks, or property types change.
 */
export const hostInlineRefreshEffect = StateEffect.define<void>();

/**
 * Value held by `InlineLivePreviewField`, pairing the active replacement `DecorationSet` with
 * the per-editor IME composition freeze flag.
 */
export interface InlineLivePreviewFieldValue {
	readonly decorations: DecorationSet;
	readonly compositionFrozen: boolean;
}

const inlineDecorationsFacet = Facet.define<DecorationSet, DecorationSet>({
	combine: (values) => values[0] ?? Decoration.none,
});

/**
 * Reads the active Live Preview replacement `DecorationSet` from `state` (`Decoration.none` in
 * Source mode or when no inline Live Preview field is installed on `state`).
 */
export function getInlineLivePreviewDecorations(state: EditorState): DecorationSet {
	return state.facet(inlineDecorationsFacet);
}

function isLivePreviewActive(state: EditorState): boolean {
	return state.field(editorLivePreviewField, false) === true;
}

function resolveStateSourcePath(state: EditorState): string {
	return state.field(editorInfoField, false)?.file?.path ?? '';
}

function selectionTouchesRange(state: EditorState, spanFrom: number, spanTo: number): boolean {
	const ranges = state.selection.ranges;
	for (let i = 0; i < ranges.length; i++) {
		const r = ranges[i]!;
		if (r.from <= spanTo && r.to >= spanFrom) {
			return true;
		}
	}
	return false;
}

function didTouchedSpansChange(
	prevState: EditorState,
	nextState: EditorState,
	spans: readonly ScannedInlineSpan[],
): boolean {
	for (let i = 0; i < spans.length; i++) {
		const span = spans[i]!;
		if (
			selectionTouchesRange(prevState, span.spanFrom, span.spanTo) !==
			selectionTouchesRange(nextState, span.spanFrom, span.spanTo)
		) {
			return true;
		}
	}
	return false;
}

function computeLivePreviewDecorations(
	state: EditorState,
	app: App,
	inlineHostResolver: InlineHostResolver,
): DecorationSet {
	if (!isLivePreviewActive(state)) {
		return Decoration.none;
	}
	const spans = getCachedRhizomeInlineSpans(state.doc);
	if (spans.length === 0) {
		return Decoration.none;
	}

	const sourcePath = resolveStateSourcePath(state);
	const resolvedHost = inlineHostResolver.resolveSync(sourcePath);
	const baseRuntimeCtx = inlineHostResolver.buildRuntimeContext(sourcePath, 0);
	const items: Array<Range<Decoration>> = [];

	for (let i = 0; i < spans.length; i++) {
		const span = spans[i]!;
		if (selectionTouchesRange(state, span.spanFrom, span.spanTo)) {
			continue;
		}
		const runtimeCtx =
			span.headingLevel === 0
				? baseRuntimeCtx
				: { ...baseRuntimeCtx, headingLevel: span.headingLevel };
		const evalResult = evaluateInlineRhizomeExpression(
			span.expr,
			resolvedHost.hostMatch,
			runtimeCtx,
		);
		if (!evalResult.ok) {
			inlineHostResolver.logInlineWarningOnce(sourcePath, span.expr, evalResult.diagnostic);
		}
		const widget = new InlineRhizomeWidget({
			app,
			expr: span.expr,
			sourcePath,
			headingLevel: span.headingLevel,
			hostRevisionHash: resolvedHost.revisionHash,
			depth: 1,
			spanFrom: span.spanFrom,
			spanTo: span.spanTo,
			backtickCount: span.backtickCount,
			result: evalResult,
		});
		items.push(Decoration.replace({ widget }).range(span.spanFrom, span.spanTo));
	}

	return items.length === 0 ? Decoration.none : Decoration.set(items, true);
}

/**
 * Creates the CodeMirror 6 Live Preview `StateField` and companion `ViewPlugin` (IME composition
 * freeze + per-editor `InlineHostResolver` subscription) for inline `◊ <expr>` expressions.
 */
export function createInlineLivePreviewExtension(
	app: App,
	inlineHostResolver: InlineHostResolver,
	configRefreshEffect?: StateEffectType<void>,
	waitForVaultReady?: (signal?: AbortSignal) => Promise<void>,
): Extension {
	const inlineLivePreviewField = StateField.define<InlineLivePreviewFieldValue>({
		create(state) {
			return {
				decorations: computeLivePreviewDecorations(state, app, inlineHostResolver),
				compositionFrozen: false,
			};
		},
		update(prev, tr) {
			let compositionFrozen = prev.compositionFrozen;
			let hostRefreshed = false;
			for (let i = 0; i < tr.effects.length; i++) {
				const eff = tr.effects[i]!;
				if (eff.is(setCompositionFrozenEffect)) {
					compositionFrozen = eff.value;
				} else if (
					eff.is(hostInlineRefreshEffect) ||
					(configRefreshEffect !== undefined && eff.is(configRefreshEffect))
				) {
					hostRefreshed = true;
				}
			}

			const livePreviewNow = isLivePreviewActive(tr.state);
			if (!livePreviewNow) {
				if (
					prev.decorations === Decoration.none &&
					prev.compositionFrozen === compositionFrozen
				) {
					return prev;
				}
				return { decorations: Decoration.none, compositionFrozen };
			}

			if (compositionFrozen) {
				const mapped = tr.docChanged ? prev.decorations.map(tr.changes) : prev.decorations;
				if (mapped === prev.decorations && prev.compositionFrozen === compositionFrozen) {
					return prev;
				}
				return { decorations: mapped, compositionFrozen };
			}

			const livePreviewWas = isLivePreviewActive(tr.startState);
			const unfroze = prev.compositionFrozen && !compositionFrozen;
			const prevSourcePath = resolveStateSourcePath(tr.startState);
			const nextSourcePath = resolveStateSourcePath(tr.state);

			if (
				!tr.docChanged &&
				!hostRefreshed &&
				!unfroze &&
				livePreviewWas === livePreviewNow &&
				prevSourcePath === nextSourcePath
			) {
				if (tr.selection === undefined) {
					return prev;
				}
				const spans = getCachedRhizomeInlineSpans(tr.state.doc);
				if (spans.length === 0 || !didTouchedSpansChange(tr.startState, tr.state, spans)) {
					return prev;
				}
			}

			return {
				decorations: computeLivePreviewDecorations(tr.state, app, inlineHostResolver),
				compositionFrozen,
			};
		},
		provide: (field) => [
			EditorView.decorations.from(field, (val) => val.decorations),
			inlineDecorationsFacet.from(field, (val) => val.decorations),
		],
	});

	const lifecyclePlugin = ViewPlugin.fromClass(
		class implements PluginValue {
			private readonly view: EditorView;
			private readonly abortController = new AbortController();
			private subscribedPath = '';
			private unsubscribeHost: (() => void) | null = null;
			private readonly onCompositionStart: () => void;
			private readonly onCompositionEnd: () => void;

			constructor(view: EditorView) {
				this.view = view;
				this.onCompositionStart = () => {
					this.view.dispatch({ effects: setCompositionFrozenEffect.of(true) });
				};
				this.onCompositionEnd = () => {
					this.view.dispatch({ effects: setCompositionFrozenEffect.of(false) });
				};
				const dom = (view as { contentDOM?: HTMLElement | undefined }).contentDOM;
				if (dom && typeof dom.addEventListener === 'function') {
					dom.addEventListener('compositionstart', this.onCompositionStart);
					dom.addEventListener('compositionend', this.onCompositionEnd);
				}

				this.syncSubscription();

				if (waitForVaultReady) {
					void waitForVaultReady(this.abortController.signal).then(() => {
						if (
							!this.abortController.signal.aborted &&
							getCachedRhizomeInlineSpans(this.view.state.doc).length > 0
						) {
							this.view.dispatch({ effects: hostInlineRefreshEffect.of(undefined) });
						}
					});
				}
			}

			update(_update: ViewUpdate): void {
				this.syncSubscription();
			}

			destroy(): void {
				this.abortController.abort();
				this.unsubscribeHost?.();
				this.unsubscribeHost = null;
				const dom = (this.view as { contentDOM?: HTMLElement | undefined }).contentDOM;
				if (dom && typeof dom.removeEventListener === 'function') {
					dom.removeEventListener('compositionstart', this.onCompositionStart);
					dom.removeEventListener('compositionend', this.onCompositionEnd);
				}
			}

			private syncSubscription(): void {
				const hasInlineSpans = getCachedRhizomeInlineSpans(this.view.state.doc).length > 0;
				const nextPath = hasInlineSpans
					? (resolveEditorHostFile(this.view)?.path ?? '')
					: '';
				if (nextPath === this.subscribedPath) {
					return;
				}
				this.unsubscribeHost?.();
				this.unsubscribeHost = null;
				this.subscribedPath = nextPath;
				if (nextPath.length > 0) {
					this.unsubscribeHost = inlineHostResolver.subscribe(
						nextPath,
						{
							onChange: () => {
								if (!this.abortController.signal.aborted) {
									this.view.dispatch({
										effects: hostInlineRefreshEffect.of(undefined),
									});
								}
							},
							onRename: (renamedPath) => {
								this.subscribedPath = renamedPath;
							},
						},
						this.abortController.signal,
					);
				}
			}
		},
	);

	return [inlineLivePreviewField, lifecyclePlugin];
}
