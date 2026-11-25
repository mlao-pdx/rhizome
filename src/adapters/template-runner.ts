import {
	type App,
	type Editor,
	getLanguage,
	normalizePath,
	Notice,
	Platform,
	type TFile,
} from 'obsidian';
import {
	hasInternalRhizomeFlag,
	initEngineConfig,
	INTERNAL_RHIZOME_CODES,
	type ResolvedEngineConfig,
} from '@core/search';
import {
	extractTopLevelRhizomeBlocks,
	renderRhizomeTemplate,
	resolveCodeBlockHeadingLevel,
	resolveTemplateFolders,
	TargetPathClaimRegistry,
	type TemplateFolderConfig,
	type TemplateMetadataObject,
	type TemplateRenderResult,
	type TemplateTargetTabMode,
	type TopLevelRhizomeBlock,
} from '@core/templates';
import type RhizomePlugin from '../main';
import { discoverExecutableTemplates, TemplatePickerModal } from '../ui/template-picker-modal';
import { type TemplateBlockErrorGroup, TemplateErrorModal } from '../ui/template-error-modal';
import { markSensitive } from './logger-format';
import {
	buildTemplateMetadataSnapshot,
	createVaultDirectoryChildrenLookup,
} from './template-folder-ladder';
import { loadVaultPropertyTypes } from './vault-query-logging';
import {
	resolveDefaultTimeZone,
	resolveHostDocument,
	toVaultQueryMatch,
} from './vault-query-runner';

export interface CreateNoteFromTemplateResult {
	readonly ok: boolean;
	readonly createdFiles: readonly TFile[];
	readonly errorGroups: readonly TemplateBlockErrorGroup[];
}

export interface InsertFromTemplateResult {
	readonly ok: boolean;
	readonly insertedMarkdown: string;
	readonly errorGroups: readonly TemplateBlockErrorGroup[];
}

interface PreparedTemplateSession {
	readonly referenceTimeMs: number;
	readonly timeZone: string;
	readonly vaultName: string;
	readonly language: string;
	readonly folderConfig: TemplateFolderConfig;
	readonly resolvedConfig: ResolvedEngineConfig;
	readonly blocks: readonly TopLevelRhizomeBlock[];
	readonly templateMeta: TemplateMetadataObject;
}

async function readPartialOrLayoutFile(
	app: App,
	vaultRelativePath: string,
): Promise<string | null> {
	const normalized = normalizePath(vaultRelativePath);
	const vaultWithLookup = app.vault as {
		getFileByPath?: (path: string) => TFile | null;
	};
	const matchedFile =
		typeof vaultWithLookup.getFileByPath === 'function'
			? (vaultWithLookup.getFileByPath(normalized) ?? undefined)
			: app.vault.getMarkdownFiles().find((f) => f.path === normalized);
	if (matchedFile) {
		const cache = app.metadataCache.getFileCache(matchedFile);
		if (
			hasInternalRhizomeFlag(cache?.frontmatter, INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY)
		) {
			return null;
		}
		return app.vault.cachedRead(matchedFile);
	}
	try {
		return await app.vault.adapter.read(normalized);
	} catch {
		return null;
	}
}

