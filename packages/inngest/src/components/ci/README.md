# `inngest/ci`

An opinionated CI API layered over the SDK's existing primitives. Nothing here
is a new execution model: a pipeline is a function, a job is a scope of steps,
and a command is a sandbox step.

| Concept | User API | Built on |
|---|---|---|
| Pipeline | `ci.pipeline(config, handler)` | `inngest.createFunction` |
| Trigger | `github.pullRequest()`, `{ cron }` | Function triggers with `if` expressions |
| Job | `ci.job(idOrConfig, handler)` | A scope of steps plus a lazily created sandbox |
| Command | `` $`…` `` | `step.sandbox` process start, polls, and output |
| Starting from a job | `await from(job)` | A snapshot of the parent, then a clone |
| Matrix | `ci.matrix(config, handler)` | Many jobs run together |
| Cache | `cache: { key, refresh }` | A cache store, snapshots, and generated functions |
| Checks | automatic, plus `report.*` | `step.run` calls to GitHub through Octokit |
| GitHub | `github.rest`, `github.stickyComment()`, … | A rule-based proxy over Octokit |

## Where things live

| File | What it owns |
|---|---|
| `createCi.ts` | `createCi`, pipelines, jobs, matrices, generated functions |
| `scope.ts` | the run and job scopes, step ID counters, and step scoping |
| `command.ts` | `$`, `$.sh`, argv parsing, and command execution |
| `machine.ts` | lazy machines, pause, snapshots, `from()`, cleanup |
| `extraMachine.ts` | `sandbox(name)` |
| `cache.ts`, `localCache.ts` | keys, stores, lookup and store |
| `helpers.ts`, `localCheckout.ts` | `checkout`, `changed`, `files`, waits |
| `durable.ts` | the internal rule-based proxy `github.rest` is built on |
| `github/` | auth, triggers, events, checks, `github.rest`, helpers, fixtures |
| `report.ts` | `report.summary`, `report.annotate` |
| `unsupported.ts` | typed, deprecated placeholders for platform gaps |
| `testHelpers.ts` | a fake sandbox REST API and a fake GitHub HTTP layer |

**Keep this self-contained.** Code here may import from the rest of the SDK,
but nothing outside `components/ci/` and `src/ci.ts` may import from here, and
Octokit is only imported inside this directory. That's what makes moving CI
into its own package later a file move rather than a refactor.

## Types carry the trigger through to the handler

A trigger is an ordinary function trigger plus a phantom `__ciEventData`, which
never exists at runtime. `ci.pipeline` reads it back off `on` and types the
handler's event:

```ts
ci.pipeline({ id: "pr", on: github.pullRequest() }, async ({ event }) => {
  event.data.pull_request.head.sha; // string
  event.data.action;                // "opened" | "synchronize" | "reopened"
});
```

Three things make that work:

- **`PayloadOf`** walks arrays, so `on: [github.pullRequest(), github.push()]`
  gives a union the handler can narrow with `in`. A trigger written by hand
  infers `unknown`; that's mapped to `never` so it can't swallow the payloads
  beside it, and a pipeline with no typed triggers falls back to an open
  record rather than `never`.
- **`const` type parameters** on `pullRequest({ types })` and `ci.matrix`, so
  `["20", "22"]` stays `"20" | "22"` without `as const`.
- **Inference from the handler** for jobs: `ci.job("x", async (node: string) =>
  …)` is a `Job<…, string>` with no type arguments written.

`github.rest`'s mapped type is worth knowing about: Octokit's parameters carry
a string index signature, and `Omit` over such a type collapses every specific
key into it — `{ pull_number: "7" }` would have been accepted. `RepoDefaults`
uses two mapped types with `as` clauses instead, which preserves them.

`types.test.ts` pins all of this down, including what shouldn't compile.

## Two scopes

CI keeps its own `AsyncLocalStorage`, nested inside the SDK's:

- **The run scope** holds the run ID, the repository, the jobs that have
  started, the machines and snapshots taken, the check reporter, and the step
  ID counters. `ci.pipeline` enters it.
- **The job scope** holds the job's path, its config, its machine, its
  `from()` source, and its annotations. `ci.job` enters it, and `$`,
  `checkout`, `from`, `sandbox`, and `report` read it.

Two details make this work with the execution engine:

1. **Step handlers run in the engine's context, not the caller's.** Anything
   CI looks up inside a step handler — the repository for `github.rest`, the
   provider for credentials — would otherwise find no scope at all. `run.step`
   is therefore wrapped by `withScopePreserved`, which re-enters the scope for
   the handler.
2. **Step IDs inside a job are prefixed with the job path.** The job handler
   runs inside a copy of the SDK's async context whose `ctx.step` prefixes
   IDs, so `step.run("create-db")` in two different jobs doesn't collide.

## Determinism

Everything CI does has to replay identically:

- **Step IDs** come from the job path plus a label, with ` #n` added from the
  second use of the same label. The counters live on the run scope and are
  rebuilt in the same order on every request, because handler code is.
- **Jobs dedupe by ID** within a run, so two callers share one execution.
- **Machines are lazy** and shared through a single promise, so concurrent
  first commands create one machine.
- **Snapshots are memoized per parent per run**, so five jobs starting from
  one parent take one snapshot.

Handlers re-run on every request; only steps are memoized. A job's body may
therefore run many times, which is why side effects belong in `step.run`.

## Commands

A command is lazy until it's awaited. When it runs:

- With `.timeout()` under five minutes, it's one captured `commands.run` step.
- Otherwise it's a managed process: `processes.start`, then a durable sleep
  and a `processes.get` per poll, then one `getOutput` step for the tail.

The sandbox API's `process.wait` blocks server-side for at most five minutes
and raises an error when that passes, which would spend the function's retries
on a healthy long-running command. Polling never errors and has no upper
bound. See NOTES.md.

## Testing

Sandboxes don't run locally yet, so the tests fake the **HTTP layer** rather
than the SDK: `testHelpers.ts` serves the sandbox REST API and GitHub's API
through `fetch`, and the SDK's real client, validation, durable protocol, and
execution engine all run for real above it.

```bash
pnpm test src/components/ci
```
