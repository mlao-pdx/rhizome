import { type ExplainConceptKey, formatInlineCode, formatSourceCaretSnippet } from '@core/search';
import { Tag, type Template } from 'liquidjs';
import { clampHeadingLevel, type HeadingLevelSpec, resolveHeadingLevel } from '../heading-filter';
import { isQueryDiagnosticCode } from '../query-diagnostics';
import type { QuerySampleMetrics } from '../query-sampler';
import {
	formatAstNodeKey,
	MAX_TEMPLATE_OUTPUT_CHARS,
	type RenderTelemetryCollector,
} from '../render-limits';
import { normalizeLookupCacheKey, type ParsedRhizomeTemplate } from '../template-engine';
import { normalizeInitialHeadingLevel } from '../temporal-drop';
import type { TemplateDiagnostic, TemplateRenderResult, TemplateRuntimeContext } from '../types';
import { explainLiquidValue } from './expression-explainer';
import {
	escapeExplainProse,
	formatSafeExplainFileLink,
	prefixCalloutBodyLines,
	wrapCodeFenceLines,
} from './query-explain-callout';
import {
	analyzeRenderPartialScope,
	extractLayoutArgsSummary,
	formatCallSiteBindingsInline,
	isComplexPartialAst,
} from './scope-analyzer';
import {
	estimateFullScaleOutput,
	formatHumanCharSize,
	formatNodeSizeBadge,
	resolveQueryScaleFactor,
} from './size-badge';

const MAX_COMPLEX_PARTIAL_EXPANSIONS = 16;
const QUERY_COLLECTION_REF_RE = /\bquery\.([a-zA-Z_][a-zA-Z0-9_-]*)\b/;

export interface BuildTemplateExplainPlanOptions {
	readonly source: string;
	readonly parsed: ParsedRhizomeTemplate;
	readonly renderResult: TemplateRenderResult;
	readonly runtimeContext?: TemplateRuntimeContext | undefined;
	readonly metricsByName: ReadonlyMap<string, QuerySampleMetrics>;
	readonly waveByQueryName: ReadonlyMap<string, number>;
	readonly lazyQueryNames: ReadonlySet<string>;
	readonly telemetry?: RenderTelemetryCollector | undefined;
	readonly stagedYamlChars?: number | undefined;
}

export interface TemplateExplainPlanResult {
	readonly calloutMarkdown: string;
	readonly triggeredConcepts: ReadonlySet<ExplainConceptKey>;
	readonly hasWarnings: boolean;
}

interface OutlineWalkContext {
	readonly parsed: ParsedRhizomeTemplate;
	readonly isNewNoteMode: boolean;
	readonly isDynamicNullTemplate: boolean;
	readonly knownQueryNames: ReadonlySet<string>;
	readonly metricsByName: ReadonlyMap<string, QuerySampleMetrics>;
	readonly waveByQueryName: ReadonlyMap<string, number>;
	readonly lazyQueryNames: ReadonlySet<string>;
	readonly telemetry: RenderTelemetryCollector | undefined;
	readonly totalSampleChars: number;
	readonly concepts: Set<ExplainConceptKey>;
	readonly seenPartialsCount: Map<string, number>;
	readonly activeFileChain: Set<string>;
	readonly warnings: string[];
	readonly attributedSampleCharsByQuery: Map<string, number>;
	totalComplexExpansions: number;
}

function addWarningUnique(ctx: OutlineWalkContext, msg: string): void {
	if (!ctx.warnings.includes(msg)) {
		ctx.warnings.push(msg);
	}
}

function extractDrivingQueryName(
	exprText: string,
	localQueryVarMap: ReadonlyMap<string, string>,
): string | null {
	const direct = QUERY_COLLECTION_REF_RE.exec(exprText);
	if (direct?.[1]) {
		return direct[1];
	}
	const rootIdent = /^([a-zA-Z_][a-zA-Z0-9_-]*)/.exec(exprText.trim())?.[1];
	if (rootIdent && localQueryVarMap.has(rootIdent)) {
		return localQueryVarMap.get(rootIdent) ?? null;
	}
	return null;
}

function recordAttributedQueryChars(
	ctx: OutlineWalkContext,
	queryName: string | null,
	sampleChars: number,
	insideAttributedLoop: boolean,
): void {
	if (insideAttributedLoop || !queryName || sampleChars <= 0) {
		return;
	}
	ctx.attributedSampleCharsByQuery.set(
		queryName,
		(ctx.attributedSampleCharsByQuery.get(queryName) ?? 0) + sampleChars,
	);
}

function summarizeLiteralSnippet(raw: string): string {
	const trimmed = raw.trim().replace(/\s+/g, ' ');
	if (trimmed.length <= 48) {
		return formatInlineCode(trimmed);
	}
	return formatInlineCode(`${trimmed.slice(0, 45)}...`);
}

function isNonEmittingMetaTag(tpl: Template): boolean {
	if (!(tpl instanceof Tag)) return false;
	const name = (tpl as { readonly name?: string }).name ?? '';
	return (
		name === 'query' ||
		name === 'targetPath' ||
		name === 'frontmatter' ||
		name === 'comment' ||
		name === '#' ||
		name === 'assign' ||
		name === 'capture'
	);
}

