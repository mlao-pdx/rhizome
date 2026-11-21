import type {
	GraphDirection,
	GraphScopeName,
	HopBounds,
	SearchAST,
	SearchDiagnostic,
	SourceSpan,
	ValueExprAST,
} from './types';

/** Maximum explicit or `*`-bounded hop count allowed in graph traversal quantifiers. */
export const MAX_GRAPH_HOPS = 64;

/** Canonical built-in scopes that support graph traversal arrows and targets. */
export const GRAPH_SCOPE_NAMES: readonly GraphScopeName[] = Object.freeze([
	'links',
	'embeds',
	'backlinks',
]);

const GRAPH_SCOPE_SET: ReadonlySet<string> = new Set<string>(GRAPH_SCOPE_NAMES);

/**
 * Returns `true` when `canonicalScope` is one of the built-in note-graph scopes
 * (`links`, `embeds`, or `backlinks`).
 */
export function isGraphScopeCanonicalName(
	canonicalScope: string,
): canonicalScope is GraphScopeName {
	return GRAPH_SCOPE_SET.has(canonicalScope);
}

export type ParsedGraphArrowResult =
	| {
			readonly ok: true;
			readonly direction: GraphDirection;
			readonly hops: HopBounds;
	  }
	| {
			readonly ok: false;
			readonly direction: GraphDirection;
			readonly hops: HopBounds;
			readonly issue: string;
			readonly hint: string | null;
	  };

const HOP_RANGE_RE = /^(\d*)\.\.(\d+|\*)$/;

/**
 * Parses a `GraphArrow` token image (`->`, `->*`, `->..N`, `->M..N`, `<-`, etc.)
 * into its traversal direction and validated `[minHops, maxHops]` bounds.
 */
export function parseGraphArrow(rawArrow: string): ParsedGraphArrowResult {
	const direction: GraphDirection = rawArrow.startsWith('<-') ? 'incoming' : 'outgoing';
	const arrowPrefix = direction === 'incoming' ? '<-' : '->';
	const quant = rawArrow.slice(2);

	if (quant === '') {
		return {
			ok: true,
			direction,
			hops: { minHops: 1, maxHops: 1, unbounded: false, raw: rawArrow },
		};
	}

	if (quant === '*') {
		return {
			ok: true,
			direction,
			hops: { minHops: 1, maxHops: MAX_GRAPH_HOPS, unbounded: true, raw: rawArrow },
		};
	}

	const rangeMatch = HOP_RANGE_RE.exec(quant);
	if (!rangeMatch) {
		const numHint =
			/^\d+$/.test(quant) && Number(quant) >= 1
				? `Use "${arrowPrefix}..${quant}" for up to ${quant} hops or "${arrowPrefix}${quant}..${quant}" for exact ${quant} hops.`
				: `Use "${arrowPrefix}", "${arrowPrefix}*", "${arrowPrefix}..3", or "${arrowPrefix}1..3".`;
		return {
			ok: false,
			direction,
			hops: { minHops: 1, maxHops: 1, unbounded: false, raw: rawArrow },
			issue: `Invalid graph hop quantifier "${rawArrow}".`,
			hint: numHint,
		};
	}

	const minStr = rangeMatch[1]!;
	const maxStr = rangeMatch[2]!;
	const minHops = minStr === '' ? 1 : Number(minStr);
	const unbounded = maxStr === '*';
	const maxHops = unbounded ? MAX_GRAPH_HOPS : Number(maxStr);
	const fallbackHops: HopBounds = {
		minHops: Number.isSafeInteger(minHops) ? minHops : 1,
		maxHops: Number.isSafeInteger(maxHops) ? maxHops : 1,
		unbounded,
		raw: rawArrow,
	};

	if (
		!Number.isSafeInteger(minHops) ||
		minHops < 0 ||
		(!unbounded && !Number.isSafeInteger(maxHops)) ||
		minHops > MAX_GRAPH_HOPS ||
		(!unbounded && maxHops > MAX_GRAPH_HOPS)
	) {
		return {
			ok: false,
			direction,
			hops: fallbackHops,
			issue: `Hop quantifier "${rawArrow}" exceeds the maximum allowed bound of ${MAX_GRAPH_HOPS} hops.`,
			hint: `Use "${arrowPrefix}*" for unbounded reachability, or specify hop bounds <= ${MAX_GRAPH_HOPS}.`,
		};
	}

	if (maxHops < 1) {
		return {
			ok: false,
			direction,
			hops: fallbackHops,
			issue: `Hop quantifier "${rawArrow}" must allow at least 1 hop (got maxHops = ${maxHops}).`,
			hint: `Use "${arrowPrefix}..1" or "${arrowPrefix}0..1".`,
		};
	}

	if (minHops > maxHops) {
		return {
			ok: false,
			direction,
			hops: fallbackHops,
			issue: `Hop quantifier "${rawArrow}" has minimum hops (${minHops}) greater than maximum hops (${maxHops}).`,
			hint: `Use "${arrowPrefix}${maxHops}..${minHops}" instead.`,
		};
	}

	return {
		ok: true,
		direction,
		hops: { minHops, maxHops, unbounded, raw: rawArrow },
	};
}

