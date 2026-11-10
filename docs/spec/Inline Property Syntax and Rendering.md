# Inline Property Syntax and Rendering

# Inline Property Syntax: Specification

## 1. Delimiters

- `renderer := "~" | "." | "!"`
- `opener := "{" renderer`
- `closer := renderer "}"`
- An opener and closer form a pair only if they use the same renderer.
- Looking for the closer starts right after the two-character opener. That's why `{.}` and `{..}` never close themselves.
- Each opener pairs with the first matching closer after it. In the classifier, a closer inside quotes doesn't count (§3).
- A line ending (EOL) or end of file (EOF) never closes an inline property. An opener without a closer is plain text.

## 2. Structure

- `inline := opener classifier "=" value closer`
- The assignment is the first unquoted `=` after the opener.
- After the assignment, `=` is just a normal character. So `{.k=a=b.}` has the value `a=b`.
- If an unquoted closer comes before any assignment, the opener does not form a property (§4).

## 3. Scanning order

- **Classifier phase:** quotes first, then the closer, then the assignment.
- **Value phase:** only the closer matters. Quotes, parentheses, `|` and `+` are normal characters.

## 4. Choosing properties in a document

- Scan left to right. The first opener that forms a valid inline property wins.
- Everything inside a property that wins is plain content. Inline properties never nest, whatever their renderer.
- If an opener doesn't form a valid property, its `{` is plain text and scanning continues at the next character.

## 5. Blank lines

- A blank line is a newline, then optional spaces or tabs, then another newline. CRLF counts as one newline.
- A classifier must never contain a blank line, and that includes text inside quotes.
- Only `{~ … ~}` values may contain blank lines. In `{. … .}` and `{! … !}`, a blank line makes the property invalid.

## 6. Classifier: tokens

- Whitespace separates tokens and is then thrown away, unless it's inside quotes. `a b` becomes `ab`.
- Reserved characters: `(` `)` `+` `|` `"` `'`. The `=` ends the classifier.
- A word without quotes is a run of characters that aren't reserved and aren't whitespace.
- **Quoted text:**
  - Quotes are `"…"` or `'…'`. There is no escaping, so a quote can't appear inside the same kind of quotes, but the other kind can.
  - A quote that's never closed is a syntax error.
  - Backslashes are normal characters.
- **Null:**
  - Without quotes, the words `null` and `nil` mean null in any capitalization, but only as a whole token and before any joining. So `nu"ll"`, `(nu)(ll)` and `n ull` all give the plain word `null`.
  - Empty quotes (`""` or `''`) also mean null.
- The quoted words `"null"` and `"nil"` are ordinary words. `" "` is a key made of one space.

## 7. Classifier: operators

Precedence, from tightest to loosest:

1. Parentheses `( … )`
2. Concatenation (writing parts next to each other, with or without whitespace between them)
3. Augment `+`
4. Alternate `|`

Other rules:

- A missing operand counts as null. This covers the start or end of the classifier, either side of `+` or `|`, and empty parentheses `()`.
- Parentheses must come in matching pairs and may be nested. A parenthesis without a partner is a syntax error.
- An `=` can't appear inside parentheses, because the classifier ends at the first unquoted `=`. That leaves a parenthesis without a partner, which is an error.
- `+` and `|` group from left to right.

## 8. Classifier: expansion

Every expression produces an ordered list of outcomes. Each outcome is a list of identifiers, and any identifier may be null.

- **Alternate:** add the outcomes of the right side after the outcomes of the left side.
- **Augment:** combine every left outcome with every right outcome by putting the two lists end to end. The left side changes slowest.
- **Concatenation:** combine every left outcome with every right outcome, joining the last identifier on the left with the first identifier on the right. The left side changes slowest.
  - null joined with null gives null
  - null joined with _x_ gives _x_
  - _x_ joined with null gives _x_
  - _x_ joined with _y_ gives _xy_

## 9. Entries

For each outcome, in order:

1. Remove every null. If nothing is left, discard the outcome.
2. The first identifier is the key. The rest are contexts, in order.
3. If a context repeats within the same entry, drop the later copy. A context may match its key. Contexts under different keys never affect each other.
4. If an entry is identical to one produced earlier, drop it. The comparison is case-sensitive.

If no entries are left, the property is invalid and shown as plain text.

## 10. Value

- The value is the exact text between the assignment and the closer, with leading and trailing whitespace trimmed.
- Values have no escaping and no idea of null. `""`, `nil` and `null` are just text. An empty value is the empty string `''`.
- A value may contain anything except its own closer. `{~` values may also contain blank lines.

## 11. Errors

- Any syntax error means the opener does not form a property. Scanning continues as described in §4.

# Test Cases (YAML)

