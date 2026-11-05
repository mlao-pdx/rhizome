import { CstParser, type IRecognitionException, type IToken } from 'chevrotain';
import {
	endOfInputSpan,
	lowerQueryCst,
	mergeSpans,
	type ParseQueryResult,
	resolveBuiltInScopeCanonicalName,
	tokenToSpan,
} from './ast-lowering';
import {
	ALL_TOKENS,
	And,
	BangNot,
	Colon,
	CompOp,
	DateTimeLiteral,
	Identifier,
	LBracket,
	LParen,
	Not,
	Or,
	QuotedString,
	RBracket,
	RegexLiteral,
	RParen,
	SearchLexer,
	TagLiteral,
	ThisReference,
	WikiLinkValue,
} from './tokens';
import type { PropertyFilterNode, SearchAST, SearchDiagnostic } from './types';

export const MAX_QUERY_LENGTH = 4096;
export const MAX_SYNTACTIC_DEPTH = 32;

export class MaxDepthExceededError extends Error {
	readonly token: IToken;

	constructor(token: IToken) {
		super(`Query exceeds maximum syntactic nesting depth of ${MAX_SYNTACTIC_DEPTH}.`);
		this.name = 'MaxDepthExceededError';
		this.token = token;
	}
}

/**
 * Disambiguated LL(k) Chevrotain `CstParser` implementing the 15-rule filter syntax grammar.
 */
export class SearchParser extends CstParser {
	private currentDepth = 0;

	constructor() {
		super(ALL_TOKENS, { recoveryEnabled: false });
		this.performSelfAnalysis();
	}

	public resetDepth(): void {
		this.currentDepth = 0;
	}

	private withDepth<T>(token: IToken, fn: () => T): T {
		if (this.RECORDING_PHASE) {
			return fn();
		}
		this.currentDepth++;
		if (this.currentDepth > MAX_SYNTACTIC_DEPTH) {
			throw new MaxDepthExceededError(token);
		}
		try {
			return fn();
		} finally {
			this.currentDepth--;
		}
	}

	public readonly query = this.RULE('query', () => {
		this.OPTION(() => {
			this.SUBRULE(this.orExpression);
		});
	});

	public readonly orExpression = this.RULE('orExpression', () => {
		this.SUBRULE(this.andExpression, { LABEL: 'lhs' });
		this.MANY(() => {
			this.CONSUME(Or);
			this.SUBRULE2(this.andExpression, { LABEL: 'rhs' });
		});
	});

	public readonly andExpression = this.RULE('andExpression', () => {
		this.SUBRULE(this.notExpression, { LABEL: 'lhs' });
		this.MANY(() => {
			this.OPTION(() => {
				this.CONSUME(And);
			});
			this.SUBRULE2(this.notExpression, { LABEL: 'rhs' });
		});
	});

	public readonly notExpression = this.RULE('notExpression', () => {
		this.OR([
			{
				ALT: () => {
					const opTok = this.OR2([
						{ ALT: () => this.CONSUME(Not) },
						{ ALT: () => this.CONSUME(BangNot) },
					]);
					this.withDepth(opTok, () => {
						this.SUBRULE(this.notExpression, { LABEL: 'operand' });
					});
				},
			},
			{
				ALT: () => {
					this.SUBRULE(this.primary);
				},
			},
		]);
	});

