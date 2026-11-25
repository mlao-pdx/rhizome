import { type MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer } from 'obsidian';
import {
	isPathInTemplatesFolder,
	parsedTemplateHasLoopTag,
	parsedTemplateReferencesHost,
	parseRhizomeTemplatePass1Async,
	partitionNewNoteQueries,
	renderParsedRhizomeTemplate,
	resolveCodeBlockHeadingLevel,
	type RhizomeCodeBlockFlavor,
	type TemplateRenderResult,
} from '@core/templates';
import type RhizomePlugin from '../main';
import { hashVaultQueryResult } from './active-query-roster';
import {
	appendQuarantineRetryButton,
	formatDynamicStandbyCallout,
	formatLargeRenderStandbyCallout,
	formatQuarantinedCalloutMarkdown,
	logCodeBlockRenderResult,
	schedulePostRenderPaintCleanup,
	type StandbyTrigger,
	yieldForBrowserPaint,
} from './codeblock-callouts';
import {
	buildBaseRuntimeContext,
	buildDynamicRuntimeContextWithConfig,
	buildNewNotePreviewRuntimeContext,
	lookupHostHeadingLevel,
	readVaultTemplateNote,
} from './codeblock-lifecycle';
import {
	allExtractedQueriesExecutable,
	countExtractedQueryRecords,
	exceedsLargeMarkdownThreshold,
	exceedsSentinelThreshold,
	isRuntimeRenderErrorResult,
	LARGE_MARKDOWN_CHAR_THRESHOLD,
	LARGE_MARKDOWN_LINE_THRESHOLD,
	LARGE_QUERY_RECORD_THRESHOLD,
	measureMarkdownOutput,
} from './codeblock-render-cache';
import { markSensitive } from './logger-format';
import { computeCodeBlockSentinelHash } from './render-sentinel-store';
import { processRhizomeSampleCodeBlock } from './rhizome-sample-workbench';
import type { VaultQueryResult } from './vault-query-runner';

export {
	countExtractedQueryRecords,
	exceedsLargeMarkdownThreshold,
	exceedsSentinelThreshold,
	formatDynamicStandbyCallout,
	formatLargeRenderStandbyCallout,
	LARGE_MARKDOWN_CHAR_THRESHOLD,
	LARGE_MARKDOWN_LINE_THRESHOLD,
	LARGE_QUERY_RECORD_THRESHOLD,
	measureMarkdownOutput,
	resolveCodeBlockHeadingLevel,
};

interface CoalescedInitialRender {
	readonly payload: VaultQueryResult;
	readonly result: TemplateRenderResult;
	readonly totalRecords: number;
	readonly liquidMs: number;
	readonly cacheHit?: 'payload' | undefined;
	readonly standbyShownOnLeader: boolean;
}

/**
 * Processes a fenced `rhizome` or `rhizome-sample` Markdown codeblock. When `flavor` is
 * `'rhizome-sample'`, delegates to the two-region `rhizome-sample` Authoring & Diagnostics
 * Workbench; otherwise executes the production `rhizome` render pipeline.
 */
