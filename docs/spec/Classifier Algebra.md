# Inline Property Classifier Algebra: Specification

## 1. Scope and Seam

This specification defines `classify(input)` as a pure, standalone function: string in, ordered list of `(key, contexts[])` entries—or an invalid-classifier error—out.

- **Carrier-agnostic:** `classify` knows nothing about assignment tokens (`::`), comment delimiters (`%%`), list markers, or rendering.
- **Consumers:**
  1. The Inline Property parser calls `classify` on the header slice preceding an unescaped `::` (using this specification's **escape unit** and **control-character rule** while scanning for `::`).
  2. The YAML frontmatter normalizer may call `classify` on raw frontmatter keys (for example, `rating>(book|author): 4.5`). When `classify` returns invalid on a frontmatter key, the normalizer falls back to treating the raw key string as a single key with no contexts.

## 2. Characters, Names, and Escapes

- **Reserved characters:** `(`, `)`, `>`, `|`, and `\`.
  - Note: Single `:` and `::` are ordinary name characters to `classify` when called standalone (inline callers stop at the leftmost unescaped `::` before invoking `classify`).
- **Escape unit:** A backslash `\` makes the character immediately following it an ordinary name character (`\>`, `\:`, `\(`, `\)`, `\[`, `\\`, `\ `). A backslash before any unreserved character is dropped (`a\b` produces `ab`). A trailing `\` at the end of input is a syntax error (`trailing-escape`).
- **Pipe exception (`\|`):** `\|` is **not** an escaped literal pipe—it is the alternate operator, identical to `|`, so alternates can be written inside Markdown table cells without breaking table columns. Consequently, no key or context name can ever contain `|`.
- **Control characters:** Any Unicode control character (category `Cc`, including `\t`, `\r`, and `\n`), escaped or unescaped, makes the classifier invalid (`control-character`).
- **Whitespace:** Space (`U+0020`) is the only trimmable word-boundary whitespace (`\t` is rejected as `Cc`, and `U+00A0` is an ordinary name character).
- **Words:** A word is a maximal run of unreserved characters and escape units:
  - Interior spaces inside a word are preserved (`due date` -> `due date`; `a  b` -> `a  b`).
  - Unescaped leading and trailing spaces at the edges of a word are stripped (`k` -> `k`; `( a )` -> `a`).
  - Escaped spaces are never stripped (`\ a\ ` -> `a`; `a \ ` -> `a  `; `due\ (date|time)` -> `due date` and `due time`).
  - Quotes (`"`, `'`) and keywords (`null`, `nil`) are ordinary characters with no special meaning.

## 3. Operators and Precedence

From tightest to loosest binding:

1. **Grouping:** `( … )`
2. **Concatenation:** Adjacency between a word and a group, or between two groups (`a(b)`, `(a)b`, `(a)(b)`). Note that `a (b)` has an unescaped trailing space on the word `a`, which trims to `a` before concatenating with `b` to yield `ab`.
3. **Context:** `>`
4. **Alternate:** `|` (or `\|`)

Additional syntax rules:

- **Missing operands:** Permitted at the start/end of input, on either side of `>` or `|`, and inside `()`, evaluating to a single outcome containing one empty name `[""]`.
- **Parentheses:** Must balance and may nest arbitrarily. Any unmatched `(` or `)` is a syntax error (`unmatched-paren`).

## 4. Expansion Semantics

Every sub-expression evaluates to an ordered list of **outcomes**, where each outcome is an ordered list of **names** (`string[][]`, where individual names may be `""`):

- **Alternate (`A | B`):** Concatenates the outcome list of `A` followed by the outcome list of `B`.
- **Context (`A > B`):** Cartesian product of `A` and `B` (`A` outer/slowest, `B` inner/fastest), concatenating each left outcome's name list with each right outcome's name list (`[...leftNames, ...rightNames]`).
- **Concatenation (`AB`):** Cartesian product of `A` and `B` (`A` outer/slowest, `B` inner/fastest), joining the **last** name of the left outcome with the **first** name of the right outcome (`[...leftNames.slice(0, -1), leftLast + rightFirst, ...rightNames.slice(1)]`), where `"" + x = x`, `x + "" = x`, and `"" + "" = ""`.

## 5. Outcome Limit and Entry Normalization

1. **Outcome cap:** Count total raw outcomes _before_ empty-name removal and deduplication (`|A|B| = |A| + |B|`, `|A>B| = |A| * |B|`, `|(A)(B)| = |A| * |B|`). If raw outcomes exceed **32**, the classifier is invalid (`too-many-outcomes`).
2. **Normalize each outcome in order:** 3. Remove all empty names (`""`). If no names remain, discard the outcome. 4. The first remaining name is the `key`; all subsequent names form `contexts` in order. 5. Deduplicate `contexts` case-sensitively within the same entry, keeping the first occurrence (`a>b>c>b` -> key `a`, contexts `['b', 'c']`). A context _may_ equal its own `key` (`a>a` -> key `a`, contexts `['a']`).
3. **Deduplicate entries:** Drop any `(key, contexts)` entry that is case-sensitively identical in both `key` and ordered `contexts` to an earlier entry.
4. **Non-empty requirement:** If zero entries remain after normalization, the classifier is invalid (`empty-entries`).
