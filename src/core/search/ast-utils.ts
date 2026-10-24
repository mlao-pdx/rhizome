import { isVirtualFileKey, type LogicalNode, type SearchAST, type ValueExprAST } from './types';

/**
 * Recursively freezes a `ValueExprAST` node, including its `matcher` or `children` array.
 */
export function deepFreezeValueExprAST(expr: ValueExprAST): ValueExprAST {
	if (expr.type === 'VALUE_LEAF') {
		Object.freeze(expr.matcher);
		return Object.freeze(expr);
	}
	if (expr.type === 'VALUE_NOT') {
		deepFreezeValueExprAST(expr.child);
		return Object.freeze(expr);
	}
	for (const c of expr.children) deepFreezeValueExprAST(c);
	Object.freeze(expr.children);
	return Object.freeze(expr);
}

/**
 * Recursively freezes a `SearchAST` tree, including all `children` arrays, `matcher` objects, and `span` objects.
 */
export function deepFreezeAST(ast: SearchAST): SearchAST {
	if (ast.type === 'MATCH_ALL') return Object.freeze(ast);
	if ('span' in ast && ast.span) Object.freeze(ast.span);

	switch (ast.type) {
		case 'TEXT_MATCH':
			Object.freeze(ast.matcher);
			return Object.freeze(ast);
		case 'NOT':
			deepFreezeAST(ast.child);
			return Object.freeze(ast);
		case 'SCOPED_FILTER':
			deepFreezeValueExprAST(ast.expr);
			return Object.freeze(ast);
		case 'PROPERTY_FILTER':
			if (ast.valueExpr) deepFreezeValueExprAST(ast.valueExpr);
			return Object.freeze(ast);
		case 'LOGICAL':
			for (const c of ast.children) deepFreezeAST(c);
			Object.freeze(ast.children);
			return Object.freeze(ast);
	}
}

/**
 * Collects all non-virtual user property keys referenced anywhere in `ast`.
 * Virtual `file.*` keys are excluded because they read `doc.file`, not `doc.propertyOccurrences`.
 */
export function collectReferencedPropertyKeys(
	ast: SearchAST,
	out: Set<string> = new Set(),
): Set<string> {
	switch (ast.type) {
		case 'PROPERTY_FILTER': {
			const k = ast.key.trim().toLowerCase();
			if (!isVirtualFileKey(k)) out.add(k);
			return out;
		}
		case 'NOT':
			return collectReferencedPropertyKeys(ast.child, out);
		case 'LOGICAL':
			for (const c of ast.children) collectReferencedPropertyKeys(c, out);
			return out;
		default:
			return out;
	}
}

/**
 * Returns true if `expr` contains at least one `regex` leaf matcher.
 */
export function containsRegexLeaf(expr: ValueExprAST): boolean {
	if (expr.type === 'VALUE_LEAF') return expr.matcher.kind === 'regex';
	if (expr.type === 'VALUE_NOT') return containsRegexLeaf(expr.child);
	return expr.children.some(containsRegexLeaf);
}

/**
 * Produces a canonical `ValueExprAST` with `VALUE_NOT.syntax` normalized to `'NOT'`
 * and nested `VALUE_LOGICAL` nodes of the same operator flattened.
 */
export function normalizeValueExprAST(expr: ValueExprAST): ValueExprAST {
	switch (expr.type) {
		case 'VALUE_LEAF':
			return { type: 'VALUE_LEAF', matcher: { ...expr.matcher } };
		case 'VALUE_NOT':
			return { type: 'VALUE_NOT', syntax: 'NOT', child: normalizeValueExprAST(expr.child) };
		case 'VALUE_LOGICAL': {
			const flatChildren: ValueExprAST[] = [];
			for (const c of expr.children) {
				const normC = normalizeValueExprAST(c);
				if (normC.type === 'VALUE_LOGICAL' && normC.operator === expr.operator) {
					flatChildren.push(...normC.children);
				} else {
					flatChildren.push(normC);
				}
			}
			if (flatChildren.length === 1) return flatChildren[0]!;
			return { type: 'VALUE_LOGICAL', operator: expr.operator, children: flatChildren };
		}
	}
}

/**
 * Produces a canonical `SearchAST` with `span` and `parenthesized` stripped,
 * negation syntax normalized to `'NOT'`, `tag` scope string leaves prefixed with `'#'`,
 * property keys lowercased, and nested `LOGICAL` nodes of the same operator flattened.
 */
export function normalizeAST(ast: SearchAST): SearchAST {
	switch (ast.type) {
		case 'MATCH_ALL':
			return { type: 'MATCH_ALL' };
		case 'TEXT_MATCH':
			return {
				type: 'TEXT_MATCH',
				matcher: { ...ast.matcher },
				rawText: '',
			};
		case 'NOT':
			return {
				type: 'NOT',
				syntax: 'NOT',
				child: normalizeAST(ast.child),
			};
		case 'SCOPED_FILTER': {
			let normExpr = normalizeValueExprAST(ast.expr);
			if (
				ast.scope === 'tag' &&
				normExpr.type === 'VALUE_LEAF' &&
				normExpr.matcher.kind === 'string'
			) {
				const matcher = normExpr.matcher;
				normExpr = {
					type: 'VALUE_LEAF',
					matcher: {
						kind: 'string',
						value: matcher.value.startsWith('#') ? matcher.value : `#${matcher.value}`,
						quoted: matcher.quoted,
					},
				};
			}
			return {
				type: 'SCOPED_FILTER',
				scope: ast.scope,
				rawScope: ast.scope,
				expr: normExpr,
			};
		}
		case 'PROPERTY_FILTER': {
			const lowerKey = ast.key.trim().toLowerCase();
			return {
				type: 'PROPERTY_FILTER',
				key: lowerKey,
				rawKey: lowerKey,
				operator: ast.operator,
				...(ast.valueExpr ? { valueExpr: normalizeValueExprAST(ast.valueExpr) } : {}),
			};
		}
		case 'LOGICAL': {
			const flatChildren: SearchAST[] = [];
			for (const c of ast.children) {
				const normC = normalizeAST(c);
				if (normC.type === 'LOGICAL' && normC.operator === ast.operator) {
					flatChildren.push(...normC.children);
				} else {
					flatChildren.push(normC);
				}
			}
			if (flatChildren.length === 1) return flatChildren[0]!;
			const out: LogicalNode = {
				type: 'LOGICAL',
				operator: ast.operator,
				children: flatChildren,
			};
			return out;
		}
	}
}