```yaml
# Inline Property Syntax: test suite
#
# Schema
#   id:      unique test id
#   input:   source text
#   expect:  either TEXT (the whole input is shown as literal text), or a list of segments:
#              {text: '...'}             literal text
#              {prop: [entry, ...]}      a valid inline property
#            entry = [key, [context, ...], value]
#
# Rules this suite checks
#   - Each opener pairs with its first matching closer. Scanning goes left to right,
#     and the first opener that forms a valid property wins. Its contents are inert.
#   - Classifier scan: quotes, then closer, then assignment. Value scan: closer only.
#   - Operator precedence: parentheses, then concatenation, then augment (+),
#     then alternate (|).
#   - null/nil (any case) are recognized per token, before joining. Quoted "null" is a word.
#   - Remove nulls first, and the first identifier left is the key. A property with
#     no entries is shown as TEXT.
#   - Classifier whitespace is removed unless quoted. Values keep their text, trimmed
#     at the start and end, and an empty value is ''.
#   - Contexts are an ordered list, and a repeat is dropped only within the same entry.
#     A context may match its key. Duplicate removal is case-sensitive.
#   - Blank lines are allowed only in {~ ~} values.

# ---------- A. Delimiters and renderers ----------
- {id: A01, input: '{.k=v.}', expect: [{prop: [['k', [], 'v']]}]}
- {id: A02, input: '{~k=v~}', expect: [{prop: [['k', [], 'v']]}]}
- {id: A03, input: '{!k=v!}', expect: [{prop: [['k', [], 'v']]}]}
- {id: A04, input: '{.k=v~}', expect: TEXT}
- {id: A05, input: '{~k=v.} more~}', expect: [{prop: [['k', [], 'v.} more']]}]}
- {id: A06, input: '{.k=v', expect: TEXT}
- {id: A07, input: "{.k=v\n", expect: TEXT}
- {id: A08, input: '{.k.}', expect: TEXT}
- {id: A09, input: '{.k=v.}{.j=w.}', expect: [{prop: [['k', [], 'v']]}, {prop: [['j', [], 'w']]}]}
- {id: A10, input: '{.k=a.}b.}', expect: [{prop: [['k', [], 'a']]}, {text: 'b.}'}]}
- {id: A11, input: '{.k=a..}', expect: [{prop: [['k', [], 'a.']]}]}
- {id: A12, input: '{ .k=v.}', expect: TEXT}
- {id: A13, input: '{.k=v. }', expect: TEXT}
- {id: A14, input: 'x {.k=v.} y', expect: [{text: 'x '}, {prop: [['k', [], 'v']]}, {text: ' y'}]}
- {id: A15, input: '{.a=1.} {.b=2', expect: [{prop: [['a', [], '1']]}, {text: ' {.b=2'}]}

# ---------- B. Values ----------
- {id: B01, input: '{.k=.}', expect: [{prop: [['k', [], '']]}]}
- {id: B02, input: '{.k=   .}', expect: [{prop: [['k', [], '']]}]}
- {id: B03, input: '{.k= a  b .}', expect: [{prop: [['k', [], 'a  b']]}]}
- {id: B04, input: '{.k=a=b.}', expect: [{prop: [['k', [], 'a=b']]}]}
- {id: B05, input: '{.k==.}', expect: [{prop: [['k', [], '=']]}]}
- {id: B06, input: '{.k=a.b}c.}', expect: [{prop: [['k', [], 'a.b}c']]}]}
- {id: B07, input: '{.k=a~}b.}', expect: [{prop: [['k', [], 'a~}b']]}]}
- {id: B08, input: '{.k="x.}".}', expect: [{prop: [['k', [], '"x']]}, {text: '".}'}]}
- {id: B09, input: '{.k=(.}', expect: [{prop: [['k', [], '(']]}]}
- {id: B10, input: '{.k=a|b+c.}', expect: [{prop: [['k', [], 'a|b+c']]}]}
- {id: B11, input: '{.k="".}', expect: [{prop: [['k', [], '""']]}]}
- {id: B12, input: '{.k=nil.}', expect: [{prop: [['k', [], 'nil']]}]}
- {id: B13, input: '{.k=null.}', expect: [{prop: [['k', [], 'null']]}]}
- {id: B14, input: '{.k="abc.}', expect: [{prop: [['k', [], '"abc']]}]}
- {id: B15, input: "{.k=line1\nline2.}", expect: [{prop: [['k', [], "line1\nline2"]]}]}
- {id: B16, input: '{.k=a\b.}', expect: [{prop: [['k', [], 'a\b']]}]}

# ---------- C. Whitespace ----------
- {id: C01, input: '{. k = v .}', expect: [{prop: [['k', [], 'v']]}]}
- {id: C02, input: '{.a b=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: C03, input: '{.a (b)=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: C04, input: '{. a + b | c =v.}', expect: [{prop: [['a', ['b'], 'v'], ['c', [], 'v']]}]}
- {id: C05, input: "{.a\nb=v.}", expect: [{prop: [['ab', [], 'v']]}]}
- {id: C06, input: "{.a+\nb=v.}", expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: C07, input: '{." a "=v.}', expect: [{prop: [[' a ', [], 'v']]}]}
- {id: C08, input: '{." a " b=v.}', expect: [{prop: [[' a b', [], 'v']]}]}
- {id: C09, input: '{.a "b c" d=v.}', expect: [{prop: [['ab cd', [], 'v']]}]}
- {id: C10, input: '{.a b|ab=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: C11, input: '{." "=v.}', expect: [{prop: [[' ', [], 'v']]}]}
- {id: C12, input: '{." "+a=v.}', expect: [{prop: [[' ', ['a'], 'v']]}]}
- {id: C13, input: '{.   =v.}', expect: TEXT}

# ---------- D. Vacuous and null ----------
- {id: D01, input: '{.=.}', expect: TEXT}
- {id: D02, input: '{.null=v.}', expect: TEXT}
- {id: D03, input: '{.NULL=v.}', expect: TEXT}
- {id: D04, input: '{.Nil=v.}', expect: TEXT}
- {id: D05, input: '{.""=v.}', expect: TEXT}
- {id: D06, input: '{.''''=v.}', expect: TEXT}
- {id: D07, input: '{.()=v.}', expect: TEXT}
- {id: D08, input: '{.|=v.}', expect: TEXT}
- {id: D09, input: '{.+=v.}', expect: TEXT}
- {id: D10, input: '{.null|nil=v.}', expect: TEXT}
- {id: D11, input: '{.(null)=v.}', expect: TEXT}
- {id: D12, input: '{.+null=v.}', expect: TEXT}
- {id: D13, input: '{.null+nil|=v.}', expect: TEXT}
- {id: D14, input: '{.null+a=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: D15, input: '{.a+null=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: D16, input: '{.a+nil+b=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: D17, input: '{.+a=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: D18, input: '{.+a+b=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: D19, input: '{.null+a+b=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: D20, input: '{.nIl|a=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: D21, input: '{.nullx=v.}', expect: [{prop: [['nullx', [], 'v']]}]}
- {id: D22, input: '{.a(null)b=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: D23, input: '{.a(NULL)b=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: D24, input: '{."null"=v.}', expect: [{prop: [['null', [], 'v']]}]}
- {id: D25, input: '{.''nil''+a=v.}', expect: [{prop: [['nil', ['a'], 'v']]}]}
- {id: D26, input: '{.nu"ll"=v.}', expect: [{prop: [['null', [], 'v']]}]}
- {id: D27, input: '{.(nu)(ll)=v.}', expect: [{prop: [['null', [], 'v']]}]}
- {id: D28, input: '{.n ull=v.}', expect: [{prop: [['null', [], 'v']]}]}
- {id: D29, input: '{.null x=v.}', expect: [{prop: [['x', [], 'v']]}]}
- {id: D30, input: '{.a null b=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: D31, input: '{.""+a=v.}', expect: [{prop: [['a', [], 'v']]}]}

# ---------- E. Alternation ----------
- {id: E01, input: '{.a|b=v.}', expect: [{prop: [['a', [], 'v'], ['b', [], 'v']]}]}
- {id: E02, input: '{.a||b=v.}', expect: [{prop: [['a', [], 'v'], ['b', [], 'v']]}]}
- {id: E03, input: '{.|a=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: E04, input: '{.a|=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: E05, input: '{.a|a=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: E06, input: '{.b|a|b=v.}', expect: [{prop: [['b', [], 'v'], ['a', [], 'v']]}]}
- {id: E07, input: '{.a|+a=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: E08, input: '{.a|A=v.}', expect: [{prop: [['a', [], 'v'], ['A', [], 'v']]}]}
- {id: E09, input: '{.a|b|c|d=v.}', expect: [{prop: [['a', [], 'v'], ['b', [], 'v'], ['c', [], 'v'], ['d', [], 'v']]}]}

# ---------- F. Augment and contexts ----------
- {id: F01, input: '{.a+b=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: F02, input: '{.a+b+c=v.}', expect: [{prop: [['a', ['b', 'c'], 'v']]}]}
- {id: F03, input: '{.a++b=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: F04, input: '{.a+|b=v.}', expect: [{prop: [['a', [], 'v'], ['b', [], 'v']]}]}
- {id: F05, input: '{.a+b|b+a=v.}', expect: [{prop: [['a', ['b'], 'v'], ['b', ['a'], 'v']]}]}
- {id: F06, input: '{.a+b+b=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: F07, input: '{.a+b+c+b=v.}', expect: [{prop: [['a', ['b', 'c'], 'v']]}]}
- {id: F08, input: '{.a+b+c|a+c+b=v.}', expect: [{prop: [['a', ['b', 'c'], 'v'], ['a', ['c', 'b'], 'v']]}]}
- {id: F09, input: '{.a+(b|c)+b=v.}', expect: [{prop: [['a', ['b'], 'v'], ['a', ['c', 'b'], 'v']]}]}
- {id: F10, input: '{.a+b|a+b+b=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: F11, input: '{.a+a=v.}', expect: [{prop: [['a', ['a'], 'v']]}]}
- {id: F12, input: '{.a+b+a=v.}', expect: [{prop: [['a', ['b', 'a'], 'v']]}]}
- {id: F13, input: '{.a+b|c+b=v.}', expect: [{prop: [['a', ['b'], 'v'], ['c', ['b'], 'v']]}]}
- {id: F14, input: '{.a+B+b=v.}', expect: [{prop: [['a', ['B', 'b'], 'v']]}]}
- {id: F15, input: '{.a+b|a=v.}', expect: [{prop: [['a', ['b'], 'v'], ['a', [], 'v']]}]}

# ---------- G. Mixed precedence ----------
- {id: G01, input: '{.a+b|c=v.}', expect: [{prop: [['a', ['b'], 'v'], ['c', [], 'v']]}]}
- {id: G02, input: '{.a|b+c=v.}', expect: [{prop: [['a', [], 'v'], ['b', ['c'], 'v']]}]}
- {id: G03, input: '{.a+b|c+d=v.}', expect: [{prop: [['a', ['b'], 'v'], ['c', ['d'], 'v']]}]}
- {id: G04, input: '{.a+b|c|d+e=v.}', expect: [{prop: [['a', ['b'], 'v'], ['c', [], 'v'], ['d', ['e'], 'v']]}]}
- {id: G05, input: '{.t1+(+t2|t3)|t4+t5=value.}', expect: [{prop: [['t1', ['t2'], 'value'], ['t1', ['t3'], 'value'], ['t4', ['t5'], 'value']]}]}

# ---------- H. Parentheses ----------
- {id: H01, input: '{.(a)=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: H02, input: '{.((a))=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: H03, input: '{.a+(b|c)=v.}', expect: [{prop: [['a', ['b'], 'v'], ['a', ['c'], 'v']]}]}
- {id: H04, input: '{.a+(b|c)+d=v.}', expect: [{prop: [['a', ['b', 'd'], 'v'], ['a', ['c', 'd'], 'v']]}]}
- {id: H05, input: '{.(a|b)+c=v.}', expect: [{prop: [['a', ['c'], 'v'], ['b', ['c'], 'v']]}]}
- {id: H06, input: '{.(a|b)+(c|d)=v.}', expect: [{prop: [['a', ['c'], 'v'], ['a', ['d'], 'v'], ['b', ['c'], 'v'], ['b', ['d'], 'v']]}]}
- {id: H07, input: '{.(a|b)+(c|d)+(e|f)=v.}', expect: [{prop: [
    ['a', ['c', 'e'], 'v'], ['a', ['c', 'f'], 'v'], ['a', ['d', 'e'], 'v'], ['a', ['d', 'f'], 'v'],
    ['b', ['c', 'e'], 'v'], ['b', ['c', 'f'], 'v'], ['b', ['d', 'e'], 'v'], ['b', ['d', 'f'], 'v']]}]}
- {id: H08, input: '{.a+(b|(c+d))=v.}', expect: [{prop: [['a', ['b'], 'v'], ['a', ['c', 'd'], 'v']]}]}
- {id: H09, input: '{.a+(b+(c|d))=v.}', expect: [{prop: [['a', ['b', 'c'], 'v'], ['a', ['b', 'd'], 'v']]}]}
- {id: H10, input: '{.(a+b)|c=v.}', expect: [{prop: [['a', ['b'], 'v'], ['c', [], 'v']]}]}
- {id: H11, input: '{.(t1|t2)+(t3|t4|)=value.}', expect: [{prop: [
    ['t1', ['t3'], 'value'], ['t1', ['t4'], 'value'], ['t1', [], 'value'],
    ['t2', ['t3'], 'value'], ['t2', ['t4'], 'value'], ['t2', [], 'value']]}]}
- {id: H12, input: '{.a+()=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: H13, input: '{.()+a=v.}', expect: [{prop: [['a', [], 'v']]}]}
- {id: H14, input: '{.a+(b|c)=(x).}', expect: [{prop: [['a', ['b'], '(x)'], ['a', ['c'], '(x)']]}]}
- {id: H15, input: '{.(a=v.}', expect: TEXT}
- {id: H16, input: '{.a)=v.}', expect: TEXT}
- {id: H17, input: '{.(a))=v.}', expect: TEXT}
- {id: H18, input: '{.((a)=v.}', expect: TEXT}
- {id: H19, input: '{.(a|b=c)=v.}', expect: TEXT}

# ---------- I. Concatenation ----------
- {id: I01, input: '{.a(b)=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: I02, input: '{.(a)b=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: I03, input: '{.(a)(b)=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: I04, input: '{.a()b=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: I05, input: '{.a(b|c)=v.}', expect: [{prop: [['ab', [], 'v'], ['ac', [], 'v']]}]}
- {id: I06, input: '{.a(b|c)d=v.}', expect: [{prop: [['abd', [], 'v'], ['acd', [], 'v']]}]}
- {id: I07, input: '{.(a|b)(c|d)=v.}', expect: [{prop: [['ac', [], 'v'], ['ad', [], 'v'], ['bc', [], 'v'], ['bd', [], 'v']]}]}
- {id: I08, input: '{.(|a)(|b)=v.}', expect: [{prop: [['b', [], 'v'], ['a', [], 'v'], ['ab', [], 'v']]}]}
- {id: I09, input: '{.a(+b)=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: I10, input: '{.(+a)b=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: I11, input: '{.(a+b)c=v.}', expect: [{prop: [['a', ['bc'], 'v']]}]}
- {id: I12, input: '{.a(b+)c=v.}', expect: [{prop: [['ab', ['c'], 'v']]}]}
- {id: I13, input: '{.a(b+c)d=v.}', expect: [{prop: [['ab', ['cd'], 'v']]}]}
- {id: I14, input: '{.a+b(c|d)=v.}', expect: [{prop: [['a', ['bc'], 'v'], ['a', ['bd'], 'v']]}]}
- {id: I15, input: '{.(a+b)(c+d)=v.}', expect: [{prop: [['a', ['bc', 'd'], 'v']]}]}
- {id: I16, input: '{.(a|b+c)d=v.}', expect: [{prop: [['ad', [], 'v'], ['b', ['cd'], 'v']]}]}
- {id: I17, input: '{.(t1|t2)(|t3|+t4)=value.}', expect: [{prop: [
    ['t1', [], 'value'], ['t1t3', [], 'value'], ['t1', ['t4'], 'value'],
    ['t2', [], 'value'], ['t2t3', [], 'value'], ['t2', ['t4'], 'value']]}]}
- {id: I18, input: '{.t1(t2"t|3"t4)=value.}', expect: [{prop: [['t1t2t|3t4', [], 'value']]}]}

# ---------- J. Quoting ----------
- {id: J01, input: '{."a|b"=v.}', expect: [{prop: [['a|b', [], 'v']]}]}
- {id: J02, input: '{.''a+b''=v.}', expect: [{prop: [['a+b', [], 'v']]}]}
- {id: J03, input: '{."a=b"=v.}', expect: [{prop: [['a=b', [], 'v']]}]}
- {id: J04, input: '{."a(b"=v.}', expect: [{prop: [['a(b', [], 'v']]}]}
- {id: J05, input: '{."it''s"=v.}', expect: [{prop: [['it''s', [], 'v']]}]}
- {id: J06, input: '{.''say "hi"''=v.}', expect: [{prop: [['say "hi"', [], 'v']]}]}
- {id: J07, input: '{.''it"s''=v.}', expect: [{prop: [['it"s', [], 'v']]}]}
- {id: J08, input: '{.a"b"c=v.}', expect: [{prop: [['abc', [], 'v']]}]}
- {id: J09, input: '{.a"|"b=v.}', expect: [{prop: [['a|b', [], 'v']]}]}
- {id: J10, input: '{."a"|"b"=v.}', expect: [{prop: [['a', [], 'v'], ['b', [], 'v']]}]}
- {id: J11, input: '{."a"+''b''=v.}', expect: [{prop: [['a', ['b'], 'v']]}]}
- {id: J12, input: '{."a""b"=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: J13, input: '{."a"''b''=v.}', expect: [{prop: [['ab', [], 'v']]}]}
- {id: J14, input: '{."a"(b|c)=v.}', expect: [{prop: [['ab', [], 'v'], ['ac', [], 'v']]}]}
- {id: J15, input: '{.a\|b=v.}', expect: [{prop: [['a\', [], 'v'], ['b', [], 'v']]}]}
- {id: J16, input: '{."a.}"=v.}', expect: [{prop: [['a.}', [], 'v']]}]}
- {id: J17, input: '{.a\"b=v.}', expect: TEXT}
- {id: J18, input: '{."abc=v.}', expect: TEXT}
- {id: J19, input: '{.a"b=v.}', expect: TEXT}
- {id: J20, input: '{."a''=v.}', expect: TEXT}
- {id: J21, input: '{.a"b"c"=v.}', expect: TEXT}

# ---------- K. Reserved characters in identifiers ----------
- {id: K01, input: '{.a.b=v.}', expect: [{prop: [['a.b', [], 'v']]}]}
- {id: K02, input: '{.a}b=v.}', expect: [{prop: [['a}b', [], 'v']]}]}
- {id: K03, input: '{.a{b=v.}', expect: [{prop: [['a{b', [], 'v']]}]}
- {id: K04, input: '{.a~b!c=v.}', expect: [{prop: [['a~b!c', [], 'v']]}]}
- {id: K05, input: '{.a~}b=v.}', expect: [{prop: [['a~}b', [], 'v']]}]}
- {id: K06, input: '{.a.}b=v.}', expect: TEXT}
- {id: K07, input: '{.é+日本=v.}', expect: [{prop: [['é', ['日本'], 'v']]}]}

# ---------- L. Overlap and nesting (leftmost wins) ----------
- {id: L01, input: '{.{.k=v.}', expect: [{prop: [['{.k', [], 'v']]}]}
- {id: L02, input: '{.k={.a=b.}.}', expect: [{prop: [['k', [], '{.a=b']]}, {text: '.}'}]}
- {id: L03, input: '{.k={~a=b~}.}', expect: [{prop: [['k', [], '{~a=b~}']]}]}
- {id: L04, input: '{~k={.a=b.}~}', expect: [{prop: [['k', [], '{.a=b.}']]}]}
- {id: L05, input: '{.a=1 {.b.}', expect: [{prop: [['a', [], '1 {.b']]}]}
- {id: L06, input: '{.a=x {.b=y.}', expect: [{prop: [['a', [], 'x {.b=y']]}]}
- {id: L07, input: '{.k=a{~b.}', expect: [{prop: [['k', [], 'a{~b']]}]}
- {id: L08, input: '{.a={~b=c.}~}', expect: [{prop: [['a', [], '{~b=c']]}, {text: '~}'}]}
- {id: L09, input: '{.a={~b=.}c=~}', expect: [{prop: [['a', [], '{~b=']]}, {text: 'c=~}'}]}
- {id: L10, input: '{."{.a=b.}"=v.}', expect: [{prop: [['{.a=b.}', [], 'v']]}]}
- {id: L11, input: '{."a.} {.b=c.}', expect: [{text: '{."a.} '}, {prop: [['b', [], 'c']]}]}
- {id: L12, input: '{."a.} {.b="c.}', expect: [{text: '{."a.} '}, {prop: [['b', [], '"c']]}]}
- {id: L13, input: '{.=.}{.a=b.}', expect: [{text: '{.=.}'}, {prop: [['a', [], 'b']]}]}
- {id: L14, input: '{.k={.=.}.}', expect: [{prop: [['k', [], '{.=']]}, {text: '.}'}]}
- {id: L15, input: '{.a=1.} text {~b=2~} more {!c=3!}', expect: [
    {prop: [['a', [], '1']]}, {text: ' text '}, {prop: [['b', [], '2']]},
    {text: ' more '}, {prop: [['c', [], '3']]}]}
- {id: L16, input: '{.k={~a~}.}', expect: [{prop: [['k', [], '{~a~}']]}]}
- {id: L17, input: '{~k={.a.}~}', expect: [{prop: [['k', [], '{.a.}']]}]}
- {id: L18, input: '{.a="{.b=c.}".}', expect: [{prop: [['a', [], '"{.b=c']]}, {text: '".}'}]}
- {id: L19, input: '{.a=x{~b=c.}yyyy~}', expect: [{prop: [['a', [], 'x{~b=c']]}, {text: 'yyyy~}'}]}
- {id: L20, input: 'Use {. here {.k=v.}', expect: [{text: 'Use '}, {prop: [['here{.k', [], 'v']]}]}

# ---------- M. Blank lines ----------
# Assumptions: a line containing only whitespace counts as blank; CRLF counts as one newline.
- {id: M01, input: "{~k=a\n\nb~}", expect: [{prop: [['k', [], "a\n\nb"]]}]}
- {id: M02, input: "{~k=\na\n~}", expect: [{prop: [['k', [], 'a']]}]}
- {id: M03, input: "{~k=\n\n~}", expect: [{prop: [['k', [], '']]}]}
- {id: M04, input: "{~k=a\n  \nb~}", expect: [{prop: [['k', [], "a\n  \nb"]]}]}
- {id: M05, input: "{!k=a\nb!}", expect: [{prop: [['k', [], "a\nb"]]}]}
- {id: M06, input: "{.k=a\n\nb.}", expect: TEXT}
- {id: M07, input: "{!k=a\n\nb!}", expect: TEXT}
- {id: M08, input: "{.k=a\n  \nb.}", expect: TEXT}
- {id: M09, input: "{.k=a\r\n\r\nb.}", expect: TEXT}
- {id: M10, input: "{~a+\n\nb=v~}", expect: TEXT}
- {id: M11, input: "{.a\n\nb=v.}", expect: TEXT}
- {id: M12, input: "{.\"a\n\nb\"=v.}", expect: TEXT}
- {id: M13, input: "{.k=a\n\nb.} {.j=c.}", expect: [{text: "{.k=a\n\nb.} "}, {prop: [['j', [], 'c']]}]}

# ---------- X. Original spec examples not covered elsewhere ----------
# Already covered: {.=.} → D01, t1+(+t2|t3)|t4+t5 → G05,
# (t1|t2)+(t3|t4|) → H11, (t1|t2)(|t3|+t4) → I17, t1(t2"t|3"t4) → I18
- {id: X01, input: '{.key=value.}', expect: [{prop: [['key', [], 'value']]}]}
- {id: X02, input: '{.t1|t2=value.}', expect: [{prop: [['t1', [], 'value'], ['t2', [], 'value']]}]}
- {id: X03, input: '{.t1+t2=value.}', expect: [{prop: [['t1', ['t2'], 'value']]}]}
- {id: X04, input: '{.t1|t2+t3=value.}', expect: [{prop: [['t1', [], 'value'], ['t2', ['t3'], 'value']]}]}
- {id: X05, input: '{.t1+t2|t3=value.}', expect: [{prop: [['t1', ['t2'], 'value'], ['t3', [], 'value']]}]}
- {id: X06, input: '{.t1+(t2|t3)=value.}', expect: [{prop: [['t1', ['t2'], 'value'], ['t1', ['t3'], 'value']]}]}
- {id: X07, input: '{.t1+t2|t3+t4=value.}', expect: [{prop: [['t1', ['t2'], 'value'], ['t3', ['t4'], 'value']]}]}
- {id: X08, input: '{.t1+(t2|t3)+t4=value.}', expect: [{prop: [['t1', ['t2', 't4'], 'value'], ['t1', ['t3', 't4'], 'value']]}]}
- {id: X09, input: '{.t1+t2|t3|t4+t5=value.}', expect: [{prop: [['t1', ['t2'], 'value'], ['t3', [], 'value'], ['t4', ['t5'], 'value']]}]}
- {id: X10, input: '{.+t1=value.}', expect: [{prop: [['t1', [], 'value']]}]}

```

