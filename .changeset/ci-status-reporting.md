---
"@inngest/ci": patch
---

Pipeline and job statuses on GitHub now update live: every job shows as queued as soon as the pipeline reaches it (every matrix combination at once), then running, then its result, and retries show on commit statuses too. The pipeline's status always ends with the result, such as "4 of 30 jobs failed", including when the run is cancelled, and a pipeline that skips ends as skipped. A failed job's status shows the line of its output that says why, rather than a stray bracket or exit code.

Failed checks on GitHub now have a "Re-run, no cache" button, and re-running a job's check re-runs just that job.

When a run starts from a cached build, the pipeline's status and check summary say how much time the cache saved, such as "Passed in 4m (saved 11m from cache)".
