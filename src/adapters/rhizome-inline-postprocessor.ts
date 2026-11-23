import {
	type MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	normalizePath,
} from 'obsidian';
import {
	evaluateInlineRhizomeExpression,
	extractInlineRhizomeExpression,
	MAX_INLINE_RENDER_DEPTH,
	resolveCodeBlockHeadingLevel,
} from '@core/templates';
import type RhizomePlugin from '../main';
import {
	createInlineErrorPill,
	createInlineOutputSpan,
	createInlineStagingElement,
	isSoleContentOfParagraph,
	readAncestorInlineDepth,
	unwrapStagingToReadingElement,
} from './inline-dom';

interface InlineSlotState {
	readonly expr: string;
	readonly depth: number;
	readonly soleInParagraph: boolean;
	currentEl: HTMLElement;
	slotRenderChild: MarkdownRenderChild | null;
	lastRenderKey: string | null;
}

function collectCandidateCodeElements(rootEl: HTMLElement): HTMLElement[] {
	const out: HTMLElement[] = [];
	const visit = (node: HTMLElement): void => {
		if (node.tagName?.toUpperCase() === 'CODE') {
			out.push(node);
			return;
		}
		const children = node.children;
		if (!children) {
			return;
		}
		for (let i = 0; i < children.length; i++) {
			visit(children[i] as HTMLElement);
		}
	};
	visit(rootEl);
	return out;
}

function isInsidePreElement(el: HTMLElement): boolean {
	if (typeof el.closest === 'function') {
		return el.closest('pre') !== null;
	}
	let cur: HTMLElement | null = el.parentElement;
	while (cur !== null) {
		if (cur.tagName?.toUpperCase() === 'PRE') {
			return true;
		}
		cur = cur.parentElement;
	}
	return false;
}

function mountSlotElement(slot: InlineSlotState, nextEl: HTMLElement, isBlock: boolean): void {
	const cur = slot.currentEl;
	if (slot.soleInParagraph) {
		const parent = cur.parentElement;
		if (isBlock) {
			if (parent && parent.tagName?.toUpperCase() === 'P') {
				parent.replaceWith(nextEl);
			} else {
				cur.replaceWith(nextEl);
			}
			slot.currentEl = nextEl;
			return;
		}
		if (parent && parent.tagName?.toUpperCase() !== 'P') {
			const wrapperP = createEl('p');
			wrapperP.appendChild(nextEl);
			cur.replaceWith(wrapperP);
			slot.currentEl = nextEl;
			return;
		}
	}
	cur.replaceWith(nextEl);
	slot.currentEl = nextEl;
}