# Invariant Testing

The grammar's structure gives quite a few invariants to test. Below they're grouped by layer, from whole-document behaviour down to the classifier algebra.

Each one includes the exact condition it needs. That's where most naive versions go wrong: several properties look like they always hold, but they break because of whitespace, null keywords, blank lines or quoting.

**Notation**

- `parse(s)` is the list of segments the parser produces.
- `raw(seg)` is the exact source text a segment came from. Your parser needs to expose this for P1.
- `E(C)` is the entries of `parse("{." + C + "=v.}")`, or `[]` if that comes out as text.
- `≡` means the same entries in the same order. `≅` means the same set of entries, in any order.

## 1. Document level

**P1. Nothing is lost.** Joining `raw(seg)` for every segment gives back the input exactly. Segments are in order, don't overlap and leave no gaps.

**P2. Every property has a proper shape.** Each property segment's raw text starts with an opener and ends with the closer for the same renderer. Its value contains no copy of that closer.

**P3. Leftmost wins, so nothing valid is skipped.** For every opener inside a text segment, trying to parse a property at that position in the full input fails. This is the strongest single test of §4.

**P4. Segments re-parse to themselves.**

- A text segment parsed on its own is a single text segment equal to itself.
- A property segment parsed on its own is that same property.

Both hold because scanning only ever looks forward, and cutting the input off can't make a failed candidate succeed.

