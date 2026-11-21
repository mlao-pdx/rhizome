import {
	getExecutionPlan,
	type CompiledGraphFilterNode,
	type CompiledPropertyColonNode,
	type CompiledPropertyComparison,
	type CompiledSearchNode,
	type CompiledValueExprNode,
} from './execution-plan';
import {
	coerceQueryScalarsForProperty,
	computeReachablePaths,
	createGraphEvaluationContext,
	type GraphEvaluationContext,
	resolveQueryScalarValues,
	VaultGraphSnapshot,
} from './graph-evaluator';
import { getTypedPropertyEntries, hasPropertyOccurrence } from './oracle';
import {
	normalizeScopeComparisonOperands,
	scopeTargetsMatchComparison,
	substringStringMatch,
} from './scopes';
import { compareDateIntervals } from './temporal';
import type {
	DocumentDiagnostic,
	DocumentEvaluationContext,
	NormalizedDocument,
	PreparedQuery,
	ScopeDefinition,
	TypedPropertyValue,
	VaultEvaluationReport,
} from './types';

function resolveGraphCtx(
	ctx: DocumentEvaluationContext | undefined,
): GraphEvaluationContext | undefined {
	return ctx?.graphContext as GraphEvaluationContext | undefined;
}

function getOrBuildQueryStrings(
	leafNode: Extract<CompiledValueExprNode, { readonly type: 'VALUE_LEAF_QUERY' }>,
	graphCtx: GraphEvaluationContext | undefined,
): readonly string[] {
	if (!graphCtx) return [];
	const cached = graphCtx.queryScalarCache.get(leafNode) as readonly string[] | undefined;
	if (cached !== undefined) return cached;
	const scalars = resolveQueryScalarValues(
		graphCtx.priorQueryDocs?.get(leafNode.queryName),
		leafNode.segments,
		graphCtx.getBacklinksForDoc,
	);
	const strs = scalars.map(String);
	graphCtx.queryScalarCache.set(leafNode, strs);
	return strs;
}

function evalCompiledValueExpr(
	target: string,
	expr: CompiledValueExprNode,
	scopeDef: Pick<ScopeDefinition, 'matchString'>,
	graphCtx?: GraphEvaluationContext,
): boolean {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return expr.operator === 'AND'
				? expr.children.every((c) => evalCompiledValueExpr(target, c, scopeDef, graphCtx))
				: expr.children.some((c) => evalCompiledValueExpr(target, c, scopeDef, graphCtx));
		case 'VALUE_NOT':
			return !evalCompiledValueExpr(target, expr.child, scopeDef, graphCtx);
		case 'VALUE_LEAF_REGEX':
			return expr.regex.test(target);
		case 'VALUE_LEAF_STRING':
			return scopeDef.matchString(target, expr.value, expr.quoted);
		case 'VALUE_LEAF_QUERY': {
			const vals = getOrBuildQueryStrings(expr, graphCtx);
			return vals.some((v) => scopeDef.matchString(target, v, true));
		}
	}
}

function getOrBuildColonQueryNodes(
	leafNode: Extract<CompiledPropertyColonNode, { readonly type: 'COLON_QUERY' }>,
	graphCtx: GraphEvaluationContext | undefined,
): readonly CompiledPropertyColonNode[] {
	if (!graphCtx) return [];
	const cached = graphCtx.queryScalarCache.get(leafNode) as
		readonly CompiledPropertyColonNode[] | undefined;
	if (cached !== undefined) return cached;
	const scalars = resolveQueryScalarValues(
		graphCtx.priorQueryDocs?.get(leafNode.queryName),
		leafNode.segments,
		graphCtx.getBacklinksForDoc,
	);
	const coerced = coerceQueryScalarsForProperty(
		scalars,
		leafNode.propType,
		leafNode.timeZone,
		leafNode.referenceTimeMs,
	);
	const nodes: CompiledPropertyColonNode[] = coerced.map((c) => {
		switch (c.kind) {
			case 'number':
				return { type: 'COLON_NUMBER', rhsNum: c.rhsNum };
			case 'checkbox':
				return { type: 'COLON_CHECKBOX', rhsBool: c.rhsBool };
			case 'temporal':
				return { type: 'COLON_TEMPORAL', rhsInterval: c.rhsInterval };
			case 'text':
				return { type: 'COLON_TEXT', value: c.rhsRaw, quoted: true };
		}
	});
	graphCtx.queryScalarCache.set(leafNode, nodes);
	return nodes;
}

