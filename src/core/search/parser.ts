import { CstParser, type IRecognitionException, type IToken } from 'chevrotain';
import { endOfInputSpan, lowerQueryCst, type ParseQueryResult, tokenToSpan } from './ast-lowering';
import {
	ALL_TOKENS,
	And,
	Colon,
	CompOp,
	DateTimeLiteral,
	HyphenNot,
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
 * Disambiguated LL(k) Chevrotain `CstParser` implementing the 19-rule filter syntax grammar.
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
						{ ALT: () => this.CONSUME(HyphenNot) },
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
			{ ALT: () => this.SUBRULE(this.bareLeafValue) },
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
			this.OR([
				{
					ALT: () => {
						this.CONSUME(Colon);
						this.SUBRULE(this.scopeOrPropRhs);
					},
				},
				{
					ALT: () => {
						this.CONSUME(CompOp);
						this.SUBRULE(this.rhsLeafValue);
					},
				},
			]);
		});
		this.CONSUME(RBracket);
	});

	public readonly scopedOperator = this.RULE('scopedOperator', () => {
		this.SUBRULE(this.scopeName);
		this.CONSUME(Colon);
		this.SUBRULE(this.scopeOrPropRhs);
	});

	public readonly scopeOrPropRhs = this.RULE('scopeOrPropRhs', () => {
		this.OR([
			{
				ALT: () => {
					this.CONSUME(LParen);
					this.SUBRULE(this.valueOrExpr);
					this.CONSUME(RParen);
				},
			},
			{ ALT: () => this.CONSUME(WikiLinkValue) },
			{ ALT: () => this.SUBRULE(this.rhsLeafValue) },
		]);
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
						{ ALT: () => this.CONSUME(HyphenNot) },
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
			{ ALT: () => this.SUBRULE(this.unsignedValueLeaf) },
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

	public readonly bareLeafValue = this.RULE('bareLeafValue', () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString) },
			{ ALT: () => this.CONSUME(RegexLiteral) },
			{ ALT: () => this.CONSUME(DateTimeLiteral) },
			{ ALT: () => this.CONSUME(Identifier) },
		]);
	});

	public readonly unsignedValueLeaf = this.RULE('unsignedValueLeaf', () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString) },
			{ ALT: () => this.CONSUME(RegexLiteral) },
			{ ALT: () => this.CONSUME(DateTimeLiteral) },
			{ ALT: () => this.CONSUME(TagLiteral) },
			{ ALT: () => this.CONSUME(Identifier) },
		]);
	});

	public readonly rhsLeafValue = this.RULE('rhsLeafValue', () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString) },
			{ ALT: () => this.CONSUME(RegexLiteral) },
			{ ALT: () => this.CONSUME(DateTimeLiteral) },
			{ ALT: () => this.CONSUME(TagLiteral) },
			{ ALT: () => this.SUBRULE(this.signedIdentifier) },
		]);
	});

	public readonly signedIdentifier = this.RULE('signedIdentifier', () => {
		this.OPTION(() => {
			this.CONSUME(HyphenNot);
		});
		this.CONSUME(Identifier);
	});
}

const sharedParser = new SearchParser();

function recognitionExceptionToDiagnostic(
	err: IRecognitionException,
	input: string,
	tokens: readonly IToken[],
): SearchDiagnostic {
	const prev = (err as { previousToken?: IToken }).previousToken ?? tokens[tokens.length - 1];
	return {
		code: 'SYNTAX_ERROR',
		severity: 'error',
		issue: err.message,
		hint: null,
		span: tokenToSpan(err.token, prev, input),
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