async function prepareTemplateSession(
	plugin: RhizomePlugin,
	templateFile: TFile,
	activeFileOverride?: TFile | null,
): Promise<PreparedTemplateSession | null> {
	const referenceTimeMs = Date.now();
	const timeZone = resolveDefaultTimeZone();
	const workspaceWithActive = plugin.app.workspace as {
		getActiveFile?: () => TFile | null;
	};
	const activeFileAtTrigger =
		activeFileOverride !== undefined
			? activeFileOverride
			: typeof workspaceWithActive.getActiveFile === 'function'
				? workspaceWithActive.getActiveFile()
				: null;

	if (typeof plugin.waitForVaultReady === 'function') {
		await plugin.waitForVaultReady();
	}

	let templateText: string;
	try {
		templateText =
			typeof plugin.app.vault.read === 'function'
				? await plugin.app.vault.read(templateFile)
				: await plugin.app.vault.cachedRead(templateFile);
	} catch (err: unknown) {
		plugin.loggerAdapter?.log(
			'error',
			`Failed to read template file ${markSensitive(templateFile.path)}`,
			{
				source: 'template.run',
				error: markSensitive(String(err)),
			},
		);
		new Notice(`Could not read template "${templateFile.path}".`);
		return null;
	}

	const blocks = extractTopLevelRhizomeBlocks(templateText);
	if (blocks.length === 0) {
		new Notice(
			`No top-level \`\`\`rhizome or \`\`\`rhizome-sample codeblocks found in "${templateFile.path}".`,
		);
		return null;
	}

	const folderConfig: TemplateFolderConfig = {
		templatesFolder: plugin.settings.templatesFolder,
		partialsFolder: plugin.settings.partialsFolder,
		layoutsFolder: plugin.settings.layoutsFolder,
		configDir: plugin.app.vault.configDir,
	};

	const vaultTypes = await loadVaultPropertyTypes(plugin.app, plugin.loggerAdapter);
	const cfgRes = initEngineConfig({ timeZone, propertyTypes: vaultTypes });
	const fallbackRes = cfgRes.ok
		? cfgRes
		: initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
	if (!fallbackRes.ok) {
		throw new Error('Failed to initialize engine configuration.');
	}
	const resolvedConfig = fallbackRes.config;

	const templateMeta = await buildTemplateMetadataSnapshot(
		plugin.app,
		templateFile,
		folderConfig,
		plugin.settings.newNoteDefaultFolderRung ?? 'notebookNavigator',
		resolvedConfig,
		{
			templateText,
			activeFileOverride: activeFileAtTrigger,
		},
	);

	const vaultWithGetName = plugin.app.vault as { getName?: () => string };
	const vaultName =
		typeof vaultWithGetName.getName === 'function' ? vaultWithGetName.getName() : '';
	const language = typeof getLanguage === 'function' ? getLanguage() : 'en';

	return {
		referenceTimeMs,
		timeZone,
		vaultName,
		language,
		folderConfig,
		resolvedConfig,
		blocks,
		templateMeta,
	};
}

async function ensureParentFolders(app: App, normalizedFilePath: string): Promise<void> {
	const slashIdx = normalizedFilePath.lastIndexOf('/');
	if (slashIdx <= 0) {
		return;
	}
	const dirSegments = normalizedFilePath.slice(0, slashIdx).split('/');
	let currentPrefix = '';
	for (const seg of dirSegments) {
		currentPrefix = currentPrefix.length === 0 ? seg : `${currentPrefix}/${seg}`;
		const normFolder = normalizePath(currentPrefix);
		const existing = app.vault.getAbstractFileByPath(normFolder);
		if (!existing) {
			try {
				await app.vault.createFolder(normFolder);
			} catch (err: unknown) {
				if (!app.vault.getAbstractFileByPath(normFolder)) {
					throw err;
				}
			}
		}
	}
}

/**
 * Executes `"newNote"` mode on `templateFile`: preflights all top-level `rhizome` blocks in
 * memory with shared `referenceTimeMs` and `TargetPathClaimRegistry`, aborts with zero vault writes
 * if any block fails, and otherwise creates each note, applies frontmatter via `processFrontMatter`,
 * and opens tabs according to each block's `tabMode`.
 */
