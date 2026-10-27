# Filter Syntax Railroad Diagrams

> **Auto-generated from [`src/core/search/parser.ts`](../../src/core/search/parser.ts) and [`src/core/search/tokens.ts`](../../src/core/search/tokens.ts).**
> Normative semantics, type coercion, and diagnostic rules are specified in [`docs/spec/Filter Syntax.md`](../spec/Filter%20Syntax.md).

## Overview

Rhizome parses filter queries with a single-pass Chevrotain lexer and a disambiguated LL(k) `CstParser` (`SearchParser`) comprising **19 grammar productions** and **16 lexical tokens** (plus skipped whitespace).

### Visual Legend

- **Rounded pills** (blue) represent **lexical terminals** consumed directly from the token stream (labelled with their human-readable token `label`, e.g. `'['`, `'OR'`, `'quoted string'`, `'comparison operator'`).
- **Rectangular boxes** (purple) represent **non-terminal subrules** referencing another production in this document.
- **Syntactic Resource Limits**: Maximum query length is **`4096` UTF-16 code units**; maximum syntactic nesting depth across unary negation (`NOT` / `-`) and parenthesized groups (`(...)`) is **`32` levels**.

## 1. Top-Level Query & Document Boolean Expressions

These productions define top-level query entry, operator precedence (`OR` < `AND` < `NOT`/`-`), implicit conjunction, and atomic document filters.

### `query`

Entry rule for filter queries. An empty or whitespace-only query lowers to `MATCH_ALL`.

```ebnf
Query ::= OrExpression? EOF
```

![query](./assets/query.svg)

### `orExpression`

Document-level disjunction (`OR`). Lower precedence than `AND` and unary negation.

```ebnf
OrExpression ::= AndExpression ( "OR" AndExpression )*
```

![orExpression](./assets/orExpression.svg)

### `andExpression`

Document-level conjunction. Adjacent expressions without an explicit `AND` keyword are implicitly conjoined.

```ebnf
AndExpression ::= NotExpression ( "AND"? NotExpression )*
```

![andExpression](./assets/andExpression.svg)

### `notExpression`

Document-level unary negation (`NOT` or prefix `-`) or a `Primary` filter atom. Each negation increments syntactic nesting depth by `+1`.

```ebnf
NotExpression ::= ( "NOT" | HyphenNot ) NotExpression | Primary
```

![notExpression](./assets/notExpression.svg)

### `primary`

Disambiguated atomic document-level filter unit: parenthesized group, bracketed property filter, `scope:value` operator, `#tag` shorthand, or bare full-text search term.

```ebnf
Primary ::= Parenthesized | PropertyFilter | ScopedOperator | TagShorthand | BareLeafValue
```

![primary](./assets/primary.svg)

### `parenthesized`

Groups a document-level boolean expression inside `(...)`. Increments syntactic nesting depth by `+1`.

```ebnf
Parenthesized ::= "(" OrExpression ")"
```

![parenthesized](./assets/parenthesized.svg)

## 2. Property Filters & Scoped Operators

Bracketed property filters (`[key]`, `[key: value]`, `[key op value]`) and `scope:value` operators share a common right-hand side production (`scopeOrPropRhs`).

### `propertyFilter`

Bracketed frontmatter or virtual file property filter (`[key]` existence check, `[key: value]` colon match, or `[key >= value]` comparison).

```ebnf
PropertyFilter ::= "[" PropertyKey ( ":" ScopeOrPropRhs | CompOp RhsLeafValue )? "]"
```

![propertyFilter](./assets/propertyFilter.svg)

### `scopedOperator`

Scoped filter operator (`tag:`, `file:`, `path:`, `content:`, `headings:`, `links:`, or registered custom scopes).

```ebnf
ScopedOperator ::= ScopeName ":" ScopeOrPropRhs
```

![scopedOperator](./assets/scopedOperator.svg)

### `scopeOrPropRhs`

Right-hand side of a `scope:` or `[key: ...]` filter: a parenthesized value-level boolean expression, a `[[wikilink]]`, or a single leaf value.

```ebnf
ScopeOrPropRhs ::= "(" ValueOrExpr ")" | WikiLinkValue | RhsLeafValue
```

![scopeOrPropRhs](./assets/scopeOrPropRhs.svg)

## 3. Parenthesized Value-Level Boolean Expressions

Inside `scope:(...)` or `[key:(...)]`, boolean operators combine value matchers within that scope or property without repeating the prefix.

### `valueOrExpr`

Value-level disjunction inside `scope:(...)` or `[key:(...)]`, evaluated against the same scope or property.

```ebnf
ValueOrExpr ::= ValueAndExpr ( "OR" ValueAndExpr )*
```

![valueOrExpr](./assets/valueOrExpr.svg)

### `valueAndExpr`

Value-level conjunction inside `scope:(...)` or `[key:(...)]`. Supports both explicit `AND` and implicit juxtaposition.

```ebnf
ValueAndExpr ::= ValueNotExpr ( "AND"? ValueNotExpr )*
```

![valueAndExpr](./assets/valueAndExpr.svg)

### `valueNotExpr`

Value-level negation, nested parenthesized value group, `[[wikilink]]`, or unsigned leaf value. Both unary negation and `(` increment syntactic nesting depth by `+1`.

```ebnf
ValueNotExpr ::= ( "NOT" | HyphenNot ) ValueNotExpr | "(" ValueOrExpr ")" | WikiLinkValue | UnsignedValueLeaf
```

