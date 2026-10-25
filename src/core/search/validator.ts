import { containsRegexLeaf } from './ast-utils';
import { validateRegexLiteral } from './literals';
import { resolveQueryPropertyType, STRICT_NUMBER_RE } from './property-coercion';
import { parseTemporalExpr } from './temporal';
import type {
	LeafMatcher,
	ObsidianPropertyType,
	PropertyFilterNode,
	ResolvedEngineConfig,
	SearchAST,
	SearchDiagnostic,
	SourceSpan,
	ValueExprAST,
} from './types';

export interface ValidationResult {
	readonly diagnostics: SearchDiagnostic[];
	readonly invalidPropertyNodes: ReadonlySet<PropertyFilterNode>;
}

/**
 * Computes the Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
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
			const del = prev[j]! + 1;
			const ins = curr[j - 1]! + 1;
			const sub = prev[j - 1]! + cost;
			curr[j] = Math.min(del, ins, sub);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return prev[n]!;
}

/**
 * Suggests a closest registered scope or `[prop:]` hint for an unknown scope name.
 */
export function suggestScopeHint(
	rawScope: string,
	resolvedConfig: ResolvedEngineConfig,
): string | null {
	const lower = rawScope.trim().toLowerCase();
	if (lower === 'tags') {
		return 'Did you mean "tag:"?';
	}
	if (lower === 'prop' || lower === 'property' || lower === 'properties') {
		return 'Use "[prop:]" for property filters.';
	}

	let bestMatch: string | null = null;
	let bestDist = 3;
	for (const candidate of resolvedConfig.getAllScopeNames()) {
		const dist = levenshteinDistance(lower, candidate.toLowerCase());
		if (dist <= 2 && dist < bestDist) {
			bestDist = dist;
			bestMatch = candidate;
		}
	}
	return bestMatch !== null ? `Did you mean "${bestMatch}:"?` : null;
}

function collectValueExprLeaves(
	expr: ValueExprAST,
	out: LeafMatcher[] = [],
): readonly LeafMatcher[] {
	switch (expr.type) {
		case 'VALUE_LEAF':
			out.push(expr.matcher);
			return out;
		case 'VALUE_NOT':
			return collectValueExprLeaves(expr.child, out);
		case 'VALUE_LOGICAL':
			for (const child of expr.children) {
				collectValueExprLeaves(child, out);
			}
			return out;
	}
}

function validateRegexLeavesInValueExpr(
	expr: ValueExprAST,
	span: SourceSpan | null,
	diagnostics: SearchDiagnostic[],
): boolean {
	let hadInvalidRegex = false;
	for (const matcher of collectValueExprLeaves(expr)) {
		if (matcher.kind === 'regex') {
			if (validateRegexLiteral(matcher.pattern, matcher.flags) === null) {
				hadInvalidRegex = true;
				diagnostics.push({
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: `Invalid regular expression "/${matcher.pattern}/${matcher.flags}".`,
					hint: null,
					span,
				});
			}
		}
	}
	return hadInvalidRegex;
}

function validateComparisonLeaf(
	leaf: Extract<LeafMatcher, { kind: 'string' }>,
	propType: ObsidianPropertyType,
	node: PropertyFilterNode,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
	diagnostics: SearchDiagnostic[],
): boolean {
	const span = node.span ?? null;
	switch (propType) {
		case 'checkbox': {
			const lower = leaf.value.trim().toLowerCase();
			if (leaf.quoted || (lower !== 'true' && lower !== 'false')) {
				diagnostics.push({
					code: 'ERROR_TYPE_MISMATCH',
					severity: 'error',
					issue: `"${leaf.value}" is not a valid ${propType} for property "${node.key}".`,
					hint: null,
					span,
				});
				return false;
			}
			return true;
		}
		case 'number': {
			const trimmed = leaf.value.trim();
			if (
				leaf.quoted ||
				!STRICT_NUMBER_RE.test(trimmed) ||
				!Number.isFinite(Number(trimmed))
			) {
				diagnostics.push({
					code: 'ERROR_TYPE_MISMATCH',
					severity: 'error',
					issue: `"${leaf.value}" is not a valid ${propType} for property "${node.key}".`,
					hint: null,
					span,
				});
				return false;
			}
			return true;
		}
		case 'date':
		case 'datetime': {
			const res = parseTemporalExpr(leaf.value, {
				allowYearOnly: true,
				allowRelative: true,
				timeZone: resolvedConfig.timeZone,
				referenceTimeMs,
			});
			if (!res.ok) {
				if (res.reason === 'REVERSED_RANGE') {
					diagnostics.push({
						code: 'SYNTAX_ERROR',
						severity: 'error',
						issue: `The left endpoint '${res.leftRaw}' starts on or after the exclusive end contributed by the right endpoint '${res.rightRaw}'.`,
						hint: res.hint,
						span,
					});
				} else {
					diagnostics.push({
						code: 'ERROR_TYPE_MISMATCH',
						severity: 'error',
						issue: `"${leaf.value}" is not a valid ${propType} for property "${node.key}".`,
						hint: null,
						span,
					});
				}
				return false;
			}
			return true;
		}
		case 'text':
		case 'multitext':
		case 'tags':
			return true;
	}
}

