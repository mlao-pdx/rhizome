import {
	type MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	stringifyYaml,
} from 'obsidian';
import { XxHash64Accumulator } from '@core/hash/xxhash64';
import {
	type ExplainConceptKey,
	hasInternalRhizomeFlag,
	INTERNAL_RHIZOME_CODES,
	type NormalizedDocument,
	normalizeObsidianMetadata,
	type ResolvedEngineConfig,
} from '@core/search';
import {
	buildConceptsReferenceCallout,
	buildQueryExplainCallouts,
	buildTemplateExplainPlanCallout,
	checkFilterOutputSize,
	type CoercionInspectableDocument,
	formatTemplateDiagnosticsMarkdown,
	isPathInTemplateFolders,
	isPathInTemplatesFolder,
	parsedTemplateHasLoopTag,
	parsedTemplateReferencesHost,
	type ParsedRhizomeTemplate,
	parseRhizomeTemplatePass1Async,
	partitionNewNoteQueries,
	prefixCalloutBodyLines,
	type QuerySampleMetrics,
	renderParsedRhizomeTemplate,
	RenderTelemetryCollector,
	sampleSingleLazyQuery,
	sampleStaticQueryBatch,
	type TemplateDiagnostic,
	type TemplateFolderConfig,
	type TemplateRenderResult,
	type TemplateRuntimeContext,
} from '@core/templates';
import type RhizomePlugin from '../main';
import { hashVaultQueryResult } from './active-query-roster';
import {
	appendQuarantineRetryButton,
	formatQuarantinedCalloutMarkdown,
	schedulePostRenderPaintCleanup,
} from './codeblock-callouts';
import {
	buildDynamicRuntimeContextWithConfig,
	buildNewNotePreviewRuntimeContext,
	lookupHostHeadingLevel,
	readVaultTemplateNote,
} from './codeblock-lifecycle';
import {
	allExtractedQueriesExecutable,
	countExtractedQueryRecords,
	exceedsSentinelThreshold,
	isRuntimeRenderErrorResult,
	measureMarkdownOutput,
} from './codeblock-render-cache';
import { markSensitive } from './logger-format';
import { computeCodeBlockSentinelHash } from './render-sentinel-store';
import { resolveHostDocument, type VaultQueryResult } from './vault-query-runner';

const SAMPLE_NUM_FMT = new Intl.NumberFormat('en-US');

interface SampleWorkbenchRenderBundle {
	readonly headerSummary: string;
	readonly targetPathPill: string | null;
	readonly tabModePill: string | null;
	readonly previewMarkdown: string;
	readonly previewEmptyNotice: string | null;
	readonly explainMarkdown: string;
	readonly queriedKeysUnion: ReadonlySet<string>;
	readonly coercionDigest: string;
	readonly metricsByName: ReadonlyMap<string, QuerySampleMetrics>;
	readonly lazyHostDocsByName: ReadonlyMap<string, NormalizedDocument | null>;
	readonly telemetry: RenderTelemetryCollector;
	readonly stagedYamlChars: number;
}

const coercionDigestMemo = new WeakMap<
	RhizomePlugin,
	{ readonly stateRevision: number; readonly byKeysSig: Map<string, string> }
>();

function createVaultCoercionIterable(
	plugin: RhizomePlugin,
	resolvedConfig: ResolvedEngineConfig,
	folderConfig: TemplateFolderConfig,
): Iterable<CoercionInspectableDocument> {
	return {
		*[Symbol.iterator](): Iterator<CoercionInspectableDocument> {
			if (plugin.documentCache && plugin.documentCache.size > 0) {
				for (const [, doc] of plugin.documentCache.entries()) {
					if (doc.diagnostics.length > 0) {
						yield doc;
					}
				}
				return;
			}
			for (const file of plugin.app.vault.getMarkdownFiles()) {
				if ((file as { deleted?: boolean }).deleted) {
					continue;
				}
				const cacheEntry = plugin.app.metadataCache.getFileCache(file);
				if (
					hasInternalRhizomeFlag(
						cacheEntry?.frontmatter,
						INTERNAL_RHIZOME_CODES.DO_NOT_INDEX_OR_QUERY,
					) ||
					isPathInTemplateFolders(file.path, folderConfig)
				) {
					continue;
				}
				try {
					const normalized = normalizeObsidianMetadata(file, cacheEntry, resolvedConfig);
					if (normalized.diagnostics.length > 0) {
						yield normalized;
					}
				} catch {
					// Skip unreadable metadata
				}
			}
		},
	};
}

function computeCoercionDiagnosticsDigest(
	plugin: RhizomePlugin,
	queriedKeys: ReadonlySet<string>,
	documents: Iterable<CoercionInspectableDocument>,
): string {
	if (queriedKeys.size === 0) {
		return '';
	}
	const keysSig = [...queriedKeys].sort().join('\0');
	const rosterRev = plugin.activeQueryRoster?.stateRevision;
	if (typeof rosterRev === 'number') {
		const cached = coercionDigestMemo.get(plugin);
		if (cached && cached.stateRevision === rosterRev) {
			const hit = cached.byKeysSig.get(keysSig);
			if (hit !== undefined) {
				return hit;
			}
		}
	}

	const entries: string[] = [];
	for (const doc of documents) {
		for (const d of doc.diagnostics) {
			const lower = d.propertyKey.toLowerCase();
			if (queriedKeys.has(lower)) {
				entries.push(`${doc.file.path}\0${lower}\0${d.expectedType}\0${d.rawValue}`);
			}
		}
	}

	let digest = '';
	if (entries.length > 0) {
		entries.sort();
		const acc = new XxHash64Accumulator();
		acc.updateTag(0x43, entries.length);
		for (const item of entries) {
			acc.updateString(item);
		}
		digest = acc.digest().hex;
	}

	if (typeof rosterRev === 'number') {
		let bucket = coercionDigestMemo.get(plugin);
		if (!bucket || bucket.stateRevision !== rosterRev) {
			bucket = { stateRevision: rosterRev, byKeysSig: new Map<string, string>() };
			coercionDigestMemo.set(plugin, bucket);
		}
		bucket.byKeysSig.set(keysSig, digest);
	}
	return digest;
}