**P5. A text prefix doesn't affect what follows.** If `t` contains no `{`, then `parse(t + s)` is `t` as text, merged with `parse(s)`.

**P6. A text suffix doesn't affect what comes before.** If `t` contains no `}`, then `parse(s + t)` is `parse(s)`, merged with `t` as text.

**P7. A property at the start doesn't affect what follows.** If `P` is a complete valid property, then `parse(P + s)` is `[P]` followed by `parse(s)`.

**P8. `.` and `!` behave identically.** Swap every `.` and `!` in the input. The output is the same, with the same swap applied to all its strings. `.` and `!` aren't special anywhere else, so this holds for any input.

**P9. `~` behaves like `.` when there are no blank lines.** If the input has no blank line, swapping every `~` and `.` in the input does the same to the output.

**P10. Count limits.** The number of properties is no more than the number of openers in the input, and no more than the number of closers.

**P11. The parser never fails or hangs.** On any string it returns without an exception. It runs in time no worse than O(n²), and O(n) if you memoize. Fuzz it with random input and with inputs packed with openers, such as `"{." * 10_000`.

## 2. Value

**P12. Values round-trip.** Take any valid classifier `C` and any string `v` that:

- has no whitespace at either end,
- doesn't contain the closer for renderer `r`,
- and, if `r` isn't `~`, contains no blank line.

