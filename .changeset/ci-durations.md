---
"@inngest/ci": minor
---

Every duration (`cache.maxAge`, `keepOnFailure`, `.timeout()`, `waitForPort`, `waitForHttp`, `github.waitForChecks` and `waitForWorkflow`) now takes milliseconds, an `ms` string like `"1d"` or `"1h30m"`, or a `Temporal.Duration`. A bad value throws `CiUsageError` naming the field, and the Sandbox API decides how long is too long. A bare number in a string (`"10"`) now means milliseconds.