function isNavigationAnchorEvent(evt: Event, stopAt: HTMLElement): boolean {
	let cur = evt.target as {
		tagName?: string;
		classList?: { contains?: (cls: string) => boolean };
		parentElement?: unknown;
	} | null;
	while (cur && cur !== (stopAt as unknown)) {
		if (
			cur.tagName?.toUpperCase() === 'A' ||
			cur.classList?.contains?.('internal-link') ||
			cur.classList?.contains?.('external-link')
		) {
			return true;
		}
		cur = (cur.parentElement as typeof cur) ?? null;
	}
	return false;
}

function attachExplainStackEventGuard(explainStackEl: HTMLElement): void {
	const addFn = (
		explainStackEl as { addEventListener?: (type: string, cb: (e: Event) => void) => void }
	).addEventListener;
	if (typeof addFn !== 'function') {
		return;
	}
	const stopAlways = (evt: Event): void => {
		evt.stopPropagation();
	};
	explainStackEl.addEventListener('mousedown', stopAlways);
	explainStackEl.addEventListener('pointerdown', stopAlways);
	explainStackEl.addEventListener('click', (evt: Event) => {
		if (!isNavigationAnchorEvent(evt, explainStackEl)) {
			evt.stopPropagation();
		}
	});
}

function formatHeaderSummaryText(
	totalQueries: number,
	metricsByName: ReadonlyMap<string, QuerySampleMetrics>,
	isTemplatePreview: boolean,
): string {
	const parts: string[] = [];
	if (isTemplatePreview) {
		parts.push('simulated new note');
	}
	if (totalQueries === 0) {
		parts.push('0 queries');
		return parts.join(' · ');
	}
	parts.push(`${totalQueries} ${totalQueries === 1 ? 'query' : 'queries'}`);
	let totalMatched = 0;
	let totalSampled = 0;
	let anyDownsampled = false;
	for (const m of metricsByName.values()) {
		totalMatched += m.matchedCount;
		totalSampled += m.sampledCount;
		if (m.downsampled || m.cutoffBound) {
			anyDownsampled = true;
		}
	}
	if (anyDownsampled) {
		parts.push(
			`sampled ${SAMPLE_NUM_FMT.format(totalSampled)} of ${SAMPLE_NUM_FMT.format(totalMatched)} records`,
		);
	} else {
		parts.push(
			`all ${SAMPLE_NUM_FMT.format(totalMatched)} ${totalMatched === 1 ? 'record' : 'records'}`,
		);
	}
	return parts.join(' · ');
}

function synthesizeSimulatedFrontmatterMarkdown(
	source: string,
	parsed: ParsedRhizomeTemplate,
	renderResult: TemplateRenderResult,
	isTemplatePreview: boolean,
): {
	readonly effectiveResult: TemplateRenderResult;
	readonly frontmatterCalloutMarkdown: string;
	readonly stagedYamlChars: number;
} {
	if (
		!isTemplatePreview ||
		!renderResult.ok ||
		!renderResult.hasFrontmatterMutations ||
		!renderResult.frontmatter
	) {
		return {
			effectiveResult: renderResult,
			frontmatterCalloutMarkdown: '',
			stagedYamlChars: 0,
		};
	}

	const yamlRaw = stringifyYaml(renderResult.frontmatter).trimEnd();
	const rawYamlBlock = `---\n${yamlRaw}\n---\n`;
	try {
		checkFilterOutputSize(rawYamlBlock.length + renderResult.markdown.length);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const hint =
			typeof (err as { hint?: unknown }).hint === 'string'
				? String((err as { hint: string }).hint)
				: null;
		const diag: TemplateDiagnostic = Object.freeze({
			code: 'TEMPLATE_RENDER_ERROR',
			severity: 'error',
			issue: msg,
			hint,
			span: null,
			file: null,
		});
		const failedDiags = Object.freeze([diag]);
		return {
			effectiveResult: Object.freeze({
				ok: false,
				markdown: formatTemplateDiagnosticsMarkdown(
					source,
					failedDiags,
					parsed.env.fileSources,
				),
				queries: renderResult.queries,
				diagnostics: failedDiags,
			}),
			frontmatterCalloutMarkdown: '',
			stagedYamlChars: rawYamlBlock.length,
		};
	}

	const calloutLines = [
		'> [!info]- Simulated Frontmatter (YAML)',
		...prefixCalloutBodyLines(['```yaml', ...yamlRaw.split('\n'), '```']),
	];
	return {
		effectiveResult: renderResult,
		frontmatterCalloutMarkdown: calloutLines.join('\n'),
		stagedYamlChars: rawYamlBlock.length,
	};
}

