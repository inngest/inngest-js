# Notes: what was verified, and what's limited

Findings from building the prototype. Each one says what's true today, what CI
does about it, and what would remove the workaround.

## Verified

**Per-function middleware works (spec §4.1).** `InngestFunction.Options` takes
`middleware`, `Inngest.createFunction` calls `onRegister` for each, and
`InngestCommHandler` appends them to the client's for the matched function. So
`createCi` attaches `sandboxMiddleware()` to every function it creates, and
users don't have to add it to their client.

Executions created directly (as in tests) **don't** append function-level
middleware — `engine.ts` builds instances from `client.middleware` only — so
`testHelpers.ts` does what the comm handler does.

**Step handlers run outside the caller's async context.** The engine invokes a
`step.run` callback from its own context, so an `AsyncLocalStorage` store
entered in the job body is not visible inside the handler. CI wraps its own
step tools to re-enter the scope (`withScopePreserved`), and the same wrapper
gives user code job-scoped step IDs. Without this, `github.rest` inside
`step.run` can't tell which repository it belongs to.

**Nesting async contexts is safe.** Running a job handler inside
`runWithAsyncCtx` with a copy of `execution.ctx` whose `step` is wrapped works:
the engine keys off `execution.instance`, which is untouched. This is what
scopes step IDs per job.

**A failed step reports its error in both `data` and `error`** (`op` is
`StepError` or `StepFailed`). Only the error is kept; replaying with both
resolves the step with the serialized error instead of throwing it. This
matters for anyone writing an execution harness.

**The system event names are right.** `internalEvents.FunctionFailed` and
`internalEvents.FunctionCancelled` exist in `helpers/consts.ts`, and the
cleanup function filters on `event.data.function_id == "<app>-<fn>"`.

**Octokit's `RestEndpointMethods` isn't exported by name.** It's reachable as
`Octokit["rest"]`, which is what `DurableGitHubRest` maps over.

**`hash.js` is CommonJS.** A named `import { sha256 }` type-checks and bundles
but throws under Node's ESM loader. Import the default, like the rest of the
SDK.

**The sandbox client requires a signing key**, even in dev, because it signs
its requests.

## Deviations from the spec

**Commands poll instead of blocking on `process.wait`.** The spec's wait loop
assumes `wait` returns when its timeout passes; the API raises
`sandbox_process_wait_timed_out` instead, and a step that throws is retried by
the executor, so a healthy 20-minute command would burn the function's retry
budget. CI sleeps between `processes.get` calls instead: `1s, 2s, 5s, 10s,
15s…`, each pair being a durable sleep and a step.

*What would fix it:* a `wait` that returns the process unchanged when its
timeout passes, or a process-exit event to `step.waitForEvent` on. Either
removes the polling entirely.

**`.timeout()` doesn't race `step.sleep`.** The elapsed time is the sum of the
poll intervals, which is deterministic on replay; racing two step promises is
not something to rely on in a prototype. Behaviour is the same: `onTimeout()`
runs, the process gets signal 9, and `CommandTimeoutError` is thrown.

**`getOutput` is its own step**, not part of the last wait. The durable
sandbox API exposes each operation as a step, so they can't be combined
without a direct client call from inside a step handler.

**A value with no whitespace before it joins its argument.** The spec says
every interpolated value is one argument; taken literally,
`` $`pnpm test --filter=${pkg}` `` would pass `--filter=` and `pkg`
separately. Values still never split, and arrays always spread.

**Cache chains use the parent's stored keys.** `from()` is only known at
runtime, so a job's key can't include its parents' before it runs. An entry
records `fromJobIds`, and the resolved parent keys are folded into the child's
key on the next run. A first run after a parent changes is a miss for the
parent and therefore for the child, which is the behaviour you want; a
*first-ever* run can't know its parents at lookup time.

**`failFast: true` rejects on the first failure** and lets the others run to
completion, ignoring their results. There's no cancellation to hand them.

**Live output is published when a command finishes**, not streamed while it
runs. Streaming needs the direct client's process output stream from inside
the step handler, which the durable sandbox tools don't expose. The publish is
best effort and not memoized, as the realtime docs suggest for high-frequency
updates.

**Helpers can't run outside a pipeline run** (spec §8.4). `$` needs a machine,
and the machine path goes through `step.sandbox`. Running one on a throwaway
sandbox from a plain script would need a second execution path in the command
builder; it isn't built.

## Limits worth knowing

- **Snapshots may not exist** in every environment. `from()` catches "not
  implemented", "unsupported", 404, and 501, marks the run, and falls back to
  a fresh machine with `fell back: snapshots unavailable` on the check.
- **`from()` retries land on the same machine.** `.retries(n)` reruns the
  command with new step IDs on the machine it already has.
- **`github.waitForChecks` and `waitForWorkflow` have a race.** A check that
  completes between the initial read and the wait is missed, so that name
  times out. Fixing it needs the executor to accept a wait that can match
  events from a point in the past.
- **Re-run from a check re-runs the whole pipeline**, not from the failed job.
  `rerunFromFailedJob` is typed and throws until the REST API supports
  rerun-from-step. The re-run also rebuilds a minimal event from the check
  run's head commit, because the SDK can't look up the original event.
- **Webhook transforms can't verify `X-Hub-Signature-256`.** They don't get
  the raw body and a secret in a form that allows an HMAC, so treat the
  webhook URL as a secret. The example's local forwarder does verify, with
  `@octokit/webhooks-methods`.
- **Trigger limit.** `ci.pipeline` throws when a pipeline exceeds ten
  triggers, which is the documented per-function limit. `github.pullRequest()`
  with many `types` is the usual way to reach it.
- **`inngest.sandboxes` snapshot options can't be labelled**, so a snapshot
  can't say which job or run it came from. Kept machines are recorded in the
  check summary instead.

## What would unlock the most

1. **Sandboxes against the local Dev Server.** Everything else is testable
   locally today; commands are not.
2. **A process-exit event, or a non-erroring `wait`.** Removes the poll loop,
   its steps, and its latency.
3. **Rerun-from-step in the REST API.** Makes "Re-run" on a job check mean
   what people expect.
4. **Labels on snapshots.** Lets cache entries and kept machines be found
   without a side table.
5. **Networking between machines.** `sandbox()` is half a feature without it.
