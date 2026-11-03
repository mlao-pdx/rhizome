---
description: Run after adding or upgrading a dependency, before committing — verifies version pinning policy, audits production dependency licenses and bundle vulnerabilities, and drafts any missing THIRD-PARTY-NOTICES.md entries. The check is CI-enforced.
---

Run `npm run check:licenses` and `npm run audit:bundle` to verify dependency hygiene before committing.

This runs `scripts/check-licenses.mjs`, which shells out to
`license-checker-rseidelsohn` scoped to production dependencies only
(`--production`), excluding the project's own package entry. It enforces
an allowlist of permissive licenses: `0BSD, MIT, BSD-2-Clause,
BSD-3-Clause, Apache-2.0, ISC, Zlib`. Anything else — including copyleft
licenses (GPL/AGPL/LGPL/MPL) or a missing/unknown license field — fails
the check (exit code 1) and must be resolved manually, not silently
allowed.

Steps:

1. **Verify version pinning policy and lockfile sync:**
   - Every entry in `dependencies` in `package.json` must be pinned to an
     exact `x.y.z` version (no `^`, `~`, or range prefixes, installed via
     `npm install --save-exact <pkg>@<version>`).
   - Every entry in `devDependencies` must use `^` carets (`~` for
     `typescript`), and `.npmrc` must not contain `save-exact=true` (per
     `AGENTS.md`).
   - Confirm the root `packages[""]` block in `package-lock.json` and the
     resolved `node_modules/*` entries match `package.json` (`npm ls --depth=0`).
   - For any added or upgraded dependency, confirm that the changelog and
     sub-dependency diff were reviewed rather than blindly upgraded or
     modified via `npm audit fix --force`.
2. Run `npm run check:licenses`.
3. If it exits non-zero because of a disallowed/missing license: report
   the offending package and license to the user, and stop — do not
   attempt to work around the allowlist or silently continue. The
   allowlist itself lives in `scripts/check-licenses.mjs` and should only
   be changed with explicit user sign-off.
4. If it exits non-zero because a production dependency isn't yet listed
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
5. Re-run `npm run check:licenses` after updating the notices file to
   confirm it now passes.
6. Run `npm run build && npm run audit:bundle` to verify that zero
   vulnerable packages are bundled into `main.js` (per `meta.json`) and no
   critical vulnerabilities exist in dev/unbundled dependencies.
7. Both `check:licenses` and `audit:bundle` run in CI via
   `.github/workflows/lint.yml` and `.github/workflows/release.yml`, so a
   failing audit blocks CI and releases. Run them locally after adding or
   upgrading a dependency so any missing notices or bundle advisories are
   resolved before you commit.
8. **Triage non-critical dev-dependency alerts in GitHub / Dependabot:**
   When `npm run audit:bundle` passes with non-critical dev/unbundled
   advisories, check or remind the user about GitHub Dependabot alerts
   (never run `npm audit fix --force` to silence dev-only advisories):
   - **One-time manual GitHub UI setting (remind user if red/yellow alerts
     appear on GitHub or `git push`):**
     `https://github.com/mlao-pdx/rhizome/settings/security_analysis` →
     **Dependabot rules** → enable **"Dismiss low impact issues for
     development-scoped dependencies"**.
   - **Automated CLI dismissal of existing open dev-scoped non-critical
     alerts (via `gh api`):**
     ```sh
     gh api --paginate /repos/mlao-pdx/rhizome/dependabot/alerts \
       --jq '.[] | select(.state == "open" and .dependency.scope == "development" and .security_advisory.severity != "critical") | .number' \
       | while read -r num; do
           gh api --method PATCH "/repos/mlao-pdx/rhizome/dependabot/alerts/$num" \
             -f state='dismissed' \
             -f dismissed_reason='tolerable_risk' \
             -f dismissed_comment='Dev-only dependency; not bundled into main.js (verified by npm run audit:bundle).'
         done
     ```
