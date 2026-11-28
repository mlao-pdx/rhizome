# Inline Property Conformance Tests & Invariants

## Key Invariants (Summary)

- **P1 (Lossless segmentation):** Concatenating `raw(seg)` across all returned segments reproduces the input UTF-16 string exactly with no empty or adjacent text segments.
- **P2 (Reading-mode leak zero):** Every recognized `.` or `!` property, and every header/closer of a `~` property, lies strictly inside comment ranges hidden by Obsidian 1.14 Reading mode.
- **P3 (Leftmost non-nesting):** Bare attempt runs first on eligible non-task unordered list lines; otherwise inline comments scan left-to-right; recognized properties never nest.
- **P4 (Classifier laws):** Associativity of `|`, `>`, and concatenation; idempotence `E(A|A) ≡ E(A)`; identity of empty operands `E(A|) ≡ E(A>) ≡ E(A()) ≡ E(A)`; right-distributivity `E((B|C)>A) ≡ E((B>A)|(C>A))`; `E(A\|B) ≡ E(A|B)`; max 32 raw outcomes.
- **P5 (Tag excision & `\#` unescape):** Index value equals `content` with contained `MetadataCache` tags (and preceding whitespace) excised, odd-backslash `\#` unescaped to `#`, trimmed, and null-normalized (`""`, `null`, `Null`, `NULL` -> `null`).

## Representative YAML Test Cases

