import {
	analyzeQueryDependencyDag,
	analyzeQueryExplain,
	type DocumentDiagnostic,
	type ExplainConceptKey,
	formatInlineCode,
	formatSourceCaretSnippet,
	type NormalizedDocument,
	type QueryExplainAnalysis,
	type ResolvedEngineConfig,
	type SearchAST,
	type SearchDiagnostic,
} from '@core/search';
import { partitionNewNoteQueries } from '../query-partitioner';
import type { QuerySampleMetrics } from '../query-sampler';
import type { ExtractedQueryBlock, TemplateFolderConfig } from '../types';
import { isPathInTemplateFolders, resolveTemplateFolders } from '../vault-liquid-fs';

const EXPLAIN_NUM_FMT = new Intl.NumberFormat('en-US');
const MAX_COERCION_SAMPLE_NOTES = 5;
const MAX_EXPLAIN_CALLOUTS_CHARS = 524_288;
const UNSAFE_WIKILINK_CHARS_RE = /[[\]|#^\\\r\n]/;

/**
 * Formats a safe Obsidian `[[path]]` wikilink when `vaultPath` has no unsafe characters,
 * falling back to an inline code span.
 */
export function formatSafeExplainFileLink(vaultPath: string): string {
	const trimmed = vaultPath.trim();
	if (trimmed.length > 0 && !UNSAFE_WIKILINK_CHARS_RE.test(trimmed)) {
		return `[[${trimmed}]]`;
	}
	return formatInlineCode(trimmed);
}

/**
 * Escapes Markdown image/link syntax (`![` and `](`) in untrusted diagnostic prose so vault-derived
 * `@this` property values cannot inject external network image loads or disguised links.
 */
export function escapeExplainProse(text: string): string {
	return text.replace(/!\[/g, '\\![').replace(/\]\(/g, ']\\(');
}

/**
 * Wraps `snippet` inside an indented backtick code fence whose delimiter length is strictly wider
 * than any backtick run inside `snippet` so embedded triple-backticks never break out of the fence.
 */
export function wrapCodeFenceLines(snippet: string, info: string, indent = '  '): string[] {
	let maxRun = 2;
	const runs = snippet.match(/`+/g);
	if (runs) {
		for (const r of runs) {
			if (r.length > maxRun) {
				maxRun = r.length;
			}
		}
	}
	const fence = '`'.repeat(maxRun + 1);
	const out: string[] = [`${indent}${fence}${info}`];
	for (const sLine of snippet.split(/\r?\n/)) {
		out.push(`${indent}${sLine}`);
	}
	out.push(`${indent}${fence}`);
	return out;
}

/**
 * Splits embedded line breaks and prefixes every resulting line with `> ` so multi-line strings,
 * lists, and code fences can never escape an Obsidian callout block.
 */
export function prefixCalloutBodyLines(lines: readonly string[]): string[] {
	return lines
		.flatMap((l) => l.split(/\r?\n/))
		.map((line) => (line.length === 0 ? '>' : `> ${line}`));
}

/**
 * Minimal document shape required to aggregate queried property coercion diagnostics.
 */
export interface CoercionInspectableDocument {
	readonly file: { readonly path: string };
	readonly diagnostics: readonly DocumentDiagnostic[];
}

interface AggregatedCoercionGroup {
	readonly propertyKey: string;
	readonly expectedType: string;
	readonly totalFailures: number;
	readonly sampleNotePaths: readonly string[];
	readonly sampleRawValue: string;
}

type CoercionIndexByKey = ReadonlyMap<string, readonly AggregatedCoercionGroup[]>;

function buildCoercionIndexForKeys(
	targetKeys: ReadonlySet<string>,
	documents: Iterable<CoercionInspectableDocument> | undefined,
): CoercionIndexByKey {
	const result = new Map<string, AggregatedCoercionGroup[]>();
	if (!documents || targetKeys.size === 0) {
		return result;
	}

	const buckets = new Map<
		string,
		{
			propertyKey: string;
			expectedType: string;
			totalFailures: number;
			notePaths: Set<string>;
			sampleRawValue: string;
		}
	>();

	for (const doc of documents) {
		for (const diag of doc.diagnostics) {
			const lowerKey = diag.propertyKey.toLowerCase();
			if (!targetKeys.has(lowerKey)) {
				continue;
			}
			const mapKey = `${lowerKey}\0${diag.expectedType}`;
			let bucket = buckets.get(mapKey);
			if (!bucket) {
				bucket = {
					propertyKey: lowerKey,
					expectedType: diag.expectedType,
					totalFailures: 0,
					notePaths: new Set<string>(),
					sampleRawValue: diag.rawValue,
				};
				buckets.set(mapKey, bucket);
			}
			bucket.totalFailures++;
			bucket.notePaths.add(doc.file.path);
		}
	}

	const sortedGroups = [...buckets.values()]
		.sort((a, b) =>
			a.propertyKey < b.propertyKey ? -1 : a.propertyKey > b.propertyKey ? 1 : 0,
		)
		.map((b) => ({
			propertyKey: b.propertyKey,
			expectedType: b.expectedType,
			totalFailures: b.totalFailures,
			sampleNotePaths: [...b.notePaths].sort().slice(0, MAX_COERCION_SAMPLE_NOTES),
			sampleRawValue: b.sampleRawValue,
		}));

	for (const group of sortedGroups) {
		let list = result.get(group.propertyKey);
		if (!list) {
			list = [];
			result.set(group.propertyKey, list);
		}
		list.push(group);
	}
	return result;
}

function lookupCoercionGroupsForQuery(
	queriedKeys: ReadonlySet<string>,
	coercionIndex: CoercionIndexByKey,
): readonly AggregatedCoercionGroup[] {
	if (queriedKeys.size === 0 || coercionIndex.size === 0) {
		return [];
	}
	const out: AggregatedCoercionGroup[] = [];
	for (const k of [...queriedKeys].sort()) {
		const groups = coercionIndex.get(k);
		if (groups) {
			out.push(...groups);
		}
	}
	return out;
}

function detectExcludedFolderLiterals(
	pathLiterals: readonly string[],
	folderConfig?: TemplateFolderConfig,
): readonly string[] {
	if (pathLiterals.length === 0) {
		return [];
	}
	const resolved = resolveTemplateFolders(folderConfig);
	const roots = [
		resolved.templatesFolder.toLowerCase(),
		resolved.partialsFolder.toLowerCase(),
		resolved.layoutsFolder.toLowerCase(),
	];
	const matched: string[] = [];
	for (const rawLit of pathLiterals) {
		const norm = rawLit
			.trim()
			.replace(/\\/g, '/')
			.replace(/^\/+|\/+$/g, '');
		if (norm.length === 0) {
			continue;
		}
		const lower = norm.toLowerCase();
		const hitsRoot =
			isPathInTemplateFolders(norm, folderConfig) ||
			isPathInTemplateFolders(`${norm}/probe.md`, folderConfig) ||
			roots.some((r) => lower === r || lower.startsWith(`${r}/`));
		if (hitsRoot && !matched.includes(rawLit)) {
			matched.push(rawLit);
		}
	}
	return matched;
}

function formatPropertyScalarSummary(val: unknown): string {
	if (val === null || val === undefined) return 'null';
	if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
		return String(val);
	}
	return JSON.stringify(val);
}

function formatVirtualThisSnapshotLines(doc: NormalizedDocument): string[] {
	const out: string[] = [];
	const parentDisplay = doc.file.parent.length > 0 ? formatInlineCode(doc.file.parent) : '`""`';
	out.push(
		`- **Virtual \`@this\` Snapshot**: \`this.file.path\` = ${formatInlineCode(doc.file.path)} (\`basename\`: ${formatInlineCode(doc.file.basename)}, \`parent\`: ${parentDisplay})`,
	);
	const propKeys = Object.keys(doc.properties).sort();
	if (propKeys.length > 0) {
		const propSummaries = propKeys.map((k) => {
			const val = doc.properties[k];
			const raws = Array.isArray(val)
				? (val as readonly unknown[]).map(formatPropertyScalarSummary).join(', ')
				: formatPropertyScalarSummary(val);
			return `${formatInlineCode(k)}: ${formatInlineCode(raws)}`;
		});
		out.push(`  - Staged \`this.properties\`: ${propSummaries.join(', ')}`);
	}
	if (doc.tags.length > 0) {
		out.push(
			`  - Staged \`this.tags\`: ${doc.tags.map((t) => formatInlineCode(`#${t}`)).join(', ')}`,
		);
	}
	if (doc.aliases.length > 0) {
		out.push(
			`  - Staged \`this.aliases\`: ${doc.aliases.map((a) => formatInlineCode(a)).join(', ')}`,
		);
	}
	if (doc.cssclasses.length > 0) {
		out.push(
			`  - Staged \`this.cssclasses\`: ${doc.cssclasses.map((c) => formatInlineCode(c)).join(', ')}`,
		);
	}
	if (doc.links.length > 0) {
		out.push(
			`  - Staged frontmatter \`this.links\`: ${doc.links.map((l) => formatInlineCode(l.rawTarget)).join(', ')}`,
		);
	}
	return out;
}

/**
 * Input options for building all per-query explain callouts in `rhizome-sample`.
 */
export interface BuildQueryExplainCalloutsOptions {
	readonly queries: readonly ExtractedQueryBlock[];
	readonly resolvedConfig: ResolvedEngineConfig;
	readonly referenceTimeMs: number;
	readonly folderConfig?: TemplateFolderConfig | undefined;
	readonly hostDoc?: NormalizedDocument | null | undefined;
	readonly isNewNoteMode: boolean;
	readonly metricsByName: ReadonlyMap<string, QuerySampleMetrics>;
	readonly lazyHostDocsByName?: ReadonlyMap<string, NormalizedDocument | null> | undefined;
	readonly coercionDocuments?: Iterable<CoercionInspectableDocument> | undefined;
}

/**
 * Output from `buildQueryExplainCallouts`.
 */
export interface QueryExplainCalloutsResult {
	readonly callouts: readonly string[];
	readonly queriedKeysUnion: ReadonlySet<string>;
	readonly triggeredConcepts: ReadonlySet<ExplainConceptKey>;
	readonly waveByQueryName: ReadonlyMap<string, number>;
	readonly lazyQueryNames: ReadonlySet<string>;
}

interface EnrichedQueryEntry {
	readonly block: ExtractedQueryBlock;
	readonly declIndex: number;
	readonly isLazy: boolean;
	readonly waveNumber: number | null;
	readonly blockedByCycleOrError: boolean;
	readonly skippedInSample: boolean;
	readonly analysis: QueryExplainAnalysis;
	readonly lazyHostDoc: NormalizedDocument | null | undefined;
}

function formatRecordsShortPhrase(metrics: QuerySampleMetrics): string {
	const mFmt = EXPLAIN_NUM_FMT.format(metrics.matchedCount);
	const sFmt = EXPLAIN_NUM_FMT.format(metrics.sampledCount);
	if (metrics.downsampled) {
		return `sampled ${sFmt} of ${mFmt} records`;
	}
	if (metrics.cutoffBound) {
		return `truncated to ${sFmt} of ${mFmt} records`;
	}
	return `all ${mFmt} ${metrics.matchedCount === 1 ? 'record' : 'records'}`;
}

function renderSingleQueryCallout(
	entry: EnrichedQueryEntry,
	metrics: QuerySampleMetrics | undefined,
	folderConfig: TemplateFolderConfig | undefined,
	coercionIndex: CoercionIndexByKey,
	conceptsOut: Set<ExplainConceptKey>,
): string {
	const { block, analysis } = entry;
	for (const c of analysis.concepts) {
		conceptsOut.add(c);
	}

	const excludedLiterals = detectExcludedFolderLiterals(
		analysis.pathFilterLiterals,
		folderConfig,
	);
	if (excludedLiterals.length > 0) {
		conceptsOut.add('template-modes-virtual-this');
	}
	const coercionGroups = lookupCoercionGroupsForQuery(analysis.queriedKeys, coercionIndex);
	if (coercionGroups.length > 0) {
		conceptsOut.add('property-coercion');
	}
	if (entry.isLazy) {
		conceptsOut.add('template-modes-virtual-this');
	}

	const qCode = formatInlineCode(block.name);
	let headerLine: string;

	if (!analysis.executable || entry.blockedByCycleOrError) {
		const errCount = Math.max(1, analysis.errorCount);
		headerLine = `> [!danger]+ Query ${qCode} — ${errCount} ${errCount === 1 ? 'error' : 'errors'} (Not executable)`;
	} else if (entry.skippedInSample) {
		headerLine = `> [!info]- Query ${qCode} — Skipped (branch not entered in sample)`;
	} else {
		const matchedCount = metrics?.matchedCount ?? 0;
		const warningReasons: string[] = [];
		if (metrics?.exceedsProductionCutoff) {
			warningReasons.push(`exceeds ${EXPLAIN_NUM_FMT.format(block.cutoff)} cutoff`);
		}
		if (analysis.warningCount > 0) {
			warningReasons.push(
				`${analysis.warningCount} query ${analysis.warningCount === 1 ? 'warning' : 'warnings'}`,
			);
		}
		if (coercionGroups.length > 0) {
			const totalNoteFails = coercionGroups.reduce((sum, g) => sum + g.totalFailures, 0);
			warningReasons.push(
				`${EXPLAIN_NUM_FMT.format(totalNoteFails)} property coercion ${totalNoteFails === 1 ? 'warning' : 'warnings'}`,
			);
		}
		if (excludedLiterals.length > 0) {
			warningReasons.push('targets excluded template folder');
		}

		if (matchedCount === 0) {
			const suffix = warningReasons.length > 0 ? ` · ${warningReasons.join(' · ')}` : '';
			headerLine = `> [!warning]- Query ${qCode} — 0 records matched${suffix}`;
		} else {
			const countPhrase = metrics
				? formatRecordsShortPhrase(metrics)
				: `all ${EXPLAIN_NUM_FMT.format(matchedCount)} records`;
			if (warningReasons.length > 0) {
				headerLine = `> [!warning]- Query ${qCode} — ${countPhrase} · ${warningReasons.join(' · ')}`;
			} else {
				headerLine = `> [!check]- Query ${qCode} — ${countPhrase}`;
			}
		}
	}

	const body: string[] = [];
	const provText = block.file
		? `Defined in ${formatSafeExplainFileLink(block.file)} (line ${block.headerSpan.startLine})`
		: `Defined inline in this codeblock (line ${block.headerSpan.startLine})`;
	body.push(`- **Provenance**: ${provText}`);

	const depsSuffix =
		analysis.queryDependencies.length > 0
			? ` · depends on ${analysis.queryDependencies.map((d) => formatInlineCode(`@query.${d}`)).join(', ')}`
			: '';
	if (!analysis.executable || entry.blockedByCycleOrError) {
		body.push(`- **Stage**: Blocked (compile or dependency error)${depsSuffix}`);
	} else if (entry.isLazy) {
		body.push(`- **Stage**: Pass 2 Lazy — depends on virtual \`@this\`${depsSuffix}`);
	} else {
		body.push(`- **Stage**: Pass 1.5 · Wave ${entry.waveNumber ?? 1}${depsSuffix}`);
	}

	if (entry.isLazy && entry.lazyHostDoc) {
		body.push(...formatVirtualThisSnapshotLines(entry.lazyHostDoc));
	}

	if (analysis.executable && !entry.blockedByCycleOrError && !entry.skippedInSample && metrics) {
		const mFmt = EXPLAIN_NUM_FMT.format(metrics.matchedCount);
		const sFmt = EXPLAIN_NUM_FMT.format(metrics.sampledCount);
		if (metrics.downsampled) {
			const bFmt = EXPLAIN_NUM_FMT.format(metrics.baseStrideCount);
			const rFmt = EXPLAIN_NUM_FMT.format(metrics.referentialTopUpCount);
			body.push(
				`- **Records**: Matched \`${mFmt}\` records · Sampled \`${sFmt}\` records (\`${bFmt}\` stride + \`${rFmt}\` referential top-up)`,
			);
		} else if (metrics.cutoffBound) {
			body.push(
				`- **Records**: Matched \`${mFmt}\` records · Truncated to \`${sFmt}\` records by active \`cutoff: ${EXPLAIN_NUM_FMT.format(block.cutoff)}\``,
			);
		} else {
			body.push(
				`- **Records**: Matched \`${mFmt}\` ${metrics.matchedCount === 1 ? 'record' : 'records'} (all included in sample)`,
			);
		}
	}

	if (block.cutoff <= 0) {
		body.push('- **Cutoff**: Unlimited (`cutoff: 0`)');
	} else {
		const cFmt = EXPLAIN_NUM_FMT.format(block.cutoff);
		const originTag = block.explicitCutoff ? 'explicit' : 'default';
		const prodWarn = metrics?.exceedsProductionCutoff
			? ` — ⚠️ Production renders (\`rhizome\`, \`newNote\`, \`atCursor\`) will truncate this query at \`${cFmt}\` records.`
			: '';
		body.push(`- **Cutoff**: \`${cFmt}\` records (${originTag})${prodWarn}`);
	}

	const nowPart = analysis.nowLocalIso
		? `\`@now\`: \`${analysis.nowLocalIso}\``
		: `\`@now\`: ❌ Invalid \`referenceTimeMs\``;
	body.push(
		`- **Temporal Context**: ${nowPart} · \`@today\`: \`${analysis.todayLocalWindow}\` · Timezone: ${formatInlineCode(analysis.effectiveTimeZone)}`,
	);

	body.push('', '**Logic Breakdown**', '');
	if (analysis.ast === null) {
		body.push(
			'This query could not be parsed into an execution tree because of a syntax or query-length error. See **Diagnostics** below for the exact location and fix.',
		);
	} else {
		body.push(...analysis.astBullets);
	}

	const hasAnyDiagnosticsSection =
		analysis.diagnostics.length > 0 || excludedLiterals.length > 0 || coercionGroups.length > 0;
	if (hasAnyDiagnosticsSection) {
		body.push('', '**Diagnostics**', '');
		for (const diag of analysis.diagnostics) {
			const icon =
				diag.severity === 'error'
					? '❌ Error'
					: diag.severity === 'warning'
						? '⚠️ Warning'
						: 'ℹ️ Hint';
			const loc = diag.span
				? ` (line ${diag.span.startLine}, column ${diag.span.startColumn})`
				: '';
			body.push(`- **${icon}** (\`${diag.code}\`)${loc}: ${escapeExplainProse(diag.issue)}`);
			if (diag.span !== null) {
				const snippet = formatSourceCaretSnippet(block.query, diag.span);
				body.push(...wrapCodeFenceLines(snippet, 'text', '  '));
			}
			if (diag.hint !== null) {
				body.push(`  *Fix*: ${escapeExplainProse(diag.hint)}`);
			}
		}

		if (excludedLiterals.length > 0) {
			const resolved = resolveTemplateFolders(folderConfig);
			const litList = excludedLiterals.map((l) => formatInlineCode(l)).join(', ');
			body.push(
				`- **⚠️ Template-Folder Index Exclusion**: Path filter ${litList} targets a configured Rhizome template folder (\`${resolved.templatesFolder}\`, \`${resolved.partialsFolder}\`, or \`${resolved.layoutsFolder}\`). Notes inside template, partial, and layout folders are excluded from vault indexing and never appear in query results.`,
			);
		}

		for (const group of coercionGroups) {
			const links = group.sampleNotePaths.map((p) => formatSafeExplainFileLink(p)).join(', ');
			const extraCount = Math.max(0, group.totalFailures - group.sampleNotePaths.length);
			const moreSuffix =
				extraCount > 0 ? ` (+ ${EXPLAIN_NUM_FMT.format(extraCount)} more)` : '';
			body.push(
				`- **⚠️ Vault Property Coercion**: \`${EXPLAIN_NUM_FMT.format(group.totalFailures)}\` ${group.totalFailures === 1 ? 'note has' : 'notes have'} a malformed ${formatInlineCode(group.propertyKey)} value for expected type \`${group.expectedType}\` (e.g. ${formatInlineCode(group.sampleRawValue)} in ${links}${moreSuffix}); non-coercible values are skipped during matching.`,
			);
		}
	}

	return [headerLine, ...prefixCalloutBodyLines(body)].join('\n');
}

function findUpstreamBlockerName(
	startName: string,
	depsByName: ReadonlyMap<string, readonly string[]>,
	directlyFailedNames: ReadonlySet<string>,
): string | null {
	const visited = new Set<string>([startName]);
	const queue = [...(depsByName.get(startName) ?? [])];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (visited.has(cur)) continue;
		visited.add(cur);
		if (directlyFailedNames.has(cur)) {
			return cur;
		}
		for (const nextDep of depsByName.get(cur) ?? []) {
			if (!visited.has(nextDep)) {
				queue.push(nextDep);
			}
		}
	}
	return null;
}

/**
 * Builds ordered, self-contained per-query explain callouts (Errors first, then Pass-1.5 static waves,
 * then Pass-2 lazy queries in declaration order) per `docs/spec/Extended Explain Plan.md` §5.1 & §6.
 */
export function buildQueryExplainCallouts(
	options: BuildQueryExplainCalloutsOptions,
): QueryExplainCalloutsResult {
	const {
		queries,
		resolvedConfig,
		referenceTimeMs,
		folderConfig,
		hostDoc,
		isNewNoteMode,
		metricsByName,
		lazyHostDocsByName,
		coercionDocuments,
	} = options;

	if (queries.length === 0) {
		return {
			callouts: Object.freeze([]),
			queriedKeysUnion: new Set<string>(),
			triggeredConcepts: new Set<ExplainConceptKey>(),
			waveByQueryName: new Map<string, number>(),
			lazyQueryNames: new Set<string>(),
		};
	}

	const partitioned = isNewNoteMode
		? partitionNewNoteQueries(queries)
		: { staticQueries: queries, lazyQueryNames: new Set<string>() };
	const knownQueryNames = new Set<string>(queries.map((q) => q.name));

	// Single-pass query analysis; only re-run on queries that receive DAG/blocker extraDiagnostics
	const initialAnalyses = new Map<string, QueryExplainAnalysis>();
	const preliminaryAsts: Array<{ readonly name: string; readonly ast: SearchAST | null }> = [];
	const depsByName = new Map<string, readonly string[]>();

	for (const block of queries) {
		const isLazy = partitioned.lazyQueryNames.has(block.name);
		const hasLazyMetrics = metricsByName.has(block.name);
		const lazyHostDoc = isLazy ? lazyHostDocsByName?.get(block.name) : undefined;
		const effectiveHostDoc = isLazy ? (hasLazyMetrics ? lazyHostDoc : undefined) : hostDoc;

		const analysis = analyzeQueryExplain(block.query, resolvedConfig, referenceTimeMs, {
			knownQueryNames,
			hostDoc: effectiveHostDoc,
		});
		initialAnalyses.set(block.name, analysis);
		preliminaryAsts.push({ name: block.name, ast: analysis.ast });
		depsByName.set(block.name, analysis.queryDependencies);
	}

	const fullDag = analyzeQueryDependencyDag(preliminaryAsts, { checkUnknownRefs: true });

	const staticNameSet = new Set<string>(partitioned.staticQueries.map((q) => q.name));
	const staticDag = analyzeQueryDependencyDag(
		preliminaryAsts.filter((item) => staticNameSet.has(item.name)),
		{ checkUnknownRefs: false },
	);
	const waveByQueryName = new Map<string, number>();
	staticDag.waves.forEach((wave, idx) => {
		for (const qName of wave) {
			waveByQueryName.set(qName, idx + 1);
		}
	});

	const directlyFailedNames = new Set<string>();
	for (const block of queries) {
		const init = initialAnalyses.get(block.name)!;
		if (
			!init.executable ||
			fullDag.unknownRefDiagnosticsByQuery.has(block.name) ||
			fullDag.cycleDiagnosticsByQuery.has(block.name)
		) {
			directlyFailedNames.add(block.name);
		}
	}

	const enriched: EnrichedQueryEntry[] = [];
	const queriedKeysUnion = new Set<string>();

	queries.forEach((block, declIndex) => {
		const isLazy = partitioned.lazyQueryNames.has(block.name);
		const hasLazyMetrics = metricsByName.has(block.name);
		const lazyHostDoc = isLazy ? lazyHostDocsByName?.get(block.name) : undefined;
		const effectiveHostDoc = isLazy ? (hasLazyMetrics ? lazyHostDoc : undefined) : hostDoc;
		const extraDiags: SearchDiagnostic[] = [
			...(fullDag.unknownRefDiagnosticsByQuery.get(block.name) ?? []),
			...(fullDag.cycleDiagnosticsByQuery.get(block.name) ?? []),
		];

		let analysis = initialAnalyses.get(block.name)!;
		if (analysis.executable && extraDiags.length === 0) {
			const upstreamName = findUpstreamBlockerName(
				block.name,
				depsByName,
				directlyFailedNames,
			);
			if (upstreamName !== null) {
				const isCycle = fullDag.cycleDiagnosticsByQuery.has(upstreamName);
				extraDiags.push({
					code: isCycle ? 'ERROR_CIRCULAR_QUERY_REF' : 'ERROR_UNKNOWN_QUERY_REF',
					severity: 'error',
					issue: `Blocked because upstream dependency '@query.${upstreamName}' failed compilation or is part of a dependency cycle.`,
					hint: `Resolve the error reported on Query '${upstreamName}' above.`,
					span: null,
				});
			}
		}

		if (extraDiags.length > 0) {
			analysis = analyzeQueryExplain(block.query, resolvedConfig, referenceTimeMs, {
				knownQueryNames,
				extraDiagnostics: extraDiags,
				hostDoc: effectiveHostDoc,
			});
		}

		for (const k of analysis.queriedKeys) {
			queriedKeysUnion.add(k);
		}

		const blockedByCycleOrError =
			!analysis.executable || fullDag.blockedQueryNames.has(block.name);
		const skippedInSample = isLazy && !blockedByCycleOrError && !hasLazyMetrics;

		enriched.push({
			block,
			declIndex,
			isLazy,
			waveNumber: isLazy ? null : (waveByQueryName.get(block.name) ?? null),
			blockedByCycleOrError,
			skippedInSample,
			analysis,
			lazyHostDoc,
		});
	});

	// Pre-bucket coercion diagnostics across vault docs ONCE (`O(docs)` instead of `O(queries * docs)`)
	const coercionIndex = buildCoercionIndexForKeys(queriedKeysUnion, coercionDocuments);

	const errorEntries = enriched.filter((e) => e.blockedByCycleOrError);
	const staticEntries = enriched
		.filter((e) => !e.blockedByCycleOrError && !e.isLazy)
		.sort((a, b) => (a.waveNumber ?? 1) - (b.waveNumber ?? 1) || a.declIndex - b.declIndex);
	const lazyEntries = enriched.filter((e) => !e.blockedByCycleOrError && e.isLazy);

	const ordered = [...errorEntries, ...staticEntries, ...lazyEntries];
	const triggeredConcepts = new Set<ExplainConceptKey>();
	const callouts: string[] = [];
	let accumulatedChars = 0;

	for (let i = 0; i < ordered.length; i++) {
		const entry = ordered[i]!;
		const rendered = renderSingleQueryCallout(
			entry,
			metricsByName.get(entry.block.name),
			folderConfig,
			coercionIndex,
			triggeredConcepts,
		);
		if (
			accumulatedChars + rendered.length > MAX_EXPLAIN_CALLOUTS_CHARS &&
			callouts.length > 0
		) {
			const remaining = ordered.length - i;
			callouts.push(
				`> [!info]- Remaining ${remaining} query explain ${remaining === 1 ? 'plan' : 'plans'} omitted (size cap reached)`,
			);
			break;
		}
		accumulatedChars += rendered.length;
		callouts.push(rendered);
	}

	return {
		callouts: Object.freeze(callouts),
		queriedKeysUnion,
		triggeredConcepts,
		waveByQueryName,
		lazyQueryNames: partitioned.lazyQueryNames,
	};
}
