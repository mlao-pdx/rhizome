/**
 * Build-time constant injected by esbuild's `define`.
 *
 * @remarks
 * Dev-only code is wrapped in `if (__DEV__)` so the production build
 * tree-shakes it away entirely. Invariant assertions, timing
 * instrumentation, and the test harness handle all live behind it.
 *
 * **Not** how you gate a diagnostic log statement — `__DEV__` code never
 * ships to real users, so it cannot help them capture a real bug. Runtime
 * logging for that purpose is `LoggerPort` (`src/ports/logger-port.ts`):
 * it ships in the production bundle and is silent by default, only
 * writing once a user opts in via Settings. See `src/ports/README.md`
 * for the full two-axes rationale.
 */
declare const __DEV__: boolean;