function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = new Array<number>(n + 1);
	let curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		const aChar = a.charCodeAt(i - 1);
		for (let j = 1; j <= n; j++) {
			const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return prev[n]!;
}

/**
 * Produces an actionable fix-it hint for an unknown `@query.<name>` reference,
 * suggesting the closest declared query name within Levenshtein distance 2 when available.
 */
export function suggestQueryNameHint(queryName: string, knownQueryNames: Iterable<string>): string {
	const lower = queryName.toLowerCase();
	let bestMatch: string | null = null;
	let bestDist = 3;
	const candidates: string[] = [];
	for (const candidate of knownQueryNames) {
		candidates.push(candidate);
		const dist = editDistance(lower, candidate.toLowerCase());
		if (dist <= 2 && dist < bestDist) {
			bestDist = dist;
			bestMatch = candidate;
		}
	}
	if (bestMatch !== null) {
		return `Did you mean "@query.${bestMatch}"?`;
	}
	if (candidates.length > 0 && candidates.length <= 5) {
		return `Available queries: ${candidates.map((c) => `"@query.${c}"`).join(', ')}.`;
	}
	return `Declare "{% query ${queryName} %}...{% endquery %}" before referencing "@query.${queryName}".`;
}

export interface QueryReferenceOccurrence {
	readonly queryName: string;
	readonly raw: string;
	readonly span: SourceSpan | null;
	readonly kind: 'node_set' | 'scalar_projection';
}

function collectValueExprQueryRefs(
	expr: ValueExprAST,
	fallbackSpan: SourceSpan | null,
	out: QueryReferenceOccurrence[],
): void {
	switch (expr.type) {
		case 'VALUE_LEAF':
			if (expr.matcher.kind === 'query') {
				out.push({
					queryName: expr.matcher.queryName,
					raw: expr.matcher.raw,
					span: expr.span ?? fallbackSpan,
					kind: 'scalar_projection',
				});
			}
			return;
		case 'VALUE_NOT':
			collectValueExprQueryRefs(expr.child, expr.span ?? fallbackSpan, out);
			return;
		case 'VALUE_LOGICAL':
			for (const child of expr.children) {
				collectValueExprQueryRefs(child, expr.span ?? fallbackSpan, out);
			}
			return;
	}
}

/**
 * Collects all `@query.<name>` graph-target and `@query.<name>.<path>` scalar-leaf references
 * across `ast` and any nested `{ ... }` subqueries in AST traversal order.
 */
export function collectQueryReferences(
	ast: SearchAST,
	out: QueryReferenceOccurrence[] = [],
): QueryReferenceOccurrence[] {
	switch (ast.type) {
		case 'MATCH_ALL':
			return out;
		case 'NOT':
			return collectQueryReferences(ast.child, out);
		case 'LOGICAL':
			for (const child of ast.children) {
				collectQueryReferences(child, out);
			}
			return out;
		case 'SCOPED_FILTER':
			collectValueExprQueryRefs(ast.expr, ast.span ?? null, out);
			return out;
		case 'PROPERTY_FILTER':
			if (ast.valueExpr) {
				collectValueExprQueryRefs(ast.valueExpr, ast.span ?? null, out);
			}
			return out;
		case 'SCOPE_GRAPH_FILTER':
		case 'PROPERTY_GRAPH_FILTER':
			if (ast.target.kind === 'query_ref') {
				out.push({
					queryName: ast.target.queryName,
					raw: ast.target.raw,
					span: ast.target.span ?? ast.span ?? null,
					kind: 'node_set',
				});
			} else if (ast.target.kind === 'subquery') {
				collectQueryReferences(ast.target.ast, out);
			}
			return out;
	}
}