Then every entry of `parse("{" + r + C + "=" + v + r + "}")` has the value `v`.

**P13. The value doesn't depend on the classifier.** Swapping one valid classifier for another never changes the value, and every entry of a property has the same value.

**P14. Values have a predictable shape.** A value has no whitespace at either end and contains no copy of its own closer. A `.` or `!` value contains no blank line.

## 3. Classifier algebra

These are the laws that hold on `E(...)`. `A`, `B` and `C` are valid classifiers, written in parentheses wherever precedence matters.

| ID  | Law                                                                         | Strength           |
| --- | --------------------------------------------------------------------------- | ------------------ |
| P15 | `E((A)) ≡ E(A)`                                                             | exact              |
| P16 | `E((A\|B)\|C) ≡ E(A\|(B\|C))`                                               | exact              |
| P17 | `E((A+B)+C) ≡ E(A+(B+C))`                                                   | exact              |
| P18 | `E((A)(B)(C))` is the same whichever way it's grouped                       | exact              |
| P19 | `E(A\|A) ≡ E(A)`                                                            | exact              |
| P20 | `E(A\|B) ≅ E(B\|A)`                                                         | set only           |
| P21 | `E(A\|) ≡ E(\|A) ≡ E(A+) ≡ E(+A) ≡ E(A()) ≡ E(()A) ≡ E(A)`                  | exact              |
| P22 | `E((B\|C)+A) ≡ E((B+A)\|(C+A))`                                             | exact              |
| P23 | `E(A+(B\|C)) ≅ E((A+B)\|(A+C))`, and it's exact when A has only one outcome | set / exact        |
| P24 | `E((B\|C)A) ≡ E((B)A\|(C)A)`                                                | exact              |
| P25 | `E(A(B\|C)) ≅ E((A)B\|(A)C)`                                                | set / exact as P23 |
| P26 | `E(A) ⊆ E(A\|B)`                                                            | set only           |