function evalCompiledColonExpr(
	entry: Exclude<TypedPropertyValue, { kind: 'null' } | { kind: 'invalid' }>,
	expr: CompiledPropertyColonNode,
	graphCtx?: GraphEvaluationContext,
): boolean {
	switch (expr.type) {
		case 'COLON_LOGICAL':
			return expr.operator === 'AND'
				? expr.children.every((c) => evalCompiledColonExpr(entry, c, graphCtx))
				: expr.children.some((c) => evalCompiledColonExpr(entry, c, graphCtx));
		case 'COLON_NOT':
			return !evalCompiledColonExpr(entry, expr.child, graphCtx);
		case 'COLON_REGEX': {
			if (expr.propType === 'checkbox' || entry.kind === 'checkbox') return false;
			const target = entry.kind === 'text' ? entry.value : entry.raw;
			return expr.regex.test(target);
		}
		case 'COLON_NUMBER':
			return entry.kind === 'number' && entry.value === expr.rhsNum;
		case 'COLON_CHECKBOX':
			return entry.kind === 'checkbox' && entry.value === expr.rhsBool;
		case 'COLON_TEMPORAL':
			return (
				(entry.kind === 'date' || entry.kind === 'datetime') &&
				compareDateIntervals(entry.interval, '=', expr.rhsInterval)
			);
		case 'COLON_TEXT':
			return entry.kind === 'text' && substringStringMatch(entry.value, expr.value);
		case 'COLON_QUERY': {
			const subNodes = getOrBuildColonQueryNodes(expr, graphCtx);
			return subNodes.some((n) => evalCompiledColonExpr(entry, n, graphCtx));
		}
	}
}

function evalCompiledComparisonOnEntry(
	entry: TypedPropertyValue,
	comparison: CompiledPropertyComparison,
): boolean {
	if (entry.kind === 'null' || entry.kind === 'invalid') return false;

	switch (comparison.kind) {
		case 'number': {
			if (entry.kind !== 'number') return false;
			const { operator: op, rhsNum } = comparison;
			switch (op) {
				case '=':
					return entry.value === rhsNum;
				case '!=':
					return entry.value !== rhsNum;
				case '<':
					return entry.value < rhsNum;
				case '>':
					return entry.value > rhsNum;
				case '<=':
					return entry.value <= rhsNum;
				case '>=':
					return entry.value >= rhsNum;
				default:
					return false;
			}
		}
		case 'checkbox': {
			if (entry.kind !== 'checkbox') return false;
			const { operator: op, rhsBool } = comparison;
			if (op === '=') return entry.value === rhsBool;
			if (op === '!=') return entry.value !== rhsBool;
			return false;
		}
		case 'temporal': {
			if (entry.kind !== 'date' && entry.kind !== 'datetime') return false;
			return compareDateIntervals(
				entry.interval,
				comparison.operator,
				comparison.rhsInterval,
			);
		}
		case 'text': {
			if (entry.kind !== 'text') return false;
			const a = entry.value.toLowerCase();
			const b = comparison.rhsLower;
			switch (comparison.operator) {
				case '=':
					return a === b;
				case '!=':
					return a !== b;
				case '<':
					return a < b;
				case '>':
					return a > b;
				case '<=':
					return a <= b;
				case '>=':
					return a >= b;
				default:
					return false;
			}
		}
	}
}

function evaluateGraphFilterMatchedSet(
	node: CompiledGraphFilterNode,
	graphCtx: GraphEvaluationContext,
): ReadonlySet<string> {
	const cached = graphCtx.graphNodeCache.get(node);
	if (cached !== undefined) {
		return cached;
	}

	const { graph } = graphCtx;
	const targetIndices: number[] = [];

	switch (node.target.kind) {
		case 'this_ref': {
			if (node.target.hostPath !== null) {
				const idx = graph.docIndexByPath.get(node.target.hostPath);
				if (idx !== undefined) {
					targetIndices.push(idx);
				}
			}
			break;
		}
		case 'query_ref': {
			const qDocs = graphCtx.priorQueryDocs?.get(node.target.queryName);
			if (qDocs) {
				for (let i = 0; i < qDocs.length; i++) {
					const idx = graph.docIndexByPath.get(qDocs[i]!.file.path);
					if (idx !== undefined) {
						targetIndices.push(idx);
					}
				}
			}
			break;
		}
		case 'subquery': {
			const docs = graph.docsByIndex;
			for (let i = 0; i < docs.length; i++) {
				const subDoc = docs[i]!;
				const subCtx: DocumentEvaluationContext = {
					backlinks: () =>
						graphCtx.getBacklinksForDoc
							? graphCtx.getBacklinksForDoc(subDoc)
							: (subDoc.backlinks ?? []),
					graphContext: graphCtx,
				};
				if (evalCompiledSearchNode(subDoc, node.target.subRoot, subCtx)) {
					targetIndices.push(i);
				}
			}
			break;
		}
	}

	const adjacency =
		node.edge.kind === 'scope'
			? graph.getScopeAdjacency(node.edge.scope, node.direction)
			: graph.getPropertyAdjacency(node.edge.lowerKey, node.direction);

	const matchedPaths = computeReachablePaths(graph, adjacency, node.hops, targetIndices);
	graphCtx.graphNodeCache.set(node, matchedPaths);
	return matchedPaths;
}

