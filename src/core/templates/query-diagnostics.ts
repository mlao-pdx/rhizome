import {
	analyzeQueryDependencyDag,
	compileQuery,
	type DiagnosticCode,
	initEngineConfig,
	type ResolvedEngineConfig,
	type SearchAST,
	type SearchDiagnostic,
	type ValueExprAST,
} from '@core/search';
import { offsetRangeToSourceSpan } from './query-tag';
import type {
	ExtractedQueryBlock,
	TemplateDiagnostic,
	TemplateDiagnosticCode,
	TemplateRuntimeContext,
} from './types';

const QUERY_DIAGNOSTIC_CODE_MAP = {
	SYNTAX_ERROR: true,
	ERROR_INVALID_CONFIG: true,
	ERROR_UNKNOWN_SCOPE: true,
	ERROR_UNKNOWN_QUERY_REF: true,
	ERROR_CIRCULAR_QUERY_REF: true,
	ERROR_TYPE_MISMATCH: true,
	ERROR_INVALID_OPERATOR_FOR_TYPE: true,
	WARN_SINGLE_VALUE_CONTRADICTION: true,
	WARN_MISSING_THIS_VALUE: true,
	WARN_THIS_TYPE_MISMATCH: true,
	HINT_PROP_NEQ_EXISTENCE: true,
	HINT_PROPERTY_MATCHES_SCOPE: true,
	HINT_AMBIGUOUS_PRECEDENCE: true,
	HINT_WIKILINK_BRACKETS_IN_SCOPE: true,
	HINT_UNCLOSED_REGEX: true,
} as const satisfies Record<DiagnosticCode, true>;

const QUERY_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set<string>(
	Object.keys(QUERY_DIAGNOSTIC_CODE_MAP),
);

/**
 * Returns `true` when `code` is a search-query `DiagnosticCode` rather than a `TemplateDiagnosticCode`.
 */
export function isQueryDiagnosticCode(
	code: TemplateDiagnosticCode | DiagnosticCode,
): code is DiagnosticCode {
	return QUERY_DIAGNOSTIC_CODES.has(code);
}

/**
 * Collects direct `@query.<name>` dependency names referenced inside `ast`.
 */
export function collectDirectQueryDependencies(ast: SearchAST | null): readonly string[] {
	if (ast === null) {
		return [];
	}
	const out = new Set<string>();

	const visitVal = (expr: ValueExprAST): void => {
		if (expr.type === 'VALUE_LEAF') {
			if (expr.matcher.kind === 'query') {
				out.add(expr.matcher.queryName);
			}
		} else if (expr.type === 'VALUE_NOT') {
			visitVal(expr.child);
		} else {
			for (const c of expr.children) visitVal(c);
		}
	};

	const visitAst = (node: SearchAST): void => {
		switch (node.type) {
			case 'MATCH_ALL':
				return;
			case 'LOGICAL':
				for (const c of node.children) visitAst(c);
				return;
			case 'NOT':
				visitAst(node.child);
				return;
			case 'SCOPED_FILTER':
				visitVal(node.expr);
				return;
			case 'PROPERTY_FILTER':
				if (node.valueExpr) visitVal(node.valueExpr);
				return;
			case 'SCOPE_GRAPH_FILTER':
			case 'PROPERTY_GRAPH_FILTER':
				if (node.target.kind === 'subquery') {
					visitAst(node.target.ast);
				} else if (node.target.kind === 'query_ref') {
					out.add(node.target.queryName);
				}
				return;
		}
	};

	visitAst(ast);
	return [...out];
}

/**
 * Maps a `SearchDiagnostic` inside `queryBlock` onto a `TemplateDiagnostic` positioned in
 * the root codeblock source (when `queryBlock.file` is `null`) or external template file.
 */