export async function processRhizomeCodeBlock(
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	plugin: RhizomePlugin,
	flavor: RhizomeCodeBlockFlavor = 'rhizome',
): Promise<void> {
	if (flavor === 'rhizome-sample') {
		await processRhizomeSampleCodeBlock(source, el, ctx, plugin);
		return;
	}

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

	let activeRenderChild: MarkdownRenderChild | null = null;
	let hasCommittedRender = false;
	let lastCommittedMarkdown: string | null = null;
	let renderGeneration = 0;

	const renderIntoContainer = async (
		markdown: string,
		generation: number,
		cycleSignal: AbortSignal,
	): Promise<{
		readonly markdownRenderMs: number;
		readonly renderChild: MarkdownRenderChild;
	} | null> => {
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			generation !== renderGeneration
		) {
			return null;
		}
		if (activeRenderChild !== null) {
			outerChild.removeChild(activeRenderChild);
		}
		const emptyFn = (el as { empty?: () => void }).empty;
		if (typeof emptyFn === 'function') {
			emptyFn.call(el);
		}
		const renderChild = new MarkdownRenderChild(el);
		activeRenderChild = renderChild;
		outerChild.addChild(renderChild);
		const markdownStartedAt = Date.now();
		await MarkdownRenderer.render(plugin.app, markdown, el, currentSourcePath, renderChild);
		const markdownRenderMs = Math.max(0, Date.now() - markdownStartedAt);
		if (
			outerAbortController.signal.aborted ||
			cycleSignal.aborted ||
			generation !== renderGeneration
		) {
			return null;
		}
		return { markdownRenderMs, renderChild };
	};

	const showStandbyCalloutAndYield = async (
		trigger: StandbyTrigger,
		generation: number,
		cycleSignal: AbortSignal,
	): Promise<boolean> => {
		const standbyMarkdown = formatDynamicStandbyCallout(trigger);
		const rendered = await renderIntoContainer(standbyMarkdown, generation, cycleSignal);
		if (rendered === null) {
			return false;
		}
		await yieldForBrowserPaint(outerAbortController.signal, cycleSignal);
		return (
			!outerAbortController.signal.aborted &&
			!cycleSignal.aborted &&
			generation === renderGeneration
		);
	};

	const commitCycleRender = async (
		result: TemplateRenderResult,
		options: {
			readonly generation: number;
			readonly cycleSignal: AbortSignal;
			readonly sentinelHash: string;
			readonly totalRecords: number;
			readonly parseMs: number;
			readonly liquidMs: number;
			readonly standbyAlreadyShown?: boolean | undefined;
			readonly cacheHit?: 'remount' | 'payload' | 'coalesced' | undefined;
		},
	): Promise<void> => {
		const outputMetrics = measureMarkdownOutput(result.markdown);
		let standbyShown = options.standbyAlreadyShown === true;
		if (
			!hasCommittedRender &&
			!standbyShown &&
			result.ok &&
			exceedsLargeMarkdownThreshold(outputMetrics)
		) {
			const ok = await showStandbyCalloutAndYield(
				{ kind: 'output', metrics: outputMetrics },
				options.generation,
				options.cycleSignal,
			);
			if (!ok) {
				return;
			}
			standbyShown = true;
		}

		if (
			outerAbortController.signal.aborted ||
			options.cycleSignal.aborted ||
			options.generation !== renderGeneration
		) {
			return;
		}

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
		let rendered: Awaited<ReturnType<typeof renderIntoContainer>>;
		try {
			rendered = await renderIntoContainer(
				result.markdown,
				options.generation,
				options.cycleSignal,
			);
		} catch (err) {
			if (sentinelStore && shouldTrackSentinel) {
				void sentinelStore.finishRunning(options.sentinelHash, { committed: false });
			}
			throw err;
		}

		if (sentinelStore && shouldTrackSentinel) {
			schedulePostRenderPaintCleanup(() => {
				const stillCurrent =
					rendered !== null &&
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
		} else if (sentinelStore && rendered !== null) {
			void sentinelStore.clearProbationIfSubThreshold(options.sentinelHash);
		}

		if (rendered === null) {
			return;
		}

		hasCommittedRender = true;
		lastCommittedMarkdown = result.markdown;
		logCodeBlockRenderResult(plugin.loggerAdapter, currentSourcePath, result, {
			parseMs: options.parseMs,
			liquidMs: options.liquidMs,
			markdownRenderMs: rendered.markdownRenderMs,
			records: options.totalRecords,
			outputChars: outputMetrics.chars,
			outputLines: outputMetrics.lines,
			standbyShown,
			cacheHit: options.cacheHit,
		});
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

		const folderConfig = {
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
		let hasLoopTag: boolean;
		let parseDurationMs = 0;

		if (cachedPass1 !== undefined) {
			parsed = cachedPass1.parsed;
			referencesHost = cachedPass1.referencesHost;
			hasLoopTag = cachedPass1.hasLoopTag ?? parsedTemplateHasLoopTag(source, parsed);
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
			hasLoopTag = pass1Res.hasLoopTag;
		}

		if (outerAbortController.signal.aborted || cycleSignal.aborted) {
			return;
		}

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
			const { runtimeContext } = await buildDynamicRuntimeContextWithConfig(
				plugin,
				referenceTimeMs,
				currentSourcePath,
				ctx,
				el,
			);
			const renderStartedAt = Date.now();
			const errorResult = await renderParsedRhizomeTemplate(
				source,
				parsed,
				Object.freeze({}),
				runtimeContext,
			);
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			const liquidMs = Math.max(0, Date.now() - renderStartedAt);
			const outputMetrics = measureMarkdownOutput(errorResult.markdown);
			const rendered = await renderIntoContainer(
				errorResult.markdown,
				generation,
				cycleSignal,
			);
			if (rendered === null) {
				return;
			}
			hasCommittedRender = true;
			lastCommittedMarkdown = errorResult.markdown;
			logCodeBlockRenderResult(plugin.loggerAdapter, currentSourcePath, errorResult, {
				parseMs: parseDurationMs,
				liquidMs,
				markdownRenderMs: rendered.markdownRenderMs,
				records: 0,
				outputChars: outputMetrics.chars,
				outputLines: outputMetrics.lines,
			});
			return;
		}

		const sentinelHash = computeCodeBlockSentinelHash(
			currentSourcePath,
			source,
			parsed.env.fileSources,
			'rhizome',
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
			const quarantineMarkdown = formatQuarantinedCalloutMarkdown(quarantinedRecord);
			const outputMetrics = measureMarkdownOutput(quarantineMarkdown);
			const rendered = await renderIntoContainer(quarantineMarkdown, generation, cycleSignal);
			if (rendered === null) {
				return;
			}
			appendQuarantineRetryButton(el, rendered.renderChild, () => {
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
			hasCommittedRender = true;
			lastCommittedMarkdown = null;
			plugin.loggerAdapter?.log(
				'warn',
				`Paused quarantined rhizome codeblock in ${markSensitive(currentSourcePath)}`,
				{
					source: 'template.render',
					quarantined: true,
					hash: sentinelHash,
					records: quarantinedRecord.records,
					outputChars: quarantinedRecord.outputChars,
					outputLines: quarantinedRecord.outputLines,
					renderedChars: outputMetrics.chars,
				},
			);
			return;
		}

		const isTemplatePreview =
			currentSourcePath.length > 0 &&
			isPathInTemplatesFolder(currentSourcePath, folderConfig);
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

		const resolveCurrentHeadingLevel = (): number =>
			lookupHostHeadingLevel(plugin, currentSourcePath, ctx, el);

		const onUpdate = async (newPayload: VaultQueryResult): Promise<void> => {
			if (outerAbortController.signal.aborted || cycleSignal.aborted) {
				return;
			}
			const generation = ++renderGeneration;
			const updateStartedAt = Date.now();
			const allStaticExecutable =
				!isTemplatePreview && allExtractedQueriesExecutable(parsed, newPayload);
			const runtimeCtx = isTemplatePreview
				? await buildNewNotePreviewRuntimeContext(
						plugin,
						updateStartedAt,
						currentSourcePath,
						ctx,
						el,
						folderConfig,
					)
				: allStaticExecutable
					? buildBaseRuntimeContext(plugin, updateStartedAt, currentSourcePath, ctx, el)
					: (
							await buildDynamicRuntimeContextWithConfig(
								plugin,
								updateStartedAt,
								currentSourcePath,
								ctx,
								el,
							)
						).runtimeContext;
			const currentHeadingLevel = runtimeCtx.headingLevel ?? 0;
			const currentTemplateRev = plugin.activeQueryRoster?.templateRevision ?? 0;
			const currentStateRev = plugin.activeQueryRoster?.stateRevision ?? 0;
			const payloadHash = hashVaultQueryResult(newPayload, {
				includeHost: effectiveReferencesHost,
				headingLevel: currentHeadingLevel,
			});

			const updatedResult = await renderParsedRhizomeTemplate(
				source,
				parsed,
				newPayload,
				runtimeCtx,
				isTemplatePreview
					? (lazyMap, lazyOpts) =>
							plugin.query(lazyMap, {
								referenceTimeMs: updateStartedAt,
								...(lazyOpts?.hostDoc !== undefined
									? { hostDoc: lazyOpts.hostDoc }
									: {}),
								...(lazyOpts?.priorQueryPaths !== undefined
									? { priorQueryPaths: lazyOpts.priorQueryPaths }
									: {}),
							})
					: undefined,
				allStaticExecutable ? { staticQueriesPrevalidated: true } : undefined,
			);
			if (
				outerAbortController.signal.aborted ||
				cycleSignal.aborted ||
				generation !== renderGeneration
			) {
				return;
			}
			const canCacheUpdate =
				!isTemplatePreview &&
				(updatedResult.ok || isRuntimeRenderErrorResult(updatedResult)) &&
				currentTemplateRev === templateRevision &&
				allExtractedQueriesExecutable(parsed, newPayload);
			if (canCacheUpdate) {
				renderCache?.setRender(
					currentSourcePath,
					source,
					currentHeadingLevel,
					folderConfig,
					templateRevision,
					currentStateRev,
					payloadHash,
					newPayload,
					updatedResult,
					'rhizome',
				);
			}
			if (hasCommittedRender && updatedResult.markdown === lastCommittedMarkdown) {
				return;
			}
			const liquidMs = Math.max(0, Date.now() - updateStartedAt);
			const totalRecords = countExtractedQueryRecords(parsed, newPayload);
			await commitCycleRender(updatedResult, {
				generation,
				cycleSignal,
				sentinelHash,
				totalRecords,
				parseMs: 0,
				liquidMs,
			});
		};

		const initialGeneration = ++renderGeneration;
		const initialHeadingLevel = resolveCurrentHeadingLevel();
		const onUnchangedPayload = (stateRev: number, unchangedPayloadHash: string): void => {
			if (outerAbortController.signal.aborted || cycleSignal.aborted || isTemplatePreview) {
				return;
			}
			renderCache?.advanceStateRevision(
				currentSourcePath,
				source,
				resolveCurrentHeadingLevel(),
				folderConfig,
				plugin.activeQueryRoster?.templateRevision ?? 0,
				unchangedPayloadHash,
				stateRev,
				'rhizome',
			);
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
					'rhizome',
				)
			: undefined;
		if (remountHit !== undefined) {
			plugin.activeQueryRoster?.register(
				frozenQueryMap,
				subscriptionOptions,
				remountHit.payload,
				mountOnUpdate,
			);
			const totalRecords = countExtractedQueryRecords(parsed, remountHit.payload);
			await commitCycleRender(remountHit.result, {
				generation: initialGeneration,
				cycleSignal,
				sentinelHash,
				totalRecords,
				parseMs: parseDurationMs,
				liquidMs: 0,
				cacheHit: 'remount',
			});
			return;
		}

		const executeInitialQueryAndPass2 = async (
			hasLiveSubscribers: () => boolean,
		): Promise<CoalescedInitialRender | null> => {
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
			const allExecutable =
				!isTemplatePreview && allExtractedQueriesExecutable(parsed, initialPayload);
			const runtimeCtx = isTemplatePreview
				? await buildNewNotePreviewRuntimeContext(
						plugin,
						referenceTimeMs,
						currentSourcePath,
						ctx,
						el,
						folderConfig,
					)
				: allExecutable
					? buildBaseRuntimeContext(plugin, referenceTimeMs, currentSourcePath, ctx, el)
					: (
							await buildDynamicRuntimeContextWithConfig(
								plugin,
								referenceTimeMs,
								currentSourcePath,
								ctx,
								el,
							)
						).runtimeContext;
			const currentHeadingLevel = runtimeCtx.headingLevel ?? 0;
			const liveTemplateRev = plugin.activeQueryRoster?.templateRevision ?? 0;
			const templateRevStillMatches = liveTemplateRev === templateRevision;
			const currentStateRev = plugin.activeQueryRoster?.stateRevision ?? 0;
			const payloadHash = hashVaultQueryResult(initialPayload, {
				includeHost: effectiveReferencesHost,
				headingLevel: currentHeadingLevel,
			});
			const cachedByPayload =
				allExecutable && templateRevStillMatches
					? renderCache?.getRenderByPayloadHash(
							currentSourcePath,
							source,
							currentHeadingLevel,
							folderConfig,
							templateRevision,
							payloadHash,
							'rhizome',
						)
					: undefined;
			if (cachedByPayload !== undefined) {
				renderCache?.setRender(
					currentSourcePath,
					source,
					currentHeadingLevel,
					folderConfig,
					templateRevision,
					currentStateRev,
					payloadHash,
					initialPayload,
					cachedByPayload,
					'rhizome',
				);
				return {
					payload: initialPayload,
					result: cachedByPayload,
					totalRecords,
					liquidMs: 0,
					cacheHit: 'payload',
					standbyShownOnLeader: false,
				};
			}

			let standbyShownOnLeader = false;
			if (
				!hasCommittedRender &&
				hasLoopTag &&
				totalRecords >= LARGE_QUERY_RECORD_THRESHOLD &&
				!outerAbortController.signal.aborted &&
				!cycleSignal.aborted &&
				initialGeneration === renderGeneration
			) {
				const ok = await showStandbyCalloutAndYield(
					{ kind: 'records', totalRecords },
					initialGeneration,
					cycleSignal,
				);
				if (ok) {
					standbyShownOnLeader = true;
				}
			}

			if (!hasLiveSubscribers()) {
				return null;
			}

			const renderStartedAt = Date.now();
			const initialResult = await renderParsedRhizomeTemplate(
				source,
				parsed,
				initialPayload,
				runtimeCtx,
				isTemplatePreview
					? (lazyMap, lazyOpts) =>
							plugin.query(lazyMap, {
								referenceTimeMs,
								...(lazyOpts?.hostDoc !== undefined
									? { hostDoc: lazyOpts.hostDoc }
									: {}),
								...(lazyOpts?.priorQueryPaths !== undefined
									? { priorQueryPaths: lazyOpts.priorQueryPaths }
									: {}),
							})
					: undefined,
				allExecutable ? { staticQueriesPrevalidated: true } : undefined,
			);
			const liquidMs = Math.max(0, Date.now() - renderStartedAt);

			const templateRevAfterPass2 = plugin.activeQueryRoster?.templateRevision ?? 0;
			if (
				allExecutable &&
				templateRevAfterPass2 === templateRevision &&
				(initialResult.ok || isRuntimeRenderErrorResult(initialResult))
			) {
				renderCache?.setRender(
					currentSourcePath,
					source,
					currentHeadingLevel,
					folderConfig,
					templateRevision,
					plugin.activeQueryRoster?.stateRevision ?? currentStateRev,
					payloadHash,
					initialPayload,
					initialResult,
					'rhizome',
				);
			}

			return {
				payload: initialPayload,
				result: initialResult,
				totalRecords,
				liquidMs,
				standbyShownOnLeader,
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
							flavor: 'rhizome',
						},
						cycleSignal,
						executeInitialQueryAndPass2,
					)
				: {
						promise: executeInitialQueryAndPass2(
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

		await commitCycleRender(shared.result, {
			generation: initialGeneration,
			cycleSignal,
			sentinelHash,
			totalRecords: shared.totalRecords,
			parseMs: parseDurationMs,
			liquidMs: flight.isLeader ? shared.liquidMs : 0,
			standbyAlreadyShown: flight.isLeader && shared.standbyShownOnLeader,
			cacheHit: flight.isLeader ? shared.cacheHit : 'coalesced',
		});
	};

	await runCycle();
}
