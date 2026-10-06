# pipeline

The client and the run engine.

- `createCi.ts`: `createCi()`, its options and the `Ci` interface; wires the rest together.
- `pipeline.ts`: `ci.pipeline()`, running a pipeline, and the functions generated beside it (cleanup, re-runs, cache refreshes).
- `job.ts`: `ci.job()` and the job body (checks, caching, pausing machines). A cached job always asks its build function for its entry.
- `cacheBuild.ts`: the generated `ci/cache-build/<job or matrix>` function (`build <id>` in the Dev Server). It decides whether to reuse the cache entry or build it, one run per cache key at a time, and reports to the pipeline run that invoked it.
- `matrix.ts`: `ci.matrix()`, matrix expansion and the concurrency pool.
- `metadata.ts`: the `userland.inngest-ci` metadata attached to runs and steps, and the helpers that build and attach it.
- `scope.ts`: the run and job scopes held in async context.
- `durable.ts`: durable proxies that run calls as steps.
- `rerun.ts`: re-running a pipeline from a GitHub check.
