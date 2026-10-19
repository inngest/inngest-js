---
"@inngest/ci": minor
---

Every job now runs as a run of its own, so each has its own step budget and a long pipeline of many jobs no longer hits the step limit. Cancelling a pipeline, or a pipeline ending, cancels the jobs it started.

Jobs defined inside the pipeline function, and jobs with `keepOnFailure`, still run in the pipeline's run. To run every job there, set `childRuns: false`.

```ts
ci.pipeline({ id: "pr", on: github.pullRequest(), childRuns: false }, async () => {
  await Promise.all([lint(), test()]);
});
```