```yaml
# ---------- A. Sigils and comment carriers ----------
- {id: A01, input: '%%.k:: v%%', expect: [{prop: [['k', [], 'v']], sigil: '.'}]}
- {id: A02, input: '%%!k:: v%%', expect: [{prop: [['k', [], 'v']], sigil: '!'}]}
- {id: A03, input: '%%~k::%%v%%%%', expect: [{prop: [['k', [], 'v']], sigil: '~', content: 'v'}]}
- {id: A04, input: '%%~k::%%v%%~ closer note%%', expect: [{prop: [['k', [], 'v']], sigil: '~', content: 'v'}]}
- {id: A05, input: '%% .k:: v%%', expect: TEXT}          # leading space -> plain comment
- {id: A06, input: '%%.k: v%%', expect: TEXT}            # single colon -> fails (lints "no :: found")
- {id: A07, input: '%%~k:: stray%%v%%%%', expect: TEXT}  # text-after-header fails
# Forgotten ~ closer does NOT swallow a following ~ property header as its closer:
- {id: A08, input: '%%~a::%%foo %%~b::%%bar%%%%', expect: [{text: '%%~a::%%foo '}, {prop: [['b', [], 'bar']], sigil: '~'}]}
# Plain comment before property pairs first:
- {id: A09, input: '%% note %%.k:: v%%', expect: TEXT}
- {id: A10, input: '%% ◊prepend %%', expect: TEXT}       # PositionMarker is plain comment, zero lint

# ---------- B. Percent runs, colons, and null values ----------
- {id: B01, input: '%%.progress:: 50% %%', expect: [{prop: [['progress', [], '50%']], content: ' 50% '}]}
- {id: B02, input: '%%.progress:: 50%%%', expect: [{prop: [['progress', [], '50']]}, {text: '%'}]}
- {id: B03, input: '%%.time:: 10:30%%', expect: [{prop: [['time', [], '10:30']]}]}
- {id: B04, input: '%%.k:::: v%%', expect: [{prop: [['k', [], ':: v']], content: ':: v'}]}
- {id: B05, input: '%%.ns:key:: v%%', expect: [{prop: [['ns:key', [], 'v']]}]}
- {id: B06, input: '%%.Re\::: v%%', expect: [{prop: [['Re:', [], 'v']]}]}
- {id: B07, input: '%%.k::%%', expect: [{prop: [['k', [], null]], content: ''}]}
- {id: B08, input: '%%.k:: NULL%%', expect: [{prop: [['k', [], null]]}]}
- {id: B09, input: '%%.k:: ~%%', expect: [{prop: [['k', [], '~']]}]}

# ---------- C. Classifier algebra (contexts, alternation, concatenation) ----------
- {id: C01, input: '%%.rating>(book|author):: 4.5%%', expect: [{prop: [['rating', ['book'], '4.5'], ['rating', ['author'], '4.5']]}]}
- {id: C02, input: '%%.due\ (date\|time):: 2026-03-01%%', expect: [{prop: [['due date', [], '2026-03-01'], ['due time', [], '2026-03-01']]}]}
- {id: C03, input: '%%.(a|a)(a|a)(a|a)(a|a)(a|a)|a:: v%%', expect: TEXT} # 33 raw outcomes > 32

# ---------- O. Percent escapes ----------
- {id: O01, input: '\%%.k:: v%%', expect: TEXT}
- {id: O02, input: '\\%%.k:: v%%', expect: [{text: '\\'}, {prop: [['k', [], 'v']]}]}
- {id: O03, input: '\%%%.k:: v%%', expect: [{text: '\%'}, {prop: [['k', [], 'v']]}]}
- {id: O04, input: '%%%.k:: v%%', expect: TEXT}          # payload starts with %, no sigil

# ---------- R. Bare properties & Task / Dataview coexistence ----------
- {id: R01, input: '- age>ch3:: 34 #character', expect: [{text: '- '}, {prop: [['age', ['ch3'], '34 #character']], bare: true}]}
- {id: R02, input: "-\tk:: v", expect: [{text: "-\t"}, {prop: [['k', [], 'v']], bare: true}]}
- {id: R03, input: '1. k:: v', expect: TEXT}             # ordered list never starts bare
- {id: R04, input: '- a\:: b', expect: TEXT}             # escaped colon forces plain list text
# Task lines are excluded from bare properties so task & Dataview scanners own them:
- {id: R05, input: '- [ ] Call Ada [due:: 2026-11-30]', expect: TEXT}
# Unescaped '[' in bare classifier fails bare attempt, falling through to legacy Dataview reader:
- {id: R06, input: '- Buy milk [shop:: groceries]', expect: TEXT}
# Closed classifier group before '::' still works on bare lines (distinct from Dataview '(k:: v)'):
- {id: R07, input: '- (due|deadline):: 2026-11-30', expect: [{text: '- '}, {prop: [['due', [], '2026-11-30'], ['deadline', [], '2026-11-30']], bare: true}]}
- {id: R08, input: '- (status:: active)', expect: TEXT}  # unmatched '(' before '::' -> falls through to Dataview

# ---------- S. Unified scanner (fences, indented code, block comments) ----------
- {id: S01, input: "---\nk: '%%.a:: b%%'\n---\n%%.j:: w%%", expect: [{text: "---\nk: '%%.a:: b%%'\n---\n"}, {prop: [['j', [], 'w']]}]}
- {id: S02, input: "~~~\n%%.k:: v%%\n~~~\n%%.j:: w%%", expect: [{text: "~~~\n%%.k:: v%%\n~~~\n"}, {prop: [['j', [], 'w']]}]}
# Indented code (4 spaces or leading tab after blank line) excludes %% just like Reading mode:
- {id: S03, input: "\t%%\nx", expect: TEXT}
- {id: S04, input: "\n\t%%.k:: v%%", expect: TEXT}
# Plain block comment (0..3 spaces) crosses blank lines to next textual %%:
- {id: S05, input: "   %%.k:: v\n\n%%.j:: w%%", expect: TEXT}
# Container block comment requires >=1 '>' or list marker, and stops before blank line:
- {id: S06, input: "- %%.k:: v\n\ntext\n%%.j:: w%%", expect: [{text: "- %%.k:: v\n\ntext\n"}, {prop: [['j', [], 'w']]}]}
# Textual closer inside backticks closes an open comment:
- {id: S07, input: '%%.k:: a `b%%` c', expect: [{prop: [['k', [], 'a `b']]}, {text: '` c'}]}

# ---------- T. Index tag attribution & \# unescaping (§8) ----------
- {id: T01, input: '- age>ch3:: 34 #character', cache_tags: ['#character'], expect: [{text: '- '}, {prop: [['age', ['ch3'], '34']], tags: ['#character']}]}
- {id: T02, input: '%%.k:: #onlytag%%', cache_tags: ['#onlytag'], expect: [{prop: [['k', [], null]], tags: ['#onlytag']}]}
- {id: T03, input: '%%.color:: #ff0000%%', cache_tags: ['#ff0000'], expect: [{prop: [['color', [], null]], tags: ['#ff0000']}]}
- {id: T04, input: '%%.color:: \#ff0000%%', cache_tags: [], expect: [{prop: [['color', [], '#ff0000']], tags: []}]}
- {id: T05, input: '- color:: \#ff0000', cache_tags: [], expect: [{text: '- '}, {prop: [['color', [], '#ff0000']], tags: []}]}
```
