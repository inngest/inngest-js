---
"@inngest/ci": patch
---

Pipeline and job statuses on GitHub now update live: every job shows as queued as soon as the pipeline reaches it (every matrix combination at once), then running, then its result, and retries show on commit statuses too. The pipeline's status always ends with the result, such as "4 of 30 jobs failed", including when the run is cancelled, and a pipeline that skips ends as skipped. A failed job's status shows the line of its output that says why, rather than a stray bracket or exit code.