![valueNotExpr](./assets/valueNotExpr.svg)

## 4. Keys, Scopes & Leaf Values

Terminal-level productions disambiguating property keys, scope identifiers, `#tag` shorthands, bare full-text terms, parenthesized unsigned leaves, and unparenthesized signed RHS leaves.

### `propertyKey`

Frontmatter or virtual property name inside `[...]`. Quoted strings allow spaces and special characters (e.g. `["Due Date" < @today]`).

```ebnf
PropertyKey ::= QuotedString | Identifier
```

![propertyKey](./assets/propertyKey.svg)

### `scopeName`

Unquoted identifier naming a built-in scope (or alias) or a custom scope before `:`.

```ebnf
ScopeName ::= Identifier
```

![scopeName](./assets/scopeName.svg)

### `tagShorthand`

Top-level `#tag` shorthand (e.g. `#work/urgent`), lowered identically to `tag:#work/urgent`.

```ebnf
TagShorthand ::= TagLiteral
```

![tagShorthand](./assets/tagShorthand.svg)

### `bareLeafValue`

Unscoped full-text search term matched against note title/filename, aliases, and body text.

```ebnf
BareLeafValue ::= QuotedString | RegexLiteral | DateTimeLiteral | Identifier
```

![bareLeafValue](./assets/bareLeafValue.svg)

### `unsignedValueLeaf`

Leaf value inside parenthesized value expressions (`ValueNotExpr`), where a leading `-` is always parsed as unary value negation (`VALUE_NOT`).

```ebnf
UnsignedValueLeaf ::= QuotedString | RegexLiteral | DateTimeLiteral | TagLiteral | Identifier
```

![unsignedValueLeaf](./assets/unsignedValueLeaf.svg)

### `rhsLeafValue`

Unparenthesized right-hand leaf value after `:` or a comparison operator (`=`, `!=`, `<`, `<=`, `>`, `>=`), permitting signed numeric/identifier literals via `SignedIdentifier`.

```ebnf
RhsLeafValue ::= QuotedString | RegexLiteral | DateTimeLiteral | TagLiteral | SignedIdentifier
```

![rhsLeafValue](./assets/rhsLeafValue.svg)

### `signedIdentifier`

Optional leading `-` immediately adjacent to an `Identifier` (`hyphen.endOffset + 1 === id.startOffset`), allowing unparenthesized negative numbers (`[score >= -10.5]`) and hyphen-prefixed filenames (`file:-draft`).

```ebnf
SignedIdentifier ::= HyphenNot? Identifier
```

![signedIdentifier](./assets/signedIdentifier.svg)

## 5. Lexical Tokens Reference

Tokens are evaluated by `SearchLexer` in priority order (`ALL_TOKENS`). Every non-skipped token defines a concise `label` used in both the railroad diagrams above and runtime `SYNTAX_ERROR` messages.

| Priority | Token Name        | Diagram & Diagnostic `label` | Pattern                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `WhiteSpace`      | _(skipped)_                  | `/\s+/`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2        | `WikiLinkValue`   | `'[[wikilink]]'`             | `/\[\[[^\]\r\n]+\]\]/`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3        | `LParen`          | `'('`                        | `/\(/`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4        | `RParen`          | `')'`                        | `/\)/`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5        | `LBracket`        | `'['`                        | `/\[/`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6        | `RBracket`        | `']'`                        | `/\]/`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7        | `Or`              | `'OR'`                       | `/OR(?![^\s()[\]])/`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 8        | `And`             | `'AND'`                      | `/AND(?![^\s()[\]])/`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 9        | `Not`             | `'NOT'`                      | `/NOT(?![^\s()[\]])/`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10       | `HyphenNot`       | `'-'`                        | `/-(?=\S)/`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 11       | `DateTimeLiteral` | `'date literal'`             | `/(?:(?:\d{4}-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z\|[+-]\d{2}:?\d{2})?)\|(?:[+-]\d+d))?)?\|@[a-zA-Z0-9_+-]+)(?:\.\.(?:\d{4}(?:-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z\|[+-]\d{2}:?\d{2})?)\|(?:[+-]\d+d))?)?)?\|@[a-zA-Z0-9_+-]+))?\|\d{4}\.\.(?:\d{4}(?:-\d{2}(?:-\d{2}(?:(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z\|[+-]\d{2}:?\d{2})?)\|(?:[+-]\d+d))?)?)?\|@[a-zA-Z0-9_+-]+))(?![^\s()[\]])/` |
| 12       | `Colon`           | `':'`                        | `/:/`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13       | `CompOp`          | `'comparison operator'`      | `/!=\|>=\|<=\|>\|<\|=/`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 14       | `RegexLiteral`    | `'/regex/'`                  | `/\/(?:\\.\|[^/\\\r\n])+\/[a-zA-Z]*/`                                                                                                                                                                                                                                                                                                                                                                                                    |
| 15       | `QuotedString`    | `'quoted string'`            | `/"(?:\\.\|[^"\\\r\n])*"\|'(?:\\.\|[^'\\\r\n])*'/`                                                                                                                                                                                                                                                                                                                                                                                       |
| 16       | `TagLiteral`      | `'#tag'`                     | `/#[a-zA-Z0-9_\-/]+/`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 17       | `Identifier`      | `'identifier'`               | `/[^\s()[\]:"'><=!]+/`                                                                                                                                                                                                                                                                                                                                                                                                                   |
