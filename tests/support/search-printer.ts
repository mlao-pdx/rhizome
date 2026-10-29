import type { LeafMatcher, SearchAST, ValueExprAST } from '../../src/core/search';

function encodeDoubleQuoted(value: string): string {
	let out = '"';
	for (const ch of value) {
		if (ch === '\\') out += '\\\\';
		else if (ch === '"') out += '\\"';
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else out += ch;
	}
	return out + '"';
}

function printLeafMatcher(matcher: LeafMatcher): string {
	if (matcher.kind === 'regex') return `/${matcher.pattern}/${matcher.flags}`;
	return matcher.quoted ? encodeDoubleQuoted(matcher.value) : matcher.value;
}

function printValueExpr(expr: ValueExprAST, parentOp?: 'AND' | 'OR' | 'NOT'): string {
	switch (expr.type) {
		case 'VALUE_LEAF':
			return printLeafMatcher(expr.matcher);
		case 'VALUE_NOT': {
			const child =
				expr.child.type === 'VALUE_LOGICAL'
					? `(${printValueExpr(expr.child)})`
					: printValueExpr(expr.child, 'NOT');
			return expr.syntax === '!' ? `!${child}` : `NOT ${child}`;
		}
		case 'VALUE_LOGICAL': {
			const joined = expr.children
				.map((child) => printValueExpr(child, expr.operator))
				.join(` ${expr.operator} `);
			return parentOp && parentOp !== expr.operator ? `(${joined})` : joined;
		}
	}
}

function printPropertyKey(rawKey: string): string {
	if (/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(rawKey) && !/^(?:AND|OR|NOT)$/.test(rawKey)) {
		return rawKey;
	}
	return encodeDoubleQuoted(rawKey);
}

/** Prints a `ValueExprAST` using the search query grammar. */
export function printValueExprAST(expr: ValueExprAST): string {
	return printValueExpr(expr);
}

function printSearchAST(ast: SearchAST, parentOp?: 'AND' | 'OR' | 'NOT'): string {
	switch (ast.type) {
		case 'MATCH_ALL':
			return '';
		case 'TEXT_MATCH':
			return printLeafMatcher(ast.matcher);
		case 'NOT': {
			const child =
				ast.child.type === 'LOGICAL'
					? `(${printSearchAST(ast.child)})`
					: printSearchAST(ast.child, 'NOT');
			return ast.syntax === '!' ? `!${child}` : `NOT ${child}`;
		}
		case 'SCOPED_FILTER': {
			if (
				ast.rawScope === '#' &&
				ast.expr.type === 'VALUE_LEAF' &&
				ast.expr.matcher.kind === 'string' &&
				!ast.expr.matcher.quoted &&
				ast.expr.matcher.value.startsWith('#')
			) {
				return ast.expr.matcher.value;
			}
			const scopeName = ast.rawScope === '#' ? 'tag' : ast.scope;
			if (ast.expr.type === 'VALUE_LEAF') {
				return `${scopeName}:${printLeafMatcher(ast.expr.matcher)}`;
			}
			return `${scopeName}:(${printValueExpr(ast.expr)})`;
		}
		case 'PROPERTY_FILTER': {
			const key = printPropertyKey(ast.rawKey);
			if (ast.operator === 'EXISTS') return `[${key}]`;
			if (ast.operator === 'EMPTY') return `[${key}:]`;
			const value = ast.valueExpr!;
			if (ast.operator === ':') {
				if (value.type === 'VALUE_LEAF') {
					return `[${key}:${printLeafMatcher(value.matcher)}]`;
				}
				return `[${key}:(${printValueExpr(value)})]`;
			}
			return `[${key}:${ast.operator}${printValueExpr(value)}]`;
		}
		case 'LOGICAL': {
			const joined = ast.children
				.map((child) => printSearchAST(child, ast.operator))
				.join(` ${ast.operator} `);
			return ast.parenthesized || (parentOp && parentOp !== ast.operator)
				? `(${joined})`
				: joined;
		}
	}
}

/** Pretty-prints a printable `SearchAST` into a valid query string. */
export function printAST(ast: SearchAST): string {
	return printSearchAST(ast);
}

/** Computes the printed syntactic depth of a `ValueExprAST`. */
export function computeSyntacticDepthValueExpr(
	expr: ValueExprAST,
	parentOp?: 'AND' | 'OR' | 'NOT',
): number {
	switch (expr.type) {
		case 'VALUE_LEAF':
			return 0;
		case 'VALUE_NOT': {
			const needsParens = expr.child.type === 'VALUE_LOGICAL';
			return (
				1 +
				(needsParens ? 1 : 0) +
				computeSyntacticDepthValueExpr(expr.child, needsParens ? undefined : 'NOT')
			);
		}
		case 'VALUE_LOGICAL': {
			const needsParens = Boolean(parentOp && parentOp !== expr.operator);
			const maxChild = Math.max(
				0,
				...expr.children.map((child) =>
					computeSyntacticDepthValueExpr(child, expr.operator),
				),
			);
			return (needsParens ? 1 : 0) + maxChild;
		}
	}
}

/** Computes the printed syntactic depth of a `SearchAST`. */
export function computeSyntacticDepth(ast: SearchAST, parentOp?: 'AND' | 'OR' | 'NOT'): number {
	switch (ast.type) {
		case 'MATCH_ALL':
		case 'TEXT_MATCH':
			return 0;
		case 'NOT': {
			const needsParens = ast.child.type === 'LOGICAL';
			return (
				1 +
				(needsParens ? 1 : 0) +
				computeSyntacticDepth(ast.child, needsParens ? undefined : 'NOT')
			);
		}
		case 'SCOPED_FILTER':
			return (
				(ast.expr.type !== 'VALUE_LEAF' ? 1 : 0) + computeSyntacticDepthValueExpr(ast.expr)
			);
		case 'PROPERTY_FILTER':
			return ast.valueExpr
				? (ast.operator === ':' && ast.valueExpr.type !== 'VALUE_LEAF' ? 1 : 0) +
						computeSyntacticDepthValueExpr(ast.valueExpr)
				: 0;
		case 'LOGICAL': {
			const needsParens = Boolean(
				ast.parenthesized || (parentOp && parentOp !== ast.operator),
			);
			const maxChild = Math.max(
				0,
				...ast.children.map((child) => computeSyntacticDepth(child, ast.operator)),
			);
			return (needsParens ? 1 : 0) + maxChild;
		}
	}
}
