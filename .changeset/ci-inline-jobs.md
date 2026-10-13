---
"@inngest/ci": minor
---

Jobs defined inside a pipeline, and jobs that start `from` one, now work: they build in the run that defined them instead of failing. Defining the same job ID twice in a run throws a `CiUsageError`.
