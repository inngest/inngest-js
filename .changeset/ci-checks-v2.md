---
"@inngest/ci": patch
---

GitHub checks now open with the one fact you came for, in a callout: how long a cache hit saved, which test failed and where, or that a failure is probably infrastructure and a re-run is the fix. Every link and button sits in one row, and a running job lists each command once it starts. A failed job offers "Re-run job" as well as "Re-run, no cache", and a job waiting on another run's build says whose build it is and that it is not stuck.

The pipeline's "Re-run failed jobs" and "Re-run all jobs" buttons re-run exactly the jobs whose checks failed, or the whole pipeline.
