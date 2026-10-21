---
"@inngest/ci": patch
---

GitHub checks now open with the one fact you came for, in a callout: how long a cache hit saved, which test failed and where, or that a failure is probably infrastructure and a re-run is the fix. Every link and button sits in one row, and a running job lists each command once it starts. A failed job offers "Re-run job" as well as "Re-run, no cache", and a job waiting on another run's build says whose build it is and that it is not stuck.

The pipeline's "Re-run failed jobs" and "Re-run all jobs" buttons re-run exactly the jobs whose checks failed, or the whole pipeline.

The pipeline's check shows how far along it is while it runs, and ends with the time the cache saved, the critical path, the slowest jobs, a job graph and a timeline. A failed pipeline lists each failed job with the reason and a link to its check, and a cancelled one shows what finished and what was stopped.

Problems your tools find land as annotations on the lines they are about: type errors from `tsc --pretty false`, failed, snapshot-mismatched and flaky tests, and lint from eslint and biome. A command that writes or prints its report as JSON, such as `vitest run --reporter=json --outputFile=results.json`, is read on its own, and `report.results("vitest", "results.json")` reads the file of a tool a script runs. A rule that repeats on many lines becomes one annotation, and a check carries at most 200.
