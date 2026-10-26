# pipeline

The client and the run engine.

- `createCi.ts`: `createCi()`, its options and the `Ci` interface; wires the rest together.
- `pipeline.ts`: `ci.pipeline()`, running a pipeline, and the functions generated beside it (cleanup, re-runs, cache refreshes). A run ends with the same steps whether it passed or failed.
- `job.ts`: `ci.job()` and the job body (checks and caching). A direct call runs the job inline in the pipeline's run, every time; a cached job's direct call asks its build function for its snapshot instead. A job defined inside a pipeline (an inline job), or one whose `from` parent is, exists only in that run, so it never goes through the build function: it builds in the run, a `from` parent under the run's own snapshot name and a cached one under its cache name, with a warning that concurrent runs aren't deduplicated.
- `cacheBuild.ts`: the one generated `ci/build` function (`build` in the Dev Server), which builds every job and matrix: the invoke's data names the job, and the function finds it in the client's job registry. A job's `from` parent is built through it, and so is a cached job's direct call; a build is handed the parent its job starts from, so it starts from the snapshot its name was worked out from. A caller looks the snapshot up by name first, in a step of its own run, and only invokes on a miss, or when the snapshot is expiring or is the bad one. The function looks again when it starts, for requests that queued while another build took the name. It reuses a snapshot it finds, or runs the job, snapshots it and names it (within a pipeline run each base is built once; across concurrent runs that miss together it is best-effort, so more than one may build, at most one snapshot keeps the name and the others adopt it), and reports to the pipeline run that invoked it. A job without a `cache` is named for the invoking pipeline run, so no other run shares it.
- `cleanup.ts`: making a machine or snapshot a run's own, so it is destroyed or deleted when the run ends however it ends: a defer of the SDK's sandbox cleanup, or of `ci-snapshot-cleanup` for snapshots.
- `prCache.ts`: the `ci/pr-closed` function, which deletes a pull request's own cache snapshots (`ci/pr:<repo>#<number>/...`) when it closes. A close that is never seen leaves them to the platform's expiry.
- `hooks.ts`: `CiHooks`, what a run tells a tool that watches it (`run.ci.hooks`); the default hooks do nothing.
- `matrix.ts`: the jobs of a `ci.job({ matrix })`, matrix expansion and the pool that limits how many run at once.
- `metadata.ts`: the `userland.inngest-ci` metadata attached to runs and steps, and the helpers that build and attach it.
- `scope.ts`: the run and job scopes held in async context. Jobs only write to the run scope, except for `builds`, the promises of the builds `from` parents need.
- `names.ts`: what each step and span CI writes is called in the trace, and the origin that marks CI's own work.
- `spans.ts`: the one place CI touches the SDK's experimental trace-span API.
- `buildLock.ts`: how concurrent runs that miss the same cached job build it once. A run listens for `ci/build.done`, looks the snapshot up, and on a miss sends `ci/build.requested`. The `ci/build` function that takes it claims a machine named for the entry (`ci-build-<hash>`); only one succeeds, builds, snapshots, and when its run ends destroys the machine and sends `ci/build.done` with what the build gave back. A build whose run ends sends a failed `ci/build.done` from its own cleanup. Jobs with a `from` are invoked instead.
- `durable.ts`: durable proxies that run calls as steps.
- `rerun.ts`: re-running a pipeline from a GitHub check.
