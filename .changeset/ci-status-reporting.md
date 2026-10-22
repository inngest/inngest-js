---
"@inngest/ci": patch
---

Pipeline and job statuses on GitHub now update live: every job shows as queued as soon as the pipeline reaches it (every matrix combination at once), then running, then its result, and retries show on commit statuses too. The pipeline's status always ends with the result, such as "4 of 30 jobs failed", including when the run is cancelled, and a pipeline that skips ends as skipped. A failed job's status shows the line of its output that says why, rather than a stray bracket or exit code.

Queued and running checks on GitHub now have a "Cancel" button. Failed checks have a "Re-run, no cache" button.

When a run starts from a cached build, the pipeline's status and check summary say how much time the cache saved, such as "Passed in 4m (saved 11m from cache)".

A failed job's status now names the first real error in its output rather than shutdown noise after it, and checks no longer show raw terminal colour codes. Long annotation lists and logs that contain code fences display correctly, and the Cancel button stays on a check while it retries or builds.
