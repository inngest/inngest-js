# Inngest CI prototype (`inngest/ci`)

Spec: `SPEC-inngest-ci-prototype.md`. Docs: `inngest-ci-docs.md`.
Branch: `jack/ci` (based on `codex/sandbox-launch-secrets`).

## Acceptance criteria

- `inngest/ci` subpath export builds, lints, type-checks, and is covered by unit tests.
- `examples/ci-pipelines` is a runnable reference app showing the API users write.
- Sandboxes don't run locally yet, so sandbox-backed paths are exercised through
  fakes in tests rather than a live Dev Server.
- `pnpm lint`, `pnpm test`, `pnpm test:types`, `pnpm build`, `pnpm test:deps` pass
  in `packages/inngest`.

## Checklist

- [x] Read spec + docs, orient in repo, verify Octokit packages install
- [ ] P0.1 entry wiring, types, errors, scope/ALS, glob, ids
- [ ] P0.2 `createCi`, `ci.pipeline`, run scope, `ci.job` + dedupe
- [ ] P0.3 `$` command builder + execution (process + wait loop, captured exec)
- [ ] P0.4 lazy machines, pause, cleanup step + cleanup function
- [ ] P0.5 `checkout()` (local + GitHub)
- [ ] P0.6 `from()` snapshots/clone + fallback
- [ ] P0.7 console reporter + checks lifecycle
- [ ] P0.8 fixtures + example send script
- [ ] P1.9 `ci.matrix`
- [ ] P1.10 cache (`files()`, stores, lookup/store, refresh fns)
- [ ] P1.11 `changed()`, `waitForHttp/Port`, `.background()`, `sandbox()`, timeouts
- [ ] P1.12 GitHub providers (app/token), report.summary/annotate, idempotency
- [ ] P1.13 comment/mergeGroup/checkSuite triggers + permission check
- [ ] P1.14 `durable()` + `github.rest` + helpers
- [ ] P1.15 re-run from GitHub
- [ ] P1.16 live output via realtime
- [ ] P2.17 deprecated/unsupported stubs
- [ ] P2.18 local webhook forwarder
- [ ] P2.19 helpers outside a run
- [ ] P2.20 example `release`/`prerelease` pipelines + README demo
- [ ] Verify: lint, test, test:types, build, test:deps
- [ ] REPORT.md, NOTES.md, README.md

## Working notes

- Per-function middleware **is** supported (`InngestFunction.Options.middleware`,
  applied in `Inngest.createFunction`), so `createCi` attaches `sandboxMiddleware()`
  per generated function. No client-level requirement.
- Global `step` resolves `ctx.execution.ctx.step` via ALS (`getDeferredStepTooling`),
  so running a job handler inside `runWithAsyncCtx` with a step wrapper gives
  job-scoped step IDs for user code.
- `RestEndpointMethods` isn't exported by name; derive it as `Octokit["rest"]`.
- pnpm store is outside the sandbox's writable paths; the Octokit install needed
  the sandbox disabled for that one command.
</content>
</invoke>
