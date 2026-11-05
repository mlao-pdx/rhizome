import { collectReferencedPropertyKeys } from './ast-utils';
import { coerceHostScalarForProperty, resolveThisReference } from './host-reference';
import { validateRegexLiteral } from './literals';
import { resolveQueryPropertyType, STRICT_NUMBER_RE } from './property-coercion';
import { normalizeScopeComparisonOperands } from './scopes';
import { parseTemporalExpr } from './temporal';
import type {
	DateInterval,
	NormalizedDocument,
	ObsidianPropertyType,
	PreparedQuery,
	PropertyOperator,
	ResolvedEngineConfig,
	ScopeDefinition,
	ScopeOperator,
	SearchAST,
	ValueExprAST,
} from './types';

export type CompiledValueExprNode =
	| {
			readonly type: 'VALUE_LOGICAL';
			readonly operator: 'AND' | 'OR';
			readonly children: readonly CompiledValueExprNode[];
	  }
	| { readonly type: 'VALUE_NOT'; readonly child: CompiledValueExprNode }
	| { readonly type: 'VALUE_LEAF_REGEX'; readonly regex: RegExp }
	| { readonly type: 'VALUE_LEAF_STRING'; readonly value: string; readonly quoted: boolean };

export type CompiledPropertyColonNode =
	| {
			readonly type: 'COLON_LOGICAL';
			readonly operator: 'AND' | 'OR';
			readonly children: readonly CompiledPropertyColonNode[];
	  }
	| { readonly type: 'COLON_NOT'; readonly child: CompiledPropertyColonNode }
	| {
			readonly type: 'COLON_REGEX';
			readonly propType: ObsidianPropertyType;
			readonly regex: RegExp;
	  }
	| { readonly type: 'COLON_NUMBER'; readonly rhsNum: number }
	| { readonly type: 'COLON_CHECKBOX'; readonly rhsBool: boolean }
	| { readonly type: 'COLON_TEMPORAL'; readonly rhsInterval: DateInterval }
	| { readonly type: 'COLON_TEXT'; readonly value: string; readonly quoted: boolean };

export type CompiledPropertyComparison =
	| { readonly kind: 'number'; readonly operator: PropertyOperator; readonly rhsNum: number }
	| { readonly kind: 'checkbox'; readonly operator: PropertyOperator; readonly rhsBool: boolean }
	| {
			readonly kind: 'temporal';
			readonly operator: PropertyOperator;
			readonly rhsInterval: DateInterval;
	  }
	| { readonly kind: 'text'; readonly operator: PropertyOperator; readonly rhsLower: string };

export type CompiledSearchNode =
	| { readonly type: 'MATCH_ALL' }
	| {
			readonly type: 'LOGICAL';
			readonly operator: 'AND' | 'OR';
			readonly children: readonly CompiledSearchNode[];
	  }
	| { readonly type: 'NOT'; readonly child: CompiledSearchNode }
	| {
			readonly type: 'SCOPED_FILTER';
			readonly scopeDef: ScopeDefinition;
			readonly expr: CompiledValueExprNode;
	  }
	| {
			readonly type: 'SCOPED_COMPARE';
			readonly scopeDef: ScopeDefinition;
			readonly operator: Exclude<ScopeOperator, ':'>;
			readonly normalizedRhsValues: readonly string[];
	  }
	| { readonly type: 'PROPERTY_EXISTS'; readonly lowerKey: string }
	| { readonly type: 'PROPERTY_EMPTY'; readonly lowerKey: string }
	| {
			readonly type: 'PROPERTY_COLON';
			readonly lowerKey: string;
			readonly propType: ObsidianPropertyType;
			readonly expr: CompiledPropertyColonNode;
	  }
	| {
			readonly type: 'PROPERTY_COMPARE';
			readonly lowerKey: string;
			readonly comparisons: readonly CompiledPropertyComparison[];
	  };

