---
description: Reload the plugin in a running Obsidian instance and check for errors/warnings after a code change.
---

Codifies the manual "Develop/test cycle" from the `obsidian-cli` skill as a
single repeatable sequence. Requires a running Obsidian instance with this
plugin installed via the dev symlink (see `README.md`'s manual-install
section). This is a manual, local-only verification step — it is not
CI-gated, same posture as property tests, and it complements (does not
replace) `tests/smoke/plugin-lifecycle.test.ts`: that test runs against a
hand-rolled mock in `tests/support/mock-obsidian-app.ts` (the `obsidian`
npm package ships TypeScript types only, no runtime), so it cannot catch
real-Obsidian-runtime issues that this command can.

Optional argument: `$ARGUMENTS` — a description of what surface to
inspect after reload (e.g. a CSS selector for `obsidian dev:dom
selector="..." text`, or a note to take a full workspace screenshot). If
no argument is given, default to a general workspace screenshot.

Steps:

1. Reload the plugin using the `id` currently set in `manifest.json` (read
   it — do not hardcode a specific id literal here, since a template
   project's id may be renamed):
   ```
   obsidian plugin:reload id=<id from manifest.json>
   ```
2. Check for errors:
   ```
   obsidian dev:errors
   ```
   - If this reports any errors, **stop** — this is a fix-and-repeat
     loop, not a gate to continue past. Report the error(s), fix the
     underlying code, and go back to step 1.
3. Enable debug mode and check the console for warnings/errors (console
   output requires debug mode first):
   ```
   obsidian debug:on
   obsidian dev:console level=error
   ```
   - If this reports unexpected warnings or errors, investigate before
     continuing.
4. Targeted verification based on `$ARGUMENTS`:
   - If `$ARGUMENTS` names a CSS selector or UI surface, use
     `obsidian dev:dom selector="..." text` to inspect it, or
     `obsidian dev:css selector="..." prop=...` for style checks.
   - If no argument was given, take a general screenshot instead:
     ```
     obsidian dev:screenshot path=screenshot.png
     ```
5. Report back what was verified (errors found and fixed, console output,
   screenshot/DOM findings) rather than silently declaring success.
