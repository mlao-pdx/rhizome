import type { CstElement, CstNode, IToken } from 'chevrotain';
import { isGraphScopeCanonicalName, parseGraphArrow } from './graph-dag';
import { createWikilinkBracketsHint } from './linter';
import {
	decodeQueryReference,
	decodeQuotedString,
	decodeRegexLiteral,
	decodeThisReference,
	decodeWikiLinkValue,
} from './literals';
import { BUILT_IN_SCOPES } from './scopes';
import type {
	GraphTargetAST,
	LeafMatcher,
	PropertyFilterNode,
	PropertyOperator,
	ScopeDefinition,
	ScopeOperator,
	SearchAST,
	SearchDiagnostic,
	SourceSpan,
	ValueExprAST,
} from './types';

export interface ParseQueryResult {
	ast: SearchAST | null;
	diagnostics: SearchDiagnostic[];
}

export interface LoweredQueryResult {
	ast: SearchAST;
	diagnostics: SearchDiagnostic[];
	invalidPropertyNodes: ReadonlySet<PropertyFilterNode>;
}

interface LoweredValueExpr {
	expr: ValueExprAST;
	span: SourceSpan;
	parenthesized: boolean;
}

const BUILT_IN_SCOPE_MAP: ReadonlyMap<string, ScopeDefinition> = (() => {
	const map = new Map<string, ScopeDefinition>();
	for (const def of BUILT_IN_SCOPES) {
		map.set(def.canonicalName.trim().toLowerCase(), def);
		for (const alias of def.aliases) {
			map.set(alias.trim().toLowerCase(), def);
		}
	}
	return map;
})();

export function resolveBuiltInScopeCanonicalName(rawScope: string): string {
	const trimmed = rawScope.trim();
	return BUILT_IN_SCOPE_MAP.get(trimmed.toLowerCase())?.canonicalName ?? trimmed;
}

/**
 * Computes the 1-based line and column at the end of `input`.
 */