function valueExprUsesHost(expr: ValueExprAST): boolean {
	if (expr.type === 'VALUE_LEAF') return expr.matcher.kind === 'this';
	if (expr.type === 'VALUE_NOT') return valueExprUsesHost(expr.child);
	return expr.children.some(valueExprUsesHost);
}

/**
 * Returns `true` when `ast` (or any nested `{ ... }` subquery) references `@this` or `@this.<path>`.
 */
export function astUsesHostReference(ast: SearchAST): boolean {
	switch (ast.type) {
		case 'MATCH_ALL':
			return false;
		case 'NOT':
			return astUsesHostReference(ast.child);
		case 'LOGICAL':
			return ast.children.some(astUsesHostReference);
		case 'SCOPED_FILTER':
			return valueExprUsesHost(ast.expr);
		case 'PROPERTY_FILTER':
			return ast.valueExpr ? valueExprUsesHost(ast.valueExpr) : false;
		case 'SCOPE_GRAPH_FILTER':
		case 'PROPERTY_GRAPH_FILTER':
			if (ast.target.kind === 'this_ref') return true;
			if (ast.target.kind === 'subquery') return astUsesHostReference(ast.target.ast);
			return false;
	}
}

function valueExprUsesQuery(expr: ValueExprAST): boolean {
	if (expr.type === 'VALUE_LEAF') return expr.matcher.kind === 'query';
	if (expr.type === 'VALUE_NOT') return valueExprUsesQuery(expr.child);
	return expr.children.some(valueExprUsesQuery);
}

/**
 * Returns `true` when `ast` contains graph traversal filters (`SCOPE_GRAPH_FILTER`,
 * `PROPERTY_GRAPH_FILTER`) or `@query.<name>.<path>` scalar projections.
 */
export function astUsesGraphFeatures(ast: SearchAST): boolean {
	switch (ast.type) {
		case 'MATCH_ALL':
			return false;
		case 'NOT':
			return astUsesGraphFeatures(ast.child);
		case 'LOGICAL':
			return ast.children.some(astUsesGraphFeatures);
		case 'SCOPED_FILTER':
			return valueExprUsesQuery(ast.expr);
		case 'PROPERTY_FILTER':
			return ast.valueExpr ? valueExprUsesQuery(ast.valueExpr) : false;
		case 'SCOPE_GRAPH_FILTER':
		case 'PROPERTY_GRAPH_FILTER':
			return true;
	}
}

export interface QueryDagEntryInput {
	readonly name: string;
	readonly ast: SearchAST | null;
}

export interface QueryDagAnalysis {
	/** Ordered dependency waves; queries within each wave depend only on earlier waves. */
	readonly waves: ReadonlyArray<readonly string[]>;
	/** `ERROR_UNKNOWN_QUERY_REF` diagnostics keyed by declaring query name. */
	readonly unknownRefDiagnosticsByQuery: ReadonlyMap<string, readonly SearchDiagnostic[]>;
	/** `ERROR_CIRCULAR_QUERY_REF` diagnostics keyed by declaring query name. */
	readonly cycleDiagnosticsByQuery: ReadonlyMap<string, readonly SearchDiagnostic[]>;
	/** Queries that cannot execute due to a cycle or unknown `@query.<name>` dependency. */
	readonly blockedQueryNames: ReadonlySet<string>;
}

/**
 * Validates `@query.<name>` existence and circular dependencies across a batch of named queries,
 * partitioning executable queries into topological dependency waves.
 */
