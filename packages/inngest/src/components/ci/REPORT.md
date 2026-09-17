# Report: the `inngest/ci` prototype

## Branch

- **Branch:** `jack/ci`
- **Base:** `codex/sandbox-launch-secrets` (at `cfa4e928 feat(sandbox): select
  secrets with a name array`), as asked, rather than the spec's default of
  `jack/inngest-ci-prototype` from `main`.
- **Commits:**
  1. `feat(ci): add the inngest/ci prototype surface`
  2. `test(ci): cover the CI prototype against fake sandbox and GitHub layers`
  3. `feat(ci): add the ci-pipelines example, and fix what running it found`
  4. `fix(ci): keep the CI scope alive inside step handlers`
  5. `docs(ci): architecture notes, limitations, and this report`

No changesets, no release scripts, no pull request.

## Running the demo

```bash
# build the SDK, then install the example against it
cd packages/inngest && pnpm build
cd ../../examples/ci-pipelines && pnpm install --ignore-workspace

npx inngest-cli@latest dev      # one terminal
pnpm dev                        # another

pnpm ci:send pr                 # a pull request event built from this repo
pnpm ci:send release --event push
pnpm ci:send prerelease --event comment --body "/prerelease"
```

The full walk-through, with what to look for at each step, is in
`examples/ci-pipelines/README.md`.

## What works

**P0, end to end**

- `inngest/ci` as a subpath export, wired into `package.json` and
  `tsdown.config.ts`, built and type-checked.
- `createCi`, `ci.pipeline`, the run scope, and the pipeline wrapper that
  always completes the check and always destroys machines.
- `ci.job` with per-run dedupe, job-scoped step IDs, and job checks.
- `$` and `$.sh`: argv parsing, `.env`, `.cwd`, `.as`, `.retries`, `.nothrow`,
  `.timeout`, `.onTimeout`, `.background`, `.text`, `.lines`, `.json`,
  `.withSecret` with masking.
- Lazy machines, `vcpu`-to-memory mapping, pause after a job, the run's
  cleanup step, and the generated cleanup function for permanent failures.
- `checkout()` for GitHub (token minted inside the step handler, never in step
  input or output) and for the local working tree (a hand-rolled ustar
  writer, no new dependency).
- `from()`: run the parent, snapshot once per parent per run, clone per child,
  and fall back to a fresh machine where snapshots aren't available.
- The console reporter and the whole check lifecycle.
- Fixtures built from the local git repository, and `pnpm ci:send`.

**P1**

- `ci.matrix`: expansion with `exclude`/`include`, a concurrency pool, and
  both `failFast` modes.
- Cache: `files()` keys against the git tree or the local working tree,
  memory and file stores, branch and global scopes, lookup, store, snapshot
  validation, and generated refresh functions.
- `changed()`, `waitForHttp`, `waitForPort`, `sandbox()`.
- GitHub App and token providers, the Checks API and commit-status fallbacks,
  `report.summary`, `report.annotate`, annotation batching, summary
  truncation, idempotent check creation, and throttled title updates.
- `github.comment` with a permission check, `github.mergeGroup`,
  `github.checkSuite`.
- `durable()`, `github.rest`, `github.repo/token/octokit/paginate/graphql`,
  and every helper including both waits.
- Re-run from a GitHub check.
- Command output published to `ci:${runId}` when a command finishes.

**P2**

- Every deprecated placeholder from the spec's table.
- The local webhook forwarder, with signature verification.
- The example's `release` and `prerelease` pipelines and the README demo.

**Tests:** 261 in `src/components/ci`, against a fake sandbox REST API and a
fake GitHub HTTP layer at the `fetch` boundary, so the SDK's real client,
validation, durable protocol, and execution engine run for real above them.

## What's stubbed, and why

Everything in the spec's table of platform gaps is typed, `@deprecated`, and
throws or warns with a message saying what to do instead:
`MachineConfig.image`, `MachineConfig.arch`, `ExtraMachine.url()`,
`shell()`, `inngestCacheStore()`, `shard({ by: "timing" })` (falls back to
`"count"`), `report.junit()`, `$.junit()`/`.retryFailed()`, `oidc.aws/gcp()`,
`vercel.waitForDeployment()`, and `rerunFromFailedJob`. A test asserts each
one carries the tag.