function evalCompiledSearchNode(
	doc: NormalizedDocument,
	node: CompiledSearchNode,
	ctx?: DocumentEvaluationContext,
): boolean {
	switch (node.type) {
		case 'MATCH_ALL':
			return true;
		case 'LOGICAL':
			return node.operator === 'AND'
				? node.children.every((c) => evalCompiledSearchNode(doc, c, ctx))
				: node.children.some((c) => evalCompiledSearchNode(doc, c, ctx));
		case 'NOT':
			return !evalCompiledSearchNode(doc, node.child, ctx);
		case 'SCOPED_FILTER': {
			const targets = node.scopeDef.extract(doc, ctx);
			const graphCtx = resolveGraphCtx(ctx);
			return targets.some((t) =>
				evalCompiledValueExpr(t, node.expr, node.scopeDef, graphCtx),
			);
		}
		case 'SCOPED_COMPARE': {
			const targets = node.scopeDef.extract(doc, ctx);
			return scopeTargetsMatchComparison(
				node.scopeDef.canonicalName,
				targets,
				node.operator,
				node.normalizedRhsValues,
			);
		}
		case 'SCOPED_COMPARE_QUERY': {
			const graphCtx = resolveGraphCtx(ctx);
			if (!graphCtx) return false;
			let normRhs = graphCtx.queryScalarCache.get(node) as readonly string[] | undefined;
			if (normRhs === undefined) {
				const rawVals = resolveQueryScalarValues(
					graphCtx.priorQueryDocs?.get(node.queryName),
					node.segments,
					graphCtx.getBacklinksForDoc,
				).map(String);
				normRhs = normalizeScopeComparisonOperands(node.scopeDef.canonicalName, rawVals);
				graphCtx.queryScalarCache.set(node, normRhs);
			}
			if (normRhs.length === 0) return false;
			const targets = node.scopeDef.extract(doc, ctx);
			return scopeTargetsMatchComparison(
				node.scopeDef.canonicalName,
				targets,
				node.operator,
				normRhs,
			);
		}
		case 'PROPERTY_EXISTS': {
			return hasPropertyOccurrence(doc, node.lowerKey);
		}
		case 'PROPERTY_EMPTY': {
			if (!hasPropertyOccurrence(doc, node.lowerKey)) return false;
			const entries = getTypedPropertyEntries(doc, node.lowerKey);
			return entries.every((e) => e.kind === 'null');
		}
		case 'PROPERTY_COLON': {
			const entries = getTypedPropertyEntries(doc, node.lowerKey);
			const graphCtx = resolveGraphCtx(ctx);
			return entries.some((entry) => {
				if (entry.kind === 'null' || entry.kind === 'invalid') return false;
				return evalCompiledColonExpr(entry, node.expr, graphCtx);
			});
		}
		case 'PROPERTY_COMPARE': {
			if (node.comparisons.length === 0) return false;
			const entries = getTypedPropertyEntries(doc, node.lowerKey);
			return entries.some((entry) =>
				node.comparisons.some((comp) => evalCompiledComparisonOnEntry(entry, comp)),
			);
		}
		case 'PROPERTY_COMPARE_QUERY': {
			const graphCtx = resolveGraphCtx(ctx);
			if (!graphCtx) return false;
			let comparisons = graphCtx.queryScalarCache.get(node) as
				readonly CompiledPropertyComparison[] | undefined;
			if (comparisons === undefined) {
				const scalars = resolveQueryScalarValues(
					graphCtx.priorQueryDocs?.get(node.queryName),
					node.segments,
					graphCtx.getBacklinksForDoc,
				);
				const coerced = coerceQueryScalarsForProperty(
					scalars,
					node.propType,
					node.timeZone,
					node.referenceTimeMs,
				);
				comparisons = coerced.map((c): CompiledPropertyComparison => {
					switch (c.kind) {
						case 'number':
							return { kind: 'number', operator: node.operator, rhsNum: c.rhsNum };
						case 'checkbox':
							return {
								kind: 'checkbox',
								operator: node.operator,
								rhsBool: c.rhsBool,
							};
						case 'temporal':
							return {
								kind: 'temporal',
								operator: node.operator,
								rhsInterval: c.rhsInterval,
							};
						case 'text':
							return { kind: 'text', operator: node.operator, rhsLower: c.rhsLower };
					}
				});
				graphCtx.queryScalarCache.set(node, comparisons);
			}
			if (comparisons.length === 0) return false;
			const entries = getTypedPropertyEntries(doc, node.lowerKey);
			return entries.some((entry) =>
				comparisons.some((comp) => evalCompiledComparisonOnEntry(entry, comp)),
			);
		}
		case 'GRAPH_FILTER': {
			let graphCtx = resolveGraphCtx(ctx);
			if (!graphCtx) {
				const fallbackDocs = preparedFallbackDocsForStandalone(doc, node);
				graphCtx = createGraphEvaluationContext(new VaultGraphSnapshot(fallbackDocs));
			}
			const matchedSet = evaluateGraphFilterMatchedSet(node, graphCtx);
			return matchedSet.has(doc.file.path);
		}
	}
}

