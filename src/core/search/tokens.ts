import { createToken, Lexer, type TokenType } from 'chevrotain';

export const WhiteSpace = createToken({
	name: 'WhiteSpace',
	pattern: /\s+/,
	group: Lexer.SKIPPED,
});

export const WikiLinkValue = createToken({
	name: 'WikiLinkValue',
	pattern: /\[\[[^\]\r\n]+\]\]/,
	label: '[[wikilink]]',
});

export const LParen = createToken({ name: 'LParen', pattern: /\(/, label: '(' });
export const RParen = createToken({ name: 'RParen', pattern: /\)/, label: ')' });
export const LBracket = createToken({ name: 'LBracket', pattern: /\[/, label: '[' });
export const RBracket = createToken({ name: 'RBracket', pattern: /\]/, label: ']' });

// Anchor-free boundary assertion: succeeds before whitespace, (), [], or EOF
export const Or = createToken({ name: 'Or', pattern: /OR(?![^\s()[\]])/, label: 'OR' });
export const And = createToken({ name: 'And', pattern: /AND(?![^\s()[\]])/, label: 'AND' });
export const Not = createToken({ name: 'Not', pattern: /NOT(?![^\s()[\]])/, label: 'NOT' });

export const BangNot = createToken({ name: 'BangNot', pattern: /!(?![=\s])/, label: '!' });

/**
 * Matches:
 * - ISO dates/datetimes (with optional `±Nd` day offset on `YYYY-MM-DD`)
 * - `@now`, `@today`, `@yesterday`, `@tomorrow`, `@(last|this|next)(day|week|month|quarter|year)` (with optional `±Nd?` offset)
 * - Any `<Atom1>..<Atom2>` range (including `YYYY..YYYY-MM`, `2026-10-22..2026`, `@thisyear..@today`, `@today..@today-7d`, etc.)
 */
export const DateTimeLiteral = createToken({
	name: 'DateTimeLiteral',
	pattern:
		/(?:(?:\d{4}-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)|(?:[+-]\d+d))?)?|@[a-zA-Z0-9_+-]+)(?:\.\.(?:\d{4}(?:-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)|(?:[+-]\d+d))?)?)?|@[a-zA-Z0-9_+-]+))?|\d{4}\.\.(?:\d{4}(?:-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)|(?:[+-]\d+d))?)?)?|@[a-zA-Z0-9_+-]+))(?![^\s()[\]])/,
	label: 'date literal',
});

export const Colon = createToken({ name: 'Colon', pattern: /:/, label: ':' });
export const CompOp = createToken({
	name: 'CompOp',
	pattern: /!=|>=|<=|>|<|=/,
	label: 'comparison operator',
});

export const RegexLiteral = createToken({
	name: 'RegexLiteral',
	pattern: /\/(?:\\.|[^/\\\r\n])+\/[a-zA-Z]*/,
	label: '/regex/',
});

export const QuotedString = createToken({
	name: 'QuotedString',
	pattern: /"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/,
	label: 'quoted string',
});

export const TagLiteral = createToken({
	name: 'TagLiteral',
	pattern: /#[a-zA-Z0-9_\-/]+/,
	label: '#tag',
});

export const Identifier = createToken({
	name: 'Identifier',
	pattern: /[^\s()[\]:"'><=!]+/,
	label: 'identifier',
});

export const ALL_TOKENS: TokenType[] = [
	WhiteSpace,
	WikiLinkValue,
	LParen,
	RParen,
	LBracket,
	RBracket,
	Or,
	And,
	Not,
	BangNot,
	DateTimeLiteral,
	Colon,
	CompOp,
	RegexLiteral,
	QuotedString,
	TagLiteral,
	Identifier,
];

export const SearchLexer = new Lexer(ALL_TOKENS);
