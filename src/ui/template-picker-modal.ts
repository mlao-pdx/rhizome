import { type App, type FuzzyMatch, FuzzySuggestModal, type TFile } from 'obsidian';
import { hasInternalRhizomeFlag, INTERNAL_RHIZOME_CODES } from '@core/search';
import {
	extractTopLevelRhizomeBlocks,
	isPathInTemplatesFolder,
	resolveTemplateFolders,
	type TemplateFolderConfig,
	type TemplateTrigger,
} from '@core/templates';

/**
 * Executable template note discovered under `templatesFolder` (`>= 1` top-level `rhizome` block).
 */
export interface DiscoveredTemplateItem {
	readonly file: TFile;
	/** Path relative to `templatesFolder` without the `.md` extension (e.g. `Meetings/Weekly`). */
	readonly displayPath: string;
	/** Subfolder relative to `templatesFolder` (`""` when directly inside `templatesFolder`). */
	readonly subfolder: string;
	/** Template basename (`Weekly`). */
	readonly title: string;
	/** Number of top-level `rhizome` codeblocks inside the template. */
	readonly blockCount: number;
}

/**
 * Discovers all Markdown notes inside `templatesFolder` that contain at least one top-level
 * fenced `rhizome` codeblock, sorted alphabetically by relative path.
 */
export async function discoverExecutableTemplates(
	app: App,
	folderConfig: TemplateFolderConfig,
): Promise<DiscoveredTemplateItem[]> {
	const resolved = resolveTemplateFolders(folderConfig);
	const prefix = `${resolved.templatesFolder}/`;
	const candidates = app.vault.getMarkdownFiles().filter((file) => {
		if ((file as { deleted?: boolean }).deleted || !file.path.toLowerCase().endsWith('.md')) {
			return false;
		}
		if (!isPathInTemplatesFolder(file.path, folderConfig)) {
			return false;
		}
		const cache = app.metadataCache.getFileCache(file);
		return !hasInternalRhizomeFlag(
			cache?.frontmatter,
			INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
		);
	});

	const items: DiscoveredTemplateItem[] = [];
	for (const file of candidates) {
		let text: string;
		try {
			text = await app.vault.cachedRead(file);
		} catch {
			continue;
		}
		const blocks = extractTopLevelRhizomeBlocks(text);
		if (blocks.length === 0) {
			continue;
		}
		const relWithExt = file.path.startsWith(prefix)
			? file.path.slice(prefix.length)
			: file.name;
		const displayPath = relWithExt.toLowerCase().endsWith('.md')
			? relWithExt.slice(0, -3)
			: relWithExt;
		const slashIdx = displayPath.lastIndexOf('/');
		const subfolder = slashIdx === -1 ? '' : displayPath.slice(0, slashIdx);
		const title = slashIdx === -1 ? displayPath : displayPath.slice(slashIdx + 1);
		items.push({
			file,
			displayPath,
			subfolder,
			title,
			blockCount: blocks.length,
		});
	}

	items.sort((a, b) =>
		a.displayPath.localeCompare(b.displayPath, undefined, { sensitivity: 'base' }),
	);
	return items;
}

/**
 * Fuzzy template picker modal listing executable Rhizome templates from `templatesFolder`.
 */
export class TemplatePickerModal extends FuzzySuggestModal<DiscoveredTemplateItem> {
	private readonly items: readonly DiscoveredTemplateItem[];
	private readonly mode: Exclude<TemplateTrigger, 'dynamicCodeblock'>;
	private readonly onChoose: (item: DiscoveredTemplateItem) => void;

	public constructor(
		app: App,
		items: readonly DiscoveredTemplateItem[],
		mode: Exclude<TemplateTrigger, 'dynamicCodeblock'>,
		onChoose: (item: DiscoveredTemplateItem) => void,
	) {
		super(app);
		this.items = items;
		this.mode = mode;
		this.onChoose = onChoose;
		this.setPlaceholder(
			mode === 'newNote'
				? 'Select a template to create a new note…'
				: 'Select a template to insert at cursor…',
		);
	}

	public override getItems(): DiscoveredTemplateItem[] {
		return [...this.items];
	}

	public override getItemText(item: DiscoveredTemplateItem): string {
		return item.displayPath;
	}

	public override renderSuggestion(
		match: FuzzyMatch<DiscoveredTemplateItem>,
		el: HTMLElement,
	): void {
		const item = match.item;
		el.empty();
		const row = el.createDiv({ cls: 'rhizome-template-picker-row' });
		const titleRow = row.createDiv({ cls: 'rhizome-template-picker-title-row' });
		titleRow.createSpan({ cls: 'rhizome-template-picker-title', text: item.title });
		if (item.blockCount > 1) {
			const unit = this.mode === 'newNote' ? 'notes' : 'blocks';
			titleRow.createSpan({
				cls: 'rhizome-template-picker-badge',
				text: `${item.blockCount} ${unit}`,
			});
		}
		if (item.subfolder.length > 0) {
			row.createDiv({ cls: 'rhizome-template-picker-folder', text: item.subfolder });
		}
	}

	public override onChooseItem(item: DiscoveredTemplateItem): void {
		this.onChoose(item);
	}
}
