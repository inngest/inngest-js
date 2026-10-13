---
"@inngest/ci": minor
---

Jobs defined inside a pipeline, and jobs that start `from` one, now build in the run that defined them instead of failing to be found by the build function. Cached ones are cached under their cache name, with a warning that concurrent runs aren't deduplicated. Defining one job ID twice in a run throws a `CiUsageError`.
