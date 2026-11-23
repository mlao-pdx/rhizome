import { type EditorView, WidgetType } from '@codemirror/view';
import { type App, MarkdownRenderChild, MarkdownRenderer } from 'obsidian';
import type { InlineEvaluationResult } from '@core/templates';
import {
	createInlineEmptyBadge,
	createInlineErrorPill,
	createInlineOutputSpan,
	createInlineStagingElement,
	populateLivePreviewFromStaging,
} from '../inline-dom';

/**
 * Constructor options for `InlineRhizomeWidget`.
 */
export interface InlineRhizomeWidgetOptions {
	readonly app: App;
	readonly expr: string;
	readonly sourcePath: string;
	readonly headingLevel: number;
	readonly hostRevisionHash: string;
	readonly depth: number;
	readonly spanFrom: number;
	readonly spanTo: number;
	readonly backtickCount: number;
	readonly result: InlineEvaluationResult;
}

interface DomLifecycleState {
	destroyed: boolean;
	renderChild: MarkdownRenderChild | null;
	cleanupClick: (() => void) | null;
}

const domLifecycleMap = new WeakMap<HTMLElement, DomLifecycleState>();

function isInteractiveTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as HTMLElement).closest !== 'function') {
		return false;
	}
	return (
		(target as HTMLElement).closest(
			'a, button, input, select, textarea, .internal-link, .external-link, .tag',
		) !== null
	);
}

/**
 * CodeMirror 6 replacement widget rendering an inline `◊ <expr>` span in Live Preview as:
 * - an accessible `◊ Error` pill on syntax/render failure,
 * - a muted `◊` placeholder badge on blank output so empty expressions stay visible and clickable,
 * - or unwrapped inline/block Markdown rendered via `MarkdownRenderer.render`.
 */
export class InlineRhizomeWidget extends WidgetType {
	readonly expr: string;
	readonly sourcePath: string;
	readonly headingLevel: number;
	readonly hostRevisionHash: string;
	readonly depth: number;
	readonly spanFrom: number;
	readonly spanTo: number;
	readonly backtickCount: number;
	readonly result: InlineEvaluationResult;
	private readonly app: App;
	private readonly diagKey: string;

	constructor(options: InlineRhizomeWidgetOptions) {
		super();
		this.app = options.app;
		this.expr = options.expr;
		this.sourcePath = options.sourcePath;
		this.headingLevel = options.headingLevel;
		this.hostRevisionHash = options.hostRevisionHash;
		this.depth = options.depth;
		this.spanFrom = options.spanFrom;
		this.spanTo = options.spanTo;
		this.backtickCount = options.backtickCount;
		this.result = options.result;
		this.diagKey = options.result.ok
			? ''
			: `${options.result.diagnostic.code}\0${options.result.diagnostic.issue}\0${options.result.diagnostic.hint ?? ''}`;
	}

	override eq(other: InlineRhizomeWidget): boolean {
		if (
			this.expr !== other.expr ||
			this.sourcePath !== other.sourcePath ||
			this.headingLevel !== other.headingLevel ||
			this.hostRevisionHash !== other.hostRevisionHash ||
			this.depth !== other.depth ||
			this.result.ok !== other.result.ok
		) {
			return false;
		}
		if (this.result.ok && other.result.ok) {
			return this.result.markdown === other.result.markdown;
		}
		return this.diagKey === other.diagKey;
	}

	override toDOM(view: EditorView): HTMLElement {
		const lifecycle: DomLifecycleState = {
			destroyed: false,
			renderChild: null,
			cleanupClick: null,
		};

		const wireRevealOnClick = (dom: HTMLElement): void => {
			const onMouseDown = (evt: MouseEvent): void => {
				if (evt.button !== 0 || isInteractiveTarget(evt.target)) {
					return;
				}
				evt.preventDefault();
				evt.stopPropagation();
				let liveFrom = this.spanFrom;
				if (typeof view.posAtDOM === 'function') {
					try {
						liveFrom = view.posAtDOM(dom);
					} catch {
						liveFrom = this.spanFrom;
					}
				}
				const spanLen = Math.max(0, this.spanTo - this.spanFrom);
				const docLen = view.state.doc.length;
				const clampedFrom = Math.max(0, Math.min(docLen, liveFrom));
				const clampedTo = Math.max(clampedFrom, Math.min(docLen, clampedFrom + spanLen));
				const rawCaret = Math.min(
					clampedTo - this.backtickCount,
					clampedFrom + this.backtickCount + 2,
				);
				const caret = Math.max(clampedFrom, Math.min(clampedTo, rawCaret));
				view.dispatch({ selection: { anchor: caret } });
				if (typeof view.focus === 'function') {
					view.focus();
				}
			};
			dom.addEventListener('mousedown', onMouseDown);
			lifecycle.cleanupClick = () => {
				dom.removeEventListener('mousedown', onMouseDown);
			};
		};

		if (!this.result.ok) {
			const pill = createInlineErrorPill(this.result.diagnostic);
			wireRevealOnClick(pill);
			domLifecycleMap.set(pill, lifecycle);
			return pill;
		}

		if (this.result.markdown.trim().length === 0) {
			const badge = createInlineEmptyBadge(this.expr);
			wireRevealOnClick(badge);
			domLifecycleMap.set(badge, lifecycle);
			return badge;
		}

		const container = createInlineOutputSpan(this.depth);
		wireRevealOnClick(container);
		const stagingEl = createInlineStagingElement(this.depth);
		const renderChild = new MarkdownRenderChild(stagingEl);
		lifecycle.renderChild = renderChild;
		domLifecycleMap.set(container, lifecycle);

		void MarkdownRenderer.render(
			this.app,
			this.result.markdown,
			stagingEl,
			this.sourcePath,
			renderChild,
		).then(() => {
			if (lifecycle.destroyed) {
				renderChild.unload();
				return;
			}
			renderChild.containerEl = container;
			populateLivePreviewFromStaging(container, stagingEl);
			if (typeof view.requestMeasure === 'function') {
				view.requestMeasure();
			}
		});

		return container;
	}

	override destroy(dom: HTMLElement): void {
		const lifecycle = domLifecycleMap.get(dom);
		if (!lifecycle) {
			return;
		}
		lifecycle.destroyed = true;
		lifecycle.cleanupClick?.();
		lifecycle.cleanupClick = null;
		lifecycle.renderChild?.unload();
		lifecycle.renderChild = null;
		domLifecycleMap.delete(dom);
	}

	override ignoreEvent(event: Event): boolean {
		return isInteractiveTarget(event.target);
	}
}
