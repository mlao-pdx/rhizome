---
description: Run after adding or upgrading a dependency, before committing — audits production dependency licenses and drafts any missing THIRD-PARTY-NOTICES.md entries. The check is CI-enforced.
---

Run `npm run check:licenses` and report the result.

This runs `scripts/check-licenses.mjs`, which shells out to
`license-checker-rseidelsohn` scoped to production dependencies only
(`--production`), excluding the project's own package entry. It enforces
an allowlist of permissive licenses: `0BSD, MIT, BSD-2-Clause,
BSD-3-Clause, Apache-2.0, ISC, Zlib`. Anything else — including copyleft
licenses (GPL/AGPL/LGPL/MPL) or a missing/unknown license field — fails
the check (exit code 1) and must be resolved manually, not silently
allowed.

Steps:

1. Run `npm run check:licenses`.
2. If it exits non-zero because of a disallowed/missing license: report
   the offending package and license to the user, and stop — do not
   attempt to work around the allowlist or silently continue. The
   allowlist itself lives in `scripts/check-licenses.mjs` and should only
   be changed with explicit user sign-off.
3. If it exits non-zero because a production dependency isn't yet listed
   in `THIRD-PARTY-NOTICES.md`, the script prints a draft notice (package
   name, version, license, repository, and local license file path) for
   each missing entry. Use that draft to add a full entry to
   `THIRD-PARTY-NOTICES.md` by hand:
   - Paste the **full license text** into the notices file — do not
     reference a `node_modules/<pkg>/LICENSE` path, since release
     artifacts only ship `main.js`, `manifest.json`, and `styles.css`
     (per `.github/workflows/release.yml`); `node_modules` is never
     shipped, so a path reference would be broken for anyone reading the
     shipped notice.
   - Never have this command (or the script) auto-write
     `THIRD-PARTY-NOTICES.md` for you — it is a hand-maintained file, same
     convention as `docs/dev/fast-check-log.md` being append-only by a
     script but never silently rewritten wholesale.
4. Re-run `npm run check:licenses` after updating the notices file to
   confirm it now passes.
5. This check also runs in CI via `.github/workflows/lint.yml` on every
   push and pull request, so a failing audit blocks CI as well. The local
   run exists for drafting `THIRD-PARTY-NOTICES.md` entries: run it after
   adding or upgrading a dependency so any missing notices are drafted and
   added before you commit.