function assembleExplainStackMarkdown(params: {
	readonly plugin: RhizomePlugin;
	readonly source: string;
	readonly parsed: ParsedRhizomeTemplate;
	readonly renderResult: TemplateRenderResult;
	readonly runtimeCtx: TemplateRuntimeContext;
	readonly folderConfig: TemplateFolderConfig;
	readonly isNewNoteMode: boolean;
	readonly hostDoc: NormalizedDocument | null;
	readonly metricsByName: ReadonlyMap<string, QuerySampleMetrics>;
	readonly lazyHostDocsByName: ReadonlyMap<string, NormalizedDocument | null>;
	readonly coercionDocs: Iterable<CoercionInspectableDocument>;
	readonly telemetry: RenderTelemetryCollector;
	readonly stagedYamlChars: number;
}): {
	readonly explainMarkdown: string;
	readonly queriedKeysUnion: ReadonlySet<string>;
	readonly coercionDigest: string;
} {
	const {
		plugin,
		source,
		parsed,
		renderResult,
		runtimeCtx,
		folderConfig,
		isNewNoteMode,
		hostDoc,
		metricsByName,
		lazyHostDocsByName,
		coercionDocs,
		telemetry,
		stagedYamlChars,
	} = params;

	const resolvedConfig = runtimeCtx.resolvedConfig!;
	const referenceTimeMs = runtimeCtx.referenceTimeMs ?? Date.now();

	const queryExplainRes = buildQueryExplainCallouts({
		queries: parsed.env.queries,
		resolvedConfig,
		referenceTimeMs,
		folderConfig,
		hostDoc,
		isNewNoteMode,
		metricsByName,
		lazyHostDocsByName,
		coercionDocuments: parsed.env.queries.length > 0 ? coercionDocs : undefined,
	});

	const templateExplainRes = buildTemplateExplainPlanCallout({
		source,
		parsed,
		renderResult,
		runtimeContext: runtimeCtx,
		metricsByName,
		waveByQueryName: queryExplainRes.waveByQueryName,
		lazyQueryNames: queryExplainRes.lazyQueryNames,
		telemetry,
		stagedYamlChars,
	});

	const mergedConcepts = new Set<ExplainConceptKey>([
		...queryExplainRes.triggeredConcepts,
		...templateExplainRes.triggeredConcepts,
	]);
	const conceptsMarkdown = buildConceptsReferenceCallout(
		mergedConcepts,
		referenceTimeMs,
		resolvedConfig.timeZone,
	);

	const explainMarkdown = [
		...queryExplainRes.callouts,
		templateExplainRes.calloutMarkdown,
		conceptsMarkdown,
	]
		.filter((s) => s.length > 0)
		.join('\n\n');

	const coercionDigest = computeCoercionDiagnosticsDigest(
		plugin,
		queryExplainRes.queriedKeysUnion,
		coercionDocs,
	);

	return {
		explainMarkdown,
		queriedKeysUnion: queryExplainRes.queriedKeysUnion,
		coercionDigest,
	};
}

/**
 * Processes a fenced `rhizome-sample` Markdown codeblock, rendering the two-region
 * Sample Preview + Explain Stack workbench with deterministic two-phase Referential
 * Integrity sampling, per-AST-node output telemetry, and live vault coercion reactivity.
 */
