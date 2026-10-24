# Fast-check finding log

Append-only history of fast-check discoveries surfaced by
`npm run test:promote`, whether the finding was promoted to a permanent
regression test or dismissed. Entries are written automatically by
`scripts/promote-fast-check.mjs`; do not hand-edit past entries.

## search/parser__fuzz-totality-error-gating-and-span-integrity — 2026-10-24T23:29:13.960Z

- seed: 65383671, path: "33:10"
- counterexample: ["["]
- resolution: promoted
- regression test: `tests/unit/search-parser.test.ts`