function formatHeadingTransitionPhrase(
	currentLevel: number,
	spec: HeadingLevelSpec | null,
): {
	readonly nextLevel: number;
	readonly label: string;
} {
	const nextLevel = resolveHeadingLevel(currentLevel, spec);
	if (nextLevel > 6) {
		return {
			nextLevel,
			label: `logical level \`${nextLevel}\` (> \`H6\`, so \`| heading\` falls back to indented list items)`,
		};
	}
	const clamped = clampHeadingLevel(nextLevel <= 0 ? 1 : nextLevel);
	return {
		nextLevel,
		label: `\`H${clamped}\` (\`${'#'.repeat(clamped)}\`)`,
	};
}

function renderTemplateDiagnosticsSection(
	rootSource: string,
	diagnostics: readonly TemplateDiagnostic[],
	fileSources: ReadonlyMap<string, string>,
): string[] {
	const filtered = diagnostics.filter((d) => !isQueryDiagnosticCode(d.code));
	const targetList = filtered.length > 0 ? filtered : diagnostics;
	if (targetList.length === 0) {
		return [];
	}
	const lines: string[] = ['**Template Diagnostics**', ''];
	for (const diag of targetList) {
		const extFile =
			typeof diag.file === 'string' && diag.file.trim().length > 0 ? diag.file.trim() : null;
		const filePrefix = extFile !== null ? `in ${formatSafeExplainFileLink(extFile)}, ` : '';
		const loc = diag.span
			? ` (${filePrefix}line ${diag.span.startLine}, column ${diag.span.startColumn})`
			: extFile !== null
				? ` (in ${formatSafeExplainFileLink(extFile)})`
				: '';
		lines.push(`- **❌ \`${diag.code}\`**${loc}: ${escapeExplainProse(diag.issue)}`);
		if (diag.span !== null) {
			const src = extFile !== null ? fileSources.get(extFile) : rootSource;
			if (typeof src === 'string') {
				const snippet = formatSourceCaretSnippet(src, diag.span);
				lines.push(...wrapCodeFenceLines(snippet, 'text', '  '));
			}
		}
		if (diag.hint !== null) {
			lines.push(`  *Fix*: ${escapeExplainProse(diag.hint)}`);
		}
	}
	return lines;
}

interface ScopedWalkState {
	readonly callerLocals: Set<string>;
	readonly localQueryVarMap: Map<string, string>;
	readonly activeLoopScaleFactor: number;
	readonly insideAttributedLoop: boolean;
}

