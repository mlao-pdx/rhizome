import { collectReferencedPropertyKeys } from './ast-utils';
import { validateRegexLiteral } from './literals';
import { resolveQueryPropertyType, STRICT_NUMBER_RE } from './property-coercion';
import { normalizeTagBody } from './scopes';
import { parseTemporalExpr } from './temporal';
import type {
	DateInterval,
	ObsidianPropertyType,
	PreparedQuery,
	PropertyOperator,
	ResolvedEngineConfig,
	ScopeDefinition,
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
	| { readonly type: 'COLON_TAG'; readonly rhsRaw: string }
	| { readonly type: 'COLON_TEXT'; readonly value: string; readonly quoted: boolean };

export type CompiledPropertyComparison =
	| { readonly kind: 'number'; readonly operator: PropertyOperator; readonly rhsNum: number }
	| { readonly kind: 'checkbox'; readonly operator: PropertyOperator; readonly rhsBool: boolean }
	| {
			readonly kind: 'temporal';
			readonly operator: PropertyOperator;
			readonly rhsInterval: DateInterval;
	  }
	| { readonly kind: 'tags'; readonly operator: PropertyOperator; readonly rhsTag: string }
	| { readonly kind: 'text'; readonly operator: PropertyOperator; readonly rhsLower: string };

export type CompiledSearchNode =
	| { readonly type: 'MATCH_ALL' }
	| {
			readonly type: 'LOGICAL';
			readonly operator: 'AND' | 'OR';
			readonly children: readonly CompiledSearchNode[];
	  }
	| { readonly type: 'NOT'; readonly child: CompiledSearchNode }
	| { readonly type: 'TEXT_MATCH_REGEX'; readonly regex: RegExp }
	| { readonly type: 'TEXT_MATCH_STRING'; readonly value: string }
	| {
			readonly type: 'SCOPED_FILTER';
			readonly scopeDef: ScopeDefinition;
			readonly expr: CompiledValueExprNode;
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
			readonly comparison: CompiledPropertyComparison;
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

function compileValueExpr(expr: ValueExprAST): CompiledValueExprNode {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return {
				type: 'VALUE_LOGICAL',
				operator: expr.operator,
				children: expr.children.map(compileValueExpr),
			};
		case 'VALUE_NOT':
			return {
				type: 'VALUE_NOT',
				child: compileValueExpr(expr.child),
			};
		case 'VALUE_LEAF':
			return expr.matcher.kind === 'regex'
				? {
						type: 'VALUE_LEAF_REGEX',
						regex: compileRegexOrThrow(expr.matcher.pattern, expr.matcher.flags),
					}
				: {
						type: 'VALUE_LEAF_STRING',
						value: expr.matcher.value,
						quoted: expr.matcher.quoted,
					};
	}
}

function compilePropertyColonExpr(
	expr: ValueExprAST,
	propType: ObsidianPropertyType,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
): CompiledPropertyColonNode {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return {
				type: 'COLON_LOGICAL',
				operator: expr.operator,
				children: expr.children.map((c) =>
					compilePropertyColonExpr(c, propType, resolvedConfig, referenceTimeMs),
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
				case 'tags':
					return { type: 'COLON_TAG', rhsRaw };
				case 'text':
				case 'multitext':
					return { type: 'COLON_TEXT', value: rhsRaw, quoted };
			}
		}
	}
}

function compilePropertyComparison(
	lowerKey: string,
	propType: ObsidianPropertyType,
	operator: PropertyOperator,
	valueExpr: ValueExprAST | undefined,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
): CompiledPropertyComparison {
	if (!valueExpr || valueExpr.type !== 'VALUE_LEAF' || valueExpr.matcher.kind === 'regex') {
		throw new Error(`Invalid comparison expression for property "${lowerKey}".`);
	}
	const { value: rhsRaw, quoted } = valueExpr.matcher;

	switch (propType) {
		case 'number': {
			const trimmed = rhsRaw.trim();
			const rhsNum = Number(trimmed);
			if (quoted || !STRICT_NUMBER_RE.test(trimmed) || !Number.isFinite(rhsNum)) {
				throw new Error(`Unvalidated number literal reached execution plan: ${rhsRaw}`);
			}
			return { kind: 'number', operator, rhsNum };
		}
		case 'checkbox': {
			const lower = rhsRaw.trim().toLowerCase();
			if (quoted || (lower !== 'true' && lower !== 'false')) {
				throw new Error(`Unvalidated checkbox literal reached execution plan: ${rhsRaw}`);
			}
			return { kind: 'checkbox', operator, rhsBool: lower === 'true' };
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
			return { kind: 'temporal', operator, rhsInterval: res.interval };
		}
		case 'tags':
			return { kind: 'tags', operator, rhsTag: normalizeTagBody(rhsRaw) };
		case 'text':
		case 'multitext':
			return { kind: 'text', operator, rhsLower: rhsRaw.toLowerCase() };
	}
}

function compileSearchNode(
	ast: SearchAST,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
): CompiledSearchNode {
	switch (ast.type) {
		case 'MATCH_ALL':
			return { type: 'MATCH_ALL' };
		case 'LOGICAL':
			return {
				type: 'LOGICAL',
				operator: ast.operator,
				children: ast.children.map((c) =>
					compileSearchNode(c, resolvedConfig, referenceTimeMs),
				),
			};
		case 'NOT':
			return {
				type: 'NOT',
				child: compileSearchNode(ast.child, resolvedConfig, referenceTimeMs),
			};
		case 'TEXT_MATCH':
			return ast.matcher.kind === 'regex'
				? {
						type: 'TEXT_MATCH_REGEX',
						regex: compileRegexOrThrow(ast.matcher.pattern, ast.matcher.flags),
					}
				: {
						type: 'TEXT_MATCH_STRING',
						value: ast.matcher.value,
					};
		case 'SCOPED_FILTER': {
			const scopeDef =
				ast.rawScope === '#'
					? resolvedConfig.getScope('tag')
					: resolvedConfig.getScope(ast.scope);
			if (!scopeDef) throw new Error(`Unresolved scope in AST: ${ast.scope}`);
			return {
				type: 'SCOPED_FILTER',
				scopeDef,
				expr: compileValueExpr(ast.expr),
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
					),
				};
			}
			return {
				type: 'PROPERTY_COMPARE',
				lowerKey,
				comparison: compilePropertyComparison(
					lowerKey,
					propType,
					ast.operator,
					ast.valueExpr,
					resolvedConfig,
					referenceTimeMs,
				),
			};
		}
	}
}

export function getExecutionPlan(prepared: PreparedQuery): ExecutionPlan {
	const cached = EXECUTION_PLAN_CACHE.get(prepared);
	if (cached) return cached;

	const { ast, resolvedConfig, referenceTimeMs } = prepared;
	const plan: ExecutionPlan = {
		root: compileSearchNode(ast, resolvedConfig, referenceTimeMs),
		queriedKeys: collectReferencedPropertyKeys(ast),
		expectedFingerprint: resolvedConfig.normalizationFingerprint,
	};
	EXECUTION_PLAN_CACHE.set(prepared, plan);
	return plan;
}
