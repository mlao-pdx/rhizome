import { setTooltip } from 'obsidian';
import type { TemplateDiagnostic } from '@core/templates';

/**
 * Diagnostic DOM attribute written onto plugin-created inline output wrappers.
 * Security note: `readAncestorInlineDepth` NEVER trusts this attribute from the DOM; nested
 * depth is tracked exclusively in `trustedInlineDepthMap` so vault HTML cannot forge depths.
 */
export const INLINE_DEPTH_ATTR = 'data-rhizome-inline-depth';

const trustedInlineDepthMap = new WeakMap<HTMLElement, number>();

/**
 * Creates a trusted `<span class="rhizome-inline-output">` wrapper registered at `depth` in
 * `trustedInlineDepthMap`.
 */
export function createInlineOutputSpan(depth: number): HTMLSpanElement {
	const span = createSpan({
		cls: 'rhizome-inline-output',
		attr: { [INLINE_DEPTH_ATTR]: String(depth) },
	});
	trustedInlineDepthMap.set(span, depth);
	return span;
}

/**
 * Formats a `TemplateDiagnostic` into tooltip text (`issue` + optional `Fix: hint`).
 */
export function formatInlineDiagnosticTooltip(
	diag: Pick<TemplateDiagnostic, 'issue' | 'hint'>,
): string {
	return diag.hint ? `${diag.issue}\nFix: ${diag.hint}` : diag.issue;
}

/**
 * Creates the accessible inline `<span class="rhizome-inline-error">` pill with tooltip attached.
 */
export function createInlineErrorPill(
	diag: Pick<TemplateDiagnostic, 'issue' | 'hint'>,
): HTMLSpanElement {
	const pill = createSpan({
		cls: 'rhizome-inline-error',
		text: '◊ Error',
		attr: {
			role: 'status',
			tabindex: '0',
		},
	});
	setTooltip(pill, formatInlineDiagnosticTooltip(diag));
	return pill;
}

/**
 * Creates the muted Live Preview `<span class="rhizome-inline-empty">◊</span>` placeholder badge.
 */
export function createInlineEmptyBadge(expr: string): HTMLSpanElement {
	const badge = createSpan({
		cls: 'rhizome-inline-empty',
		text: '◊',
	});
	setTooltip(badge, `\`◊ ${expr}\``);
	return badge;
}

/**
 * Creates a detached staging `<div>` registered in `trustedInlineDepthMap` so nested
 * post-processor passes triggered inside `MarkdownRenderer.render` observe the unforgeable depth.
 */
export function createInlineStagingElement(depth: number): HTMLDivElement {
	const stagingEl = createDiv({
		cls: 'rhizome-inline-output',
		attr: {
			[INLINE_DEPTH_ATTR]: String(depth),
		},
	});
	trustedInlineDepthMap.set(stagingEl, depth);
	return stagingEl;
}

/**
 * Reads the maximum unforgeable inline render depth across all ancestors registered in
 * `trustedInlineDepthMap`, returning `0` when `el` is not inside a plugin-created output wrapper.
 */
export function readAncestorInlineDepth(el: HTMLElement): number {
	let maxDepth = 0;
	let cur: HTMLElement | null = el.parentElement;
	while (cur !== null) {
		const trusted = trustedInlineDepthMap.get(cur);
		if (trusted !== undefined && trusted > maxDepth) {
			maxDepth = trusted;
		}
		cur = cur.parentElement;
	}
	return maxDepth;
}

/**
 * Checks whether `codeEl` is the sole non-whitespace content of an enclosing `<p>` element.
 */
export function isSoleContentOfParagraph(codeEl: HTMLElement): boolean {
	const parent = codeEl.parentElement;
	if (!parent || parent.tagName.toUpperCase() !== 'P') {
		return false;
	}
	const nodes = parent.childNodes;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		if (node === codeEl) {
			continue;
		}
		if (node.nodeType !== 3 || (node.textContent ?? '').trim().length > 0) {
			return false;
		}
	}
	return true;
}

/**
 * Determines whether a `MarkdownRenderer.render` staging container holds block-level Markdown
 * (`<table>`, `<ul>`, `<ol>`, `<h1>`–`<h6>`, `<blockquote>`, `<pre>`, `.callout`, or multiple blocks)
 * rather than a single inline `<p>`.
 */
export function isBlockOutputStaging(stagingEl: HTMLElement): boolean {
	const children = stagingEl.children;
	if (children.length === 0) {
		return false;
	}
	if (children.length > 1) {
		return true;
	}
	const only = children[0]!;
	if (only.tagName.toUpperCase() !== 'P') {
		return true;
	}
	const nodes = stagingEl.childNodes;
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i]!;
		if (n !== only && n.nodeType === 3 && (n.textContent ?? '').trim().length > 0) {
			return true;
		}
	}
	return false;
}

/**
 * Unwraps a rendered staging container into either an inline `<span class="rhizome-inline-output">`
 * (unwrapping a single `<p>`) or a `<div class="rhizome-inline-output rhizome-inline-output-block">`.
 */
export function unwrapStagingToReadingElement(
	stagingEl: HTMLElement,
	depth: number,
): { readonly el: HTMLElement; readonly isBlock: boolean } {
	const isBlock = isBlockOutputStaging(stagingEl);
	if (isBlock) {
		const blockEl = createDiv({
			cls: 'rhizome-inline-output rhizome-inline-output-block',
			attr: { [INLINE_DEPTH_ATTR]: String(depth) },
		});
		trustedInlineDepthMap.set(blockEl, depth);
		while (stagingEl.firstChild) {
			blockEl.appendChild(stagingEl.firstChild);
		}
		return { el: blockEl, isBlock: true };
	}

	const inlineEl = createInlineOutputSpan(depth);
	const sourceNode =
		stagingEl.children.length === 1 && stagingEl.children[0]!.tagName.toUpperCase() === 'P'
			? stagingEl.children[0]!
			: stagingEl;
	while (sourceNode.firstChild) {
		inlineEl.appendChild(sourceNode.firstChild);
	}
	return { el: inlineEl, isBlock: false };
}

/**
 * Transfers rendered staging nodes into an already-mounted Live Preview widget container,
 * unwrapping a single `<p>` and toggling `.rhizome-inline-output-block` when block elements render.
 */
export function populateLivePreviewFromStaging(
	targetEl: HTMLElement,
	stagingEl: HTMLElement,
): boolean {
	while (targetEl.firstChild) {
		targetEl.removeChild(targetEl.firstChild);
	}
	const isBlock = isBlockOutputStaging(stagingEl);
	targetEl.classList.toggle('rhizome-inline-output-block', isBlock);
	const sourceNode =
		!isBlock &&
		stagingEl.children.length === 1 &&
		stagingEl.children[0]!.tagName.toUpperCase() === 'P'
			? stagingEl.children[0]!
			: stagingEl;
	while (sourceNode.firstChild) {
		targetEl.appendChild(sourceNode.firstChild);
	}
	return isBlock;
}