export async function executeCreateNoteFromTemplate(
	plugin: RhizomePlugin,
	templateFile: TFile,
): Promise<CreateNoteFromTemplateResult> {
	const session = await prepareTemplateSession(plugin, templateFile);
	if (!session) {
		return { ok: false, createdFiles: [], errorGroups: [] };
	}

	const claimRegistry = new TargetPathClaimRegistry(
		createVaultDirectoryChildrenLookup(plugin.app),
	);
	const errorGroups: TemplateBlockErrorGroup[] = [];
	const stagedCreates: Array<{
		readonly block: TopLevelRhizomeBlock;
		readonly result: TemplateRenderResult;
		readonly targetPath: string;
		readonly tabMode: TemplateTargetTabMode;
		readonly frontmatter: Readonly<Record<string, unknown>>;
		readonly hasFrontmatterMutations: boolean;
	}> = [];

	for (let i = 0; i < session.blocks.length; i++) {
		const block = session.blocks[i]!;
		const res = await renderRhizomeTemplate(block.source, {
			folders: session.folderConfig,
			readTemplateFile: (relPath) => readPartialOrLayoutFile(plugin.app, relPath),
			runQueries: (qMap, lazyOpts) =>
				plugin.query(qMap, {
					timeZone: session.timeZone,
					referenceTimeMs: session.referenceTimeMs,
					...(lazyOpts?.hostDoc !== undefined ? { hostDoc: lazyOpts.hostDoc } : {}),
					...(lazyOpts?.priorQueryPaths !== undefined
						? { priorQueryPaths: lazyOpts.priorQueryPaths }
						: {}),
				}),
			runtimeContext: {
				sourcePath: templateFile.path,
				referenceTimeMs: session.referenceTimeMs,
				timeZone: session.timeZone,
				vault: session.vaultName,
				language: session.language,
				platform: Platform,
				headingLevel: 0,
				trigger: 'newNote',
				template: session.templateMeta,
				blockIndex: i,
				claimRegistry,
				resolvedConfig: session.resolvedConfig,
				configDir: plugin.app.vault.configDir,
			},
		});

		if (!res.ok) {
			errorGroups.push({
				blockIndex: i,
				blockCount: session.blocks.length,
				fenceStartLine: block.fenceStartLine,
				bodyStartLine: block.bodyStartLine,
				source: block.source,
				diagnostics: res.diagnostics,
			});
		} else {
			stagedCreates.push({
				block,
				result: res,
				targetPath: res.targetPath ?? 'untitled.md',
				tabMode: res.tabMode ?? 'background',
				frontmatter: res.frontmatter ?? Object.freeze({}),
				hasFrontmatterMutations: res.hasFrontmatterMutations === true,
			});
		}
	}

	if (errorGroups.length > 0) {
		plugin.loggerAdapter?.log(
			'warn',
			`Aborted new-note template execution due to preflight errors: ${markSensitive(templateFile.path)}`,
			{
				source: 'template.run',
				trigger: 'newNote',
				errorBlocks: errorGroups.length,
			},
		);
		new TemplateErrorModal(plugin.app, {
			title: 'Cannot create note from template',
			templateFile,
			errorGroups,
		}).open();
		return { ok: false, createdFiles: [], errorGroups };
	}

	// Refresh lazy directory caches on the preflight `claimRegistry` so any external vault file
	// synced mid-preflight is detected while keeping all sibling blocks' claims and original
	// unsuffixed `basePath` stems intact.
	claimRegistry.resetLoadedDirectories();
	const createdFiles: TFile[] = [];
	let lastActiveIndex = -1;
	for (let i = 0; i < stagedCreates.length; i++) {
		if (stagedCreates[i]!.tabMode === 'active') {
			lastActiveIndex = i;
		}
	}

	for (let i = 0; i < stagedCreates.length; i++) {
		const staged = stagedCreates[i]!;
		const finalPath = normalizePath(claimRegistry.reverifyClaim(i, staged.targetPath));
		await ensureParentFolders(plugin.app, finalPath);
		const createdFile = await plugin.app.vault.create(finalPath, staged.result.markdown);
		claimRegistry.addExistingPath(finalPath);

		if (staged.hasFrontmatterMutations && Object.keys(staged.frontmatter).length > 0) {
			await plugin.app.fileManager.processFrontMatter(
				createdFile,
				(fm: Record<string, unknown>) => {
					for (const [k, v] of Object.entries(staged.frontmatter)) {
						fm[k] = v;
					}
				},
			);
		}

		createdFiles.push(createdFile);

		if (staged.tabMode !== 'closed') {
			const workspaceWithGetLeaf = plugin.app.workspace as {
				getLeaf?: (newLeaf?: boolean | 'tab') => {
					openFile: (file: TFile, openState?: { active?: boolean }) => Promise<void>;
				};
			};
			if (typeof workspaceWithGetLeaf.getLeaf === 'function') {
				const shouldActivate = staged.tabMode === 'active' && i === lastActiveIndex;
				const leaf = workspaceWithGetLeaf.getLeaf('tab');
				await leaf.openFile(createdFile, { active: shouldActivate });
			}
		}
	}

	plugin.loggerAdapter?.log(
		'debug',
		`Created ${createdFiles.length} note(s) from template ${markSensitive(templateFile.path)}`,
		{
			source: 'template.run',
			trigger: 'newNote',
			count: createdFiles.length,
		},
	);

	if (createdFiles.length === 1) {
		new Notice(`Created "${createdFiles[0]!.path}".`);
	} else if (createdFiles.length > 1) {
		new Notice(`Created ${createdFiles.length} notes from "${templateFile.basename}".`);
	}

	return { ok: true, createdFiles, errorGroups: [] };
}