export function endOfInputSpan(input: string): SourceSpan {
	let line = 1;
	let col = 1;
	for (let i = 0; i < input.length; i++) {
		if (input[i] === '\n') {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return {
		startOffset: input.length,
		endOffset: input.length,
		startLine: line,
		startColumn: col,
	};
}

/**
 * Converts a Chevrotain `IToken` (whose `endOffset` is inclusive) to a `SourceSpan`
 * (whose `endOffset` is exclusive). Falls back to `fallbackToken` or end of `input`
 * when `token.startOffset` is `NaN` (e.g. Chevrotain's `EOF` token).
 */
export function tokenToSpan(
	token: IToken | undefined,
	fallbackToken?: IToken,
	input = '',
): SourceSpan {
	const isValidTokenOffset = (t: IToken | undefined): t is IToken =>
		Boolean(t && Number.isSafeInteger(t.startOffset) && t.startOffset >= 0);

	const tok = isValidTokenOffset(token)
		? token
		: isValidTokenOffset(fallbackToken)
			? fallbackToken
			: undefined;
	if (!tok) return endOfInputSpan(input);

	const startOffset = tok.startOffset;
	const rawEnd =
		tok.endOffset !== undefined && Number.isSafeInteger(tok.endOffset) && tok.endOffset >= 0
			? tok.endOffset + 1
			: startOffset + tok.image.length;
	const endOffset = Math.max(startOffset, rawEnd);
	const startLine =
		tok.startLine !== undefined && Number.isSafeInteger(tok.startLine) && tok.startLine >= 1
			? tok.startLine
			: 1;
	const startColumn =
		tok.startColumn !== undefined &&
		Number.isSafeInteger(tok.startColumn) &&
		tok.startColumn >= 1
			? tok.startColumn
			: 1;
	return { startOffset, endOffset, startLine, startColumn };
}

/**
 * Merges two `SourceSpan` instances into a contiguous span `[start.startOffset, end.endOffset)`.
 */
export function mergeSpans(start: SourceSpan, end: SourceSpan): SourceSpan {
	return {
		startOffset: start.startOffset,
		endOffset: end.endOffset,
		startLine: start.startLine,
		startColumn: start.startColumn,
	};
}

function asNodes(elems: CstElement[] | undefined): CstNode[] {
	return (elems ?? []) as CstNode[];
}

function asTokens(elems: CstElement[] | undefined): IToken[] {
	return (elems ?? []) as IToken[];
}

/**
 * Lowers a Chevrotain `query` CST node into a `SearchAST` and collects lowering-time diagnostics.
 */
export function lowerQueryCst(cst: CstNode): LoweredQueryResult {
	const diagnostics: SearchDiagnostic[] = [];
	const invalidPropertyNodes = new Set<PropertyFilterNode>();

	function lowerLeafTokens(ch: Record<string, CstElement[]>): {
		matcher: LeafMatcher;
		span: SourceSpan;
	} {
		const quoted = asTokens(ch.QuotedString)[0];
		if (quoted) {
			return {
				matcher: { kind: 'string', value: decodeQuotedString(quoted.image), quoted: true },
				span: tokenToSpan(quoted),
			};
		}
		const regex = asTokens(ch.RegexLiteral)[0];
		if (regex) {
			const { pattern, flags } = decodeRegexLiteral(regex.image);
			return {
				matcher: { kind: 'regex', pattern, flags },
				span: tokenToSpan(regex),
			};
		}
		const thisRef = asTokens(ch.ThisReference)[0];
		if (thisRef) {
			const span = tokenToSpan(thisRef);
			const decoded = decodeThisReference(thisRef.image);
			if (!decoded.ok) {
				diagnostics.push({
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: decoded.issue,
					hint: decoded.hint,
					span,
				});
				return {
					matcher: { kind: 'this', raw: thisRef.image, segments: [] },
					span,
				};
			}
			return {
				matcher: { kind: 'this', raw: thisRef.image, segments: decoded.segments },
				span,
			};
		}
		const queryRef = asTokens(ch.QueryReference)[0];
		if (queryRef) {
			const span = tokenToSpan(queryRef);
			const decoded = decodeQueryReference(queryRef.image);
			if (!decoded.ok) {
				diagnostics.push({
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: decoded.issue,
					hint: decoded.hint,
					span,
				});
				return {
					matcher: { kind: 'query', raw: queryRef.image, queryName: '', segments: [] },
					span,
				};
			}
			if (decoded.segments.length === 0) {
				diagnostics.push({
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: `Query reference "${queryRef.image}" requires a field path when used as a scalar value (e.g. "${queryRef.image}.file.basename").`,
					hint: `Specify a field path such as "${queryRef.image}.file.basename", or use a graph filter (e.g. "links -> ${queryRef.image}" or "[prop -> ${queryRef.image}]").`,
					span,
				});
				return {
					matcher: {
						kind: 'query',
						raw: queryRef.image,
						queryName: decoded.queryName,
						segments: [],
					},
					span,
				};
			}
			return {
				matcher: {
					kind: 'query',
					raw: queryRef.image,
					queryName: decoded.queryName,
					segments: decoded.segments,
				},
				span,
			};
		}
		const tok =
			asTokens(ch.DateTimeLiteral)[0] ??
			asTokens(ch.TagLiteral)[0] ??
			asTokens(ch.Identifier)[0]!;
		return {
			matcher: { kind: 'string', value: tok.image, quoted: false },
			span: tokenToSpan(tok),
		};
	}

	function lowerSubqueryNode(subNode: CstNode): { ast: SearchAST; span: SourceSpan } {
		const lbrace = asTokens(subNode.children.LBrace)[0]!;
		const rbrace = asTokens(subNode.children.RBrace)[0]!;
		const span = mergeSpans(tokenToSpan(lbrace), tokenToSpan(rbrace));
		const innerOr = asNodes(subNode.children.orExpression)[0];
		const ast: SearchAST = innerOr ? lowerOrExpression(innerOr) : { type: 'MATCH_ALL' };
		return { ast, span };
	}

	function lowerGraphTarget(gtNode: CstNode): { target: GraphTargetAST; span: SourceSpan } {
		const subNode = asNodes(gtNode.children.subquery)[0];
		if (subNode) {
			const lowered = lowerSubqueryNode(subNode);
			return {
				target: { kind: 'subquery', ast: lowered.ast, span: lowered.span },
				span: lowered.span,
			};
		}

		const queryTok = asTokens(gtNode.children.QueryReference)[0];
		if (queryTok) {
			const span = tokenToSpan(queryTok);
			const decoded = decodeQueryReference(queryTok.image);
			if (!decoded.ok) {
				diagnostics.push({
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: decoded.issue,
					hint: decoded.hint,
					span,
				});
				return {
					target: { kind: 'query_ref', raw: queryTok.image, queryName: '', span },
					span,
				};
			}
			if (decoded.segments.length > 0) {
				diagnostics.push({
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: `Graph target "${queryTok.image}" must reference a query name ("@query.${decoded.queryName}") without a field path.`,
					hint: `Use "@query.${decoded.queryName}" to traverse links to matched notes.`,
					span,
				});
			}
			return {
				target: {
					kind: 'query_ref',
					raw: queryTok.image,
					queryName: decoded.queryName,
					span,
				},
				span,
			};
		}

		const thisTok = asTokens(gtNode.children.ThisReference)[0]!;
		const span = tokenToSpan(thisTok);
		if (thisTok.image !== '@this') {
			diagnostics.push({
				code: 'SYNTAX_ERROR',
				severity: 'error',
				issue: `Graph target "${thisTok.image}" must be bare "@this" without a field path.`,
				hint: 'Use "@this" to traverse links to the hosting note, or use ":" to match field values.',
				span,
			});
		}
		return {
			target: { kind: 'this_ref', raw: thisTok.image, span },
			span,
		};
	}

	function extractBareColonGraphTarget(node: CstNode): GraphTargetAST | null {
		const ch = node.children;
		if (
			asTokens(ch.Not).length > 0 ||
			asTokens(ch.BangNot).length > 0 ||
			asTokens(ch.LParen).length > 0
		) {
			return null;
		}
		const leafNode = asNodes(ch.valueLeaf)[0];
		if (!leafNode) {
			return null;
		}
		const thisTok = asTokens(leafNode.children.ThisReference)[0];
		if (thisTok && thisTok.image === '@this') {
			const span = tokenToSpan(thisTok);
			return { kind: 'this_ref', raw: '@this', span };
		}
		const queryTok = asTokens(leafNode.children.QueryReference)[0];
		if (queryTok) {
			const decoded = decodeQueryReference(queryTok.image);
			if (decoded.ok && decoded.segments.length === 0) {
				const span = tokenToSpan(queryTok);
				return {
					kind: 'query_ref',
					raw: queryTok.image,
					queryName: decoded.queryName,
					span,
				};
			}
		}
		return null;
	}

	function lowerWikiLinkToken(tok: IToken): LoweredValueExpr {
		const span = tokenToSpan(tok);
		const target = decodeWikiLinkValue(tok.image);
		if (target.length === 0) {
			diagnostics.push({
				code: 'SYNTAX_ERROR',
				severity: 'error',
				issue: 'Wikilink value cannot have an empty target.',
				hint: null,
				span,
			});
		} else {
			diagnostics.push(createWikilinkBracketsHint(span));
		}
		return {
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: target, quoted: true },
				span,
			},
			span,
			parenthesized: false,
		};
	}

	function lowerValueLeaf(node: CstNode): LoweredValueExpr {
		const leaf = lowerLeafTokens(node.children);
		return {
			expr: { type: 'VALUE_LEAF', matcher: leaf.matcher, span: leaf.span },
			span: leaf.span,
			parenthesized: false,
		};
	}

	function lowerValueOrExpr(node: CstNode): LoweredValueExpr {
		const subNodes = [...asNodes(node.children.lhs), ...asNodes(node.children.rhs)];
		const lowered = subNodes.map(lowerValueAndExpr);
		if (lowered.length === 1) return lowered[0]!;
		const first = lowered[0]!;
		const last = lowered[lowered.length - 1]!;
		const span = mergeSpans(first.span, last.span);
		return {
			expr: {
				type: 'VALUE_LOGICAL',
				operator: 'OR',
				children: lowered.map((item) => item.expr),
				span,
			},
			span,
			parenthesized: false,
		};
	}

	function lowerValueAndExpr(node: CstNode): LoweredValueExpr {
		const subNodes = [...asNodes(node.children.lhs), ...asNodes(node.children.rhs)];
		const andTokens = asTokens(node.children.And);
		const lowered = subNodes.map(lowerValueNotExpr);
		if (lowered.length === 1) return lowered[0]!;
		const first = lowered[0]!;
		const last = lowered[lowered.length - 1]!;
		const span = mergeSpans(first.span, last.span);
		return {
			expr: {
				type: 'VALUE_LOGICAL',
				operator: 'AND',
				implicit: andTokens.length === 0,
				children: lowered.map((item) => item.expr),
				span,
			},
			span,
			parenthesized: false,
		};
	}

	function lowerValueNotExpr(node: CstNode): LoweredValueExpr {
		const ch = node.children;
		const notTok = asTokens(ch.Not)[0];
		const bangTok = asTokens(ch.BangNot)[0];
		if (notTok || bangTok) {
			const opTok = (notTok ?? bangTok)!;
			const child = lowerValueNotExpr(asNodes(ch.operand)[0]!);
			const span = mergeSpans(tokenToSpan(opTok), child.span);
			return {
				expr: {
					type: 'VALUE_NOT',
					syntax: notTok ? 'NOT' : '!',
					child: child.expr,
					span,
				},
				span,
				parenthesized: false,
			};
		}
		const lparen = asTokens(ch.LParen)[0];
		if (lparen) {
			const rparen = asTokens(ch.RParen)[0]!;
			const inner = lowerValueOrExpr(asNodes(ch.valueOrExpr)[0]!);
			const span = mergeSpans(tokenToSpan(lparen), tokenToSpan(rparen));
			return {
				expr: { ...inner.expr, span },
				span,
				parenthesized: true,
			};
		}
		const wikiTok = asTokens(ch.WikiLinkValue)[0];
		if (wikiTok) return lowerWikiLinkToken(wikiTok);

		return lowerValueLeaf(asNodes(ch.valueLeaf)[0]!);
	}

	function lowerPrimary(node: CstNode): SearchAST {
		const ch = node.children;
		const paren = asNodes(ch.parenthesized)[0];
		if (paren) {
			const lparen = asTokens(paren.children.LParen)[0]!;
			const rparen = asTokens(paren.children.RParen)[0]!;
			const span = mergeSpans(tokenToSpan(lparen), tokenToSpan(rparen));
			const inner = lowerOrExpression(asNodes(paren.children.orExpression)[0]!);
			if (inner.type === 'MATCH_ALL') {
				return inner;
			}
			if (inner.type === 'LOGICAL') {
				return { ...inner, parenthesized: true, span };
			}
			return { ...inner, span };
		}

		const prop = asNodes(ch.propertyFilter)[0];
		if (prop) {
			const diagCountBefore = diagnostics.length;
			const lbracket = asTokens(prop.children.LBracket)[0]!;
			const rbracket = asTokens(prop.children.RBracket)[0]!;
			const span = mergeSpans(tokenToSpan(lbracket), tokenToSpan(rbracket));
			const propKeyNode = asNodes(prop.children.propertyKey)[0]!;
			const quotedKey = asTokens(propKeyNode.children.QuotedString)[0];
			const idKey = asTokens(propKeyNode.children.Identifier)[0];
			const rawKey = quotedKey ? decodeQuotedString(quotedKey.image) : idKey!.image;
			const key = rawKey.trim().toLowerCase();
			if (key.length === 0) {
				diagnostics.push({
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: 'Property key cannot be empty.',
					hint: null,
					span: tokenToSpan(quotedKey ?? idKey),
				});
			}
			const graphArrowTok = asTokens(prop.children.GraphArrow)[0];
			if (graphArrowTok) {
				const parsedArrow = parseGraphArrow(graphArrowTok.image);
				if (!parsedArrow.ok) {
					diagnostics.push({
						code: 'SYNTAX_ERROR',
						severity: 'error',
						issue: parsedArrow.issue,
						hint: parsedArrow.hint,
						span: tokenToSpan(graphArrowTok),
					});
				}
				const gt = lowerGraphTarget(asNodes(prop.children.graphTarget)[0]!);
				return {
					type: 'PROPERTY_GRAPH_FILTER',
					key,
					rawKey,
					direction: parsedArrow.direction,
					hops: parsedArrow.hops,
					target: gt.target,
					span,
				};
			}

			const colon = asTokens(prop.children.Colon)[0];
			const compOp = asTokens(prop.children.CompOp)[0];
			const valueNotExprNode = asNodes(prop.children.valueNotExpr)[0];
			let propNode: PropertyFilterNode;
			if (!colon) {
				propNode = {
					type: 'PROPERTY_FILTER',
					key,
					rawKey,
					operator: 'EXISTS',
					span,
				};
			} else if (compOp) {
				const rhs = lowerValueLeaf(asNodes(prop.children.valueLeaf)[0]!);
				propNode = {
					type: 'PROPERTY_FILTER',
					key,
					rawKey,
					operator: compOp.image as PropertyOperator,
					valueExpr: rhs.expr,
					span,
				};
			} else if (valueNotExprNode) {
				const rhs = lowerValueNotExpr(valueNotExprNode);
				if (
					rhs.expr.type === 'VALUE_LEAF' &&
					rhs.expr.matcher.kind === 'string' &&
					rhs.expr.matcher.value === ''
				) {
					propNode = {
						type: 'PROPERTY_FILTER',
						key,
						rawKey,
						operator: 'EMPTY',
						span,
					};
				} else {
					propNode = {
						type: 'PROPERTY_FILTER',
						key,
						rawKey,
						operator: ':',
						valueExpr: rhs.expr,
						span,
					};
				}
			} else {
				propNode = {
					type: 'PROPERTY_FILTER',
					key,
					rawKey,
					operator: 'EMPTY',
					span,
				};
			}
			for (let i = diagCountBefore; i < diagnostics.length; i++) {
				if (diagnostics[i]?.severity === 'error') {
					invalidPropertyNodes.add(propNode);
					break;
				}
			}
			return propNode;
		}

		const scoped = asNodes(ch.scopedOperator)[0];
		if (scoped) {
			const scopeNameNode = asNodes(scoped.children.scopeName)[0]!;
			const scopeTok = asTokens(scopeNameNode.children.Identifier)[0]!;
			const rawScope = scopeTok.image;
			const scope = resolveBuiltInScopeCanonicalName(rawScope);
			const isKnownBuiltIn = BUILT_IN_SCOPE_MAP.has(rawScope.trim().toLowerCase());

			const graphArrowTok = asTokens(scoped.children.GraphArrow)[0];
			if (graphArrowTok) {
				const parsedArrow = parseGraphArrow(graphArrowTok.image);
				if (!parsedArrow.ok) {
					diagnostics.push({
						code: 'SYNTAX_ERROR',
						severity: 'error',
						issue: parsedArrow.issue,
						hint: parsedArrow.hint,
						span: tokenToSpan(graphArrowTok),
					});
				}
				const gt = lowerGraphTarget(asNodes(scoped.children.graphTarget)[0]!);
				const fullSpan = mergeSpans(tokenToSpan(scopeTok), gt.span);
				if (isKnownBuiltIn && !isGraphScopeCanonicalName(scope)) {
					diagnostics.push({
						code: 'SYNTAX_ERROR',
						severity: 'error',
						issue: `Scope "${scope}" does not support graph traversal ("${graphArrowTok.image}").`,
						hint: 'Only "links", "embeds", and "backlinks" support graph arrows, or use "[prop -> ...]" for property links.',
						span: fullSpan,
					});
				}
				return {
					type: 'SCOPE_GRAPH_FILTER',
					scope,
					rawScope,
					direction: parsedArrow.direction,
					hops: parsedArrow.hops,
					target: gt.target,
					span: fullSpan,
				};
			}

			const subNode = asNodes(scoped.children.subquery)[0];
			if (subNode) {
				const sub = lowerSubqueryNode(subNode);
				const fullSpan = mergeSpans(tokenToSpan(scopeTok), sub.span);
				if (isKnownBuiltIn && !isGraphScopeCanonicalName(scope)) {
					diagnostics.push({
						code: 'SYNTAX_ERROR',
						severity: 'error',
						issue: `Scope "${scope}:" does not support "{ ... }" graph subqueries.`,
						hint: 'Only "links:", "embeds:", and "backlinks:" support "{ ... }" subqueries.',
						span: fullSpan,
					});
				}
				return {
					type: 'SCOPE_GRAPH_FILTER',
					scope,
					rawScope,
					direction: 'outgoing',
					hops: { minHops: 1, maxHops: 1, unbounded: false, raw: ':' },
					target: { kind: 'subquery', ast: sub.ast, span: sub.span },
					span: fullSpan,
				};
			}

			const compOp = asTokens(scoped.children.CompOp)[0];
			if (compOp) {
				const rhs = lowerValueLeaf(asNodes(scoped.children.valueLeaf)[0]!);
				return {
					type: 'SCOPED_FILTER',
					scope,
					rawScope,
					operator: compOp.image as ScopeOperator,
					expr: rhs.expr,
					span: mergeSpans(tokenToSpan(scopeTok), rhs.span),
				};
			}

			const valNotNode = asNodes(scoped.children.valueNotExpr)[0]!;
			if (isGraphScopeCanonicalName(scope)) {
				const bareTarget = extractBareColonGraphTarget(valNotNode);
				if (bareTarget !== null) {
					const targetSpan = bareTarget.span ?? tokenToSpan(scopeTok);
					return {
						type: 'SCOPE_GRAPH_FILTER',
						scope,
						rawScope,
						direction: 'outgoing',
						hops: { minHops: 1, maxHops: 1, unbounded: false, raw: ':' },
						target: bareTarget,
						span: mergeSpans(tokenToSpan(scopeTok), targetSpan),
					};
				}
			}

			const rhs = lowerValueNotExpr(valNotNode);
			return {
				type: 'SCOPED_FILTER',
				scope,
				rawScope,
				expr: rhs.expr,
				span: mergeSpans(tokenToSpan(scopeTok), rhs.span),
			};
		}

		const tagShort = asNodes(ch.tagShorthand)[0]!;
		const tagTok = asTokens(tagShort.children.TagLiteral)[0]!;
		const span = tokenToSpan(tagTok);
		return {
			type: 'SCOPED_FILTER',
			scope: 'tag',
			rawScope: '#',
			expr: {
				type: 'VALUE_LEAF',
				matcher: { kind: 'string', value: tagTok.image, quoted: false },
				span,
			},
			span,
		};
	}

	function lowerNotExpression(node: CstNode): SearchAST {
		const ch = node.children;
		const notTok = asTokens(ch.Not)[0];
		const bangTok = asTokens(ch.BangNot)[0];
		if (notTok || bangTok) {
			const opTok = (notTok ?? bangTok)!;
			const child = lowerNotExpression(asNodes(ch.operand)[0]!);
			const opSpan = tokenToSpan(opTok);
			const span = 'span' in child && child.span ? mergeSpans(opSpan, child.span) : opSpan;
			return {
				type: 'NOT',
				syntax: notTok ? 'NOT' : '!',
				child,
				span,
			};
		}
		return lowerPrimary(asNodes(ch.primary)[0]!);
	}

	function lowerAndExpression(node: CstNode): SearchAST {
		const notNodes = [...asNodes(node.children.lhs), ...asNodes(node.children.rhs)];
		const andTokens = asTokens(node.children.And);
		const children = notNodes.map(lowerNotExpression);

		if (children.length === 1) return children[0]!;
		const firstChild = children[0]!;
		const firstSpan = 'span' in firstChild ? firstChild.span : undefined;
		const lastChild = children[children.length - 1]!;
		const lastSpan = 'span' in lastChild ? lastChild.span : undefined;
		return {
			type: 'LOGICAL',
			operator: 'AND',
			implicit: andTokens.length === 0,
			children,
			...(firstSpan && lastSpan ? { span: mergeSpans(firstSpan, lastSpan) } : {}),
		};
	}

	function lowerOrExpression(node: CstNode): SearchAST {
		const andNodes = [...asNodes(node.children.lhs), ...asNodes(node.children.rhs)];
		const children = andNodes.map(lowerAndExpression);
		if (children.length === 1) return children[0]!;
		const firstChild = children[0]!;
		const firstSpan = 'span' in firstChild ? firstChild.span : undefined;
		const lastChild = children[children.length - 1]!;
		const lastSpan = 'span' in lastChild ? lastChild.span : undefined;
		return {
			type: 'LOGICAL',
			operator: 'OR',
			children,
			...(firstSpan && lastSpan ? { span: mergeSpans(firstSpan, lastSpan) } : {}),
		};
	}

	const orNode = asNodes(cst.children.orExpression)[0];
	if (!orNode) {
		return { ast: { type: 'MATCH_ALL' }, diagnostics: [], invalidPropertyNodes };
	}

	const ast = lowerOrExpression(orNode);
	return { ast, diagnostics, invalidPropertyNodes };
}
