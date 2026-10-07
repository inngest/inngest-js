# pipeline

The client and the run engine.

- `createCi.ts`: `createCi()`, its options and the `Ci` interface; wires the rest together.
- `pipeline.ts`: `ci.pipeline()`, running a pipeline, and the functions generated beside it (cleanup, re-runs, cache refreshes).
- `job.ts`: `ci.job()` and the job body (checks and caching). A direct call runs the job inline in the pipeline's run, every time; a cached job's direct call asks its build function for its snapshot instead.
- `cacheBuild.ts`: the one generated `ci/build` function (`build` in the Dev Server), which builds every job and matrix: the invoke's data names the job, and the function finds it in the client's job registry. `from()` invokes it, and so does a cached job's direct call. A caller looks the snapshot up by name first, in a step of its own run, and only invokes on a miss, or when the snapshot is expiring or is the bad one. The function looks again when it starts, for requests that queued while another build took the name. It reuses a snapshot it finds, or runs the job, snapshots it and names it, one run per name at a time, and reports to the pipeline run that invoked it. A job without a `cache` is named for the invoking pipeline run, so no other run shares it.
- `matrix.ts`: `ci.matrix()`, matrix expansion and the concurrency pool.
- `metadata.ts`: the `userland.inngest-ci` metadata attached to runs and steps, and the helpers that build and attach it.
- `scope.ts`: the run and job scopes held in async context. Jobs only write to the run scope, except for `builds`, the promises of the builds `from()` asked for.
- `names.ts`: what each step and span CI writes is called in the trace, and the origin that marks CI's own work.
- `spans.ts`: the one place CI touches the SDK's experimental trace-span API. It is feature-detected, so CI runs unchanged on an SDK without it.
- `durable.ts`: durable proxies that run calls as steps.
- `rerun.ts`: re-running a pipeline from a GitHub check.
