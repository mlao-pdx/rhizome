# Inline Property Rendering, Editor, and Sidebar: Specification

## 1. Overview and Core Guarantees

| Form               | Source Mode | Live Preview (Collapsed)                      | Live Preview (Revealed / Touched)    | Reading Mode & PDF                |
| :----------------- | :---------- | :-------------------------------------------- | :----------------------------------- | :-------------------------------- |
| **`~` (`pair`)**   | Full syntax | Content with dotted underline (not dimmed)    | Header & closer reveal independently | Content only (native Obsidian)    |
| **`.` (`single`)** | Full syntax | Interpunct `·` + hover preview tooltip        | Full syntax                          | Hidden (native Obsidian)          |
| **`!` (`single`)** | Full syntax | Hidden (single-stop atomic caret)             | Full syntax                          | Hidden (native Obsidian)          |
| **`bare`**         | Full syntax | Content with dotted underline (`::` if empty) | Nothing hidden                       | Plain list text (native Obsidian) |

- **Zero Reading-mode post-processing:** Because `.` , `!`, and the header/closer of `~` are valid Obsidian comments (§3.7 of the Inline spec), Obsidian natively hides them in Reading mode, PDF export, Canvas cards, Hover Previews, and Publish without `registerMarkdownPostProcessor` DOM tree-walking.
- **View-only:** Rendering never mutates vault text. Whitespace outside hidden comment ranges is never invented or deleted.

## 2. Live Preview Behavior (CodeMirror 6)

### 2.1 Collapsed Appearance and Hover Preview

- **`~` (`pair`):** `Decoration.replace` hides the header comment (`%%~...::%%`) and closer comment (`%%%%` / `%%~...%%`) independently; `Decoration.mark` applies a dotted underline to the content between them (without dimming).
- **`.` (`single`):** `Decoration.replace` replaces the entire `%%.k:: v%%` comment with an interpunct widget (`·`) carrying an accessible `aria-label` **and a hover tooltip** showing the formatted `key`, `contexts`, and `value` so authors can inspect `.` metadata without moving the caret or reflowing the line.
- **`!` (`single`):** `Decoration.replace` hides `%%!k:: v%%` with no widget, paired with `EditorView.atomicRanges` and caret/deletion transaction filters:
  - Positions immediately before and after collapsed `!` (or adjacent collapsed `!` properties) form **one caret stop**; Left/Right arrows step one visible character across it, typing lands outside on the arrival side, and bare-caret Backspace/Delete deletes the visible character beyond the hidden property.
  - Opens when overlapped by a non-empty selection, jumped into programmatically (search, undo, sidebar), or created live at the caret; collapses again once no selection touches it.
- **`bare`:** Nothing hidden; `Decoration.mark` styles the content range (or `::` when content is empty/whitespace) with a dedicated CSS class for themeable dotted underlining.
- **Optional Plain-Comment Collapse Toggle (Off by default):** A user setting and command allow collapsing non-property **single-line** inline comments (`%% ... %%`) in Live Preview into a muted comment badge with hover preview. Multi-line block comments are never collapsed (avoiding multi-line viewport jumps), and `%% ◊prepend %%` / `%% ◊append %%` PositionMarkers remain visually distinct.

### 2.2 Touch-to-Reveal & Editing Safety

- Touching any hidden range of `~` or `.` with a caret or selection reveals its raw syntax in the same CM6 transaction (`StateField` update).
- Selections overlapping hidden `!` syntax reveal it first (_what you can't see, you can't accidentally delete_, except explicit whole-line commands like Delete Line).
- Visibility freezes during active IME composition (`compositionstart` .. `compositionend`).

### 2.3 Typing Aid (`EditorView.inputHandler`)

Active in Source mode and Live Preview outside excluded ranges:

- Typing `.` or `!` immediately after `%%` completes the closing comment pair around the caret: `%%.^%%` or `%%!^%%`.
- Typing `~` immediately after `%%` inserts the paired skeleton `%%~^::%%%%%%`; pressing `Tab` while inside the `~` classifier jumps the caret past `::%%` into the content slot (`%%~k::%%^%%%%`).

### 2.4 Linter Diagnostics (`@codemirror/lint`, No Gutter)

Runs in Source mode and Live Preview, suppressing diagnostics on whichever attempt the caret currently touches:

- **Unclosed plain-line `%%` (`warning` severity):** Reports how many lines (up to line `X` or EOF) are hidden by the unclosed block comment, plus warnings when closed inside a table or across mismatched blocks.
- **Unclosed container-line `%%` (`info` severity):** Notes bounded hiding up to the next blank line.
- **Failed sigiled attempts (`info` severity):**
  - `no-assignment` with `hasSingleColon`: _"no `::` found"_.
  - `text-after-header` on `~`: _"Move value after closing `%%`: `%%~key::%%value%%%%`"_.
  - `no-closer` / `bad-closer` on `~`, `invalid-classifier`, `control-character`.
  - Percent-run / closer-escape hazard (`%%%` or `\%%` at closer): suggests adding a space before closing `%%` (`50% %%`).

## 3. Read-Only Inline Properties Sidebar & Settings

- **Sidebar:** Lists active Markdown view's live parsed inline properties (`Line`, `Key`, `Contexts`, `Value`—showing raw parser value so unsaved edits update immediately without waiting on disk cache), highlighting and scrolling along with the primary caret line in Source/Live Preview, and jumping the caret after the opener (or after `::` for `bare`) when a row is clicked.
- **Settings:** Toggles for Live Preview inline property rendering (on by default), Diagnostics (on by default), and Plain single-line comment collapsing (off by default). None affect indexing or the sidebar.