export interface ExecutionPlan {
	readonly root: CompiledSearchNode;
	readonly queriedKeys: ReadonlySet<string>;
	readonly expectedFingerprint: string;
}

const EXECUTION_PLAN_CACHE = new WeakMap<PreparedQuery, ExecutionPlan>();

function compileRegexOrThrow(pattern: string, flags: string): RegExp {
	const rx = validateRegexLiteral(pattern, flags);
	if (!rx) throw new Error(`Invalid regex literal in AST: /${pattern}/${flags}`);
	return rx;
}

function compileValueExpr(
	expr: ValueExprAST,
	hostDoc: NormalizedDocument | null | undefined,
): CompiledValueExprNode {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return {
				type: 'VALUE_LOGICAL',
				operator: expr.operator,
				children: expr.children.map((c) => compileValueExpr(c, hostDoc)),
			};
		case 'VALUE_NOT':
			return {
				type: 'VALUE_NOT',
				child: compileValueExpr(expr.child, hostDoc),
			};
		case 'VALUE_LEAF': {
			if (expr.matcher.kind === 'regex') {
				return {
					type: 'VALUE_LEAF_REGEX',
					regex: compileRegexOrThrow(expr.matcher.pattern, expr.matcher.flags),
				};
			}
			if (expr.matcher.kind === 'this') {
				const res = resolveThisReference(hostDoc, expr.matcher.segments);
				return {
					type: 'VALUE_LOGICAL',
					operator: 'OR',
					children: res.values.map((v) => ({
						type: 'VALUE_LEAF_STRING',
						value: String(v),
						quoted: true,
					})),
				};
			}
			return {
				type: 'VALUE_LEAF_STRING',
				value: expr.matcher.value,
				quoted: expr.matcher.quoted,
			};
		}
	}
}

function compilePropertyColonExpr(
	expr: ValueExprAST,
	propType: ObsidianPropertyType,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
	hostDoc: NormalizedDocument | null | undefined,
): CompiledPropertyColonNode {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return {
				type: 'COLON_LOGICAL',
				operator: expr.operator,
				children: expr.children.map((c) =>
					compilePropertyColonExpr(c, propType, resolvedConfig, referenceTimeMs, hostDoc),
				),
			};
		case 'VALUE_NOT':
			return {
				type: 'COLON_NOT',
				child: compilePropertyColonExpr(
					expr.child,
					propType,
					resolvedConfig,
					referenceTimeMs,
					hostDoc,
				),
			};
		case 'VALUE_LEAF': {
			if (expr.matcher.kind === 'regex') {
				return {
					type: 'COLON_REGEX',
					propType,
					regex: compileRegexOrThrow(expr.matcher.pattern, expr.matcher.flags),
				};
			}
			if (expr.matcher.kind === 'this') {
				const res = resolveThisReference(hostDoc, expr.matcher.segments);
				const children: CompiledPropertyColonNode[] = [];
				for (const val of res.values) {
					const coerced = coerceHostScalarForProperty(
						val,
						propType,
						resolvedConfig.timeZone,
						referenceTimeMs,
					);
					if (!coerced.ok) continue;
					switch (coerced.kind) {
						case 'number':
							children.push({ type: 'COLON_NUMBER', rhsNum: coerced.rhsNum });
							break;
						case 'checkbox':
							children.push({ type: 'COLON_CHECKBOX', rhsBool: coerced.rhsBool });
							break;
						case 'temporal':
							children.push({
								type: 'COLON_TEMPORAL',
								rhsInterval: coerced.rhsInterval,
							});
							break;
						case 'text':
							children.push({
								type: 'COLON_TEXT',
								value: coerced.rhsRaw,
								quoted: true,
							});
							break;
					}
				}
				return {
					type: 'COLON_LOGICAL',
					operator: 'OR',
					children,
				};
			}
			const { value: rhsRaw, quoted } = expr.matcher;
			switch (propType) {
				case 'number': {
					const trimmed = rhsRaw.trim();
					const rhsNum = Number(trimmed);
					if (quoted || !STRICT_NUMBER_RE.test(trimmed) || !Number.isFinite(rhsNum)) {
						throw new Error(
							`Unvalidated number literal reached execution plan: ${rhsRaw}`,
						);
					}
					return { type: 'COLON_NUMBER', rhsNum };
				}
				case 'checkbox': {
					const lower = rhsRaw.trim().toLowerCase();
					if (quoted || (lower !== 'true' && lower !== 'false')) {
						throw new Error(
							`Unvalidated checkbox literal reached execution plan: ${rhsRaw}`,
						);
					}
					return { type: 'COLON_CHECKBOX', rhsBool: lower === 'true' };
				}
				case 'date':
				case 'datetime': {
					const res = parseTemporalExpr(rhsRaw, {
						allowYearOnly: true,
						allowRelative: true,
						timeZone: resolvedConfig.timeZone,
						referenceTimeMs,
					});
					if (!res.ok) {
						throw new Error(
							`Unvalidated temporal literal reached execution plan: ${rhsRaw}`,
						);
					}
					return { type: 'COLON_TEMPORAL', rhsInterval: res.interval };
				}
				case 'text':
				case 'multitext':
					return { type: 'COLON_TEXT', value: rhsRaw, quoted };
			}
		}
	}
}