/**
 * Executes semantic validation Steps 2, 3, and 4 on `ast` with short-circuit precedence.
 */
export function validateQueryAST(
	ast: SearchAST,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
): ValidationResult {
	const diagnostics: SearchDiagnostic[] = [];
	const invalidRegexPropNodes = new Set<PropertyFilterNode>();
	const invalidPropertyNodes = new Set<PropertyFilterNode>();

	// Step 2: Validate every RegexLiteral leaf first (short-circuiting Step 4 on invalid regex in PropertyFilterNode)
	function step2Traverse(node: SearchAST): void {
		switch (node.type) {
			case 'MATCH_ALL':
				return;
			case 'TEXT_MATCH':
				if (node.matcher.kind === 'regex') {
					if (validateRegexLiteral(node.matcher.pattern, node.matcher.flags) === null) {
						diagnostics.push({
							code: 'SYNTAX_ERROR',
							severity: 'error',
							issue: `Invalid regular expression "/${node.matcher.pattern}/${node.matcher.flags}".`,
							hint: null,
							span: node.span ?? null,
						});
					}
				}
				return;
			case 'SCOPED_FILTER':
				validateRegexLeavesInValueExpr(node.expr, node.span ?? null, diagnostics);
				return;
			case 'PROPERTY_FILTER':
				if (node.valueExpr) {
					const hadInvalid = validateRegexLeavesInValueExpr(
						node.valueExpr,
						node.span ?? null,
						diagnostics,
					);
					if (hadInvalid) {
						invalidRegexPropNodes.add(node);
						invalidPropertyNodes.add(node);
					}
				}
				return;
			case 'NOT':
				step2Traverse(node.child);
				return;
			case 'LOGICAL':
				for (const child of node.children) step2Traverse(child);
				return;
		}
	}

	// Step 3: Validate scopes
	function step3Traverse(node: SearchAST): void {
		switch (node.type) {
			case 'SCOPED_FILTER': {
				if (node.rawScope !== '#') {
					const scopeDef = resolvedConfig.getScope(node.rawScope);
					if (!scopeDef) {
						diagnostics.push({
							code: 'ERROR_UNKNOWN_SCOPE',
							severity: 'error',
							issue: `Unknown search scope "${node.rawScope}:".`,
							hint: suggestScopeHint(node.rawScope, resolvedConfig),
							span: node.span ?? null,
						});
					}
				}
				return;
			}
			case 'NOT':
				step3Traverse(node.child);
				return;
			case 'LOGICAL':
				for (const child of node.children) step3Traverse(child);
				return;
			default:
				return;
		}
	}

	// Step 4: Validate property filters (with short-circuit precedence)
	function step4Traverse(node: SearchAST): void {
		switch (node.type) {
			case 'PROPERTY_FILTER': {
				if (invalidRegexPropNodes.has(node)) return;
				if (node.operator === 'EXISTS' || !node.valueExpr) return;

				const propType = resolveQueryPropertyType(node.key, resolvedConfig.propertyTypes);
				const hasRegex = containsRegexLeaf(node.valueExpr);

				// Step 4a: Operator / matcher kind compatibility first
				if (node.operator !== ':' && hasRegex) {
					invalidPropertyNodes.add(node);
					diagnostics.push({
						code: 'ERROR_INVALID_OPERATOR_FOR_TYPE',
						severity: 'error',
						issue: `Operator "${node.operator}" cannot be used with ${propType}/regex.`,
						hint: null,
						span: node.span ?? null,
					});
					return;
				}

				const isOrderingOp =
					node.operator === '<' ||
					node.operator === '>' ||
					node.operator === '<=' ||
					node.operator === '>=';
				if (
					propType === 'checkbox' &&
					(isOrderingOp || (node.operator === ':' && hasRegex))
				) {
					invalidPropertyNodes.add(node);
					diagnostics.push({
						code: 'ERROR_INVALID_OPERATOR_FOR_TYPE',
						severity: 'error',
						issue: `Operator "${node.operator}" cannot be used with ${propType}/regex.`,
						hint: null,
						span: node.span ?? null,
					});
					return;
				}

				// Step 4b: Leaf literal value validation for =, !=, <, >, <=, >=
				if (node.operator !== ':') {
					for (const matcher of collectValueExprLeaves(node.valueExpr)) {
						if (matcher.kind === 'string') {
							const valid = validateComparisonLeaf(
								matcher,
								propType,
								node,
								resolvedConfig,
								referenceTimeMs,
								diagnostics,
							);
							if (!valid) {
								invalidPropertyNodes.add(node);
							}
						}
					}
				}
				return;
			}
			case 'NOT':
				step4Traverse(node.child);
				return;
			case 'LOGICAL':
				for (const child of node.children) step4Traverse(child);
				return;
			default:
				return;
		}
	}

	step2Traverse(ast);
	step3Traverse(ast);
	step4Traverse(ast);

	return { diagnostics, invalidPropertyNodes };
}
