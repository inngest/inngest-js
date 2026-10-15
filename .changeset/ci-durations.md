---
"@inngest/ci": minor
---

Every duration option (`cache.maxAge`, `keepOnFailure`, `.timeout()`, `waitForPort`, `waitForHttp`, `github.waitForChecks`, `waitForWorkflow`) now takes milliseconds, a string like `"1d"` or `"1h30m"`, or a `Temporal.Duration`. A bad value throws a `CiUsageError` naming the field. A bare numeric string like `"10"` now means 10 milliseconds.

```ts
await waitForPort(3000, { timeout: "1m30s" });
```