function walkTemplatesStaticOutline(
	templates: readonly Template[],
	indent: string,
	headingLevel: number,
	ctx: OutlineWalkContext,
	scopeState: ScopedWalkState,
	childBlockOverrides?: ReadonlyMap<string, readonly Template[]>,
): string[] {
	const out: string[] = [];
	let i = 0;

	while (i < templates.length) {
		const tpl = templates[i]!;

		// Coalesce adjacent literal HTML nodes
		if (!(tpl instanceof Tag) && 'str' in (tpl as { str?: unknown })) {
			let combinedStr = '';
			let combinedChars = 0;
			while (i < templates.length) {
				const cur = templates[i]!;
				if (cur instanceof Tag || !('str' in (cur as { str?: unknown }))) {
					break;
				}
				const s = String((cur as unknown as { readonly str: string }).str);
				combinedStr += s;
				combinedChars += ctx.telemetry ? ctx.telemetry.getTemplateChars(cur) : s.length;
				i++;
			}
			if (combinedStr.trim().length > 0) {
				const badge = formatNodeSizeBadge(
					combinedChars,
					ctx.totalSampleChars,
					scopeState.activeLoopScaleFactor,
				);
				out.push(
					`${indent}- Emits static Markdown (${summarizeLiteralSnippet(combinedStr)})${badge}.`,
				);
			}
			continue;
		}

		i++;
		const nodeChars = ctx.telemetry ? ctx.telemetry.getTemplateChars(tpl) : 0;

		// Output {{ ... }} node
		if (!(tpl instanceof Tag)) {
			const outNode = tpl as unknown as {
				readonly value?: unknown;
				readonly token?: { getContent?: () => string; getText?: () => string };
			};
			const rawContent =
				typeof outNode.token?.getContent === 'function'
					? outNode.token.getContent()
					: (outNode.token?.getText?.() ?? '');
			if (ctx.isDynamicNullTemplate && /\btemplate\s*\./.test(rawContent)) {
				addWarningUnique(
					ctx,
					'`template.*` is `null` in `dynamicCodeblock` outside `templatesFolder`',
				);
			}
			const drivingQuery = extractDrivingQueryName(rawContent, scopeState.localQueryVarMap);
			const exprScale =
				drivingQuery !== null
					? resolveQueryScaleFactor(drivingQuery, ctx.metricsByName)
					: scopeState.activeLoopScaleFactor;
			recordAttributedQueryChars(
				ctx,
				drivingQuery,
				nodeChars,
				scopeState.insideAttributedLoop,
			);
			const badge = formatNodeSizeBadge(nodeChars, ctx.totalSampleChars, exprScale);
			const exp = explainLiquidValue(outNode.value, rawContent, ctx.concepts);
			out.push(`${indent}- Outputs ${exp.sourceCode} — ${exp.summary}${badge}.`);
			continue;
		}

		const tagName = (tpl as { readonly name?: string }).name ?? '';
		const tagArgs = ((tpl as { readonly token?: { args?: string } }).token?.args ?? '').trim();
		const defaultBadge = formatNodeSizeBadge(
			nodeChars,
			ctx.totalSampleChars,
			scopeState.activeLoopScaleFactor,
		);

		switch (tagName) {
			case 'comment':
			case '#':
				break;

			case 'raw':
				out.push(`${indent}- Emits verbatim \`{% raw %}\` block${defaultBadge}.`);
				break;

			case 'query': {
				const qName = (tpl as unknown as { readonly queryName?: string | null }).queryName;
				if (qName) {
					const stageNote = ctx.lazyQueryNames.has(qName)
						? 'Pass 2 Lazy — evaluates against current virtual `@this` snapshot'
						: `Pass 1.5 · Wave ${ctx.waveByQueryName.get(qName) ?? 1}`;
					out.push(
						`${indent}- Binds ${formatInlineCode(`query.${qName}`)} (${stageNote}; see **Query ${formatInlineCode(qName)}** above).`,
					);
				}
				break;
			}

			case 'targetPath': {
				ctx.concepts.add('template-modes-virtual-this');
				const tp = tpl as unknown as {
					readonly valueExpr?: unknown;
					readonly tabMode?: string;
				};
				const exp = explainLiquidValue(tp.valueExpr, tagArgs, ctx.concepts);
				const modeLabel = tp.tabMode ?? 'background';
				if (!ctx.isNewNoteMode) {
					addWarningUnique(
						ctx,
						'`{% targetPath %}` updates in-memory `{{ targetPath }}` only outside `"newNote"` mode (no file is created or renamed)',
					);
				}
				const noopSuffix = ctx.isNewNoteMode
					? ` (tab mode: \`${modeLabel}\`, updates virtual \`this.file.*\`)`
					: ' — ⚠️ *Mode mismatch: updates in-memory `{{ targetPath }}` only outside `"newNote"` mode (no file is created or renamed).*';
				out.push(`${indent}- Sets \`targetPath\` (${exp.summary})${noopSuffix}`);
				break;
			}

			case 'frontmatter': {
				ctx.concepts.add('template-modes-virtual-this');
				if (!ctx.isNewNoteMode) {
					addWarningUnique(
						ctx,
						'`{% frontmatter %}` updates in-memory `{{ frontmatter }}` only outside `"newNote"` mode (host note frontmatter is never mutated)',
					);
				}
				const noopSuffix = ctx.isNewNoteMode
					? ' (stages YAML frontmatter and re-normalizes virtual `this`).'
					: ' — ⚠️ *Mode mismatch: stages `{{ frontmatter }}` in memory only; host note frontmatter is never mutated outside `"newNote"` mode.*';
				out.push(
					`${indent}- Stages frontmatter ${formatInlineCode(tagArgs || '...')}${noopSuffix}`,
				);
				break;
			}

			case 'heading': {
				ctx.concepts.add('relative-headings');
				const hTag = tpl as unknown as {
					readonly levelSpec?: HeadingLevelSpec | null;
					readonly templates?: Template[];
				};
				const trans = formatHeadingTransitionPhrase(headingLevel, hTag.levelSpec ?? null);
				out.push(
					`${indent}- Adjusts active heading level via ${formatInlineCode(`{% heading ${tagArgs} %}`)} → ${trans.label}${defaultBadge}:`,
				);
				out.push(
					...walkTemplatesStaticOutline(
						hTag.templates ?? [],
						`${indent}  `,
						trans.nextLevel,
						ctx,
						scopeState,
						childBlockOverrides,
					),
				);
				break;
			}

			case 'assign': {
				const aTag = tpl as unknown as { readonly key?: string; readonly value?: unknown };
				const varKey = aTag.key ?? 'var';
				const rhsRaw = tagArgs.includes('=')
					? tagArgs.slice(tagArgs.indexOf('=') + 1).trim()
					: tagArgs;
				if (ctx.isDynamicNullTemplate && /\btemplate\s*\./.test(rhsRaw)) {
					addWarningUnique(
						ctx,
						'`template.*` is `null` in `dynamicCodeblock` outside `templatesFolder`',
					);
				}
				scopeState.callerLocals.add(varKey);
				const derivedQuery = extractDrivingQueryName(rhsRaw, scopeState.localQueryVarMap);
				if (derivedQuery !== null) {
					scopeState.localQueryVarMap.set(varKey, derivedQuery);
				} else {
					scopeState.localQueryVarMap.delete(varKey);
				}
				const exp = explainLiquidValue(aTag.value, rhsRaw, ctx.concepts);
				out.push(`${indent}- Assigns ${formatInlineCode(varKey)} ← ${exp.summary}.`);
				break;
			}

			case 'capture': {
				const cTag = tpl as unknown as {
					readonly variable?: string;
					readonly templates?: Template[];
				};
				const capVar = cTag.variable ?? tagArgs;
				if (capVar.length > 0) {
					scopeState.callerLocals.add(capVar);
				}
				out.push(
					`${indent}- Captures rendered string into variable ${formatInlineCode(capVar)}:`,
				);
				out.push(
					...walkTemplatesStaticOutline(
						cTag.templates ?? [],
						`${indent}  `,
						headingLevel,
						ctx,
						scopeState,
						childBlockOverrides,
					),
				);
				break;
			}

			case 'increment':
			case 'decrement':
				out.push(
					`${indent}- ${tagName === 'increment' ? 'Increments' : 'Decrements'} and outputs counter ${formatInlineCode(tagArgs)}${defaultBadge}.`,
				);
				break;

			case 'cycle':
				out.push(
					`${indent}- Cycles output value across ${formatInlineCode(tagArgs)}${defaultBadge}.`,
				);
				break;

			case 'echo': {
				const eTag = tpl as unknown as { readonly value?: unknown };
				const drivingQuery = extractDrivingQueryName(tagArgs, scopeState.localQueryVarMap);
				const exprScale =
					drivingQuery !== null
						? resolveQueryScaleFactor(drivingQuery, ctx.metricsByName)
						: scopeState.activeLoopScaleFactor;
				recordAttributedQueryChars(
					ctx,
					drivingQuery,
					nodeChars,
					scopeState.insideAttributedLoop,
				);
				const echoBadge = formatNodeSizeBadge(nodeChars, ctx.totalSampleChars, exprScale);
				const exp = explainLiquidValue(eTag.value, tagArgs, ctx.concepts);
				out.push(`${indent}- Echoes ${exp.sourceCode} — ${exp.summary}${echoBadge}.`);
				break;
			}

			case 'liquid': {
				const lTag = tpl as unknown as { readonly templates?: Template[] };
				out.push(
					...walkTemplatesStaticOutline(
						lTag.templates ?? [],
						indent,
						headingLevel,
						ctx,
						scopeState,
						childBlockOverrides,
					),
				);
				break;
			}

			case 'break':
			case 'continue':
				out.push(
					`${indent}- Executes loop ${formatInlineCode(`{% ${tagName} %}`)} control transfer.`,
				);
				break;

			case 'if':
			case 'unless': {
				const condTag = tpl as unknown as {
					readonly branches?: readonly {
						readonly value?: unknown;
						readonly templates?: Template[];
					}[];
					readonly elseTemplates?: Template[];
				};
				const branches = condTag.branches ?? [];
				out.push(`${indent}- Conditional (\`{% ${tagName} ... %}\`)${defaultBadge}:`);
				branches.forEach((b, bIdx) => {
					const exp = explainLiquidValue(
						b.value,
						bIdx === 0 ? tagArgs : '',
						ctx.concepts,
					);
					const kw = bIdx === 0 ? tagName : 'elsif';
					out.push(`${indent}  - Branch \`${kw}\` (${exp.sourceCode}):`);
					out.push(
						...walkTemplatesStaticOutline(
							b.templates ?? [],
							`${indent}    `,
							headingLevel,
							ctx,
							scopeState,
							childBlockOverrides,
						),
					);
				});
				if (condTag.elseTemplates && condTag.elseTemplates.length > 0) {
					out.push(`${indent}  - Fallback \`else\`:`);
					out.push(
						...walkTemplatesStaticOutline(
							condTag.elseTemplates,
							`${indent}    `,
							headingLevel,
							ctx,
							scopeState,
							childBlockOverrides,
						),
					);
				}
				break;
			}

			case 'case': {
				const caseTag = tpl as unknown as {
					readonly value?: unknown;
					readonly branches?: readonly {
						readonly values?: readonly { getText?: () => string }[];
						readonly templates?: Template[];
					}[];
					readonly elseTemplates?: Template[];
				};
				const exp = explainLiquidValue(caseTag.value, tagArgs, ctx.concepts);
				out.push(`${indent}- Switch \`{% case %}\` on ${exp.sourceCode}${defaultBadge}:`);
				for (const b of caseTag.branches ?? []) {
					const vals = (b.values ?? [])
						.map((v) => formatInlineCode(v.getText?.() ?? ''))
						.join(' or ');
					out.push(`${indent}  - \`when\` ${vals}:`);
					out.push(
						...walkTemplatesStaticOutline(
							b.templates ?? [],
							`${indent}    `,
							headingLevel,
							ctx,
							scopeState,
							childBlockOverrides,
						),
					);
				}
				if (caseTag.elseTemplates && caseTag.elseTemplates.length > 0) {
					out.push(`${indent}  - Fallback \`else\`:`);
					out.push(
						...walkTemplatesStaticOutline(
							caseTag.elseTemplates,
							`${indent}    `,
							headingLevel,
							ctx,
							scopeState,
							childBlockOverrides,
						),
					);
				}
				break;
			}

			case 'for':
			case 'tablerow': {
				const loopTag = tpl as unknown as {
					readonly variable?: string;
					readonly collection?: { getText?: () => string };
					readonly templates?: Template[];
					readonly elseTemplates?: Template[];
				};
				const itemVar = loopTag.variable ?? 'item';
				const colText = loopTag.collection?.getText?.() ?? tagArgs;
				explainLiquidValue(loopTag.collection, colText, ctx.concepts);

				const drivingQuery = extractDrivingQueryName(colText, scopeState.localQueryVarMap);
				const loopScale =
					drivingQuery !== null
						? scopeState.activeLoopScaleFactor *
							resolveQueryScaleFactor(drivingQuery, ctx.metricsByName)
						: scopeState.activeLoopScaleFactor;
				recordAttributedQueryChars(
					ctx,
					drivingQuery,
					nodeChars,
					scopeState.insideAttributedLoop,
				);
				const loopBadge = formatNodeSizeBadge(nodeChars, ctx.totalSampleChars, loopScale);

				const innerLocals = new Set<string>(scopeState.callerLocals);
				innerLocals.add(itemVar);
				const innerScope: ScopedWalkState = {
					callerLocals: innerLocals,
					localQueryVarMap: new Map(scopeState.localQueryVarMap),
					activeLoopScaleFactor: loopScale,
					insideAttributedLoop: scopeState.insideAttributedLoop || drivingQuery !== null,
				};

				out.push(
					`${indent}- Loops each ${formatInlineCode(itemVar)} in ${formatInlineCode(colText)} (\`{% ${tagName} %}\`)${loopBadge}:`,
				);
				out.push(
					...walkTemplatesStaticOutline(
						loopTag.templates ?? [],
						`${indent}  `,
						headingLevel,
						ctx,
						innerScope,
						childBlockOverrides,
					),
				);
				if (loopTag.elseTemplates && loopTag.elseTemplates.length > 0) {
					out.push(`${indent}  - Empty-collection \`else\` fallback:`);
					out.push(
						...walkTemplatesStaticOutline(
							loopTag.elseTemplates,
							`${indent}    `,
							headingLevel,
							ctx,
							scopeState,
							childBlockOverrides,
						),
					);
				}
				break;
			}

			case 'render': {
				ctx.concepts.add('partials-and-layouts');
				const rawFile = (tpl as unknown as { readonly file?: unknown }).file;
				const visited =
					typeof rawFile === 'string'
						? ctx.parsed.env.visitedFiles.get(
								normalizeLookupCacheKey('render', rawFile),
							)
						: undefined;
				const scopeInfo = analyzeRenderPartialScope(tpl, visited?.templates ?? null, {
					callerLocals: scopeState.callerLocals,
					knownQueryNames: ctx.knownQueryNames,
					isDynamicNullTemplate: ctx.isDynamicNullTemplate,
				});
				const resolvedLabel = visited
					? formatSafeExplainFileLink(visited.resolvedFile)
					: formatInlineCode(typeof rawFile === 'string' ? rawFile : tagArgs);
				const partialId =
					visited?.resolvedFile ?? (typeof rawFile === 'string' ? rawFile : tagArgs);
				const prevCount = ctx.seenPartialsCount.get(partialId) ?? 0;
				const nextCount = prevCount + 1;
				ctx.seenPartialsCount.set(partialId, nextCount);

				const forBinding = scopeInfo.bindings.find((b) => b.kind === 'for');
				const forDrivingQuery = forBinding
					? extractDrivingQueryName(forBinding.sourceExpr, scopeState.localQueryVarMap)
					: null;
				const partialScale =
					forDrivingQuery !== null
						? scopeState.activeLoopScaleFactor *
							resolveQueryScaleFactor(forDrivingQuery, ctx.metricsByName)
						: scopeState.activeLoopScaleFactor;
				recordAttributedQueryChars(
					ctx,
					forDrivingQuery,
					nodeChars,
					scopeState.insideAttributedLoop,
				);
				const renderBadge = formatNodeSizeBadge(
					nodeChars,
					ctx.totalSampleChars,
					partialScale,
				);

				const nodeKey = formatAstNodeKey(tpl);
				const forceExpandOnError = Boolean(
					ctx.telemetry?.isOnFailedRenderCallStack(nodeKey),
				);
				const isComplex = visited ? isComplexPartialAst(visited.templates) : false;
				const shouldExpandComplex =
					nextCount > 1 &&
					isComplex &&
					ctx.totalComplexExpansions < MAX_COMPLEX_PARTIAL_EXPANSIONS;
				const shouldExpand =
					(nextCount === 1 || shouldExpandComplex || forceExpandOnError) &&
					visited !== undefined &&
					!ctx.activeFileChain.has(visited.resolvedFile);
				if (shouldExpand && isComplex && nextCount > 1) {
					ctx.totalComplexExpansions++;
				}

				const bindingsInline = formatCallSiteBindingsInline(scopeInfo.bindings);

				for (const leakVar of scopeInfo.unboundVariables) {
					addWarningUnique(
						ctx,
						`Partial ${resolvedLabel} references outer caller variable ${formatInlineCode(leakVar)} without receiving it via \`{% render %}\` (evaluates to \`nil\` in isolated scope)`,
					);
				}
				if (scopeInfo.readsNullTemplate) {
					addWarningUnique(
						ctx,
						`Partial ${resolvedLabel} reads \`template.*\`, which is \`null\` in \`dynamicCodeblock\` outside \`templatesFolder\``,
					);
				}

				const sharedEffects: string[] = [];
				if (scopeInfo.mutatesTargetPath) sharedEffects.push('`targetPath`');
				if (scopeInfo.mutatesFrontmatter) sharedEffects.push('`frontmatter`');
				if (scopeInfo.mutatesHeadingLevel) sharedEffects.push('heading level');

				if (shouldExpand && visited) {
					const errOverrideNote =
						nextCount > 1 && forceExpandOnError
							? ' — ⚠️ expanded: runtime error occurred inside this call site'
							: '';
					const boxLines: string[] = [
						`[!abstract] **Partial \`{% render %}\` → ${resolvedLabel}** *(isolated scope; ${bindingsInline})*${renderBadge}${errOverrideNote}`,
					];
					if (scopeInfo.unboundVariables.length > 0) {
						const vars = scopeInfo.unboundVariables
							.map((v) => formatInlineCode(v))
							.join(', ');
						boxLines.push(
							`- ⚠️ **Scope isolation warning**: References outer caller variable(s) ${vars} without passing them via \`{% render %}\`; they evaluate to \`nil\` inside this partial.`,
						);
					}
					if (scopeInfo.shadowedNames.length > 0) {
						const shadows = scopeInfo.shadowedNames
							.map((s) => `***${formatInlineCode(s)}***`)
							.join(', ');
						boxLines.push(
							`- *Shadowing note*: Local/passed binding(s) ${shadows} shadow an outer variable, query name, or root global inside this partial.`,
						);
					}
					if (scopeInfo.readsNullTemplate) {
						boxLines.push(
							`- ⚠️ **Null \`template\` warning**: Reads \`template.*\` in \`dynamicCodeblock\` outside \`templatesFolder\` (where \`template\` is \`null\`).`,
						);
					}
					if (sharedEffects.length > 0) {
						boxLines.push(
							`- *Shared globals mutated*: Updates ${sharedEffects.join(', ')} on root \`TemplateTargetState\`.`,
						);
					}

					const partialLocals = new Set<string>(scopeInfo.bindings.map((b) => b.name));
					const partialScope: ScopedWalkState = {
						callerLocals: partialLocals,
						localQueryVarMap: new Map(),
						activeLoopScaleFactor: partialScale,
						insideAttributedLoop:
							scopeState.insideAttributedLoop || forDrivingQuery !== null,
					};
					ctx.activeFileChain.add(visited.resolvedFile);
					boxLines.push(
						...walkTemplatesStaticOutline(
							visited.templates,
							'',
							headingLevel,
							ctx,
							partialScope,
						),
					);
					ctx.activeFileChain.delete(visited.resolvedFile);

					for (const bLine of boxLines) {
						out.push(`${indent}> ${bLine}`);
					}
				} else {
					const compactNotes: string[] = [`repeat call #${nextCount}`, bindingsInline];
					if (sharedEffects.length > 0) {
						compactNotes.push(`mutates ${sharedEffects.join(', ')}`);
					}
					if (scopeInfo.unboundVariables.length > 0) {
						compactNotes.push(
							`⚠️ unbound outer: ${scopeInfo.unboundVariables.map((v) => formatInlineCode(v)).join(', ')}`,
						);
					}
					if (scopeInfo.shadowedNames.length > 0) {
						compactNotes.push(
							`shadows ${scopeInfo.shadowedNames.map((s) => `***${formatInlineCode(s)}***`).join(', ')}`,
						);
					}
					out.push(
						`${indent}- Calls partial ${resolvedLabel} *(${compactNotes.join('; ')})*${renderBadge}.`,
					);
				}
				break;
			}

			case 'layout': {
				ctx.concepts.add('partials-and-layouts');
				const layoutSummary = extractLayoutArgsSummary(tpl);
				for (const b of layoutSummary.bindings) {
					scopeState.callerLocals.add(b.name);
				}
				const childTemplates =
					(tpl as unknown as { readonly templates?: Template[] }).templates ?? [];
				const visited =
					layoutSummary.rawFile !== null
						? ctx.parsed.env.visitedFiles.get(
								normalizeLookupCacheKey('layout', layoutSummary.rawFile),
							)
						: undefined;

				if (!visited || ctx.activeFileChain.has(visited.resolvedFile)) {
					const targetLabel = visited
						? formatSafeExplainFileLink(visited.resolvedFile)
						: formatInlineCode(layoutSummary.rawFile ?? 'none');
					out.push(`${indent}- Applies layout ${targetLabel}${defaultBadge}:`);
					out.push(
						...walkTemplatesStaticOutline(
							childTemplates,
							`${indent}  `,
							headingLevel,
							ctx,
							scopeState,
						),
					);
					break;
				}

				const childBlocks = new Map<string, readonly Template[]>();
				const metaSetupNodes: Template[] = [];
				const anonEmittingNodes: Template[] = [];

				for (const cNode of childTemplates) {
					if (
						cNode instanceof Tag &&
						(cNode as { readonly name?: string }).name === 'block'
					) {
						const bName = (cNode as unknown as { readonly block?: string }).block ?? '';
						const bTpls =
							(cNode as unknown as { readonly templates?: Template[] }).templates ??
							[];
						childBlocks.set(bName, bTpls);
					} else if (isNonEmittingMetaTag(cNode)) {
						metaSetupNodes.push(cNode);
					} else if (
						!(cNode instanceof Tag) &&
						'str' in (cNode as { str?: unknown }) &&
						String((cNode as unknown as { str: string }).str).trim().length === 0
					) {
						// Ignore whitespace between {% block %} definitions
					} else {
						anonEmittingNodes.push(cNode);
					}
				}

				const layoutHasAnonBlock = visited.templates.some(
					(lt) =>
						lt instanceof Tag &&
						(lt as { readonly name?: string }).name === 'block' &&
						((lt as unknown as { readonly block?: string }).block ?? '') === '',
				);
				if (layoutHasAnonBlock && !childBlocks.has('') && anonEmittingNodes.length > 0) {
					childBlocks.set('', anonEmittingNodes);
				}

				const hasDiscardedOrphans = !layoutHasAnonBlock && anonEmittingNodes.length > 0;
				if (hasDiscardedOrphans) {
					addWarningUnique(
						ctx,
						`Content outside \`{% block %}\` is discarded because layout ${formatSafeExplainFileLink(visited.resolvedFile)} has no anonymous \`{% block %}\``,
					);
				}

				const bindingsInline = formatCallSiteBindingsInline(layoutSummary.bindings);
				const layoutLink = formatSafeExplainFileLink(visited.resolvedFile);
				out.push(
					`${indent}- **Wraps output in Layout ${layoutLink}** *(shared variable scope; ${bindingsInline})*${defaultBadge}:`,
				);
				if (hasDiscardedOrphans) {
					out.push(
						`${indent}  - ⚠️ **Orphaned child content**: Nodes outside \`{% block <name> %}\` in this codeblock are discarded because ${layoutLink} defines only named blocks.`,
					);
				}
				if (metaSetupNodes.length > 0) {
					out.push(
						...walkTemplatesStaticOutline(
							metaSetupNodes,
							`${indent}  `,
							headingLevel,
							ctx,
							scopeState,
						),
					);
				}
				ctx.activeFileChain.add(visited.resolvedFile);
				out.push(
					...walkTemplatesStaticOutline(
						visited.templates,
						`${indent}  `,
						headingLevel,
						ctx,
						scopeState,
						childBlocks,
					),
				);
				ctx.activeFileChain.delete(visited.resolvedFile);
				break;
			}

			case 'block': {
				const bTag = tpl as unknown as {
					readonly block?: string;
					readonly templates?: Template[];
				};
				const bName = bTag.block ?? '';
				const displaySlot = bName.length > 0 ? formatInlineCode(bName) : '*(anonymous)*';
				const overrideTpls = childBlockOverrides?.get(bName);
				if (overrideTpls !== undefined) {
					out.push(
						`${indent}- Layout slot \`{% block %}\` ${displaySlot} *(overridden by child template)*${defaultBadge}:`,
					);
					out.push(
						...walkTemplatesStaticOutline(
							overrideTpls,
							`${indent}  `,
							headingLevel,
							ctx,
							scopeState,
						),
					);
				} else {
					out.push(
						`${indent}- Layout slot \`{% block %}\` ${displaySlot} *(renders layout default)*${defaultBadge}:`,
					);
					out.push(
						...walkTemplatesStaticOutline(
							bTag.templates ?? [],
							`${indent}  `,
							headingLevel,
							ctx,
							scopeState,
						),
					);
				}
				break;
			}

			default:
				out.push(
					`${indent}- Executes tag ${formatInlineCode(`{% ${tagName}${tagArgs ? ` ${tagArgs}` : ''} %}`)}${defaultBadge}.`,
				);
				break;
		}
	}

	return out;
}