It's also worth checking the laws that should **fail**. These show the operators aren't accidentally commutative:

- `a+b` and `b+a` give different keys.
- `ab` and `ba` give different identifiers.
- `E(a\|b)` and `E(b\|a)` give a different order.

## 4. Changes that shouldn't alter the result

**P27. Adding whitespace doesn't change entries,** as long as the inserted run doesn't create a blank line and doesn't go inside quotes:

- It's always safe right next to an operator, a parenthesis or a quote.
- Inside an unquoted word it's safe only if neither resulting piece is `null` or `nil` in any capitalization. For example, `nullx` becomes `null x`, which gives `x`.

**P28. Quoting a word doesn't change entries.** Replacing an unquoted word `w` with `"w"` or `'w'` gives the same entries, as long as `w` isn't `null` or `nil` in any capitalization.

**P29. Splitting a quote doesn't change entries.** `"ab"` and `"a""b"` give the same entries, and so do `"ab"` and `"a"'b'`.

**P30. Null keywords ignore capitalization.** Changing the capitalization of a `null` or `nil` keyword never changes entries.

**P31. The classifier works the same under every renderer.** If `C` contains no unquoted `.}`, `!}` or `~}` and no blank line, then `{.C=v.}`, `{!C=v!}` and `{~C=v~}` give the same entries.

## 5. Entries are well formed

**P32.** In every entry:

