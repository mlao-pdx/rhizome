# Inline Property, Scanner, and Index: Specification

## 1. Scope, Seams, and Coexistence

- **Classifier seam:** Uses `classify`, the backslash escape unit, and the `Cc` control-character rule from _Inline Property Classifier Algebra_.
- **Reference target:** Comment pairing and hiding rules match Obsidian 1.14 Reading mode and PDF export (§4.8). Hiding is visual only; comment payloads remain in raw Markdown, search, `MetadataCache`, and Obsidian Publish page source.
- **Legacy Dataview coexistence:** To preserve adoption on existing vaults, Rhizome continues reading wrapped Dataview inline fields (`[key:: value]` and `(key:: value)`) on plain-text segments remaining after excluded ranges and Rhizome properties are resolved (§8).
- **Template & `| body` integration:**
  - Template PositionMarkers (`%% ◊prepend %%` and `%% ◊append %%`) carry no property sigil, so they are parsed as ordinary inline comments by §4 with zero property diagnostics and are skipped when inside excluded ranges.
  - Because delimited Rhizome inline properties and PositionMarkers are standard Obsidian `%%...%%` comments, `| body`'s `"comments"` / `comments: "obsidian"` exclusion strips all `%%...%%` comment spans uniformly—removing plain comments, PositionMarkers, `.` and `!` properties, and `~` header/closer wrappers while leaving `~`'s prose content intact.
  - Passing a note object to `{% frontmatter source_note %}` copies only `source === 'frontmatter'` entries (excluding `source === 'inline'` and `source === 'dataview'`), whereas `{% frontmatter source_note.properties %}` copies the merged `properties` map.

## 2. Carriers and Structure

```text
property := single | pair | bare
single   := "%%" sigil classifier "::" content "%%"       sigil := "." | "!"
pair     := "%%~" classifier "::" "%%" content closer
closer   := "%%" ( "" | "~" non_header_text ) "%%"
bare     := classifier "::" content                       (unordered non-task list line, §7)
```

- **Sigil:** `.`, `!`, or `~` immediately following the opening `%%` with no intervening space (`%% .k:: v%%` is a plain comment).
- **Assignment:** The leftmost unescaped `::` starting from the classifier. Single `:` is an ordinary character (`ns:key` and `Chapter 3: Fall` need no escape; `Re\::: v` yields key `Re:`; `a\::b:: v` yields key `a::b`; `%%.k:::: v%%` yields content `:: v`).
- **Whitespace:** Space (`U+0020`) and tab (`U+0009`) only.
- **Single-line rule:** Line breaks are `\n`, `\r\n`, or lone `\r`. Every property opens and closes on a single line.

| Carrier               | Header Range                       | Content Range                                  | Trailer Range         |
| :-------------------- | :--------------------------------- | :--------------------------------------------- | :-------------------- |
| **single** (`.`, `!`) | `%%` + sigil + classifier + `::`   | after `::`, up to closing `%%`                 | closing `%%`          |
| **pair** (`~`)        | entire `%%~classifier::%%` comment | text between header comment and closer comment | entire closer comment |
| **bare**              | classifier + `::`                  | after `::` to end of line                      | empty                 |

## 3. The Unified Scanner

Before property recognition, a single stateful left-to-right pass over the full note (UTF-16 code unit offsets) marks **excluded ranges** and pairs **inline comments**. Whatever opens first wins.

| Scanner State    | Recognizes                                                                    | Terminates At                                     |
| :--------------- | :---------------------------------------------------------------------------- | :------------------------------------------------ |
| **Normal**       | Frontmatter (line 1 only), FencedCode, IndentedCode, InlineCode, `%%` openers | n/a                                               |
| **Frontmatter**  | closing `---` or `...` line                                                   | end of closing line (§3.5)                        |
| **FencedCode**   | matching closing backtick/tilde fence line                                    | end of closing line (§3.5)                        |
| **IndentedCode** | non-indented non-blank line                                                   | start of first non-indented non-blank line (§3.5) |
| **BlockComment** | next textual `%%` (or blank-line bound for Container blocks)                  | after closing `%%` or bound (§3.4)                |

### 3.1 Percent Escapes (Normal State Only)

