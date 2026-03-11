## Codebase Patterns
- CI workflow is at `.github/workflows/pr.yml`
- TypeScript version matrix is in the `inngest_types` job, using `tsVersion` matrix variable
- TS versions are installed via `pnpm add -D typescript@${{ matrix.tsVersion }}` before running type tests
- The `inngest_types` job runs both `test:types` and `test:dist` for each TS version
- The `inngest_test_composite` job is a separate job (not matrixed) at line ~134
- Working directory for inngest jobs is `packages/inngest`
- The `test:composite` script: `pnpm run local:pack && (cd test/composite_project && npm i ../../inngest.tgz && npm run test)` — runs `tsc --build --force` in composite mode with `skipLibCheck: false`
- To override TS version for composite tests in CI, break the script into separate steps and add `npm i typescript@<version>` after the tarball install
- TS 6.0 RC introduces `TS5112`: specifying files on the command line when a tsconfig.json exists is now an error (was silently ignored in TS < 6). Fix: use a dedicated tsconfig project file instead of inline file arguments
- The `--ignoreConfig` flag is new in TS 6.0 and does NOT exist in TS 5.x — do not use it if backward compatibility is needed

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

## 2026-03-11 - US-004
- TS 6.0 RC (6.0.1-rc) introduces error `TS5112`: when files are specified on the command line alongside a tsconfig.json, TS 6.0 now errors instead of silently ignoring the config
- Created `packages/inngest/tsconfig.test-dist.json` with minimal settings (`noEmit`, `skipLibCheck: true`, `module: "Preserve"`, `moduleResolution: "bundler"`, `target: "ES2022"`, `lib: ["ES2022", "DOM"]`) and `include: ["dist/**/*.d.ts"]`
- Changed `test:dist` script from `tsc --noEmit dist/**/*.d.ts` to `tsc -p tsconfig.test-dist.json`
- Verified passes with TS 5.8.2, 5.9.3, and 6.0.1-rc
- Files changed: `packages/inngest/package.json`, `packages/inngest/tsconfig.test-dist.json`
- **Learnings for future iterations:**
  - `typescript@rc` now resolves to 6.0.1-rc (not 5.9.2 as it did when US-003 was completed)
  - TS 6.0 error `TS5112` requires either `--ignoreConfig` (TS 6.0+ only) or using a project file instead of CLI file arguments
  - The `--ignoreConfig` flag does NOT exist in TS 5.x, so a project-based approach is the only backward-compatible solution
  - `skipLibCheck: true` is important in the dist test tsconfig to avoid checking node_modules .d.ts files (which may have unrelated errors from peer deps like next, hono, etc.)
  - When installing/uninstalling TS versions with pnpm, the version specifier in package.json may change (e.g., `^5.9.2` → `5.9.3`). Always verify and restore the original specifier
---