export function analyzeQueryDependencyDag(
	entries: readonly QueryDagEntryInput[],
	options?: {
		readonly checkUnknownRefs?: boolean | undefined;
		readonly extraKnownQueryNames?: Iterable<string> | undefined;
	},
): QueryDagAnalysis {
	const checkUnknown = options?.checkUnknownRefs ?? true;
	const entryOrder: string[] = [];
	const entryNames = new Set<string>();
	for (const entry of entries) {
		if (!entryNames.has(entry.name)) {
			entryNames.add(entry.name);
			entryOrder.push(entry.name);
		}
	}

	const knownNames = new Set<string>(entryNames);
	if (options?.extraKnownQueryNames) {
		for (const extra of options.extraKnownQueryNames) {
			knownNames.add(extra);
		}
	}

	const refsByQuery = new Map<string, QueryReferenceOccurrence[]>();
	const depsByQuery = new Map<string, string[]>();
	const unknownRefDiagnosticsByQuery = new Map<string, SearchDiagnostic[]>();
	const cycleDiagnosticsByQuery = new Map<string, SearchDiagnostic[]>();
	const blockedQueryNames = new Set<string>();

	for (const entry of entries) {
		const refs = entry.ast ? collectQueryReferences(entry.ast) : [];
		refsByQuery.set(entry.name, refs);
		const seenDeps = new Set<string>();
		const deps: string[] = [];
		for (const ref of refs) {
			if (!knownNames.has(ref.queryName)) {
				if (checkUnknown) {
					const others = [...knownNames].filter((n) => n !== entry.name);
					const list = unknownRefDiagnosticsByQuery.get(entry.name) ?? [];
					list.push({
						code: 'ERROR_UNKNOWN_QUERY_REF',
						severity: 'error',
						issue: `Unknown query reference "@query.${ref.queryName}".`,
						hint: suggestQueryNameHint(ref.queryName, others),
						span: ref.span,
					});
					unknownRefDiagnosticsByQuery.set(entry.name, list);
					blockedQueryNames.add(entry.name);
				}
				continue;
			}
			if (entryNames.has(ref.queryName) && !seenDeps.has(ref.queryName)) {
				seenDeps.add(ref.queryName);
				deps.push(ref.queryName);
			}
		}
		depsByQuery.set(entry.name, deps);
	}

	// Find exact cycle trace from `start` if `start` can reach a cycle (or itself).
	function findCycleChainFrom(start: string): string[] | null {
		const path: string[] = [];
		const indexInPath = new Map<string, number>();
		const visitedClean = new Set<string>();

		function dfs(curr: string): string[] | null {
			const existingIdx = indexInPath.get(curr);
			if (existingIdx !== undefined) {
				return [...path, curr];
			}
			if (visitedClean.has(curr)) {
				return null;
			}
			indexInPath.set(curr, path.length);
			path.push(curr);
			for (const dep of depsByQuery.get(curr) ?? []) {
				const found = dfs(dep);
				if (found !== null) {
					return found;
				}
			}
			path.pop();
			indexInPath.delete(curr);
			visitedClean.add(curr);
			return null;
		}

		return dfs(start);
	}

	for (const name of entryOrder) {
		const chain = findCycleChainFrom(name);
		if (chain !== null) {
			blockedQueryNames.add(name);
			const nextDep = chain[1];
			const refs = refsByQuery.get(name) ?? [];
			const matchingRef = refs.find((r) => r.queryName === nextDep) ?? refs[0];
			const cycleStartIdx = chain.indexOf(chain[chain.length - 1]!);
			const pureCycle = chain.slice(cycleStartIdx);
			const displayChain = chain.join(' -> ');
			const pureCycleDisplay = pureCycle.join(' -> ');
			const list = cycleDiagnosticsByQuery.get(name) ?? [];
			list.push({
				code: 'ERROR_CIRCULAR_QUERY_REF',
				severity: 'error',
				issue: `Circular @query reference detected: ${displayChain}.`,
				hint: `Break the "${pureCycleDisplay}" dependency cycle between your "{% query %}" blocks.`,
				span: matchingRef?.span ?? null,
			});
			cycleDiagnosticsByQuery.set(name, list);
		}
	}

	// Propagate blocked status to downstream queries that depend on a blocked query.
	let changed = true;
	while (changed) {
		changed = false;
		for (const name of entryOrder) {
			if (blockedQueryNames.has(name)) continue;
			const deps = depsByQuery.get(name) ?? [];
			if (deps.some((d) => blockedQueryNames.has(d))) {
				blockedQueryNames.add(name);
				changed = true;
			}
		}
	}

	// Partition unblocked queries into topological waves preserving declaration order.
	const remaining = entryOrder.filter((name) => !blockedQueryNames.has(name));
	const scheduled = new Set<string>();
	const waves: string[][] = [];
	while (remaining.length > scheduled.size) {
		const wave: string[] = [];
		for (const name of remaining) {
			if (scheduled.has(name)) continue;
			const deps = depsByQuery.get(name) ?? [];
			if (deps.every((d) => !entryNames.has(d) || scheduled.has(d))) {
				wave.push(name);
			}
		}
		if (wave.length === 0) {
			break;
		}
		for (const name of wave) {
			scheduled.add(name);
		}
		waves.push(wave);
	}

	return {
		waves,
		unknownRefDiagnosticsByQuery,
		cycleDiagnosticsByQuery,
		blockedQueryNames,
	};
}
