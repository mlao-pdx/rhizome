---
description: Run property tests and promote any fast-check findings to permanent regression tests.
---

Run `npm run test:properties`, then walk through promoting any captured
fast-check findings in `.fast-check-findings/` using the existing
interactive script (`npm run test:promote`, i.e.
`scripts/promote-fast-check.mjs`). This command makes the existing human
workflow (documented in `README.md` §"Promoting a fast-check finding")
invocable as a single step — it does not change the underlying script or
its behavior.

Steps:

1. Run `npm run test:properties`.
2. Check whether `.fast-check-findings/*.json` files exist.
   - If none exist, report that no findings were captured and stop.
3. If findings exist, run `npm run test:promote` (interactive):
   - It lists all findings with their id, seed, counterexample path, and
     counterexample value.
   - For each finding you decide to address in this pass: select its
     index, review the printed promotion template (mirrors
     `printTemplate()` in `scripts/promote-fast-check.mjs`) — this gives
     the finding id, seed, path, and a scaffold `it(...)` block with the
     counterexample args pre-filled.
   - Write the actual regression test into the appropriate `*.test.ts`
     file near the code under test, replacing the `// TODO: call the
function under test with args and assert the fix.` placeholder with
     a real assertion that reproduces and fixes the bug.
   - When prompted "Promoted or dismissed?", answer `promoted` only if a
     regression test was actually written in this pass; answer
     `dismissed` if the finding was reviewed and intentionally not turned
     into a permanent test (e.g. it was a test-only false positive).
   - When prompted to delete the finding file, confirm (`y`) once the
     finding has been logged and (if promoted) the regression test is
     committed to a test file.
4. Note: the script always leaves `- regression test: TODO (fill in the
*.test.ts path manually once promoted)` in
   `docs/dev/fast-check-log.md` for promoted entries — this is a known,
   accepted manual step. Fill in the actual test file path in that log
   entry by hand once the regression test exists.
5. Repeat step 3 for each remaining finding, one at a time, until all
   findings from this run have been either promoted or dismissed.
6. This workflow is local-only by design (same as all `test:properties*`
   scripts) — do not add it to CI or git hooks.
