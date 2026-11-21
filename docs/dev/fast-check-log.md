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

## templates/engine__cutoff-truncation-immutability-and-callout-integrity — 2026-11-21T21:05:17.225Z

- seed: -58550165, path: "4:1:1:1:1:2:2:3:3:4:3:3:3"
- counterexample: [[{"name":"a","cutoffOpt":0,"compactColon":false,"explainFirst":false,"explain":true,"matchCount":0},{"name":"aa","cutoffOpt":1,"compactColon":false,"explainFirst":false,"explain":false,"matchCount":2}],""]
- resolution: dismissed
- regression test: n/a (test-only false positive in new property assertion; fixed via `BODY_START` delimiter in `tests/unit/template-engine.properties.test.ts`)