- the key and every context are non-empty strings, never null;
- no context appears twice within the same entry;
- no two entries are identical.

**P33. Outcome counts.** Count outcomes before nulls are removed and duplicates dropped:

- `|A|B| = |A| + |B|`
- `|A+B| = |A| · |B|`
- `|(A)(B)| = |A| · |B|`
- `|E(C)|` is never more than the number of outcomes.

## 6. Test against a model

This is the most valuable test. Instead of generating strings, generate a random classifier syntax tree and do two things with it:

1. Print it as source text with a small printer. Quote words that contain reserved characters, and add parentheses where precedence requires them.
2. Work out the expected entries directly from the tree, using the §8 and §9 rules as a separate, simple reference implementation.

Then check that parsing the printed text gives the same entries as the reference:

```python
from hypothesis import given, strategies as st

@given(tree=classifier_trees(), value=safe_values("."))
def test_parser_matches_model(tree, value):
    src = "{." + print_classifier(tree) + "=" + value + ".}"
    segs = parse(src)
    assert len(segs) == 1 and segs[0].is_prop
    assert segs[0].entries == model_entries(tree, value)
```

The printer can also add random whitespace, quoting and capitalization changes that are allowed under P27–P30. That makes this one test cover the whole classifier layer.

## Generators that find bugs

- **Near-miss documents.** Start from a valid property and apply one change: delete a closer, insert a quote, insert a blank line, change the renderer of the opener or the closer, add a parenthesis, or move the `=`. Then check P1–P4 and the expected text or property result.
- **Small alphabets.** Build strings only from `{ } . ~ ! = ( ) + | " ' a b`, spaces and newlines. Random Unicode almost never hits the interesting combinations, while short strings over this alphabet find edge cases fast and shrink to readable counterexamples.
- **Keyword fragments.** Include `null`, `NuLl`, `nil`, `nu` and `ll` as tokens, so P27 and P28 run into the keyword edge cases.

## Rendering

### Terms

The parts of an inline property are its _opener_, _classifier_, _assignment_, _value_ and _closer_.

- **Header:** the opener, classifier and assignment, plus any whitespace trimmed from the start of the value.
- **Trailer:** the closer, plus any whitespace trimmed from the end of the value.
- **Hidden range:** the part of the source a decoration hides when the property is collapsed. For `~` there are two: the header and the trailer. For `.` and `!` there is one: the whole property.

### Overview

Obsidian has three view modes (Source, Live Preview, Reading), and inline properties have three renderers (`~`, `.`, `!`).

| Renderer | Source      | Live Preview, collapsed                        | Live Preview, expanded | Reading    |
| -------- | ----------- | ---------------------------------------------- | ---------------------- | ---------- |
| `~`      | Full syntax | Value with annotation style, plus gutter badge | Full syntax            | Value only |
| `.`      | Full syntax | Interpunct                                     | Full syntax            | Nothing    |
| `!`      | Full syntax | Nothing, plus optional gutter badge            | Full syntax            | Nothing    |

**Rendering is view-only.** Live Preview and Reading are projections of the source. Decorations and post-processors never change the document.

### Where inline properties are recognized

Inline properties are recognized only within the inline content of a single Markdown block: a paragraph, heading, list item, blockquote line, table cell or callout body. A property can never cross a block boundary.

No properties are recognized inside:

- frontmatter,
- fenced or indented code blocks,
- math blocks,
- HTML blocks,
- `%%` comment blocks.

**Opaque spans.** These are code spans, inline math, links, wikilinks, embeds, inline HTML, inline `%%` comments and footnote references. Within a block, an opaque span is handled like this:

- An opener, assignment or closer inside an opaque span doesn't count.
- An opaque span may appear only entirely inside a value.
- A classifier containing an opaque span means no property.
- A property that partially overlaps an opaque span is not a property.

Emphasis markers (`*`, `_`, `**`, `~~`, `==`) are not opaque and may overlap freely.

**Multi-line values.** Container prefixes such as `> ` and list indentation are not part of the value.

**Tables.** Inside a table cell, the table layer turns `\|` into `|` before parsing. An unescaped `|` always ends the cell, so alternates inside tables must be written as `\|`.

### Source mode

All inline properties are shown as full syntax, with no styling.

### Live Preview

#### Collapsed appearance

When a note opens, every property is collapsed.

- **`~`:** The header and trailer are hidden, and the value is shown as normal Markdown with a subtle annotation style. A gutter badge marks the line.
- **`.`:** The property is replaced by an interpunct (`·`).
- **`!`:** The property is hidden. A gutter badge marks the line if that setting is on.

#### Revealing

- **The cursor reveals a property.** A property is expanded while any selection endpoint lies inside one of its hidden ranges or at either edge of one. When no endpoint touches it, it collapses again.
- **For `~`,** a cursor inside the value doesn't reveal the property. Only the header and trailer edges do, so long prose values stay clean while you edit them.
- **The caret never rests at an invisible boundary.** Reaching a boundary reveals the syntax in the same update, so arrow keys, clicks, Home/End and search jumps all behave like normal text editing.

#### Pinning and toggles

- **Pinning one property.** Clicking an interpunct or a gutter badge pins that property open or collapsed. A `!` property without a gutter badge can only be pinned with the line or note commands.
- **Line and note commands.** "Toggle inline properties on this line" and "Toggle inline properties in this note" both work the same way. If any property in scope is expanded, all of them are collapsed. Otherwise, all of them are expanded.
- **The cursor wins.** A property the cursor touches stays expanded even after a collapse command.
- **Pins follow edits.** Pin state is mapped through document changes. If an edit makes a property invalid, its pin is dropped. If an edit creates a new property, it starts collapsed, but it's normally revealed anyway because you're typing at its closer.

#### Whitespace

- Visible whitespace is never invented. If the author wrote no whitespace around a property, the surrounding words join, both here and in Reading mode.
- **`!`:** If there's whitespace on both sides, one of the two runs is hidden together with the property, so `word {!k=v!} word` shows as `word word`. This matches Reading mode, where HTML collapses whitespace anyway.
- **`.`:** The interpunct keeps the whitespace on both sides: `word · word`.