export function mapSearchDiagnosticToTemplateDiagnostic(
	rootSource: string,
	queryBlock: ExtractedQueryBlock,
	diag: SearchDiagnostic,
	fileSources?: ReadonlyMap<string, string>,
): TemplateDiagnostic {
	const externalFile =
		typeof queryBlock.file === 'string' && queryBlock.file.trim().length > 0
			? queryBlock.file.trim()
			: null;
	const targetSource = externalFile !== null ? fileSources?.get(externalFile) : rootSource;

	const span =
		diag.span !== null && typeof targetSource === 'string'
			? offsetRangeToSourceSpan(
					targetSource,
					queryBlock.bodySpan.startOffset + diag.span.startOffset,
					queryBlock.bodySpan.startOffset +
						Math.max(diag.span.startOffset + 1, diag.span.endOffset),
				)
			: queryBlock.headerSpan;

	return Object.freeze({
		code: diag.code,
		severity: diag.severity,
		issue: diag.issue,
		hint: diag.hint,
		span,
		file: externalFile,
	});
}

/**
 * Builds a fallback `TemplateDiagnostic` when `runQueries` omits a query key without a static
 * compilation diagnostic (for example when vault engine configuration failed upstream).
 */
export function createOmittedQueryDiagnostic(queryBlock: ExtractedQueryBlock): TemplateDiagnostic {
	const externalFile =
		typeof queryBlock.file === 'string' && queryBlock.file.trim().length > 0
			? queryBlock.file.trim()
			: null;
	return Object.freeze({
		code: 'ERROR_INVALID_CONFIG',
		severity: 'error',
		issue: `Query '${queryBlock.name}' could not be executed because query compilation or engine configuration failed.`,
		hint: `Check the syntax and property types used in '{% query ${queryBlock.name} %}', or switch the fence to '\`\`\`rhizome-sample' to inspect detailed diagnostics.`,
		span: queryBlock.headerSpan,
		file: externalFile,
	});
}

/**
 * Error carrier thrown when one or more query errors abort Pass-2 lazy `@this` evaluation.
 */
export class MultiTemplateDiagnosticError extends Error {
	public readonly templateDiagnostics: readonly TemplateDiagnostic[];

	public constructor(diagnostics: readonly TemplateDiagnostic[]) {
		super(diagnostics[0]?.issue ?? 'Query compilation error');
		this.name = 'MultiTemplateDiagnosticError';
		this.templateDiagnostics = Object.freeze([...diagnostics]);
	}
}

/**
 * Compiles all extracted `queries` and validates their `@query.<name>` dependency DAG against
 * `runtimeContext`, returning per-query `TemplateDiagnostic` error arrays (`severity === 'error'`).
 */