In `Normal` state, a `%` directly preceded by an odd number of backslashes (`\%`, `\\\%`) is escaped as plain text; scanning resumes at the very next character. Thus `\%%.k:: v%%` is plain text, `\\%%.k:: v%%` is `\` followed by a property, and in `\%%%.k:: v%%` the second and third `%` open a property. Backslashes have **no** escaping effect on closers inside a comment, inside code, or inside frontmatter.

### 3.2 Comment Openers and Textual Closers

- An unescaped `%%` in `Normal` state opens a comment candidate.
- Its closer is the **first two `%` characters** of the next `%%` run after the opener, found purely textually—neither backslashes (`\%%`), inline backticks, nor code fences protect a closer once a comment has opened.
  - Because `50%%%` closes on the first two `%` leaving a stray visible `%`, percent-ending values are written with a trailing space (`%%.progress:: 50% %%`, which trims to `"50%"`).
- **Inline comment:** Closer is on the same line. Scanning resumes in `Normal` state immediately after the two-character closer.
- **Block comment:** No closer on the same line, and the opener **begins its line** (§3.3).
- **Stray:** No closer on the same line, and the opener does **not** begin its line. Left as plain text; scanning continues right after `%%`.

### 3.3 Prefix Definitions (Kept Distinct)

| Prefix Kind                  | Where Used                              | Exact Pattern Before Token                                                                                                                                                            |
| :--------------------------- | :-------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fence prefix**             | Opening/closing fenced code (§3.5)      | Zero or more spaces (`0..3` at root), tabs, `>`, and ordered (`1.`, `1)`) or unordered (`-`, `*`, `+`) list markers followed by space/tab.                                            |
| **Plain comment prefix**     | Unbounded block comment (§3.4)          | Nothing, or `1` to `3` spaces (`U+0020` only; no tabs, no markers).                                                                                                                   |
| **Container comment prefix** | Blank-line-bounded block comment (§3.4) | Spaces/tabs combined with **at least one** `>` character or list marker (`-`, `*`, `+`, `1.`, `1)` followed by space/tab, optionally followed by a task box `[x]`/`[ ]` + space/tab). |
| **Bare-line prefix**         | Bare inline properties (§6)             | Zero or more spaces, tabs, and `>` characters, then **exactly one** unordered marker (`-`, `*`, or `+`) followed by one space or tab, **not** followed by a task box (`[?] `).        |

Four or more leading spaces (or a leading `\t`) with no `>` or list marker, `#` heading markers, or prior prose text on the line do **not** begin a comment line.

### 3.4 Block Comments

- Runs from the line-starting `%%` to the next textual `%%` on a later line, or EOF (ignoring fences, backticks, callouts, lists, and tables).
- **Plain** block comments cross blank lines up to `%%` or EOF.
- **Container** block comments end at the next `%%` **or** immediately before the first blank line (empty or spaces/tabs only), whichever comes first.
- Forms an **excluded range**. If closed by `%%` mid-line, `Normal` scanning resumes immediately after that `%%` on the same line.

### 3.5 Other Excluded Ranges

1. **Frontmatter:** Closed `---` ... `---`/`...` block starting on line 1 (optional trailing spaces/tabs).
2. **Fenced code:** `>= 3` backticks (with no backtick in info string) or `>= 3` tildes after a Fence prefix, running to a closing fence of at least equal length or EOF.
3. **Indented code:** Outside list/blockquote continuations, a line indented by `>= 4` columns (`4` spaces or `\t`) following a blank line (or start of body after frontmatter), running through subsequent `>= 4`-column indented or blank lines. Because Obsidian renders `%%` literally inside indented code in Reading mode, excluding it preserves the §3.7 hiding guarantee.
4. **Inline code:** In `Normal` state, a run of `N` backticks closed by the next run of `N` backticks on the same line (unclosed backticks are plain text).

An opener inside an excluded range is never tried, and a bare attempt whose classifier starts inside an excluded range is never made.

### 3.6 Scanner Observations

The scanner records positions and metadata for: (a) **Block comments** (range, plain vs. container, terminator kind, line count), (b) **Strays** (unpaired mid-line `%%`), and (c) **Percent runs** (`>= 3` consecutive `%`).

### 3.7 Conformance Invariant

Every recognized `.` or `!` property, and every header and closer comment of a recognized `~` property, is hidden by Obsidian 1.14 in Reading mode and PDF export.

## 4. Choosing Properties on a Line

On each line outside full-line excluded ranges:

1. Try **bare** (§6) at the start of the line. If valid, it consumes through EOL and nothing else on the line is tried (any comments inside bare content are inert).
2. Otherwise iterate the scanner's **inline comments** on that line left-to-right:
   - Comments not starting with `.`, `!`, or `~` are plain non-property comments (consumed whole; e.g., `%% ◊prepend %%` or `%% user note %%`).
   - Comments starting with `.` or `!` attempt **single** (§5.2). On failure, only that comment is consumed as plain text.
   - Comments starting with `~` attempt **pair** (§5.3). On success, both header comment and closer comment (and the content between them) form one property; on failure, only the header comment is consumed, leaving the candidate closer comment free to be evaluated on its own.