function preparedFallbackDocsForStandalone(
	doc: NormalizedDocument,
	_node: CompiledGraphFilterNode,
): readonly NormalizedDocument[] {
	return [doc];
}

export function evaluateDoc(
	doc: NormalizedDocument,
	prepared: PreparedQuery,
	ctx?: DocumentEvaluationContext,
): boolean {
	const plan = getExecutionPlan(prepared);
	if (doc.normalizationFingerprint !== plan.expectedFingerprint) {
		throw new Error(`Document "${doc.file.path}" normalizationFingerprint mismatch.`);
	}
	if (plan.usesGraph && ctx?.graphContext === undefined) {
		const docs =
			prepared.hostDoc && prepared.hostDoc.file.path !== doc.file.path
				? [doc, prepared.hostDoc]
				: [doc];
		const graphCtx = createGraphEvaluationContext(new VaultGraphSnapshot(docs));
		const mergedCtx: DocumentEvaluationContext = {
			backlinks: ctx ? ctx.backlinks : () => doc.backlinks ?? [],
			graphContext: graphCtx,
		};
		return evalCompiledSearchNode(doc, plan.root, mergedCtx);
	}
	return evalCompiledSearchNode(doc, plan.root, ctx);
}

export function evaluateVault(
	docs: readonly NormalizedDocument[],
	prepared: PreparedQuery,
	priorQueryDocs?: ReadonlyMap<string, readonly NormalizedDocument[]>,
): VaultEvaluationReport {
	const plan = getExecutionPlan(prepared);
	const { expectedFingerprint, queriedKeys, root, usesGraph } = plan;
	const matches: NormalizedDocument[] = [];
	const propertyDiagnostics: DocumentDiagnostic[] = [];

	for (const doc of docs) {
		if (doc.normalizationFingerprint !== expectedFingerprint) {
			throw new Error(
				`Document "${doc.file.path}" normalizationFingerprint mismatch: expected ${expectedFingerprint}, got ${doc.normalizationFingerprint}`,
			);
		}
	}

	const graphCtx = usesGraph
		? createGraphEvaluationContext(new VaultGraphSnapshot(docs), priorQueryDocs)
		: undefined;

	for (const doc of docs) {
		const ctx: DocumentEvaluationContext | undefined = graphCtx
			? {
					backlinks: () => doc.backlinks ?? [],
					graphContext: graphCtx,
				}
			: undefined;
		if (evalCompiledSearchNode(doc, root, ctx)) {
			matches.push(doc);
		}
		if (queriedKeys.size > 0 && doc.diagnostics.length > 0) {
			for (const diag of doc.diagnostics) {
				if (queriedKeys.has(diag.propertyKey)) {
					propertyDiagnostics.push(diag);
				}
			}
		}
	}

	return { matches, propertyDiagnostics };
}
