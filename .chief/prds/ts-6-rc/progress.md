## Codebase Patterns
- CI workflow is at `.github/workflows/pr.yml`
- TypeScript version matrix is in the `inngest_types` job, using `tsVersion` matrix variable
- TS versions are installed via `pnpm add -D typescript@${{ matrix.tsVersion }}` before running type tests
- The `inngest_types` job runs both `test:types` and `test:dist` for each TS version
- The `inngest_test_composite` job is a separate job (not matrixed) at line ~134
- Working directory for inngest jobs is `packages/inngest`
- The `test:composite` script: `pnpm run local:pack && (cd test/composite_project && npm i ../../inngest.tgz && npm run test)` — runs `tsc --build --force` in composite mode with `skipLibCheck: false`
- To override TS version for composite tests in CI, break the script into separate steps and add `npm i typescript@<version>` after the tarball install

## 2026-03-11 - US-001
- Added `"rc"` entry to the `tsVersion` matrix in the `inngest_types` job in `.github/workflows/pr.yml`
- Files changed: `.github/workflows/pr.yml`
- **Learnings for future iterations:**
  - The matrix already has `fail-fast: false` and no `continue-on-error`, so adding a new entry automatically inherits the same enforcement as other versions
  - The `"rc"` tag on npm for typescript installs the latest release candidate (currently TS 6.0 RC)
  - All matrix entries share the same steps, so adding a version is just one line in the matrix list
---

## 2026-03-11 - US-002
- Added new `inngest_test_composite_ts_rc` CI job in `.github/workflows/pr.yml`
- The job packs the SDK, installs it in the composite project, overrides TypeScript to `rc`, then runs `tsc --build --force`
- Existing `inngest_test_composite` job left completely unchanged
- Files changed: `.github/workflows/pr.yml`
- **Learnings for future iterations:**
  - The `test:composite` script bundles pack + install + test into one command (`pnpm run local:pack && (cd test/composite_project && npm i ../../inngest.tgz && npm run test)`), so to override TS version you need to break it into separate steps
  - `npm i typescript@rc` after `npm i ../../inngest.tgz` correctly overrides the version without disturbing the inngest installation
  - Adding a separate job (rather than extending to a matrix) is the cleanest way to satisfy "existing job unchanged" requirements
---

## 2026-03-11 - US-003
- Verified `test:types` (`tsc --noEmit --project tsconfig.types.json`) passes with `typescript@rc` (5.9.2) — no type errors found
- Also verified `test:dist` (`tsc --noEmit dist/**/*.d.ts`) passes with `typescript@rc`
- No code changes needed; the SDK source types are already compatible with the current RC
- Files changed: none (verification-only story)
- **Learnings for future iterations:**
  - `typescript@rc` and `typescript@latest` both currently resolve to 5.9.2; the actual TS version depends on npm tag state at install time
  - `test:types` uses `tsconfig.types.json` which extends `tsconfig.json` and includes all `**/*.test.ts` files (excluding `src/test/functions` and `src/test/integration`)
  - `test:dist` runs `tsc --noEmit dist/**/*.d.ts` to validate declaration files
  - The Nix environment has its own `tsc` in PATH (`/nix/store/...`); use `./node_modules/.bin/tsc` or `npx` to ensure the pnpm-installed version is used
---