	public readonly primary = this.RULE('primary', () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.parenthesized) },
			{ ALT: () => this.SUBRULE(this.propertyFilter) },
			{ ALT: () => this.SUBRULE(this.scopedOperator) },
			{ ALT: () => this.SUBRULE(this.tagShorthand) },
		]);
	});

	public readonly parenthesized = this.RULE('parenthesized', () => {
		const lparen = this.CONSUME(LParen);
		this.withDepth(lparen, () => {
			this.SUBRULE(this.orExpression);
		});
		this.CONSUME(RParen);
	});

	public readonly propertyFilter = this.RULE('propertyFilter', () => {
		this.CONSUME(LBracket);
		this.SUBRULE(this.propertyKey);
		this.OPTION(() => {
			this.CONSUME(Colon);
			this.OPTION2(() => {
				this.OR([
					{
						ALT: () => {
							this.CONSUME(CompOp);
							this.SUBRULE(this.valueLeaf);
						},
					},
					{
						ALT: () => {
							this.SUBRULE(this.valueNotExpr);
						},
					},
				]);
			});
		});
		this.CONSUME(RBracket);
	});

	public readonly scopedOperator = this.RULE('scopedOperator', () => {
		this.SUBRULE(this.scopeName);
		this.CONSUME(Colon);
		this.SUBRULE(this.valueNotExpr);
	});

	public readonly valueOrExpr = this.RULE('valueOrExpr', () => {
		this.SUBRULE(this.valueAndExpr, { LABEL: 'lhs' });
		this.MANY(() => {
			this.CONSUME(Or);
			this.SUBRULE2(this.valueAndExpr, { LABEL: 'rhs' });
		});
	});

	public readonly valueAndExpr = this.RULE('valueAndExpr', () => {
		this.SUBRULE(this.valueNotExpr, { LABEL: 'lhs' });
		this.MANY(() => {
			this.OPTION(() => {
				this.CONSUME(And);
			});
			this.SUBRULE2(this.valueNotExpr, { LABEL: 'rhs' });
		});
	});

	public readonly valueNotExpr = this.RULE('valueNotExpr', () => {
		this.OR([
			{
				ALT: () => {
					const opTok = this.OR2([
						{ ALT: () => this.CONSUME(Not) },
						{ ALT: () => this.CONSUME(BangNot) },
					]);
					this.withDepth(opTok, () => {
						this.SUBRULE(this.valueNotExpr, { LABEL: 'operand' });
					});
				},
			},
			{
				ALT: () => {
					const lparen = this.CONSUME(LParen);
					this.withDepth(lparen, () => {
						this.SUBRULE(this.valueOrExpr);
					});
					this.CONSUME(RParen);
				},
			},
			{ ALT: () => this.CONSUME(WikiLinkValue) },
			{ ALT: () => this.SUBRULE(this.valueLeaf) },
		]);
	});

	public readonly propertyKey = this.RULE('propertyKey', () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString) },
			{ ALT: () => this.CONSUME(Identifier) },
		]);
	});

	public readonly scopeName = this.RULE('scopeName', () => {
		this.CONSUME(Identifier);
	});

	public readonly tagShorthand = this.RULE('tagShorthand', () => {
		this.CONSUME(TagLiteral);
	});

	public readonly valueLeaf = this.RULE('valueLeaf', () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString) },
			{ ALT: () => this.CONSUME(RegexLiteral) },
			{ ALT: () => this.CONSUME(ThisReference) },
			{ ALT: () => this.CONSUME(DateTimeLiteral) },
			{ ALT: () => this.CONSUME(TagLiteral) },
			{ ALT: () => this.CONSUME(Identifier) },
		]);
	});
}

const sharedParser = new SearchParser();

function isUnquotedValueToken(tok: IToken | undefined): tok is IToken {
	return (
		tok !== undefined &&
		(tok.tokenType === Identifier ||
			tok.tokenType === ThisReference ||
			tok.tokenType === DateTimeLiteral ||
			tok.tokenType === TagLiteral)
	);
}

function isBareLiteralToken(tok: IToken | undefined): tok is IToken {
	return (
		tok !== undefined &&
		(tok.tokenType === QuotedString ||
			tok.tokenType === RegexLiteral ||
			tok.tokenType === ThisReference ||
			tok.tokenType === DateTimeLiteral ||
			tok.tokenType === WikiLinkValue)
	);
}

function recognitionExceptionToDiagnostic(
	err: IRecognitionException,
	input: string,
	tokens: readonly IToken[],
): SearchDiagnostic {
	const prevTok = (err as { previousToken?: IToken }).previousToken;
	const fallback = prevTok ?? tokens[tokens.length - 1];
	const ruleStack = err.context?.ruleStack ?? [];
	const topRule = ruleStack[ruleStack.length - 1];

	if (
		err.name === 'MismatchedTokenException' &&
		topRule === 'scopedOperator' &&
		prevTok?.tokenType === Identifier
	) {
		const raw = prevTok.image;
		const upper = raw.toUpperCase();
		if ((upper === 'AND' || upper === 'OR' || upper === 'NOT') && raw !== upper) {
			return {
				code: 'SYNTAX_ERROR',
				severity: 'error',
				issue: `Lowercase "${raw}" is not a valid logical operator.`,
				hint: `Use uppercase "${upper}".`,
				span: tokenToSpan(prevTok, fallback, input),
			};
		}

		const prevIdx = tokens.findIndex((t) => t.startOffset === prevTok.startOffset);
		if (prevIdx >= 3) {
			const scopeTok = tokens[prevIdx - 3];
			const colonTok = tokens[prevIdx - 2];
			const valTok = tokens[prevIdx - 1];
			const beforeScopeTok = prevIdx >= 4 ? tokens[prevIdx - 4] : undefined;
			if (
				scopeTok?.tokenType === Identifier &&
				colonTok?.tokenType === Colon &&
				isUnquotedValueToken(valTok) &&
				beforeScopeTok?.tokenType !== LBracket &&
				scopeTok.startLine !== undefined &&
				scopeTok.startLine === prevTok.startLine
			) {
				const scopeName = resolveBuiltInScopeCanonicalName(scopeTok.image);
				return {
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: `"${raw}" is not inside "${scopeName}:"; bare search terms are not supported.`,
					hint: `Use ${scopeName}:"${valTok.image} ${raw}"`,
					span: mergeSpans(
						tokenToSpan(scopeTok, fallback, input),
						tokenToSpan(prevTok, fallback, input),
					),
				};
			}
		}

		if (raw.startsWith('-')) {
			return {
				code: 'SYNTAX_ERROR',
				severity: 'error',
				issue: `Bare term "${raw}" is not allowed (hyphen negation is not supported).`,
				hint: 'Use "!" or "NOT" to negate a filter (e.g. "!tag:..." or "![prop]").',
				span: tokenToSpan(prevTok, fallback, input),
			};
		}

		return {
			code: 'SYNTAX_ERROR',
			severity: 'error',
			issue: `Bare search term "${raw}" is not supported.`,
			hint: `Specify a scope (e.g. "file:${raw}", "aliases:${raw}", "#${raw}") or a property filter ("[prop:${raw}]").`,
			span: tokenToSpan(prevTok, fallback, input),
		};
	}

	if (
		isBareLiteralToken(err.token) &&
		(err.name === 'NoViableAltException' ||
			err.name === 'NotAllInputParsedException' ||
			(err.name === 'MismatchedTokenException' && topRule === 'parenthesized'))
	) {
		const raw = err.token.image;
		return {
			code: 'SYNTAX_ERROR',
			severity: 'error',
			issue: `Bare search term ${raw} is not supported.`,
			hint: `Specify a scope (e.g. "file:${raw}") or a property filter ("[prop:${raw}]").`,
			span: tokenToSpan(err.token, fallback, input),
		};
	}

	return {
		code: 'SYNTAX_ERROR',
		severity: 'error',
		issue: err.message,
		hint: null,
		span: tokenToSpan(err.token, fallback, input),
	};
}

