import { type Diagnostic, linter } from '@codemirror/lint';
import type { Extension, StateEffectType, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { CodeBlockAnalysis, CodeBlockDiagnosticSpan } from '@core/templates';
import { findRhizomeCodeBlocks } from './rhizome-code-blocks';

function renderDiagnosticItemDom(diag: CodeBlockDiagnosticSpan): HTMLElement {
	const item = createDiv({
		cls: `cm-rhizome-tooltip-item cm-rhizome-tooltip-${diag.severity}`,
	});

	const header = item.createDiv({ cls: 'cm-rhizome-tooltip-header' });
	header.createSpan({
		cls: `cm-rhizome-tooltip-badge cm-rhizome-tooltip-badge-${diag.severity}`,
		text: diag.severity.toUpperCase(),
	});
	header.createEl('code', { cls: 'cm-rhizome-tooltip-code', text: diag.code });

	item.createDiv({ cls: 'cm-rhizome-tooltip-issue', text: diag.issue });

	if (diag.hint) {
		item.createDiv({ cls: 'cm-rhizome-tooltip-hint', text: `Fix: ${diag.hint}` });
	}

	return item;
}

/**
 * Converts every codeblock diagnostic in `doc` into a `@codemirror/lint` diagnostic positioned in
 * document coordinates.
 */
export function buildRhizomeLintDiagnostics(
	doc: Text,
	getAnalysis: (source: string) => CodeBlockAnalysis,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const block of findRhizomeCodeBlocks(doc)) {
		const analysis = getAnalysis(block.source);
		for (const diag of analysis.diagnostics) {
			const from = block.bodyFrom + diag.startOffset;
			const to = Math.min(doc.length, Math.max(from + 1, block.bodyFrom + diag.endOffset));
			if (to <= from) {
				continue;
			}
			diagnostics.push({
				from,
				to,
				severity: diag.severity,
				source: 'rhizome',
				message: diag.issue,
				renderMessage: () => renderDiagnosticItemDom(diag),
			});
		}
	}

	return diagnostics;
}

/**
 * Creates the lint extension that underlines and explains diagnostics inside fenced `rhizome`
 * codeblocks.
 *
 * @remarks
 * `needsRefresh` watches `configRefreshEffect` so diagnostics re-run when property types finish
 * loading after startup; lint already re-runs on every document change.
 */
export function createRhizomeLintExtension(
	getAnalysis: (source: string, view: EditorView) => CodeBlockAnalysis,
	configRefreshEffect: StateEffectType<void>,
): Extension {
	return linter(
		(view) =>
			buildRhizomeLintDiagnostics(view.state.doc, (source) => getAnalysis(source, view)),
		{
			needsRefresh: (update) =>
				update.transactions.some((tr) =>
					tr.effects.some((effect) => effect.is(configRefreshEffect)),
				),
		},
	);
}
