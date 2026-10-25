import * as fc from 'fast-check';
import {
	MAX_QUERY_LENGTH,
	MAX_SYNTACTIC_DEPTH,
	type PropertyFilterNode,
	type ScopedFilterNode,
	type SearchAST,
	type ValueExprAST,
} from '../../src/core/search';
import { computeSyntacticDepth, printAST } from './search-printer';

export function logicalAST(operator: 'AND' | 'OR', children: SearchAST[]): SearchAST {
	return { type: 'LOGICAL', operator, children };
}

function negate(child: SearchAST): SearchAST {
	return { type: 'NOT', syntax: 'NOT', child };
}

export function booleanAlgebraASTs(a: SearchAST, b: SearchAST) {
	return {
		tautology: logicalAST('OR', [a, negate(a)]),
		contradiction: logicalAST('AND', [a, negate(a)]),
		notAnd: negate(logicalAST('AND', [a, b])),
		orNot: logicalAST('OR', [negate(a), negate(b)]),
		notOr: negate(logicalAST('OR', [a, b])),
		andNot: logicalAST('AND', [negate(a), negate(b)]),
	};
}

export type DistributionTarget = ScopedFilterNode | (PropertyFilterNode & { operator: ':' });

export function distributionASTs(target: DistributionTarget, a: ValueExprAST, b: ValueExprAST) {
	const withExpr = (expr: ValueExprAST): SearchAST =>
		target.type === 'SCOPED_FILTER'
			? { ...target, rawScope: target.rawScope === '#' ? 'tag' : target.rawScope, expr }
			: { ...target, valueExpr: expr };
	return {
		combinedOr: withExpr({ type: 'VALUE_LOGICAL', operator: 'OR', children: [a, b] }),
		separateOr: logicalAST('OR', [withExpr(a), withExpr(b)]),
		combinedAnd: withExpr({ type: 'VALUE_LOGICAL', operator: 'AND', children: [a, b] }),
		separateAnd: logicalAST('AND', [withExpr(a), withExpr(b)]),
	};
}

export function boundedCompositionsArb<T extends Record<string, SearchAST>>(
	arbitrary: fc.Arbitrary<T>,
): fc.Arbitrary<T> {
	return arbitrary.filter((asts) =>
		Object.values(asts).every(
			(ast) =>
				printAST(ast).length <= MAX_QUERY_LENGTH &&
				computeSyntacticDepth(ast) <= MAX_SYNTACTIC_DEPTH,
		),
	);
}