export async function processRhizomeSampleCodeBlock(
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	plugin: RhizomePlugin,
): Promise<void> {
	let currentSourcePath = typeof ctx.sourcePath === 'string' ? ctx.sourcePath : '';
	const onSourcePathRename = (newPath: string): void => {
		if (currentSourcePath.length > 0 && currentSourcePath !== newPath) {
			plugin.codeBlockRenderCache?.deleteForSourcePath(currentSourcePath);
		}
		currentSourcePath = newPath;
	};

	const outerChild = new MarkdownRenderChild(el);
	ctx.addChild(outerChild);
	const outerAbortController = new AbortController();
	let activeCycleController: AbortController | null = null;
	outerChild.register(() => {
		outerAbortController.abort();
		activeCycleController?.abort();
	});

	let activePreviewChild: MarkdownRenderChild | null = null;
	let activeExplainChild: MarkdownRenderChild | null = null;
	let activeExplainEl: HTMLElement | null = null;
	let lastCommittedPreviewMd: string | null = null;
	let lastCommittedExplainMd: string | null = null;
	let renderGeneration = 0;

	const renderWorkbenchDom = async (
		bundle: SampleWorkbenchRenderBundle,
		generation: number,
		cycleSignal: AbortSignal,
	): Promise<boolean> => {
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			generation !== renderGeneration
		) {
			return false;
		}
		if (
			lastCommittedPreviewMd === bundle.previewMarkdown &&
			lastCommittedExplainMd === bundle.explainMarkdown &&
			activeExplainEl !== null
		) {
			return true;
		}

		if (activePreviewChild !== null) {
			outerChild.removeChild(activePreviewChild);
			activePreviewChild = null;
		}
		if (activeExplainChild !== null) {
			outerChild.removeChild(activeExplainChild);
			activeExplainChild = null;
		}

		const emptyFn = (el as { empty?: () => void }).empty;
		if (typeof emptyFn === 'function') {
			emptyFn.call(el);
		}

		const createDivFn = (
			el as { createDiv?: (o?: { cls?: string; text?: string }) => HTMLElement }
		).createDiv;

		if (typeof createDivFn !== 'function') {
			// Minimal mock element fallback when `el` only implements `{ empty }`
			const fallbackChild = new MarkdownRenderChild(el);
			activePreviewChild = fallbackChild;
			outerChild.addChild(fallbackChild);
			const combined = [bundle.previewMarkdown, bundle.explainMarkdown]
				.filter((s) => s.length > 0)
				.join('\n\n---\n\n');
			await MarkdownRenderer.render(
				plugin.app,
				combined,
				el,
				currentSourcePath,
				fallbackChild,
			);
			lastCommittedPreviewMd = bundle.previewMarkdown;
			lastCommittedExplainMd = bundle.explainMarkdown;
			return (
				!outerAbortController.signal.aborted &&
				!cycleSignal.aborted &&
				generation === renderGeneration
			);
		}

		const rootEl = el.createDiv({ cls: 'rhizome-sample-workbench' });
		const headerEl = rootEl.createDiv({ cls: 'rhizome-sample-header' });
		headerEl.createSpan({ cls: 'rhizome-sample-badge', text: 'Sample preview' });
		headerEl.createSpan({ cls: 'rhizome-sample-summary', text: bundle.headerSummary });

		const previewRegionEl = rootEl.createDiv({ cls: 'rhizome-sample-preview' });
		if (bundle.targetPathPill !== null) {
			const pillBar = previewRegionEl.createDiv({ cls: 'rhizome-sample-target-bar' });
			pillBar.createSpan({
				cls: 'rhizome-sample-pill',
				text: `Target: ${bundle.targetPathPill}`,
			});
			if (bundle.tabModePill !== null) {
				pillBar.createSpan({
					cls: 'rhizome-sample-pill rhizome-sample-pill-muted',
					text: `Tab: ${bundle.tabModePill}`,
				});
			}
		}

		if (bundle.previewEmptyNotice !== null) {
			previewRegionEl.createDiv({
				cls: 'rhizome-sample-empty',
				text: bundle.previewEmptyNotice,
			});
		} else if (bundle.previewMarkdown.length > 0) {
			const bodyHostEl = previewRegionEl.createDiv({ cls: 'rhizome-sample-preview-body' });
			const previewChild = new MarkdownRenderChild(bodyHostEl);
			activePreviewChild = previewChild;
			outerChild.addChild(previewChild);
			await MarkdownRenderer.render(
				plugin.app,
				bundle.previewMarkdown,
				bodyHostEl,
				currentSourcePath,
				previewChild,
			);
		}

		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			generation !== renderGeneration
		) {
			return false;
		}

		if (bundle.explainMarkdown.length > 0) {
			rootEl.createDiv({ cls: 'rhizome-sample-divider' });
			const explainStackEl = rootEl.createDiv({ cls: 'rhizome-sample-explain-stack' });
			attachExplainStackEventGuard(explainStackEl);
			activeExplainEl = explainStackEl;
			const explainChild = new MarkdownRenderChild(explainStackEl);
			activeExplainChild = explainChild;
			outerChild.addChild(explainChild);
			await MarkdownRenderer.render(
				plugin.app,
				bundle.explainMarkdown,
				explainStackEl,
				currentSourcePath,
				explainChild,
			);
		} else {
			activeExplainEl = null;
		}

		lastCommittedPreviewMd = bundle.previewMarkdown;
		lastCommittedExplainMd = bundle.explainMarkdown;
		return (
			!outerAbortController.signal.aborted &&
			!cycleSignal.aborted &&
			generation === renderGeneration
		);
	};

	const commitSampleCycle = async (
		result: TemplateRenderResult,
		bundle: SampleWorkbenchRenderBundle,
		options: {
			readonly generation: number;
			readonly cycleSignal: AbortSignal;
			readonly sentinelHash: string;
			readonly totalRecords: number;
			readonly parseMs: number;
			readonly liquidMs: number;
		},
	): Promise<void> => {
		const combinedText = `${bundle.previewMarkdown}\n${bundle.explainMarkdown}`;
		const outputMetrics = measureMarkdownOutput(combinedText);
		const sentinelStore = plugin.renderSentinelStore;
		const shouldTrackSentinel = result.ok && exceedsSentinelThreshold(outputMetrics);
		const sentinelStats = {
			records: options.totalRecords,
			outputChars: outputMetrics.chars,
			outputLines: outputMetrics.lines,
		};

		if (sentinelStore && shouldTrackSentinel) {
			await sentinelStore.markRunning(options.sentinelHash, sentinelStats);
			if (
				outerAbortController.signal.aborted ||
				options.cycleSignal.aborted ||
				options.generation !== renderGeneration
			) {
				void sentinelStore.finishRunning(options.sentinelHash, { committed: false });
				return;
			}
		}

		const paintStartedAt = Date.now();
		let committed = false;
		try {
			committed = await renderWorkbenchDom(bundle, options.generation, options.cycleSignal);
		} catch (err) {
			if (sentinelStore && shouldTrackSentinel) {
				void sentinelStore.finishRunning(options.sentinelHash, { committed: false });
			}
			throw err;
		}

		if (sentinelStore && shouldTrackSentinel) {
			schedulePostRenderPaintCleanup(() => {
				const stillCurrent =
					committed &&
					!outerAbortController.signal.aborted &&
					!options.cycleSignal.aborted;
				if (stillCurrent) {
					const totalDurationMs =
						options.parseMs +
						options.liquidMs +
						Math.max(0, Date.now() - paintStartedAt);
					void sentinelStore.finishRunning(options.sentinelHash, {
						committed: true,
						durationMs: totalDurationMs,
						stats: sentinelStats,
					});
				} else {
					void sentinelStore.finishRunning(options.sentinelHash, { committed: false });
				}
			}, el);
		} else if (sentinelStore && committed) {
			void sentinelStore.clearProbationIfSubThreshold(options.sentinelHash);
		}
	};

	const runCycle = async (): Promise<void> => {
		if (outerAbortController.signal.aborted) {
			return;
		}
		activeCycleController?.abort();
		const cycleController = new AbortController();
		activeCycleController = cycleController;
		const cycleSignal = cycleController.signal;

		const parseStartedAt = Date.now();
		const referenceTimeMs = parseStartedAt;
		const onReset = (): void => {
			if (outerAbortController.signal.aborted) {
				return;
			}
			cycleController.abort();
			void runCycle();
		};

		const folderConfig: TemplateFolderConfig = {
			templatesFolder: plugin.settings.templatesFolder,
			partialsFolder: plugin.settings.partialsFolder,
			layoutsFolder: plugin.settings.layoutsFolder,
			configDir: plugin.app.vault.configDir,
		};
		const renderCache = plugin.codeBlockRenderCache;
		const templateRevision = plugin.activeQueryRoster?.templateRevision ?? 0;

		const cachedPass1 = renderCache?.getPass1(
			currentSourcePath,
			source,
			folderConfig,
			templateRevision,
		);
		let parsed: Awaited<ReturnType<typeof parseRhizomeTemplatePass1Async>>;
		let referencesHost: boolean;
		let parseDurationMs = 0;

		if (cachedPass1 !== undefined) {
			parsed = cachedPass1.parsed;
			referencesHost = cachedPass1.referencesHost;
		} else {
			const runPass1 = async () => {
				const p = await parseRhizomeTemplatePass1Async(
					source,
					folderConfig,
					(vaultRelativePath) => readVaultTemplateNote(plugin, vaultRelativePath),
				);
				const refHost = parsedTemplateReferencesHost(source, p);
				const loopTag = parsedTemplateHasLoopTag(source, p);
				if (p.env.diagnostics.length === 0 && p.templates !== null) {
					renderCache?.setPass1(
						currentSourcePath,
						source,
						folderConfig,
						templateRevision,
						p,
						refHost,
						loopTag,
					);
				}
				return { parsed: p, referencesHost: refHost, hasLoopTag: loopTag };
			};
			const pass1Res = renderCache
				? await renderCache.getOrRunPass1(
						currentSourcePath,
						source,
						folderConfig,
						templateRevision,
						runPass1,
					)
				: await runPass1();
			parseDurationMs = Math.max(0, Date.now() - parseStartedAt);
			parsed = pass1Res.parsed;
			referencesHost = pass1Res.referencesHost;
		}

		if (outerAbortController.signal.aborted || cycleSignal.aborted) {
			return;
		}

		const isTemplatePreview =
			currentSourcePath.length > 0 &&
			isPathInTemplatesFolder(currentSourcePath, folderConfig);

		const resolveCurrentHostDoc = (
			resolvedConfig: ResolvedEngineConfig,
		): NormalizedDocument | null => {
			if (isTemplatePreview || currentSourcePath.length === 0) {
				return null;
			}
			if (plugin.backlinkIndex && !plugin.backlinkIndex.isBuilt) {
				plugin.backlinkIndex.reconcile();
			}
			return (
				resolveHostDocument(
					plugin.app,
					currentSourcePath,
					resolvedConfig,
					undefined,
					plugin.loggerAdapter,
					plugin.backlinkIndex?.snapshot(),
					(f) => isPathInTemplateFolders(f.path, folderConfig),
					plugin.documentCache,
				) ?? null
			);
		};

		if (parsed.env.diagnostics.length > 0 || parsed.templates === null) {
			const generation = ++renderGeneration;
			await plugin.query(Object.freeze({}), {
				referenceTimeMs,
				signal: cycleSignal,
				onReset,
				onSourcePathRename,
				includeHostInHash: false,
				...(currentSourcePath.length > 0 ? { sourcePath: currentSourcePath } : {}),
			});
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			const runtimeCtx = isTemplatePreview
				? await buildNewNotePreviewRuntimeContext(
						plugin,
						referenceTimeMs,
						currentSourcePath,
						ctx,
						el,
						folderConfig,
					)
				: (
						await buildDynamicRuntimeContextWithConfig(
							plugin,
							referenceTimeMs,
							currentSourcePath,
							ctx,
							el,
						)
					).runtimeContext;
			const errorResult = await renderParsedRhizomeTemplate(
				source,
				parsed,
				Object.freeze({}),
				runtimeCtx,
				undefined,
				{ allowFailedQueries: true },
			);
			const resolvedCfg = runtimeCtx.resolvedConfig!;
			const coercionDocs =
				parsed.env.queries.length > 0
					? createVaultCoercionIterable(plugin, resolvedCfg, folderConfig)
					: [];
			const telemetry = new RenderTelemetryCollector();
			const { explainMarkdown, queriedKeysUnion, coercionDigest } =
				assembleExplainStackMarkdown({
					plugin,
					source,
					parsed,
					renderResult: errorResult,
					runtimeCtx,
					folderConfig,
					isNewNoteMode: isTemplatePreview,
					hostDoc: resolveCurrentHostDoc(resolvedCfg),
					metricsByName: new Map(),
					lazyHostDocsByName: new Map(),
					coercionDocs,
					telemetry,
					stagedYamlChars: 0,
				});
			await renderWorkbenchDom(
				{
					headerSummary: `${parsed.env.queries.length} ${parsed.env.queries.length === 1 ? 'query' : 'queries'} · template syntax error`,
					targetPathPill: null,
					tabModePill: null,
					previewMarkdown: '',
					previewEmptyNotice:
						'Preview skipped due to a template syntax error — see Template Explain Plan below.',
					explainMarkdown,
					queriedKeysUnion,
					coercionDigest,
					metricsByName: new Map(),
					lazyHostDocsByName: new Map(),
					telemetry,
					stagedYamlChars: 0,
				},
				generation,
				cycleSignal,
			);
			return;
		}

		const sentinelHash = computeCodeBlockSentinelHash(
			currentSourcePath,
			source,
			parsed.env.fileSources,
			'rhizome-sample',
		);
		if (plugin.renderSentinelStore) {
			await plugin.renderSentinelStore.ensureHydrated();
			if (outerAbortController.signal.aborted || cycleSignal.aborted) {
				return;
			}
		}

		const quarantinedRecord = plugin.renderSentinelStore?.getQuarantined(sentinelHash);
		if (quarantinedRecord !== undefined) {
			const generation = ++renderGeneration;
			plugin.activeQueryRoster?.register(
				Object.freeze({}),
				{
					referenceTimeMs,
					signal: cycleSignal,
					onReset,
					onSourcePathRename,
					includeHostInHash: false,
					...(currentSourcePath.length > 0 ? { sourcePath: currentSourcePath } : {}),
				},
				Object.freeze({}),
			);
			const emptyFn = (el as { empty?: () => void }).empty;
			if (typeof emptyFn === 'function') {
				emptyFn.call(el);
			}
			const qChild = new MarkdownRenderChild(el);
			activePreviewChild = qChild;
			outerChild.addChild(qChild);
			const quarantineMd = formatQuarantinedCalloutMarkdown(quarantinedRecord);
			await MarkdownRenderer.render(plugin.app, quarantineMd, el, currentSourcePath, qChild);
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			appendQuarantineRetryButton(el, qChild, () => {
				if (outerAbortController.signal.aborted) {
					return;
				}
				void (async () => {
					await plugin.renderSentinelStore?.promoteToProbation(sentinelHash);
					if (!outerAbortController.signal.aborted) {
						cycleController.abort();
						void runCycle();
					}
				})();
			});
			plugin.loggerAdapter?.log(
				'warn',
				`Paused quarantined rhizome-sample codeblock in ${markSensitive(currentSourcePath)}`,
				{
					source: 'template.sample',
					quarantined: true,
					hash: sentinelHash,
					records: quarantinedRecord.records,
				},
			);
			return;
		}

		const queries = parsed.env.queries;
		const pass15Queries = isTemplatePreview
			? partitionNewNoteQueries(queries).staticQueries
			: queries;
		const queryMap = Object.create(null) as Record<string, string>;
		for (const q of pass15Queries) {
			queryMap[q.name] = q.query;
		}
		const frozenQueryMap = Object.freeze(queryMap);
		const hasPass15Queries = Object.keys(queryMap).length > 0;
		const hasAnyQueries = queries.length > 0;
		const effectiveReferencesHost = isTemplatePreview ? false : referencesHost;

		if (
			(hasAnyQueries || effectiveReferencesHost || isTemplatePreview) &&
			typeof plugin.waitForVaultReady === 'function'
		) {
			await plugin.waitForVaultReady(cycleSignal);
			if (outerAbortController.signal.aborted || cycleSignal.aborted) {
				return;
			}
		}

		let activeBundle: SampleWorkbenchRenderBundle | null = null;
		let activeResult: TemplateRenderResult | null = null;

		const buildFullSampleWorkbench = async (
			fullPayload: VaultQueryResult,
			refMs: number,
		): Promise<{
			readonly result: TemplateRenderResult;
			readonly bundle: SampleWorkbenchRenderBundle;
			readonly liquidMs: number;
			readonly runtimeCtx: TemplateRuntimeContext;
		}> => {
			const runtimeCtx = isTemplatePreview
				? await buildNewNotePreviewRuntimeContext(
						plugin,
						refMs,
						currentSourcePath,
						ctx,
						el,
						folderConfig,
					)
				: (
						await buildDynamicRuntimeContextWithConfig(
							plugin,
							refMs,
							currentSourcePath,
							ctx,
							el,
						)
					).runtimeContext;

			const staticSample = sampleStaticQueryBatch(pass15Queries, fullPayload, runtimeCtx);
			const combinedMetrics = new Map<string, QuerySampleMetrics>(staticSample.metricsByName);
			const lazyHostDocs = new Map<string, NormalizedDocument | null>();
			const telemetry = new RenderTelemetryCollector();

			const liquidStartedAt = Date.now();
			const pass2Res = await renderParsedRhizomeTemplate(
				source,
				parsed,
				fullPayload,
				runtimeCtx,
				isTemplatePreview
					? (lazyMap, lazyOpts) =>
							plugin.query(lazyMap, {
								referenceTimeMs: refMs,
								...(lazyOpts?.hostDoc !== undefined
									? { hostDoc: lazyOpts.hostDoc }
									: {}),
								...(lazyOpts?.priorQueryPaths !== undefined
									? { priorQueryPaths: lazyOpts.priorQueryPaths }
									: {}),
							})
					: undefined,
				{
					allowFailedQueries: true,
					effectiveStaticPayload: staticSample.sampledPayload,
					precomputedStaticCalloutsMarkdown: staticSample.calloutsMarkdown,
					telemetry,
					transformLazyRows: (qBlock, rawRows, lazyOpts) => {
						lazyHostDocs.set(qBlock.name, lazyOpts.hostDoc ?? null);
						const sampledLazy = sampleSingleLazyQuery(
							qBlock,
							rawRows,
							staticSample.linkedPaths,
							runtimeCtx,
						);
						combinedMetrics.set(qBlock.name, sampledLazy.metrics);
						return {
							effectiveRows: sampledLazy.effectiveRows,
							calloutMarkdown: sampledLazy.calloutMarkdown,
						};
					},
				},
			);
			const liquidMs = Math.max(0, Date.now() - liquidStartedAt);

			const { effectiveResult, frontmatterCalloutMarkdown, stagedYamlChars } =
				synthesizeSimulatedFrontmatterMarkdown(source, parsed, pass2Res, isTemplatePreview);

			const previewParts = [
				frontmatterCalloutMarkdown,
				effectiveResult.ok ? effectiveResult.markdown : '',
			].filter((s) => s.length > 0);
			const previewMarkdown = previewParts.join('\n\n');
			const previewEmptyNotice = !effectiveResult.ok
				? 'Preview unavailable due to a template runtime error — see Template Explain Plan below.'
				: previewMarkdown.trim().length === 0
					? 'Template rendered empty output (0 characters).'
					: null;

			const resolvedCfg = runtimeCtx.resolvedConfig!;
			const coercionDocs =
				parsed.env.queries.length > 0
					? createVaultCoercionIterable(plugin, resolvedCfg, folderConfig)
					: [];
			const hostDoc = resolveCurrentHostDoc(resolvedCfg);
			const { explainMarkdown, queriedKeysUnion, coercionDigest } =
				assembleExplainStackMarkdown({
					plugin,
					source,
					parsed,
					renderResult: effectiveResult,
					runtimeCtx,
					folderConfig,
					isNewNoteMode: isTemplatePreview,
					hostDoc,
					metricsByName: combinedMetrics,
					lazyHostDocsByName: lazyHostDocs,
					coercionDocs,
					telemetry,
					stagedYamlChars,
				});

			const bundle: SampleWorkbenchRenderBundle = {
				headerSummary: formatHeaderSummaryText(
					parsed.env.queries.length,
					combinedMetrics,
					isTemplatePreview,
				),
				targetPathPill:
					isTemplatePreview && effectiveResult.ok
						? (effectiveResult.targetPath ?? null)
						: null,
				tabModePill:
					isTemplatePreview && effectiveResult.ok
						? (effectiveResult.tabMode ?? 'background')
						: null,
				previewMarkdown,
				previewEmptyNotice,
				explainMarkdown,
				queriedKeysUnion,
				coercionDigest,
				metricsByName: combinedMetrics,
				lazyHostDocsByName: lazyHostDocs,
				telemetry,
				stagedYamlChars,
			};

			return { result: effectiveResult, bundle, liquidMs, runtimeCtx };
		};

		const resolveCurrentHeadingLevel = (): number =>
			lookupHostHeadingLevel(plugin, currentSourcePath, ctx, el);

		const onUpdate = async (newPayload: VaultQueryResult): Promise<void> => {
			if (outerAbortController.signal.aborted || cycleSignal.aborted) {
				return;
			}
			const generation = ++renderGeneration;
			const updateStartedAt = Date.now();
			const built = await buildFullSampleWorkbench(newPayload, updateStartedAt);
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}

			const currentHeadingLevel = built.runtimeCtx.headingLevel ?? 0;
			const currentTemplateRev = plugin.activeQueryRoster?.templateRevision ?? 0;
			const currentStateRev = plugin.activeQueryRoster?.stateRevision ?? 0;
			const payloadHash = hashVaultQueryResult(newPayload, {
				includeHost: effectiveReferencesHost,
				headingLevel: currentHeadingLevel,
			});
			const canCache =
				!isTemplatePreview &&
				(built.result.ok || isRuntimeRenderErrorResult(built.result)) &&
				currentTemplateRev === templateRevision &&
				allExtractedQueriesExecutable(parsed, newPayload);
			if (canCache) {
				renderCache?.setRender(
					currentSourcePath,
					source,
					currentHeadingLevel,
					folderConfig,
					templateRevision,
					currentStateRev,
					payloadHash,
					newPayload,
					built.result,
					'rhizome-sample',
					built.bundle,
				);
			}

			activeResult = built.result;
			activeBundle = built.bundle;
			const totalRecords = countExtractedQueryRecords(parsed, newPayload);
			await commitSampleCycle(built.result, built.bundle, {
				generation,
				cycleSignal,
				sentinelHash,
				totalRecords,
				parseMs: 0,
				liquidMs: built.liquidMs,
			});
		};

		const initialGeneration = ++renderGeneration;
		const initialHeadingLevel = resolveCurrentHeadingLevel();
		let lastCheckedCoercionStateRev = -1;

		const onUnchangedPayload = (stateRev: number, unchangedPayloadHash: string): void => {
			if (outerAbortController.signal.aborted || cycleSignal.aborted) {
				return;
			}
			if (!isTemplatePreview) {
				renderCache?.advanceStateRevision(
					currentSourcePath,
					source,
					resolveCurrentHeadingLevel(),
					folderConfig,
					plugin.activeQueryRoster?.templateRevision ?? 0,
					unchangedPayloadHash,
					stateRev,
					'rhizome-sample',
				);
			}
			if (
				stateRev === lastCheckedCoercionStateRev ||
				activeBundle === null ||
				activeResult === null ||
				activeBundle.queriedKeysUnion.size === 0 ||
				activeExplainEl === null
			) {
				return;
			}
			lastCheckedCoercionStateRev = stateRev;
			const snapshotBundle = activeBundle;
			const snapshotResult = activeResult;
			const snapshotGen = renderGeneration;
			void (async () => {
				const { runtimeContext, resolvedConfig } =
					await buildDynamicRuntimeContextWithConfig(
						plugin,
						Date.now(),
						currentSourcePath,
						ctx,
						el,
					);
				if (
					outerAbortController.signal.aborted ||
					cycleSignal.aborted ||
					snapshotGen !== renderGeneration ||
					activeExplainEl === null
				) {
					return;
				}
				const coerceDocs = createVaultCoercionIterable(
					plugin,
					resolvedConfig,
					folderConfig,
				);
				const nextDigest = computeCoercionDiagnosticsDigest(
					plugin,
					snapshotBundle.queriedKeysUnion,
					coerceDocs,
				);
				if (nextDigest === snapshotBundle.coercionDigest) {
					return;
				}
				const effCtx = isTemplatePreview
					? await buildNewNotePreviewRuntimeContext(
							plugin,
							Date.now(),
							currentSourcePath,
							ctx,
							el,
							folderConfig,
						)
					: runtimeContext;
				const rebuilt = assembleExplainStackMarkdown({
					plugin,
					source,
					parsed,
					renderResult: snapshotResult,
					runtimeCtx: effCtx,
					folderConfig,
					isNewNoteMode: isTemplatePreview,
					hostDoc: resolveCurrentHostDoc(resolvedConfig),
					metricsByName: snapshotBundle.metricsByName,
					lazyHostDocsByName: snapshotBundle.lazyHostDocsByName,
					coercionDocs: coerceDocs,
					telemetry: snapshotBundle.telemetry,
					stagedYamlChars: snapshotBundle.stagedYamlChars,
				});
				if (
					outerAbortController.signal.aborted ||
					cycleSignal.aborted ||
					snapshotGen !== renderGeneration ||
					activeExplainEl === null
				) {
					return;
				}
				activeBundle = {
					...snapshotBundle,
					explainMarkdown: rebuilt.explainMarkdown,
					coercionDigest: rebuilt.coercionDigest,
				};
				lastCommittedExplainMd = rebuilt.explainMarkdown;
				if (activeExplainChild !== null) {
					outerChild.removeChild(activeExplainChild);
				}
				const nextExplainChild = new MarkdownRenderChild(activeExplainEl);
				activeExplainChild = nextExplainChild;
				outerChild.addChild(nextExplainChild);
				activeExplainEl.empty();
				await MarkdownRenderer.render(
					plugin.app,
					rebuilt.explainMarkdown,
					activeExplainEl,
					currentSourcePath,
					nextExplainChild,
				);
			})();
		};

		const subscriptionOptions = {
			referenceTimeMs,
			signal: cycleSignal,
			onReset,
			onSourcePathRename,
			onUnchangedPayload,
			includeHostInHash: effectiveReferencesHost,
			headingLevel: resolveCurrentHeadingLevel,
			...(!isTemplatePreview && currentSourcePath.length > 0
				? { sourcePath: currentSourcePath }
				: {}),
		};
		const mountOnUpdate = hasAnyQueries || currentSourcePath.length > 0 ? onUpdate : undefined;

		const currentTemplateRevAtMount = plugin.activeQueryRoster?.templateRevision ?? 0;
		const stateRevisionBeforeQuery = plugin.activeQueryRoster?.stateRevision ?? 0;
		const remountHit = !isTemplatePreview
			? renderCache?.getRemountHit(
					currentSourcePath,
					source,
					initialHeadingLevel,
					folderConfig,
					currentTemplateRevAtMount,
					stateRevisionBeforeQuery,
					'rhizome-sample',
				)
			: undefined;
		const remountBundle = remountHit?.extra as SampleWorkbenchRenderBundle | undefined;

		if (remountHit !== undefined && remountBundle !== undefined) {
			lastCheckedCoercionStateRev = stateRevisionBeforeQuery;
			plugin.activeQueryRoster?.register(
				frozenQueryMap,
				subscriptionOptions,
				remountHit.payload,
				mountOnUpdate,
			);
			activeResult = remountHit.result;
			activeBundle = remountBundle;
			const totalRecords = countExtractedQueryRecords(parsed, remountHit.payload);
			await commitSampleCycle(remountHit.result, remountBundle, {
				generation: initialGeneration,
				cycleSignal,
				sentinelHash,
				totalRecords,
				parseMs: parseDurationMs,
				liquidMs: 0,
			});
			return;
		}

		const executeInitialSample = async (
			hasLiveSubscribers: () => boolean,
		): Promise<{
			readonly payload: VaultQueryResult;
			readonly result: TemplateRenderResult;
			readonly bundle: SampleWorkbenchRenderBundle;
			readonly totalRecords: number;
			readonly liquidMs: number;
		} | null> => {
			if (!hasLiveSubscribers()) {
				return null;
			}
			let initialPayload: VaultQueryResult;
			if (!hasPass15Queries && !effectiveReferencesHost) {
				initialPayload = Object.freeze({});
				plugin.activeQueryRoster?.register(
					frozenQueryMap,
					subscriptionOptions,
					initialPayload,
					mountOnUpdate,
				);
			} else {
				initialPayload = await plugin.query(
					frozenQueryMap,
					subscriptionOptions,
					mountOnUpdate,
				);
			}
			if (!hasLiveSubscribers()) {
				return null;
			}

			const totalRecords = countExtractedQueryRecords(parsed, initialPayload);
			const built = await buildFullSampleWorkbench(initialPayload, referenceTimeMs);

			const currentHeadingLevel = built.runtimeCtx.headingLevel ?? 0;
			const templateRevAfterPass2 = plugin.activeQueryRoster?.templateRevision ?? 0;
			const allExecutable =
				!isTemplatePreview && allExtractedQueriesExecutable(parsed, initialPayload);
			if (
				allExecutable &&
				templateRevAfterPass2 === templateRevision &&
				(built.result.ok || isRuntimeRenderErrorResult(built.result))
			) {
				const payloadHash = hashVaultQueryResult(initialPayload, {
					includeHost: effectiveReferencesHost,
					headingLevel: currentHeadingLevel,
				});
				renderCache?.setRender(
					currentSourcePath,
					source,
					currentHeadingLevel,
					folderConfig,
					templateRevision,
					plugin.activeQueryRoster?.stateRevision ?? stateRevisionBeforeQuery,
					payloadHash,
					initialPayload,
					built.result,
					'rhizome-sample',
					built.bundle,
				);
			}

			return {
				payload: initialPayload,
				result: built.result,
				bundle: built.bundle,
				totalRecords,
				liquidMs: built.liquidMs,
			};
		};

		const flight =
			renderCache && !isTemplatePreview
				? renderCache.getOrRunInFlight(
						{
							sourcePath: currentSourcePath,
							source,
							headingLevel: initialHeadingLevel,
							folders: folderConfig,
							templateRevision: currentTemplateRevAtMount,
							stateRevision: stateRevisionBeforeQuery,
							flavor: 'rhizome-sample',
						},
						cycleSignal,
						executeInitialSample,
					)
				: {
						promise: executeInitialSample(
							() => !outerAbortController.signal.aborted && !cycleSignal.aborted,
						),
						isLeader: true,
					};

		const shared = await flight.promise;
		if (
			shared === null ||
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			initialGeneration !== renderGeneration
		) {
			return;
		}

		if (!flight.isLeader) {
			if ((plugin.activeQueryRoster?.stateRevision ?? 0) !== stateRevisionBeforeQuery) {
				await runCycle();
				return;
			}
			plugin.activeQueryRoster?.register(
				frozenQueryMap,
				subscriptionOptions,
				shared.payload,
				mountOnUpdate,
			);
		}

		activeResult = shared.result;
		activeBundle = shared.bundle;
		await commitSampleCycle(shared.result, shared.bundle, {
			generation: initialGeneration,
			cycleSignal,
			sentinelHash,
			totalRecords: shared.totalRecords,
			parseMs: parseDurationMs,
			liquidMs: flight.isLeader ? shared.liquidMs : 0,
		});
	};

	await runCycle();
}
