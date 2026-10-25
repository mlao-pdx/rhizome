import type { CstElement, CstNode, IToken } from 'chevrotain';
import { createUnquotedMultiwordScopeWarning, createWikilinkBracketsHint } from './linter';
import { decodeQuotedString, decodeRegexLiteral, decodeWikiLinkValue } from './literals';
import { BUILT_IN_SCOPES } from './scopes';
import type {
	LeafMatcher,
	PropertyFilterNode,
	PropertyOperator,
	ScopeDefinition,
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
		rawText: string;
	} {
		const quoted = asTokens(ch.QuotedString)[0];
		if (quoted) {
			return {
				matcher: { kind: 'string', value: decodeQuotedString(quoted.image), quoted: true },
				span: tokenToSpan(quoted),
				rawText: quoted.image,
			};
		}
		const regex = asTokens(ch.RegexLiteral)[0];
		if (regex) {
			const { pattern, flags } = decodeRegexLiteral(regex.image);
			return {
				matcher: { kind: 'regex', pattern, flags },
				span: tokenToSpan(regex),
				rawText: regex.image,
			};
		}
		const tok =
			asTokens(ch.DateTimeLiteral)[0] ??
			asTokens(ch.TagLiteral)[0] ??
			asTokens(ch.Identifier)[0]!;
		return {
			matcher: { kind: 'string', value: tok.image, quoted: false },
			span: tokenToSpan(tok),
			rawText: tok.image,
		};
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
			},
			span,
			parenthesized: false,
		};
	}

	function lowerRhsLeafValue(node: CstNode): LoweredValueExpr {
		const signed = asNodes(node.children.signedIdentifier)[0];
		if (signed) {
			const hyphen = asTokens(signed.children.HyphenNot)[0];
			const id = asTokens(signed.children.Identifier)[0]!;
			const idSpan = tokenToSpan(id);
			if (hyphen) {
				const hyphenSpan = tokenToSpan(hyphen);
				const span = mergeSpans(hyphenSpan, idSpan);
				if (hyphen.endOffset === undefined || hyphen.endOffset + 1 !== id.startOffset) {
					diagnostics.push({
						code: 'SYNTAX_ERROR',
						severity: 'error',
						issue: 'Whitespace is not allowed between "-" and identifier in signed value.',
						hint: `Use "-${id.image}"`,
						span,
					});
				}
				return {
					expr: {
						type: 'VALUE_LEAF',
						matcher: { kind: 'string', value: `-${id.image}`, quoted: false },
					},
					span,
					parenthesized: false,
				};
			}
			return {
				expr: {
					type: 'VALUE_LEAF',
					matcher: { kind: 'string', value: id.image, quoted: false },
				},
				span: idSpan,
				parenthesized: false,
			};
		}
		const leaf = lowerLeafTokens(node.children);
		return {
			expr: { type: 'VALUE_LEAF', matcher: leaf.matcher },
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
		return {
			expr: {
				type: 'VALUE_LOGICAL',
				operator: 'OR',
				children: lowered.map((item) => item.expr),
			},
			span: mergeSpans(first.span, last.span),
			parenthesized: false,
		};
	}

	function lowerValueAndExpr(node: CstNode): LoweredValueExpr {
		const subNodes = [...asNodes(node.children.lhs), ...asNodes(node.children.rhs)];
		const lowered = subNodes.map(lowerValueNotExpr);
		if (lowered.length === 1) return lowered[0]!;
		const first = lowered[0]!;
		const last = lowered[lowered.length - 1]!;
		return {
			expr: {
				type: 'VALUE_LOGICAL',
				operator: 'AND',
				children: lowered.map((item) => item.expr),
			},
			span: mergeSpans(first.span, last.span),
			parenthesized: false,
		};
	}

	function lowerValueNotExpr(node: CstNode): LoweredValueExpr {
		const ch = node.children;
		const notTok = asTokens(ch.Not)[0];
		const hyphenTok = asTokens(ch.HyphenNot)[0];
		if (notTok || hyphenTok) {
			const opTok = (notTok ?? hyphenTok)!;
			const child = lowerValueNotExpr(asNodes(ch.operand)[0]!);
			return {
				expr: {
					type: 'VALUE_NOT',
					syntax: notTok ? 'NOT' : '-',
					child: child.expr,
				},
				span: mergeSpans(tokenToSpan(opTok), child.span),
				parenthesized: false,
			};
		}
		const lparen = asTokens(ch.LParen)[0];
		if (lparen) {
			const rparen = asTokens(ch.RParen)[0]!;
			const inner = lowerValueOrExpr(asNodes(ch.valueOrExpr)[0]!);
			return {
				expr: inner.expr,
				span: mergeSpans(tokenToSpan(lparen), tokenToSpan(rparen)),
				parenthesized: true,
			};
		}
		const wikiTok = asTokens(ch.WikiLinkValue)[0];
		if (wikiTok) return lowerWikiLinkToken(wikiTok);

		const unsigned = asNodes(ch.unsignedValueLeaf)[0]!;
		const leaf = lowerLeafTokens(unsigned.children);
		return {
			expr: { type: 'VALUE_LEAF', matcher: leaf.matcher },
			span: leaf.span,
			parenthesized: false,
		};
	}

	function lowerScopeOrPropRhs(node: CstNode): LoweredValueExpr {
		const ch = node.children;
		const lparen = asTokens(ch.LParen)[0];
		if (lparen) {
			const rparen = asTokens(ch.RParen)[0]!;
			const inner = lowerValueOrExpr(asNodes(ch.valueOrExpr)[0]!);
			return {
				expr: inner.expr,
				span: mergeSpans(tokenToSpan(lparen), tokenToSpan(rparen)),
				parenthesized: true,
			};
		}
		const wikiTok = asTokens(ch.WikiLinkValue)[0];
		if (wikiTok) return lowerWikiLinkToken(wikiTok);

		return lowerRhsLeafValue(asNodes(ch.rhsLeafValue)[0]!);
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
			const colon = asTokens(prop.children.Colon)[0];
			const compOp = asTokens(prop.children.CompOp)[0];
			let propNode: PropertyFilterNode;
			if (colon) {
				const rhs = lowerScopeOrPropRhs(asNodes(prop.children.scopeOrPropRhs)[0]!);
				propNode = {
					type: 'PROPERTY_FILTER',
					key,
					rawKey,
					operator: ':',
					valueExpr: rhs.expr,
					span,
				};
			} else if (compOp) {
				const rhs = lowerRhsLeafValue(asNodes(prop.children.rhsLeafValue)[0]!);
				propNode = {
					type: 'PROPERTY_FILTER',
					key,
					rawKey,
					operator: compOp.image as PropertyOperator,
					valueExpr: rhs.expr,
					span,
				};
			} else {
				propNode = {
					type: 'PROPERTY_FILTER',
					key,
					rawKey,
					operator: 'EXISTS',
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
			const trimmedScope = rawScope.trim();
			const scope =
				BUILT_IN_SCOPE_MAP.get(trimmedScope.toLowerCase())?.canonicalName ?? trimmedScope;
			const rhs = lowerScopeOrPropRhs(asNodes(scoped.children.scopeOrPropRhs)[0]!);
			return {
				type: 'SCOPED_FILTER',
				scope,
				rawScope,
				expr: rhs.expr,
				span: mergeSpans(tokenToSpan(scopeTok), rhs.span),
			};
		}

		const tagShort = asNodes(ch.tagShorthand)[0];
		if (tagShort) {
			const tagTok = asTokens(tagShort.children.TagLiteral)[0]!;
			return {
				type: 'SCOPED_FILTER',
				scope: 'tag',
				rawScope: '#',
				expr: {
					type: 'VALUE_LEAF',
					matcher: { kind: 'string', value: tagTok.image, quoted: false },
				},
				span: tokenToSpan(tagTok),
			};
		}

		const bare = asNodes(ch.bareLeafValue)[0]!;
		const leaf = lowerLeafTokens(bare.children);
		return {
			type: 'TEXT_MATCH',
			matcher: leaf.matcher,
			rawText: leaf.rawText,
			span: leaf.span,
		};
	}

	function lowerNotExpression(node: CstNode): SearchAST {
		const ch = node.children;
		const notTok = asTokens(ch.Not)[0];
		const hyphenTok = asTokens(ch.HyphenNot)[0];
		if (notTok || hyphenTok) {
			const opTok = (notTok ?? hyphenTok)!;
			const child = lowerNotExpression(asNodes(ch.operand)[0]!);
			const opSpan = tokenToSpan(opTok);
			const span = 'span' in child && child.span ? mergeSpans(opSpan, child.span) : opSpan;
			return {
				type: 'NOT',
				syntax: notTok ? 'NOT' : '-',
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

		for (let i = 0; i < children.length - 1; i++) {
			const left = children[i]!;
			const right = children[i + 1]!;
			if (
				left.type === 'SCOPED_FILTER' &&
				right.type === 'TEXT_MATCH' &&
				left.span &&
				right.span &&
				left.span.startLine === right.span.startLine &&
				left.expr.type === 'VALUE_LEAF' &&
				left.expr.matcher.kind === 'string' &&
				!left.expr.matcher.quoted &&
				right.matcher.kind === 'string' &&
				!right.matcher.quoted
			) {
				const hasExplicitAnd = andTokens.some(
					(t) =>
						t.startOffset >= left.span!.endOffset &&
						t.startOffset <= right.span!.startOffset,
				);
				if (!hasExplicitAnd) {
					const leftVal = left.expr.matcher.value;
					const nextVal = right.rawText;
					diagnostics.push(
						createUnquotedMultiwordScopeWarning(
							left.scope,
							leftVal,
							nextVal,
							mergeSpans(left.span, right.span),
						),
					);
				}
			}
		}

		if (children.length === 1) return children[0]!;
		const firstChild = children[0]!;
		const firstSpan = 'span' in firstChild ? firstChild.span : undefined;
		const lastChild = children[children.length - 1]!;
		const lastSpan = 'span' in lastChild ? lastChild.span : undefined;
		return {
			type: 'LOGICAL',
			operator: 'AND',
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