const EMPTY_INVALID_PROP_NODES: ReadonlySet<PropertyFilterNode> = new Set();

export interface ParseAndLowerResult {
	readonly ast: SearchAST | null;
	readonly diagnostics: SearchDiagnostic[];
	readonly invalidPropertyNodes: ReadonlySet<PropertyFilterNode>;
}

/**
 * Internal helper that lexes, parses, and lowers `input` into a `SearchAST` while retaining
 * the lowered AST and `invalidPropertyNodes` when lowering-time `SYNTAX_ERROR`s occur.
 */
export function parseAndLowerQuery(input: string): ParseAndLowerResult {
	if (input.length > MAX_QUERY_LENGTH) {
		return {
			ast: null,
			diagnostics: [
				{
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: `Query length (${input.length}) exceeds maximum allowed length of ${MAX_QUERY_LENGTH} characters.`,
					hint: null,
					span: {
						startOffset: MAX_QUERY_LENGTH,
						endOffset: input.length,
						startLine: 1,
						startColumn: MAX_QUERY_LENGTH + 1,
					},
				},
			],
			invalidPropertyNodes: EMPTY_INVALID_PROP_NODES,
		};
	}

	const lexResult = SearchLexer.tokenize(input);
	if (lexResult.errors.length > 0) {
		return {
			ast: null,
			diagnostics: lexResult.errors.map((err) => ({
				code: 'SYNTAX_ERROR',
				severity: 'error',
				issue: err.message,
				hint: null,
				span: {
					startOffset: err.offset,
					endOffset: Math.min(input.length, err.offset + Math.max(1, err.length)),
					startLine: err.line ?? 1,
					startColumn: err.column ?? 1,
				},
			})),
			invalidPropertyNodes: EMPTY_INVALID_PROP_NODES,
		};
	}

	sharedParser.input = lexResult.tokens;
	sharedParser.resetDepth();

	try {
		const cst = sharedParser.query();
		if (sharedParser.errors.length > 0) {
			return {
				ast: null,
				diagnostics: sharedParser.errors.map((err) =>
					recognitionExceptionToDiagnostic(err, input, lexResult.tokens),
				),
				invalidPropertyNodes: EMPTY_INVALID_PROP_NODES,
			};
		}
		return lowerQueryCst(cst);
	} catch (err) {
		if (err instanceof MaxDepthExceededError) {
			return {
				ast: null,
				diagnostics: [
					{
						code: 'SYNTAX_ERROR',
						severity: 'error',
						issue: err.message,
						hint: null,
						span: tokenToSpan(
							err.token,
							lexResult.tokens[lexResult.tokens.length - 1],
							input,
						),
					},
				],
				invalidPropertyNodes: EMPTY_INVALID_PROP_NODES,
			};
		}
		return {
			ast: null,
			diagnostics: [
				{
					code: 'SYNTAX_ERROR',
					severity: 'error',
					issue: err instanceof Error ? err.message : 'Unexpected syntax error.',
					hint: null,
					span: endOfInputSpan(input),
				},
			],
			invalidPropertyNodes: EMPTY_INVALID_PROP_NODES,
		};
	}
}

/**
 * Lexes, parses, and lowers `input` into a `SearchAST` with syntactic limit enforcement (`4096` chars, depth `32`).
 */
export function parseQuery(input: string): ParseQueryResult {
	const res = parseAndLowerQuery(input);
	const hasError = res.diagnostics.some((d) => d.severity === 'error');
	return {
		ast: hasError ? null : res.ast,
		diagnostics: res.diagnostics,
	};
}