function resolveSectionHeadingLevel(
	plugin: RhizomePlugin,
	sourcePath: string,
	ctx: MarkdownPostProcessorContext,
	sectionEl: HTMLElement,
	initialLineStart: number | undefined,
): number {
	if (sourcePath.length === 0) {
		return 0;
	}
	const liveLineStart =
		typeof ctx.getSectionInfo === 'function'
			? ctx.getSectionInfo(sectionEl)?.lineStart
			: undefined;
	const lineStart = liveLineStart ?? initialLineStart;
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

/**
 * Markdown post-processor replacing inline `◊ <expr>` code spans in Reading mode (and
 * rendered Live Preview table/callout/embed subtrees) with dynamically evaluated Markdown,
 * error pills, and reactive host-note subscriptions.
 */
export function processRhizomeInlineSpans(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	plugin: RhizomePlugin,
): void {
	const candidates = collectCandidateCodeElements(el);
	if (candidates.length === 0) {
		return;
	}

	const slots: InlineSlotState[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const codeEl = candidates[i]!;
		if (isInsidePreElement(codeEl)) {
			continue;
		}
		const depth = readAncestorInlineDepth(codeEl) + 1;
		if (depth > MAX_INLINE_RENDER_DEPTH) {
			continue;
		}
		const extracted = extractInlineRhizomeExpression(codeEl.textContent ?? '', {
			normalizeCommonMark: false,
		});
		if (extracted === null) {
			continue;
		}
		slots.push({
			expr: extracted.expr,
			depth,
			soleInParagraph: isSoleContentOfParagraph(codeEl),
			currentEl: codeEl,
			slotRenderChild: null,
			lastRenderKey: null,
		});
	}

	if (slots.length === 0) {
		return;
	}

	let currentSourcePath = typeof ctx.sourcePath === 'string' ? ctx.sourcePath : '';
	const initialLineStart =
		typeof ctx.getSectionInfo === 'function' ? ctx.getSectionInfo(el)?.lineStart : undefined;

	const sectionChild = new MarkdownRenderChild(el);
	ctx.addChild(sectionChild);
	const abortController = new AbortController();
	const signal = abortController.signal;
	sectionChild.register(() => {
		abortController.abort();
	});

	let renderGeneration = 0;

	const renderAllSlots = async (): Promise<void> => {
		if (signal.aborted) {
			return;
		}
		const generation = ++renderGeneration;
		const { hostMatch } = plugin.inlineHostResolver.resolveSync(currentSourcePath);
		const headingLevel = resolveSectionHeadingLevel(
			plugin,
			currentSourcePath,
			ctx,
			el,
			initialLineStart,
		);
		const runtimeCtx = plugin.inlineHostResolver.buildRuntimeContext(
			currentSourcePath,
			headingLevel,
		);

		for (let i = 0; i < slots.length; i++) {
			if (signal.aborted || generation !== renderGeneration) {
				return;
			}
			const slot = slots[i]!;
			const result = evaluateInlineRhizomeExpression(slot.expr, hostMatch, runtimeCtx);
			const renderKey = result.ok
				? `ok:${result.markdown}`
				: `err:${result.diagnostic.code}:${result.diagnostic.issue}:${result.diagnostic.hint ?? ''}`;
			if (slot.lastRenderKey === renderKey) {
				continue;
			}

			if (!result.ok) {
				if (slot.slotRenderChild !== null) {
					sectionChild.removeChild(slot.slotRenderChild);
					slot.slotRenderChild = null;
				}
				const pill = createInlineErrorPill(result.diagnostic);
				mountSlotElement(slot, pill, false);
				slot.lastRenderKey = renderKey;
				plugin.inlineHostResolver.logInlineWarningOnce(
					currentSourcePath,
					slot.expr,
					result.diagnostic,
				);
				continue;
			}

			if (result.markdown.trim().length === 0) {
				if (slot.slotRenderChild !== null) {
					sectionChild.removeChild(slot.slotRenderChild);
					slot.slotRenderChild = null;
				}
				const emptySpan = createInlineOutputSpan(slot.depth);
				mountSlotElement(slot, emptySpan, false);
				slot.lastRenderKey = renderKey;
				continue;
			}

			const stagingEl = createInlineStagingElement(slot.depth);
			const nextChild = new MarkdownRenderChild(stagingEl);
			await MarkdownRenderer.render(
				plugin.app,
				result.markdown,
				stagingEl,
				currentSourcePath,
				nextChild,
			);
			if (signal.aborted || generation !== renderGeneration) {
				nextChild.unload();
				return;
			}

			if (slot.slotRenderChild !== null) {
				sectionChild.removeChild(slot.slotRenderChild);
			}
			const { el: mountedEl, isBlock } = unwrapStagingToReadingElement(stagingEl, slot.depth);
			nextChild.containerEl = mountedEl;
			sectionChild.addChild(nextChild);
			slot.slotRenderChild = nextChild;
			mountSlotElement(slot, mountedEl, isBlock);
			slot.lastRenderKey = renderKey;
		}
	};

	void (async () => {
		if (typeof plugin.waitForVaultReady === 'function') {
			await plugin.waitForVaultReady(signal);
			if (signal.aborted) {
				return;
			}
		}
		if (currentSourcePath.length > 0) {
			plugin.inlineHostResolver.subscribe(
				currentSourcePath,
				{
					onChange: () => {
						void renderAllSlots();
					},
					onRename: (newPath) => {
						currentSourcePath = newPath;
					},
				},
				signal,
			);
		}
		await renderAllSlots();
	})();
}
