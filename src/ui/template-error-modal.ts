import { type App, MarkdownView, Modal, Setting, type TFile } from 'obsidian';
import { formatSourceCaretSnippet } from '@core/search';
import type { TemplateDiagnostic } from '@core/templates';

/**
 * Diagnostics collected for a single top-level `rhizome` codeblock during preflight.
 */
export interface TemplateBlockErrorGroup {
	readonly blockIndex: number;
	readonly blockCount: number;
	readonly fenceStartLine: number;
	readonly bodyStartLine: number;
	readonly source: string;
	readonly diagnostics: readonly TemplateDiagnostic[];
}

export interface TemplateErrorModalOptions {
	readonly title: string;
	readonly templateFile: TFile;
	readonly errorGroups: readonly TemplateBlockErrorGroup[];
}

function resolveFirstOffendingTemplateLine(groups: readonly TemplateBlockErrorGroup[]): number {
	const firstGroup = groups[0];
	if (!firstGroup) {
		return 1;
	}
	const firstInTemplateDiag = firstGroup.diagnostics.find(
		(d) => d.file === null && d.span !== null,
	);
	if (firstInTemplateDiag?.span) {
		return Math.max(1, firstGroup.bodyStartLine + firstInTemplateDiag.span.startLine - 1);
	}
	return Math.max(1, firstGroup.fenceStartLine);
}

/**
 * Modal displayed when preflighting a `"newNote"` or `"atCursor"` template fails,
 * reporting per-block diagnostics and offering a one-click jump to the template file.
 */
export class TemplateErrorModal extends Modal {
	private readonly titleText: string;
	private readonly templateFile: TFile;
	private readonly errorGroups: readonly TemplateBlockErrorGroup[];

	public constructor(app: App, options: TemplateErrorModalOptions) {
		super(app);
		this.titleText = options.title;
		this.templateFile = options.templateFile;
		this.errorGroups = options.errorGroups;
	}

	public override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.titleText);

		contentEl.createEl('p', {
			cls: 'rhizome-template-error-summary',
			text: `"${this.templateFile.path}" reported errors during preflight. No changes were made to your vault.`,
		});

		const listEl = contentEl.createDiv({ cls: 'rhizome-template-error-list' });
		for (const group of this.errorGroups) {
			const groupEl = listEl.createDiv({ cls: 'rhizome-template-error-group' });
			const blockLabel =
				group.blockCount > 1
					? `Block ${group.blockIndex + 1} of ${group.blockCount} (line ${group.fenceStartLine})`
					: `Template codeblock (line ${group.fenceStartLine})`;
			groupEl.createDiv({ cls: 'rhizome-template-error-group-header', text: blockLabel });

			for (const diag of group.diagnostics) {
				const itemEl = groupEl.createDiv({ cls: 'rhizome-template-error-item' });
				const headerEl = itemEl.createDiv({ cls: 'cm-rhizome-tooltip-header' });
				headerEl.createSpan({
					cls: 'cm-rhizome-tooltip-badge cm-rhizome-tooltip-badge-error',
					text: 'ERROR',
				});
				headerEl.createSpan({ cls: 'cm-rhizome-tooltip-code', text: diag.code });

				const locLabel =
					diag.file !== null
						? diag.span !== null
							? `in ${diag.file} (line ${diag.span.startLine})`
							: `in ${diag.file}`
						: diag.span !== null
							? `line ${group.bodyStartLine + diag.span.startLine - 1}, column ${diag.span.startColumn}`
							: null;
				if (locLabel !== null) {
					headerEl.createSpan({
						cls: 'rhizome-template-error-location',
						text: locLabel,
					});
				}

				itemEl.createDiv({ cls: 'cm-rhizome-tooltip-issue', text: diag.issue });

				if (diag.file === null && diag.span !== null && group.source.length > 0) {
					const snippet = formatSourceCaretSnippet(group.source, diag.span);
					if (snippet.length > 0) {
						itemEl.createEl('pre', {
							cls: 'rhizome-template-error-snippet',
							text: snippet,
						});
					}
				}

				if (diag.hint !== null && diag.hint.length > 0) {
					itemEl.createDiv({
						cls: 'cm-rhizome-tooltip-hint',
						text: `Hint: ${diag.hint}`,
					});
				}
			}
		}

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText('Close').onClick(() => {
					this.close();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Open template')
					.setCta()
					.onClick(() => {
						this.close();
						void this.openTemplateAtErrorLine();
					}),
			);
	}

	public override onClose(): void {
		this.contentEl.empty();
	}

	private async openTemplateAtErrorLine(): Promise<void> {
		const targetLineZeroBased = Math.max(
			0,
			resolveFirstOffendingTemplateLine(this.errorGroups) - 1,
		);
		const workspaceWithGetLeaf = this.app.workspace as {
			getLeaf?: (newLeaf?: boolean | 'tab') => {
				openFile: (file: TFile, openState?: { active?: boolean }) => Promise<void>;
				view?: unknown;
			};
			getActiveViewOfType?: <T>(type: new (...args: never[]) => T) => T | null;
		};
		if (typeof workspaceWithGetLeaf.getLeaf !== 'function') {
			return;
		}
		const leaf = workspaceWithGetLeaf.getLeaf('tab');
		await leaf.openFile(this.templateFile, { active: true });
		const activeMdView =
			leaf.view instanceof MarkdownView
				? leaf.view
				: workspaceWithGetLeaf.getActiveViewOfType?.(MarkdownView);
		activeMdView?.editor?.setCursor?.({ line: targetLineZeroBased, ch: 0 });
	}
}
