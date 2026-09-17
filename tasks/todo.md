# Inngest CI prototype (`inngest/ci`)

Spec: `SPEC-inngest-ci-prototype.md`. Docs: `inngest-ci-docs.md`.
Branch: `jack/ci`, based on `codex/sandbox-launch-secrets`.

## Acceptance criteria

- [x] `inngest/ci` subpath export builds, lints, type-checks, and is covered by
      unit tests.
- [x] `examples/ci-pipelines` is a runnable reference app showing the API users
      write, and it type-checks and serves against the built SDK.
- [x] Sandbox-backed paths are exercised through fakes, since sandboxes don't
      run locally yet.
- [x] `pnpm lint`, `pnpm test`, `pnpm test:types`, `pnpm build`, and
      `pnpm test:deps` pass in `packages/inngest`.

## Checklist

- [x] Read spec + docs, orient in repo, verify Octokit packages install
- [x] P0.1 entry wiring, types, errors, scope/ALS, glob, ids
- [x] P0.2 `createCi`, `ci.pipeline`, run scope, `ci.job` + dedupe
- [x] P0.3 `$` command builder + execution (process + polls, captured exec)
- [x] P0.4 lazy machines, pause, cleanup step + cleanup function
- [x] P0.5 `checkout()` (local + GitHub)
- [x] P0.6 `from()` snapshots/clone + fallback
- [x] P0.7 console reporter + checks lifecycle
- [x] P0.8 fixtures + example send script
- [x] P1.9 `ci.matrix`
- [x] P1.10 cache (`files()`, stores, lookup/store, refresh fns)
- [x] P1.11 `changed()`, `waitForHttp/Port`, `.background()`, `sandbox()`, timeouts
- [x] P1.12 GitHub providers (app/token), report.summary/annotate, idempotency
- [x] P1.13 comment/mergeGroup/checkSuite triggers + permission check
- [x] P1.14 `durable()` + `github.rest` + helpers
- [x] P1.15 re-run from GitHub
- [x] P1.16 command output through realtime (published on completion)
- [x] P2.17 deprecated/unsupported stubs
- [x] P2.18 local webhook forwarder
- [ ] P2.19 helpers outside a run — not built; `$` needs a machine, and the
      machine path goes through `step.sandbox`. See NOTES.md.
- [x] P2.20 example `release`/`prerelease` pipelines + README demo
- [x] Verify: lint, test, test:types, build, test:deps
- [x] REPORT.md, NOTES.md, README.md

## Results

- **261 CI tests** in `packages/inngest/src/components/ci`, and the package's
  full suite is 5536 passing with no type errors.
- **Four real bugs** the example surfaced, and one the tests surfaced, are in
  the commit messages and REPORT.md.
- **What's left** is P2.19 and live streaming of command output; both are
  written up in NOTES.md with what would unblock them.

## Working notes

- Per-function middleware **is** supported, so `createCi` attaches
  `sandboxMiddleware()` itself. Executions created directly (tests) don't
  append it, so the harness does.
- Step handlers run in the engine's async context, not the caller's, so CI
  re-enters its scope for handlers (`withScopePreserved`).
- A failed step reports its error in both `data` and `error`; only the error
  should be replayed.
- `RestEndpointMethods` isn't exported by name; `Octokit["rest"]` is.
- `hash.js` is CommonJS — a named import breaks under Node's ESM loader.
- pnpm's store is outside the sandbox's writable paths, so the two installs
  here needed the sandbox disabled for those commands.