/**
 * Executes `"atCursor"` mode on `templateFile`: renders all top-level `rhizome` and `rhizome-sample`
 * blocks in memory against the real `hostFile` (`this`), collecting rendered Markdown (including
 * inline `[!danger]` error callouts if any block fails) and inserting all blocks joined by `\n\n`
 * in a single `editor.replaceSelection(...)` call so one Undo reverts the entire insertion.
 */
export async function executeInsertFromTemplate(
	plugin: RhizomePlugin,
	editor: Editor,
	hostFile: TFile | null,
	templateFile: TFile,
): Promise<InsertFromTemplateResult> {
	const session = await prepareTemplateSession(plugin, templateFile, hostFile);
	if (!session) {
		return { ok: false, insertedMarkdown: '', errorGroups: [] };
	}

	let cursorHeadingLevel = 0;
	if (hostFile) {
		const cursorLineZeroBased = editor.getCursor('from')?.line ?? 0;
		const hostCache = plugin.app.metadataCache.getFileCache(hostFile);
		cursorHeadingLevel = resolveCodeBlockHeadingLevel(hostCache?.headings, cursorLineZeroBased);
	}

	const resolveHostMatch = async (sourcePath: string): Promise<object | null> => {
		if (!hostFile || sourcePath.length === 0) {
			return null;
		}
		if (plugin.backlinkIndex && !plugin.backlinkIndex.isBuilt) {
			plugin.backlinkIndex.reconcile();
		}
		const doc = resolveHostDocument(
			plugin.app,
			sourcePath,
			session.resolvedConfig,
			undefined,
			plugin.loggerAdapter,
			plugin.backlinkIndex?.snapshot(),
			undefined,
			plugin.documentCache,
		);
		return doc ? toVaultQueryMatch(doc) : null;
	};

	const errorGroups: TemplateBlockErrorGroup[] = [];
	const renderedBlocks: string[] = [];
	const hostPath = hostFile?.path ?? '';

	for (let i = 0; i < session.blocks.length; i++) {
		const block = session.blocks[i]!;
		const res = await renderRhizomeTemplate(block.source, {
			folders: session.folderConfig,
			readTemplateFile: (relPath) => readPartialOrLayoutFile(plugin.app, relPath),
			resolveHost: resolveHostMatch,
			runQueries: (qMap) =>
				plugin.query(qMap, {
					timeZone: session.timeZone,
					referenceTimeMs: session.referenceTimeMs,
					...(hostPath.length > 0 ? { sourcePath: hostPath } : {}),
				}),
			runtimeContext: {
				sourcePath: hostPath,
				referenceTimeMs: session.referenceTimeMs,
				timeZone: session.timeZone,
				vault: session.vaultName,
				language: session.language,
				platform: Platform,
				headingLevel: cursorHeadingLevel,
				trigger: 'atCursor',
				template: session.templateMeta,
				blockIndex: i,
				resolvedConfig: session.resolvedConfig,
				configDir: plugin.app.vault.configDir,
			},
		});

		renderedBlocks.push(res.markdown);
		if (!res.ok) {
			errorGroups.push({
				blockIndex: i,
				blockCount: session.blocks.length,
				fenceStartLine: block.fenceStartLine,
				bodyStartLine: block.bodyStartLine,
				source: block.source,
				diagnostics: res.diagnostics,
			});
		}
	}

	const joinedMarkdown = renderedBlocks.join('\n\n');
	editor.replaceSelection(joinedMarkdown);

	if (errorGroups.length > 0) {
		plugin.loggerAdapter?.log(
			'warn',
			`Inserted template with inline error callouts from ${markSensitive(templateFile.path)}`,
			{
				source: 'template.run',
				trigger: 'atCursor',
				count: renderedBlocks.length,
				errorBlocks: errorGroups.length,
			},
		);
		return { ok: false, insertedMarkdown: joinedMarkdown, errorGroups };
	}

	plugin.loggerAdapter?.log(
		'debug',
		`Inserted ${renderedBlocks.length} block(s) from template ${markSensitive(templateFile.path)}`,
		{
			source: 'template.run',
			trigger: 'atCursor',
			count: renderedBlocks.length,
		},
	);

	return { ok: true, insertedMarkdown: joinedMarkdown, errorGroups: [] };
}