3. Properties never nest.

## 5. Delimited Properties

### 5.1 Shared Classifier Scan

Scanning left-to-right from the start of the classifier slice:

1. Backslash escape unit (`\` + next char, unless next char is `Cc`): advance 2 chars.
2. Unescaped `::`: marks the assignment; pass preceding slice to `classify`. If `classify` fails, fail with `invalid-classifier`.
3. Any `Cc` control character: fail with `control-character`.
4. End of slice before `::`: fail with `no-assignment` (recording whether an unescaped single `:` was seen).

### 5.2 Single (`.` and `!`)

Payload after `.` or `!` is scanned via §5.1; everything after `::` up to the closing `%%` is the content.

### 5.3 Pair (`~`)

1. **Header comment:** Payload after `~` is scanned via §5.1. Any character (including whitespace) between `::` and the header's closing `%%` fails with `text-after-header`.
2. **Closer comment:** The next `%%` found by the scanner after the header comment must form an **inline comment** on the same line (otherwise fail with `no-closer`). Its payload must be either `""` (`%%%%`) **or** start with `~` while **not** itself forming a valid `~` header `%%~...::%%` (otherwise fail with `bad-closer`, preventing a forgotten closer from swallowing a subsequent `~` property on the same line).
3. **Content:** The slice between the header comment and closer comment (may contain inline code with `%%`, escaped `\%`, formatting, links, and tags; cannot contain an unescaped inline comment).

## 6. Bare Properties

- Must begin with a **Bare-line prefix** (§3.3)—excluding ordered lists (`1.`) and task items (`- [ ] `, `- [x] `, etc.).
- Classifier is scanned via §5.1 from right after the list marker's space/tab.
- Fails silently (falling back to step 2 of §4 with zero diagnostics) if:
  1. Classifier start lies inside an excluded range (e.g., `- ` followed immediately by `` `k:: v` ``),
  2. Classifier contains an unescaped `%%` comment opener,
  3. Classifier contains an unescaped `[` (preventing list items with trailing legacy Dataview fields like `- Call Ada [due:: Friday]` from matching as bare properties), or
  4. §5.1 fails (`no-assignment`, `control-character`, `invalid-classifier`).
- Content runs from `::` to EOL. Escaping one colon (`- a\:: b`) forces plain list text.

## 7. Content, Parser Value, and Legacy Dataview Fallback

- **Parser value:** `content` trimmed of leading/trailing spaces (`U+0020`) and tabs (`U+0009`). If empty or case-sensitively equal to `null`, `Null`, or `NULL`, the value is `null`; otherwise the trimmed string (`~`, `nil`, `nuLL`, and `""` remain strings).
- **Legacy Dataview fallback:** On any text segment remaining after step 2 of §4 (outside excluded ranges and outside all comments), Rhizome scans non-nesting `[key:: value]` (excluding `[[WikiLink::Title]]`) and `(key:: value)` spans, emitting single entries with `contexts: []` and `source: 'dataview'`.

## 8. Tag Attribution, Index Value, and Normalized Schema

The parser stays tag-agnostic; the indexer joins parsed property content ranges with `CachedMetadata.tags` (UTF-16 offsets):

1. **Containment attribution:** Any Obsidian-recognized tag whose `[start, end)` offset range lies completely inside a property's content range (across `single`, `pair`, `bare`, and `dataview` forms) is attributed to that property (`tags: readonly string[]`).
2. **Index value derivation:** 3. Excise each attributed tag together with any immediately preceding run of spaces/tabs from `content`. 4. Unescape odd-backslash `\#` sequences (`\#` -> `#`, `\\\#` -> `\#`), matching Obsidian's tag-escape display. 5. Trim leading and trailing spaces/tabs. 6. Apply §7's exact null rule (`""`, `null`, `Null`, `NULL` -> `null`), then run Rhizome's vault property-type coercion.
3. **Normalized representation:** Each entry emits a `NormalizedPropertyLocation` carrying `{ property, contexts, tags, value, source: 'frontmatter' | 'inline' | 'dataview', origin }` and merges its coerced `value` into `doc.properties[property]`.

## 9. Parser Failure Reports

Failed sigiled attempts (`%%.`, `%%!`, `%%~` outside excluded ranges) report their opening `%%` offset and reason: `unclosed`, `no-assignment` (with `hasSingleColon` flag), `control-character`, `invalid-classifier`, `text-after-header`, `no-closer`, or `bad-closer`, alongside §3.6 scanner observations. Bare attempts and un-sigiled comments are never reported.
