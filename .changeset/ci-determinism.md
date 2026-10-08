---
"@inngest/ci": minor
---

Make a pipeline run plan the same steps on every request. A run ends with fixed steps whether it passed or failed, a job that was settled with `Promise.allSettled` no longer fails the pipeline, `changed()` is one step, and machines are no longer paused.