/**
 * Discovers executable templates in `templatesFolder` and opens `TemplatePickerModal` for `"newNote"`.
 */
export async function openCreateNoteFromTemplatePicker(plugin: RhizomePlugin): Promise<void> {
	const folderConfig: TemplateFolderConfig = {
		templatesFolder: plugin.settings.templatesFolder,
		partialsFolder: plugin.settings.partialsFolder,
		layoutsFolder: plugin.settings.layoutsFolder,
		configDir: plugin.app.vault.configDir,
	};
	const items = await discoverExecutableTemplates(plugin.app, folderConfig);
	if (items.length === 0) {
		const resolved = resolveTemplateFolders(folderConfig);
		new Notice(
			`No templates with a \`\`\`rhizome or \`\`\`rhizome-sample codeblock found in "${resolved.templatesFolder}".`,
		);
		return;
	}
	new TemplatePickerModal(plugin.app, items, 'newNote', (chosen) => {
		void executeCreateNoteFromTemplate(plugin, chosen.file);
	}).open();
}

/**
 * Discovers executable templates in `templatesFolder` and opens `TemplatePickerModal` for `"atCursor"`.
 */
export async function openInsertFromTemplatePicker(
	plugin: RhizomePlugin,
	editor: Editor,
	hostFile: TFile | null,
): Promise<void> {
	const folderConfig: TemplateFolderConfig = {
		templatesFolder: plugin.settings.templatesFolder,
		partialsFolder: plugin.settings.partialsFolder,
		layoutsFolder: plugin.settings.layoutsFolder,
		configDir: plugin.app.vault.configDir,
	};
	const items = await discoverExecutableTemplates(plugin.app, folderConfig);
	if (items.length === 0) {
		const resolved = resolveTemplateFolders(folderConfig);
		new Notice(
			`No templates with a \`\`\`rhizome or \`\`\`rhizome-sample codeblock found in "${resolved.templatesFolder}".`,
		);
		return;
	}
	new TemplatePickerModal(plugin.app, items, 'atCursor', (chosen) => {
		void executeInsertFromTemplate(plugin, editor, hostFile, chosen.file);
	}).open();
}