/**
 * Builds the single-pass static English `Template Explain Plan` callout for `rhizome-sample`
 * per `docs/spec/Extended Explain Plan.md` §§5.1 & 7.
 */
export function buildTemplateExplainPlanCallout(
	options: BuildTemplateExplainPlanOptions,
): TemplateExplainPlanResult {
	const {
		source,
		parsed,
		renderResult,
		runtimeContext,
		metricsByName,
		waveByQueryName,
		lazyQueryNames,
		telemetry,
		stagedYamlChars = 0,
	} = options;

	const isNewNoteMode = runtimeContext?.trigger === 'newNote';
	const isDynamicNullTemplate = !isNewNoteMode && runtimeContext?.template === null;
	const initialHeadingLevel = normalizeInitialHeadingLevel(runtimeContext?.headingLevel);
	const concepts = new Set<ExplainConceptKey>();
	if (isNewNoteMode) {
		concepts.add('template-modes-virtual-this');
	}
	if (initialHeadingLevel > 0) {
		concepts.add('relative-headings');
	}

	const totalSampleChars = renderResult.ok ? renderResult.markdown.length + stagedYamlChars : 0;
	const knownQueryNames = new Set<string>(parsed.env.queries.map((q) => q.name));

	const walkCtx: OutlineWalkContext = {
		parsed,
		isNewNoteMode,
		isDynamicNullTemplate,
		knownQueryNames,
		metricsByName,
		waveByQueryName,
		lazyQueryNames,
		telemetry,
		totalSampleChars,
		concepts,
		seenPartialsCount: new Map<string, number>(),
		activeFileChain: new Set<string>(),
		warnings: [],
		attributedSampleCharsByQuery: new Map<string, number>(),
		totalComplexExpansions: 0,
	};

	const rootScopeState: ScopedWalkState = {
		callerLocals: new Set<string>(),
		localQueryVarMap: new Map<string, string>(),
		activeLoopScaleFactor: 1,
		insideAttributedLoop: false,
	};

	const outlineLines =
		parsed.templates !== null
			? walkTemplatesStaticOutline(
					parsed.templates,
					'',
					initialHeadingLevel,
					walkCtx,
					rootScopeState,
				)
			: [];

	const sizeEstimate = estimateFullScaleOutput(
		totalSampleChars,
		walkCtx.attributedSampleCharsByQuery,
		metricsByName,
	);

	const cutoffExceededNames: string[] = [];
	for (const [qName, m] of metricsByName) {
		if (m.exceedsProductionCutoff) {
			cutoffExceededNames.push(qName);
		}
	}

	const warningPhrases: string[] = [];
	if (sizeEstimate.exceedsWarningThreshold) {
		warningPhrases.push(
			`estimated ${formatHumanCharSize(sizeEstimate.estimatedFullChars)} at full scale`,
		);
	}
	if (cutoffExceededNames.length > 0) {
		warningPhrases.push(
			`${cutoffExceededNames.length} ${cutoffExceededNames.length === 1 ? 'query exceeds' : 'queries exceed'} production cutoff`,
		);
	}
	if (walkCtx.warnings.length > 0) {
		warningPhrases.push(
			`${walkCtx.warnings.length} template ${walkCtx.warnings.length === 1 ? 'warning' : 'warnings'}`,
		);
	}

	let headerLine: string;
	if (!renderResult.ok) {
		const firstCode = renderResult.diagnostics[0]?.code ?? 'TEMPLATE_RENDER_ERROR';
		headerLine = `> [!danger]+ Template Explain Plan — \`${firstCode}\` (Failed)`;
	} else if (warningPhrases.length > 0) {
		headerLine = `> [!warning]- Template Explain Plan — ${formatHumanCharSize(totalSampleChars)} sample · ${warningPhrases.join(' · ')}`;
	} else {
		const estSuffix = sizeEstimate.hasDownsampledQueries
			? ` · ~${formatHumanCharSize(sizeEstimate.estimatedFullChars)} est. full scale`
			: '';
		headerLine = `> [!check]- Template Explain Plan — ${formatHumanCharSize(totalSampleChars)} sample output${estSuffix}`;
	}

	const body: string[] = [];
	const modeDesc = isNewNoteMode
		? 'Simulated New Note (`◊.trigger == "newNote"` — no files created on disk)'
		: 'Dynamic Codeblock (`◊.trigger == "dynamicCodeblock"`)';
	const headingInitDesc =
		initialHeadingLevel === 0
			? '`H0` (document root)'
			: `\`H${initialHeadingLevel}\` (inherited from enclosing note heading)`;
	body.push(`- **Execution Mode**: ${modeDesc} · Initial heading level: ${headingInitDesc}`);

	if (isNewNoteMode && renderResult.ok) {
		const tpDisplay = formatInlineCode(renderResult.targetPath ?? '');
		const tabMode = renderResult.tabMode ?? 'background';
		const fmKeys = renderResult.frontmatter ? Object.keys(renderResult.frontmatter) : [];
		const fmSummary =
			renderResult.hasFrontmatterMutations && fmKeys.length > 0
				? `staged keys: ${fmKeys.map((k) => formatInlineCode(k)).join(', ')}`
				: 'no frontmatter mutations staged';
		body.push(
			`- **Simulated Note Target**: ${tpDisplay} (tab mode: \`${tabMode}\`; ${fmSummary})`,
		);
	}

	if (cutoffExceededNames.length > 0) {
		const qList = cutoffExceededNames.map((n) => formatInlineCode(n)).join(', ');
		body.push(
			`- **⚠️ Production Cutoff Notice**: Query ${qList} matched more records than its active \`cutoff:\`; production renders (\`rhizome\`, \`newNote\`, \`atCursor\`) will truncate those collections before Liquid filters run.`,
		);
	}

	if (renderResult.ok) {
		const capLabel = formatHumanCharSize(MAX_TEMPLATE_OUTPUT_CHARS);
		const sampleLabel = formatHumanCharSize(totalSampleChars);
		if (sizeEstimate.hasDownsampledQueries || sizeEstimate.estimatedUncappedChars !== null) {
			const estLabel = formatHumanCharSize(sizeEstimate.estimatedFullChars);
			const uncappedNote =
				sizeEstimate.estimatedUncappedChars !== null &&
				sizeEstimate.estimatedUncappedChars !== sizeEstimate.estimatedFullChars
					? ` (\`~${formatHumanCharSize(sizeEstimate.estimatedUncappedChars)}\` uncapped)`
					: '';
			const capWarn = sizeEstimate.exceedsHardCap
				? ` — ⚠️ **Likely exceeds the ${capLabel} (\`3.25 MiB\`) hard cap in production!** Narrow queries or slice rendered collections.`
				: sizeEstimate.exceedsWarningThreshold
					? ` — ⚠️ **Approaches the ${capLabel} (\`3.25 MiB\`) hard cap!**`
					: '';
			body.push(
				`- **Output Size**: Sample emitted \`${sampleLabel}\` · Extrapolated post-cutoff output: \`~${estLabel}\`${uncappedNote} (cap: \`${capLabel}\`)${capWarn}`,
			);
		} else {
			body.push(`- **Output Size**: \`${sampleLabel}\` (cap: \`${capLabel}\`)`);
		}
	}

	if (!renderResult.ok) {
		const diagLines = renderTemplateDiagnosticsSection(
			source,
			renderResult.diagnostics,
			parsed.env.fileSources,
		);
		if (diagLines.length > 0) {
			body.push('', ...diagLines);
		}
	}

	if (outlineLines.length > 0) {
		body.push('', '**Execution Outline**', '', ...outlineLines);
	} else if (renderResult.ok) {
		body.push(
			'',
			'**Execution Outline**',
			'',
			'- *(Empty template body — emits 0 characters.)*',
		);
	}

	return {
		calloutMarkdown: [headerLine, ...prefixCalloutBodyLines(body)].join('\n'),
		triggeredConcepts: concepts,
		hasWarnings: warningPhrases.length > 0,
	};
}