Not built, and not stubbed:

- **Helpers outside a run** (spec §8.4). `$` needs a machine, and the machine
  path goes through `step.sandbox`; a throwaway-sandbox path would be a second
  execution path in the command builder. `ci.job` outside a run throws, as
  specified.
- **Streaming live output while a command runs.** Output is published when the
  command finishes instead.

## Verify items

| Item | Finding |
|---|---|
| Middleware per function (§4.1) | Supported. `createCi` attaches `sandboxMiddleware()` itself, so users don't have to. Executions created directly don't append function middleware, which the test harness works around. |
| Step tools inside jobs (§5.1) | The preferred approach works: the job handler runs in a copy of the SDK's async context with a prefixing `ctx.step`. Also found that step handlers run outside the caller's context, which needed the scope to be re-entered for handlers. |
| System event names (§4.2) | `internalEvents.FunctionFailed` and `FunctionCancelled` exist; the cleanup function filters on `event.data.function_id`. |
| Octokit packages (§7.1) | `@octokit/rest@22` and `@octokit/auth-app@8` are in `packages/inngest`; `@octokit/webhooks-types` types `GitHubEventData`. `@octokit/webhooks-methods` moved to the example, where the forwarder is. `pnpm test:deps` passes with no allowlist change. |
| `RestEndpointMethods` type name (§7.9) | Not exported by name; `Octokit["rest"]` is the way in. |
| Webhook signature in a transform (§7.2) | Not possible; the URL must be treated as a secret. The local forwarder verifies instead. |
| Max triggers per function (§7.3) | Ten. `ci.pipeline` throws with a message above that. |
| Details URL (§7.6) | Dev: `${devServerUrl}/run?runID=${runId}`. Cloud: `https://app.inngest.com/env/${env}/runs/${runId}`. Both overridable with `runUrl`. |
| Dev Server sandboxes (§8.1) | Not available in this environment, so it couldn't be confirmed. The fallbacks the spec asked for are built: `from()` degrades to a fresh machine, and the cache stores results without snapshots. |
| Rerun REST endpoint (§7.8) | No SDK-side run lookup or rerun-from-step, so the re-run rebuilds a minimal event from the check's head commit and `rerunFromFailedJob` throws. |
| `@inngest/test` for CI tests (§11) | The fake-`fetch` harness in `testHelpers.ts` turned out to be a better fit: it exercises the real sandbox protocol rather than mocking around it. |

## Deviations

The full list with reasons is in NOTES.md. The ones that change behaviour:

1. **Commands poll rather than blocking on `process.wait`**, because a wait
   timeout raises an error and would spend the function's retries.
2. **`.timeout()` doesn't race `step.sleep`**; elapsed time is the sum of the
   deterministic poll intervals.
3. **`getOutput` is its own step** rather than part of the last wait.
4. **An interpolated value with no whitespace before it joins its argument**,
   so `--filter=${pkg}` works.
5. **Cache chains fold in the parents' keys from the previous run's entry**,
   since `from()` is only known at runtime.
6. **Live output is published at the end of a command**, not streamed.

## Open questions

Ranked by how much they'd unlock:

1. **Do sandboxes work against the local Dev Server, and which endpoints?**
   Everything else in CI is testable locally. Until commands run, the demo
   stops at the first `$`.
2. **Can a process signal its exit?** A `github/process.exited`-style event,
   or a `wait` that returns rather than erroring on timeout, removes the poll
   loop, its steps, and its latency.
3. **Can the REST API rerun from a step?** "Re-run" on a job check meaning
   "re-run from this job" is the behaviour people expect, and it's the one
   piece of the checks story that's currently a lie.
4. **Can snapshots carry labels?** Cache entries and `keepOnFailure` machines
   would be findable without a side table.
5. **Will machines be able to reach each other?** `sandbox()` is half a
   feature until then; `ExtraMachine.url()` throws today.
6. **Is there a hosted cache store?** The file store is fine for one machine
   and wrong for a fleet.
7. **Should `step.waitForEvent` be able to match events from a point in the
   past?** That closes the race in `github.waitForChecks`.