export function analyzeExtractedQueryErrorsByName(
	rootSource: string,
	queries: readonly ExtractedQueryBlock[],
	fileSources?: ReadonlyMap<string, string>,
	runtimeContext?: TemplateRuntimeContext,
): ReadonlyMap<string, readonly TemplateDiagnostic[]> {
	const errorsByName = new Map<string, TemplateDiagnostic[]>();
	if (queries.length === 0) {
		return errorsByName;
	}

	const pushDiag = (name: string, diag: TemplateDiagnostic): void => {
		let list = errorsByName.get(name);
		if (!list) {
			list = [];
			errorsByName.set(name, list);
		}
		list.push(diag);
	};

	let resolvedConfig: ResolvedEngineConfig;
	if (runtimeContext?.resolvedConfig) {
		resolvedConfig = runtimeContext.resolvedConfig;
	} else {
		const timeZone =
			typeof runtimeContext?.timeZone === 'string' &&
			runtimeContext.timeZone.trim().length > 0
				? runtimeContext.timeZone
				: 'UTC';
		const cfgRes = initEngineConfig({ timeZone, propertyTypes: {} });
		if (!cfgRes.ok) {
			for (const q of queries) {
				for (const d of cfgRes.diagnostics) {
					if (d.severity === 'error') {
						pushDiag(
							q.name,
							mapSearchDiagnosticToTemplateDiagnostic(rootSource, q, d, fileSources),
						);
					}
				}
			}
			return errorsByName;
		}
		resolvedConfig = cfgRes.config;
	}

	const referenceTimeMs = runtimeContext?.referenceTimeMs ?? Date.now();
	const knownQueryNames = new Set<string>(queries.map((q) => q.name));
	const queryByName = new Map<string, ExtractedQueryBlock>();
	const depsByName = new Map<string, readonly string[]>();
	const dagInputs: Array<{ readonly name: string; readonly ast: SearchAST | null }> = [];

	for (const q of queries) {
		queryByName.set(q.name, q);
		const compileRes = compileQuery(
			q.query,
			resolvedConfig,
			referenceTimeMs,
			undefined,
			knownQueryNames,
		);
		for (const d of compileRes.diagnostics) {
			if (d.severity === 'error') {
				pushDiag(
					q.name,
					mapSearchDiagnosticToTemplateDiagnostic(rootSource, q, d, fileSources),
				);
			}
		}
		depsByName.set(q.name, collectDirectQueryDependencies(compileRes.ast));
		dagInputs.push({ name: q.name, ast: compileRes.ast });
	}

	const dagAnalysis = analyzeQueryDependencyDag(dagInputs, { checkUnknownRefs: true });
	for (const [qName, diags] of dagAnalysis.unknownRefDiagnosticsByQuery) {
		const block = queryByName.get(qName);
		if (!block) continue;
		const existing = errorsByName.get(qName) ?? [];
		for (const d of diags) {
			if (d.severity !== 'error') continue;
			const mapped = mapSearchDiagnosticToTemplateDiagnostic(
				rootSource,
				block,
				d,
				fileSources,
			);
			const duplicate = existing.some(
				(e) => e.code === mapped.code && e.span?.startOffset === mapped.span?.startOffset,
			);
			if (!duplicate) {
				pushDiag(qName, mapped);
			}
		}
	}
	for (const [qName, diags] of dagAnalysis.cycleDiagnosticsByQuery) {
		const block = queryByName.get(qName);
		if (!block) continue;
		for (const d of diags) {
			if (d.severity === 'error') {
				pushDiag(
					qName,
					mapSearchDiagnosticToTemplateDiagnostic(rootSource, block, d, fileSources),
				);
			}
		}
	}

	// Snapshot direct errors before propagating reachable upstream blockers to transitively blocked queries
	const directErrorsByName = new Map<string, readonly TemplateDiagnostic[]>(errorsByName);
	for (const q of queries) {
		const blockedName = q.name;
		if (directErrorsByName.has(blockedName)) {
			continue;
		}
		const reachableDiags: TemplateDiagnostic[] = [];
		const visited = new Set<string>([blockedName]);
		const queue = [...(depsByName.get(blockedName) ?? [])];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			if (visited.has(cur)) continue;
			visited.add(cur);
			const direct = directErrorsByName.get(cur);
			if (direct && direct.length > 0) {
				reachableDiags.push(...direct);
			} else {
				for (const nextDep of depsByName.get(cur) ?? []) {
					if (!visited.has(nextDep)) {
						queue.push(nextDep);
					}
				}
			}
		}
		if (reachableDiags.length > 0) {
			errorsByName.set(blockedName, reachableDiags);
		}
	}

	return errorsByName;
}

/**
 * Collects deduplicated `TemplateDiagnostic` errors in query declaration order across `targetQueries`.
 */
export function flattenQueryErrors(
	targetQueries: readonly ExtractedQueryBlock[],
	errorsByName: ReadonlyMap<string, readonly TemplateDiagnostic[]>,
): readonly TemplateDiagnostic[] {
	const out: TemplateDiagnostic[] = [];
	const seen = new Set<string>();
	for (const q of targetQueries) {
		const diags = errorsByName.get(q.name);
		if (!diags) continue;
		for (const d of diags) {
			const key = `${d.file ?? ''}\0${d.code}\0${d.span?.startOffset ?? -1}\0${d.issue}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push(d);
			}
		}
	}
	return Object.freeze(out);
}