#### Multi-line properties and containers

- **`~`:** Line breaks are never hidden. Header and trailer ranges stop at the first line break, so the value keeps its lines.
- **`.` and `!`, line-aligned:** A property is line-aligned if it starts where its first line's content starts and ends where its last line ends. Outside a container, a line-aligned property is hidden by replacing the whole lines as a block. A collapsed `.` shows a single interpunct line. A collapsed `!` takes up no height, and its gutter badge goes on the next visible line, or the previous one at the end of the note.
- **`.` and `!`, otherwise:** An inline replacement is used. If the property spans line breaks, the surrounding lines appear joined while it's collapsed.
- **Containers:** In blockquotes and list items, a prefix is never hidden, and replacements are always inline. A line whose only content is a hidden property still shows its `>` or bullet.

#### Editing

- **Typing, Backspace, Delete and IME:** These act on raw source, because the property is always revealed when the caret reaches it. While composition is in progress, visibility is frozen.
- **Copy:** Copy in Live Preview gives you source text, including hidden syntax. Copy in Reading mode gives you the rendered text. The source is always the truth.

### Reading mode

- **`~`:** The value is shown as normal prose. The header and trailer are removed, with no styling.
- **`.` and `!`:** Nothing is shown.
- Reading mode has no interpunct, no gutter badges, no pinning and no reveal.
- Visible whitespace is never invented.

### CodeMirror 6 implementation notes

1. **Use a `StateField` for replacements.** CodeMirror forbids plugin-provided decorations from replacing line breaks or adding block widgets:

   ```text
   RangeError: Decorations that replace line breaks may not be specified via plugins
   ```

   Keep replace and block decorations in a `StateField`, provided with `EditorView.decorations.from(field)`. Keep the existing `ViewPlugin` for token marks, diagnostics and tooltips.

2. **Compute visibility inside the `StateField` update.** Work it out from `tr.state.selection`, so reveal and selection land in the same transaction. That avoids the two-keystroke effect you get when expansion happens after the selection has already moved.

3. **Don't use `atomicRanges` for hidden properties.** Reveal-on-touch means the caret never sits at a collapsed boundary. That removes the zero-width "two endpoints at one pixel" problem and the caret height jumps.

4. **Freeze visibility during composition.** A small `ViewPlugin` listens for `compositionstart` and `compositionend` and sends effects that freeze and unfreeze visibility. While frozen, the field maps its existing decorations through changes instead of recomputing them.

5. **Never hide line breaks in `~` properties.** Header and trailer ranges stop at the first line break. Use `Decoration.mark` on the value for the annotation style.

6. **Block replacement only applies to line-aligned `.` and `!` properties outside containers.** Replace from the first line's `from` to the last line's `to`. In containers, use inline replacement and never touch the prefix. Replacing from `line.from` would delete the `>` or `-` and break the structure.

7. **Keep replacements non-overlapping.** Skip token marks inside replaced ranges, and build one predictable decoration set.

8. **Widgets:**
   - Implement `eq()` so scrolling doesn't rebuild them.
   - Keep their heights stable, and call `requestMeasure` after any change in height.
   - Never use U+200B.
   - Give the interpunct and gutter badges an `aria-label` and `title` showing the key(s) and value.
   - Stop interpunct clicks in the widget's event handling, so a click pins the property instead of moving the caret.

9. **Performance:**
   - Cache parse results per block, keyed by document version. Properties can't cross block boundaries, so an edit only requires re-parsing the blocks it touches.
   - Selection changes only recompute visibility, never the parse.
   - Test with line wrapping, long prose values, and rapid scrolling.

10. **Getting the regions to parse:** Use Obsidian's Lezer Markdown syntax tree to find block content ranges, opaque spans and container prefixes. Pass each block's text, its opaque spans and a position map to the pure parser.

11. **Verify tables and callouts.** In Live Preview, Obsidian renders tables, callouts and embeds as widgets. Their content goes through the Markdown post-processor, not your editor decorations, so Reading-mode rules apply there until the cursor enters and they switch back to source. Check this for each Obsidian version you support.

### Reading mode implementation notes

1. **Process after rendering.** Use `registerMarkdownPostProcessor`. By then the markers are already in the rendered DOM.

2. **Parse the source, not the DOM.** Get the section's source lines with `ctx.getSectionInfo(el)` and run the real parser on them. Rendered text differs from the source: backslash escapes are gone, emphasis markers are removed, and entities are decoded. A second parser running on the DOM would disagree with the source parser. If `getSectionInfo` returns `null`, leave every property in that element visible.

3. **Match the DOM against the parse, or don't touch it.** Count the opener and closer sequences (`{~`, `{.`, `{!`, `~}`, `.}`, `!}`) in the DOM text, outside code and math elements. Compare that count with the same count in the source section. If they differ, leave every property in the element visible. Otherwise, the n-th sequence in the DOM corresponds to the n-th in the source.

4. **Use a tree walker, never a regex over `innerHTML`.** Inline Markdown splits text across nodes at links, emphasis and code spans. Split text nodes at marker boundaries, remove the marker text, then remove any inline element left empty.

5. **`~`:** Remove the header and trailer text, including the whitespace trimmed from the value. Leave the value's nodes as they are, links and emphasis included.

6. **`.` and `!`:** Remove everything from the opener to the closer, including any whole elements in between.
   - If that leaves a `<p>`, list item or heading empty, remove the element.
   - If the property filled a whole line inside a paragraph, also remove the neighbouring `<br>`: the one after it, or the one before it if it was the last line.

7. **Whitespace:** Never invent spaces. HTML collapses the double space left after removing a property between two spaces.

8. **No reveal, no pinning and no interpunct.** Reading mode has no cursor and no expansion state. Use reader styles only, never the authoring tint.

### Limitations

These show raw syntax regardless of the plugin:

- **Obsidian Publish:** plugin post-processors don't run there.
- **Other apps:** GitHub, other Markdown editors, and sync previews.
- **Core features that read raw text:** the outline panel, heading link targets and autocomplete, search results, and possibly tab titles. Avoid properties in headings if those matter.
- **Tables in Live Preview:** see CM6 note 11.