function compilePropertyComparisons(
	lowerKey: string,
	propType: ObsidianPropertyType,
	operator: PropertyOperator,
	valueExpr: ValueExprAST | undefined,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
	hostDoc: NormalizedDocument | null | undefined,
): readonly CompiledPropertyComparison[] {
	if (!valueExpr || valueExpr.type !== 'VALUE_LEAF' || valueExpr.matcher.kind === 'regex') {
		throw new Error(`Invalid comparison expression for property "${lowerKey}".`);
	}
	if (valueExpr.matcher.kind === 'this') {
		const res = resolveThisReference(hostDoc, valueExpr.matcher.segments);
		const comparisons: CompiledPropertyComparison[] = [];
		for (const val of res.values) {
			const coerced = coerceHostScalarForProperty(
				val,
				propType,
				resolvedConfig.timeZone,
				referenceTimeMs,
			);
			if (!coerced.ok) continue;
			switch (coerced.kind) {
				case 'number':
					comparisons.push({ kind: 'number', operator, rhsNum: coerced.rhsNum });
					break;
				case 'checkbox':
					comparisons.push({ kind: 'checkbox', operator, rhsBool: coerced.rhsBool });
					break;
				case 'temporal':
					comparisons.push({
						kind: 'temporal',
						operator,
						rhsInterval: coerced.rhsInterval,
					});
					break;
				case 'text':
					comparisons.push({ kind: 'text', operator, rhsLower: coerced.rhsLower });
					break;
			}
		}
		return comparisons;
	}
	const { value: rhsRaw, quoted } = valueExpr.matcher;

	switch (propType) {
		case 'number': {
			const trimmed = rhsRaw.trim();
			const rhsNum = Number(trimmed);
			if (quoted || !STRICT_NUMBER_RE.test(trimmed) || !Number.isFinite(rhsNum)) {
				throw new Error(`Unvalidated number literal reached execution plan: ${rhsRaw}`);
			}
			return [{ kind: 'number', operator, rhsNum }];
		}
		case 'checkbox': {
			const lower = rhsRaw.trim().toLowerCase();
			if (quoted || (lower !== 'true' && lower !== 'false')) {
				throw new Error(`Unvalidated checkbox literal reached execution plan: ${rhsRaw}`);
			}
			return [{ kind: 'checkbox', operator, rhsBool: lower === 'true' }];
		}
		case 'date':
		case 'datetime': {
			const res = parseTemporalExpr(rhsRaw, {
				allowYearOnly: true,
				allowRelative: true,
				timeZone: resolvedConfig.timeZone,
				referenceTimeMs,
			});
			if (!res.ok) {
				throw new Error(`Unvalidated temporal literal reached execution plan: ${rhsRaw}`);
			}
			return [{ kind: 'temporal', operator, rhsInterval: res.interval }];
		}
		case 'text':
		case 'multitext':
			return [{ kind: 'text', operator, rhsLower: rhsRaw.toLowerCase() }];
	}
}

function compileSearchNode(
	ast: SearchAST,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
	hostDoc: NormalizedDocument | null | undefined,
): CompiledSearchNode {
	switch (ast.type) {
		case 'MATCH_ALL':
			return { type: 'MATCH_ALL' };
		case 'LOGICAL':
			return {
				type: 'LOGICAL',
				operator: ast.operator,
				children: ast.children.map((c) =>
					compileSearchNode(c, resolvedConfig, referenceTimeMs, hostDoc),
				),
			};
		case 'NOT':
			return {
				type: 'NOT',
				child: compileSearchNode(ast.child, resolvedConfig, referenceTimeMs, hostDoc),
			};
		case 'SCOPED_FILTER': {
			const scopeDef =
				ast.rawScope === '#'
					? resolvedConfig.getScope('tag')
					: resolvedConfig.getScope(ast.scope);
			if (!scopeDef) throw new Error(`Unresolved scope in AST: ${ast.scope}`);
			const op = ast.operator ?? ':';
			if (op === ':') {
				return {
					type: 'SCOPED_FILTER',
					scopeDef,
					expr: compileValueExpr(ast.expr, hostDoc),
				};
			}
			if (ast.expr.type !== 'VALUE_LEAF' || ast.expr.matcher.kind === 'regex') {
				throw new Error(
					`Invalid comparison expression for scope "${scopeDef.canonicalName}".`,
				);
			}
			const canonical = scopeDef.canonicalName;
			const rawValues =
				ast.expr.matcher.kind === 'this'
					? resolveThisReference(hostDoc, ast.expr.matcher.segments).values.map(String)
					: [ast.expr.matcher.value];
			return {
				type: 'SCOPED_COMPARE',
				scopeDef,
				operator: op,
				normalizedRhsValues: normalizeScopeComparisonOperands(canonical, rawValues),
			};
		}
		case 'PROPERTY_FILTER': {
			const lowerKey = ast.key.trim().toLowerCase();
			if (ast.operator === 'EXISTS') {
				return { type: 'PROPERTY_EXISTS', lowerKey };
			}
			if (ast.operator === 'EMPTY') {
				return { type: 'PROPERTY_EMPTY', lowerKey };
			}
			const propType = resolveQueryPropertyType(lowerKey, resolvedConfig.propertyTypes);
			if (ast.operator === ':') {
				if (!ast.valueExpr) {
					throw new Error(`Missing valueExpr on PROPERTY_FILTER ":" for "${lowerKey}"`);
				}
				return {
					type: 'PROPERTY_COLON',
					lowerKey,
					propType,
					expr: compilePropertyColonExpr(
						ast.valueExpr,
						propType,
						resolvedConfig,
						referenceTimeMs,
						hostDoc,
					),
				};
			}
			return {
				type: 'PROPERTY_COMPARE',
				lowerKey,
				comparisons: compilePropertyComparisons(
					lowerKey,
					propType,
					ast.operator,
					ast.valueExpr,
					resolvedConfig,
					referenceTimeMs,
					hostDoc,
				),
			};
		}
	}
}

export function getExecutionPlan(prepared: PreparedQuery): ExecutionPlan {
	const cached = EXECUTION_PLAN_CACHE.get(prepared);
	if (cached) return cached;

	const { ast, resolvedConfig, referenceTimeMs, hostDoc } = prepared;
	const plan: ExecutionPlan = {
		root: compileSearchNode(ast, resolvedConfig, referenceTimeMs, hostDoc),
		queriedKeys: collectReferencedPropertyKeys(ast),
		expectedFingerprint: resolvedConfig.normalizationFingerprint,
	};
	EXECUTION_PLAN_CACHE.set(prepared, plan);
	return plan;
}
